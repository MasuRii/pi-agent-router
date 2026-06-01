import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateRouterReloadCaches } from "../router-reload";
import {
  createSubagentProcessLifecycle,
  selectRetryDelayMs,
  TRANSIENT_RETRY_DELAY_CAP_MS,
} from "../subagent/subagent-execution";
import { parseProviderRetryDelayHint } from "../subagent/credential-backoff";
import {
  createDelegatedSubagentBaseArgs,
  resolveDelegatedCliSpawnCommand,
} from "../subagent/subagent-launch-command";
import {
  invalidateDelegatedExtensionRuntimeCaches,
  readDelegatedExtensionRuntimeMetadataAsync,
} from "../subagent/delegated-extensions";
import type { SubagentRunResult, SubagentSession } from "../types";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function createRunningSession(overrides: Partial<SubagentSession> = {}): SubagentSession {
  return {
    id: "session-12345678",
    taskId: "task-1",
    parentSessionId: "parent-1",
    delegatedBy: "orchestrator",
    agent: "code",
    task: "Run delegated task",
    cwd: process.cwd(),
    status: "running",
    startedAt: Date.now(),
    stderr: "",
    ...overrides,
  };
}

function mergeCapturedText(current: string, next: string): string {
  return [current, next].filter(Boolean).join("\n");
}

function preferLatestRunResult(
  base: SubagentRunResult,
  candidate: SubagentRunResult | undefined,
): SubagentRunResult {
  return candidate ?? base;
}

function createNoopRetryOptions(runAttempt: () => Promise<SubagentRunResult>) {
  return {
    runAttempt,
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    getRetryableCredentialFailure: () => undefined,
    getRunFailureText: (run: SubagentRunResult) => run.stderr,
    preferRicherRunResult: preferLatestRunResult,
    isLockRetryableFailure: () => false,
    sleep: async () => {},
    getLastAcquiredCredentialId: () => undefined,
    clearTransientCredentialError: async () => {},
    reportQuotaCredentialError: async () => {},
    reportCredentialAuthError: async () => {},
    reportTransientCredentialError: async () => {},
  };
}

await runTest("delegated subagent launch args disable ambient extension discovery behaviorally", () => {
  const args = createDelegatedSubagentBaseArgs({
    sessionDir: "/tmp/pi-agent-router-sessions",
    sessionPath: "retained-session.jsonl",
    modelRef: "openai/gpt-5",
    thinkingLevel: "off",
  });

  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--no-extensions",
    "--offline",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session-dir",
    "/tmp/pi-agent-router-sessions",
    "--session",
    "retained-session.jsonl",
    "--model",
    "openai/gpt-5",
    "--thinking",
    "off",
  ]);
});

await runTest("delegated CLI spawn resolution fails closed instead of using PATH fallback", async () => {
  const resolution = await resolveDelegatedCliSpawnCommand({
    cliEntrypoint: undefined,
    nodeExecPath: "/trusted/node",
    invocationArgs: ["--mode", "json"],
    hasExplicitSessionPath: false,
    isFile: async () => false,
  });

  assert.equal(resolution.ok, false);
  if (!resolution.ok) {
    assert.match(resolution.error, /Refusing to fall back to PATH lookup/);
  }
});

await runTest("delegated CLI spawn resolution uses trusted node and file-backed Pi entrypoint", async () => {
  const trustedFiles = new Set(["/trusted/node", "/trusted/pi-entrypoint.js"]);
  const resolution = await resolveDelegatedCliSpawnCommand({
    cliEntrypoint: "/trusted/pi-entrypoint.js",
    nodeExecPath: "/trusted/node",
    invocationArgs: ["--mode", "json"],
    hasExplicitSessionPath: false,
    isFile: async (path) => trustedFiles.has(path),
  });

  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.command, "/trusted/node");
    assert.deepEqual(resolution.buildArgs("continuation.jsonl"), [
      "/trusted/pi-entrypoint.js",
      "--mode",
      "json",
      "--session",
      "continuation.jsonl",
    ]);
  }
});

await runTest("router reload invalidates delegated runtime metadata cache behaviorally", async () => {
  invalidateDelegatedExtensionRuntimeCaches();
  const extensionDir = mkdtempSync(join(tmpdir(), "pi-agent-router-reload-cache-"));
  const packageJsonPath = join(extensionDir, "package.json");

  try {
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify({
        piAgentRouter: {
          delegatedRuntime: {
            skipWhen: ["directEnvAuthAvailable"],
          },
        },
      })}\n`,
      "utf-8",
    );

    const firstRead = await readDelegatedExtensionRuntimeMetadataAsync(extensionDir);
    assert.deepEqual(firstRead.metadata.skipWhen, ["directEnvAuthAvailable"]);

    writeFileSync(packageJsonPath, `${JSON.stringify({})}\n`, "utf-8");
    invalidateRouterReloadCaches();

    const refreshedRead = await readDelegatedExtensionRuntimeMetadataAsync(extensionDir);
    assert.deepEqual(refreshedRead.metadata.skipWhen, []);
  } finally {
    rmSync(extensionDir, { recursive: true, force: true });
    invalidateDelegatedExtensionRuntimeCaches();
  }
});

await runTest("subagent process lifecycle retries quota failures and finalizes the successful run once", async () => {
  const session = createRunningSession();
  const finalizedRuns: SubagentRunResult[] = [];
  const quotaReports: Array<{ message: string; credentialId: string }> = [];
  const clearedCredentialIds: string[] = [];
  const sleepDelays: number[] = [];
  const retryKinds: string[] = [];
  const preparedCredentialRetries: Array<{ kind: string; attempt: number; maxAttempts: number }> = [];
  let attemptCount = 0;
  let renderRequests = 0;

  const lifecycle = createSubagentProcessLifecycle({
    session,
    hardKillDelayMs: 1,
    requestUiRender: () => {
      renderRequests += 1;
    },
    mergeCapturedText,
    onFinalize: (run) => {
      finalizedRuns.push(run);
    },
  });

  await lifecycle.runWithRetry({
    runAttempt: async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        return { code: 1, stdout: "", stderr: "quota exceeded", timedOut: false };
      }
      return { code: 0, stdout: "done", stderr: "", timedOut: false, sessionPath: "fresh-session.jsonl" };
    },
    getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    getRetryableCredentialFailure: (run) => run.stderr.includes("quota")
      ? { kind: "quota" as const, message: "quota exceeded" }
      : undefined,
    getRunFailureText: (run) => run.stderr,
    preferRicherRunResult: preferLatestRunResult,
    isLockRetryableFailure: () => false,
    sleep: async (delayMs) => {
      sleepDelays.push(delayMs);
    },
    getLastAcquiredCredentialId: () => "credential-1",
    getQuotaCredentialRetryLimit: () => 1,
    clearTransientCredentialError: async (credentialId) => {
      clearedCredentialIds.push(credentialId);
    },
    reportQuotaCredentialError: async (message, credentialId) => {
      quotaReports.push({ message, credentialId });
    },
    reportCredentialAuthError: async () => {},
    reportTransientCredentialError: async () => {},
    prepareRetryAttempt: ({ failure, attempt, maxAttempts }) => {
      preparedCredentialRetries.push({
        kind: failure.kind,
        attempt,
        maxAttempts,
      });
    },
    onRetry: (event) => {
      retryKinds.push(event.kind);
    },
  });

  assert.equal(attemptCount, 2);
  assert.deepEqual(quotaReports, [{ message: "quota exceeded", credentialId: "credential-1" }]);
  assert.deepEqual(clearedCredentialIds, ["credential-1"]);
  assert.equal(sleepDelays.length, 1);
  assert.equal(sleepDelays[0] >= 1_500, true);
  assert.equal(sleepDelays[0] < 2_000, true);
  assert.deepEqual(retryKinds, ["quota"]);
  assert.deepEqual(preparedCredentialRetries, [{ kind: "quota", attempt: 1, maxAttempts: 1 }]);
  assert.equal(renderRequests, 1);
  assert.equal(finalizedRuns.length, 1);
  assert.equal(finalizedRuns[0].code, 0);
  assert.equal(finalizedRuns[0].stdout, "done");
  assert.equal(session.sessionPath, "fresh-session.jsonl");
  assert.equal(session.proc, undefined);
});

await runTest("subagent process lifecycle uses configured transient auto-retry settings", async () => {
  const session = createRunningSession({ sessionPath: "retry-session.jsonl" });
  const finalizedRuns: SubagentRunResult[] = [];
  const sleepDelays: number[] = [];
  const retryEvents: Array<{ attempt: number; maxAttempts: number; delayMs: number }> = [];
  const preparedRetrySessionPaths: string[] = [];
  let attemptCount = 0;

  const lifecycle = createSubagentProcessLifecycle({
    session,
    hardKillDelayMs: 1,
    requestUiRender: () => {},
    mergeCapturedText,
    onFinalize: (run) => {
      finalizedRuns.push(run);
    },
  });

  await lifecycle.runWithRetry({
    ...createNoopRetryOptions(async () => {
      attemptCount += 1;
      if (attemptCount <= 2) {
        return {
          code: 1,
          stdout: "",
          stderr: "CommandCode request timed out after 300000ms.",
          timedOut: false,
          sessionPath: "retry-session.jsonl",
        };
      }
      return { code: 0, stdout: "recovered", stderr: "", timedOut: false, sessionPath: "retry-session.jsonl" };
    }),
    getRetryableCredentialFailure: (run) => run.stderr.includes("timed out")
      ? { kind: "transient" as const, message: run.stderr }
      : undefined,
    transientRetrySettings: { enabled: true, maxRetries: 3, baseDelayMs: 5 },
    prepareRetryAttempt: ({ run }) => {
      if (run.sessionPath) preparedRetrySessionPaths.push(run.sessionPath);
    },
    sleep: async (delayMs) => {
      sleepDelays.push(delayMs);
    },
    onRetry: (event) => {
      if (event.kind === "transient") {
        retryEvents.push({ attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs });
      }
    },
  });

  assert.equal(attemptCount, 3);
  assert.deepEqual(sleepDelays, [5, 10]);
  assert.deepEqual(retryEvents, [
    { attempt: 1, maxAttempts: 3, delayMs: 5 },
    { attempt: 2, maxAttempts: 3, delayMs: 10 },
  ]);
  assert.deepEqual(preparedRetrySessionPaths, ["retry-session.jsonl", "retry-session.jsonl"]);
  assert.equal(finalizedRuns.length, 1);
  assert.equal(finalizedRuns[0].stdout, "recovered");
});

await runTest("provider retry delay parsing supports retry-after headers and safe caps", () => {
  assert.deepEqual(
    parseProviderRetryDelayHint("provider overloaded\nretry-after-ms: 1250"),
    { delayMs: 1250, source: "retry-after-ms", rawValue: "1250" },
  );
  assert.deepEqual(
    parseProviderRetryDelayHint('{"retry-after":"2"}'),
    { delayMs: 2_000, source: "retry-after", rawValue: "2" },
  );

  const nowMs = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
  assert.deepEqual(
    parseProviderRetryDelayHint("retry-after: Wed, 21 Oct 2015 07:28:00 GMT", nowMs),
    { delayMs: 60_000, source: "retry-after", rawValue: "Wed, 21 Oct 2015 07:28:00 GMT" },
  );
  assert.equal(parseProviderRetryDelayHint("retry-after: Wed, 21 Oct 2015 07:26:00 GMT", nowMs), undefined);

  const cappedSelection = selectRetryDelayMs(2_000, {
    delayMs: TRANSIENT_RETRY_DELAY_CAP_MS + 60_000,
    source: "retry-after-ms",
    rawValue: String(TRANSIENT_RETRY_DELAY_CAP_MS + 60_000),
  });
  assert.equal(cappedSelection.delayMs, TRANSIENT_RETRY_DELAY_CAP_MS);
  assert.equal(cappedSelection.defaultDelayMs, 2_000);
  assert.equal(cappedSelection.usedProviderRetryDelay, true);
  assert.equal(cappedSelection.providerRetryDelayCapped, true);
});

await runTest("subagent process lifecycle uses provider retry hint and reports observability fields", async () => {
  const session = createRunningSession({ sessionPath: "retry-hint-session.jsonl" });
  const finalizedRuns: SubagentRunResult[] = [];
  const sleepDelays: number[] = [];
  const retryEvents: Array<{
    delayMs: number;
    defaultDelayMs: number;
    reason: string;
    usedProviderRetryDelay: boolean;
    providerRetryDelaySource?: string;
  }> = [];
  let attemptCount = 0;

  const lifecycle = createSubagentProcessLifecycle({
    session,
    hardKillDelayMs: 1,
    requestUiRender: () => {},
    mergeCapturedText,
    onFinalize: (run) => {
      finalizedRuns.push(run);
    },
  });

  await lifecycle.runWithRetry({
    ...createNoopRetryOptions(async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        return {
          code: 1,
          stdout: "",
          stderr: "provider returned error\nretry-after-ms: 250",
          timedOut: false,
          sessionPath: "retry-hint-session.jsonl",
        };
      }
      return { code: 0, stdout: "recovered", stderr: "", timedOut: false, sessionPath: "retry-hint-session.jsonl" };
    }),
    getRetryableCredentialFailure: (run) => run.stderr.includes("provider returned error")
      ? { kind: "transient" as const, message: run.stderr, retryAfter: parseProviderRetryDelayHint(run.stderr) }
      : undefined,
    transientRetrySettings: { enabled: true, maxRetries: 1, baseDelayMs: 5 },
    sleep: async (delayMs) => {
      sleepDelays.push(delayMs);
    },
    onRetry: (event) => {
      retryEvents.push({
        delayMs: event.delayMs,
        defaultDelayMs: event.defaultDelayMs,
        reason: event.reason,
        usedProviderRetryDelay: event.usedProviderRetryDelay,
        providerRetryDelaySource: event.providerRetryDelaySource,
      });
    },
  });

  assert.equal(attemptCount, 2);
  assert.deepEqual(sleepDelays, [250]);
  assert.deepEqual(retryEvents, [{
    delayMs: 250,
    defaultDelayMs: 5,
    reason: "provider returned error\nretry-after-ms: 250",
    usedProviderRetryDelay: true,
    providerRetryDelaySource: "retry-after-ms",
  }]);
  assert.equal(session.stderr.includes("Reason: provider returned error retry-after-ms: 250"), true);
  assert.equal(session.stderr.includes("Provider retry-after-ms hint selected"), true);
  assert.equal(finalizedRuns.length, 1);
  assert.equal(finalizedRuns[0].stdout, "recovered");
});

await runTest("subagent process lifecycle reports retry exhaustion", async () => {
  const session = createRunningSession();
  const finalizedRuns: SubagentRunResult[] = [];
  const exhaustedEvents: Array<{ attempts: number; maxAttempts: number; reason: string }> = [];

  const lifecycle = createSubagentProcessLifecycle({
    session,
    hardKillDelayMs: 1,
    requestUiRender: () => {},
    mergeCapturedText,
    onFinalize: (run) => {
      finalizedRuns.push(run);
    },
  });

  await lifecycle.runWithRetry({
    ...createNoopRetryOptions(async () => ({
      code: 1,
      stdout: "",
      stderr: "stream ended unexpectedly",
      timedOut: false,
    })),
    getRetryableCredentialFailure: (run) => ({ kind: "transient" as const, message: run.stderr }),
    transientRetrySettings: { enabled: true, maxRetries: 0, baseDelayMs: 5 },
    onRetryExhausted: (event) => {
      exhaustedEvents.push({ attempts: event.attempts, maxAttempts: event.maxAttempts, reason: event.reason });
    },
  });

  assert.deepEqual(exhaustedEvents, [{ attempts: 0, maxAttempts: 0, reason: "stream ended unexpectedly" }]);
  assert.equal(finalizedRuns.length, 1);
  assert.equal(finalizedRuns[0].code, 1);
  assert.equal(finalizedRuns[0].stderr.includes("exhausted after 0/0 retries"), true);
  assert.equal(finalizedRuns[0].stderr.includes("Reason: stream ended unexpectedly"), true);
});

await runTest("subagent process lifecycle finalizes without starting an attempt after cancellation", async () => {
  const session = createRunningSession({
    status: "aborted",
    stderr: "cancelled before launch",
    sessionPath: "existing-session.jsonl",
  });
  const finalizedRuns: SubagentRunResult[] = [];
  let attemptCount = 0;

  const lifecycle = createSubagentProcessLifecycle({
    session,
    hardKillDelayMs: 1,
    requestUiRender: () => {},
    mergeCapturedText,
    onFinalize: (run) => {
      finalizedRuns.push(run);
    },
  });

  await lifecycle.runWithRetry(createNoopRetryOptions(async () => {
    attemptCount += 1;
    return { code: 0, stdout: "unexpected", stderr: "", timedOut: false };
  }));

  assert.equal(attemptCount, 0);
  assert.equal(finalizedRuns.length, 1);
  assert.deepEqual(finalizedRuns[0], {
    code: 1,
    stdout: "",
    stderr: "cancelled before launch",
    timedOut: false,
    sessionPath: "existing-session.jsonl",
  });
  assert.equal(session.proc, undefined);
});

console.log("All subagent process lifecycle tests passed.");
