import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateRouterReloadCaches } from "../router-reload";
import {
  createSubagentProcessLifecycle,
} from "../subagent/subagent-execution";
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
  assert.equal(renderRequests, 1);
  assert.equal(finalizedRuns.length, 1);
  assert.equal(finalizedRuns[0].code, 0);
  assert.equal(finalizedRuns[0].stdout, "done");
  assert.equal(session.sessionPath, "fresh-session.jsonl");
  assert.equal(session.proc, undefined);
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
