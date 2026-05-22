import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAgentRouterDebugLogger } from "../debug-logger";
import { AsyncBufferedLogWriter } from "../async-buffered-log-writer";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("debug logger redacts sensitive keys, values, URLs, and errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-router-debug-"));
  const configPath = join(root, "config.json");
  const debugDir = join(root, "debug");
  const logPath = join(debugDir, "pi-agent-router-debug.jsonl");
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJyb3V0ZXIifQ", "signaturePart"].join(".");

  try {
    writeFileSync(configPath, JSON.stringify({ debug: true }), "utf-8");
    const logger = new PiAgentRouterDebugLogger({ configPath, debugDir, logPath });

    logger.info("redaction_test", {
      credentialId: "openai-codex-credential-secret",
      authorization: "Bearer live-secret-token",
      sessionPath: `/tmp/session?access_token=${jwt}&code=callback-code-secret&safe=1`,
      error: new Error(`Authorization: Bearer nested-secret failed with ${jwt}`),
      nested: {
        apiKey: "api-key-secret",
        details: "refresh_token=refresh-secret state=state-secret verifier=verifier-secret",
      },
    });
    await logger.flush();

    const logContent = readFileSync(logPath, "utf-8");
    const entry = JSON.parse(logContent.trim().split(/\r?\n/)[0] ?? "{}") as Record<string, unknown>;
    const serialized = JSON.stringify(entry);

    assert.equal(entry.credentialId, "[REDACTED]");
    assert.equal(entry.authorization, "[REDACTED]");
    assert.equal((entry.nested as Record<string, unknown>).apiKey, "[REDACTED]");
    assert.doesNotMatch(serialized, /openai-codex-credential-secret|live-secret-token|signaturePart|callback-code-secret|nested-secret|api-key-secret|refresh-secret|state-secret|verifier-secret/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.match(serialized, /safe=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("async buffered log writer drops permanently failing payloads after bounded retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-router-writer-"));
  const logPath = join(root, "pi-agent-router-debug.jsonl");

  try {
    mkdirSync(logPath);
    const writer = new AsyncBufferedLogWriter({
      enabled: true,
      logPath,
      ensureDirectory: () => undefined,
      maxWriteRetries: 1,
      writeRetryDelayMs: 1,
      createDroppedWriteFailuresLine: (metadata) =>
        `${JSON.stringify({ event: "debug_log_write_failures_dropped", ...metadata })}\n`,
    });

    writer.writeLine("first payload");
    await writer.flush();
    await writer.flush();

    rmSync(logPath, { recursive: true, force: true });
    writer.writeLine("second payload");
    await writer.flush();
    await writer.dispose();

    const logContent = readFileSync(logPath, "utf-8");
    const lines = logContent.trim().split(/\r?\n/);
    const droppedMetadata = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

    assert.equal(droppedMetadata.event, "debug_log_write_failures_dropped");
    assert.equal(droppedMetadata.droppedPayloads, 1);
    assert.equal(droppedMetadata.droppedEntries, 1);
    assert.equal(droppedMetadata.failedAttempts, 2);
    assert.equal(logContent.includes("first payload"), false);
    assert.equal(logContent.includes("second payload"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("All debug-logger tests passed.");
