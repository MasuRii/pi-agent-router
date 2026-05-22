import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_SESSIONS_DIR } from "../constants";

import {
  prepareIsolatedAgentDirectoryAsync,
  resolveExistingWorkingDirectoryAsync,
  resolveSubagentSessionDirectoryAsync,
  tryBuildSessionPathFromHeader,
  resolveSubagentWorkingDirectoryAsync,
} from "../subagent/session-paths";
import { inspectSessionToolCallIntegrity } from "../subagent/session-integrity";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("prepareIsolatedAgentDirectoryAsync rejects empty parent directories", async () => {
  const result = await prepareIsolatedAgentDirectoryAsync("   ");
  assert.deepEqual(result, {
    error: "Failed to prepare isolated agent directory: parent temp directory is empty.",
  });
});

await runTest("prepareIsolatedAgentDirectoryAsync creates an isolated runtime directory", async () => {
  const parentDir = mkdtempSync(join(tmpdir(), "session-paths-isolated-"));

  try {
    const result = await prepareIsolatedAgentDirectoryAsync(parentDir);
    assert.equal("agentDir" in result, true);
    if ("agentDir" in result) {
      assert.equal(result.agentDir.startsWith(parentDir), true);
      if (process.platform !== "win32") {
        assert.equal(statSync(result.agentDir).mode & 0o777, 0o700);
        for (const entry of readdirSync(result.agentDir)) {
          assert.equal(statSync(join(result.agentDir, entry)).mode & 0o777, 0o600);
        }
      }
    }
  } finally {
    rmSync(parentDir, { recursive: true, force: true });
  }
});

await runTest("prepareIsolatedAgentDirectoryAsync does not copy legacy multi-auth runtime files", async () => {
  const parentDir = mkdtempSync(join(tmpdir(), "session-paths-no-multi-auth-copy-"));

  try {
    const result = await prepareIsolatedAgentDirectoryAsync(parentDir);
    assert.equal("agentDir" in result, true);
    if ("agentDir" in result) {
      assert.equal(existsSync(join(result.agentDir, "multi-auth.json")), false);
    }
  } finally {
    rmSync(parentDir, { recursive: true, force: true });
  }
});

await runTest("resolveSubagentSessionDirectoryAsync creates default session directories", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "session-paths-cwd-"));

  try {
    const result = await resolveSubagentSessionDirectoryAsync(cwd);
    assert.equal("sessionDir" in result, true);
    if ("sessionDir" in result) {
      assert.equal(result.sessionDir.includes("subagent-sessions"), true);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

await runTest("resolveExistingWorkingDirectoryAsync falls back when preferred cwd is missing", async () => {
  const fallback = await resolveExistingWorkingDirectoryAsync(join(tmpdir(), "missing-session-paths-dir"));
  assert.equal(fallback.length > 0, true);
});

await runTest("resolveSubagentWorkingDirectoryAsync keeps relative paths within the base cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-paths-working-"));
  const nested = join(root, "nested");
  mkdirSync(nested, { recursive: true });

  try {
    const valid = await resolveSubagentWorkingDirectoryAsync("nested", root);
    assert.deepEqual(valid, { cwd: nested });

    const invalid = await resolveSubagentWorkingDirectoryAsync("../escape", nested);
    assert.equal("error" in invalid, true);
    if ("error" in invalid) {
      assert.equal(invalid.error.includes("relative paths must stay within"), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("resolveSubagentSessionDirectoryAsync respects existing session paths", async () => {
  const root = mkdtempSync(join(SUBAGENT_SESSIONS_DIR, "session-paths-existing-"));
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "2026-02-23T10-12-35-420Z_session-1.jsonl");
  writeFileSync(sessionPath, "", "utf-8");

  try {
    const result = await resolveSubagentSessionDirectoryAsync(root, sessionPath);
    assert.deepEqual(result, { sessionDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("resolveSubagentSessionDirectoryAsync rejects retained paths outside subagent sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-paths-outside-"));
  const sessionPath = join(root, "2026-02-23T10-12-35-420Z_session-1.jsonl");
  writeFileSync(sessionPath, "", "utf-8");

  try {
    const result = await resolveSubagentSessionDirectoryAsync(root, sessionPath);
    assert.equal("error" in result, true);
    if ("error" in result) {
      assert.equal(result.error.includes("path must stay within"), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("tryBuildSessionPathFromHeader rejects unsafe session event identifiers", () => {
  const sessionDir = join(SUBAGENT_SESSIONS_DIR, "--safe-session-events--");
  assert.deepEqual(
    tryBuildSessionPathFromHeader("../escape", "2026-02-23T10:12:35.420Z", "/tmp", sessionDir, {
      requireSubagentSessionRoot: true,
    }),
    { error: "Invalid session event id: expected a safe filename identifier." },
  );

  const valid = tryBuildSessionPathFromHeader(
    "session-1",
    "2026-02-23T10:12:35.420Z",
    "/tmp",
    sessionDir,
    { requireSubagentSessionRoot: true },
  );
  assert.equal("sessionPath" in valid, true);
  if ("sessionPath" in valid) {
    assert.equal(valid.sessionPath.endsWith("2026-02-23T10-12-35-420Z_session-1.jsonl"), true);
  }
});

await runTest("inspectSessionToolCallIntegrity reports pending assistant tool calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-integrity-pending-"));
  const sessionPath = join(root, "session.jsonl");
  const assistantWithToolCall = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_pending", name: "read", arguments: { path: "package.json" } },
      ],
      stopReason: "toolUse",
    },
  };
  writeFileSync(sessionPath, `${JSON.stringify(assistantWithToolCall)}\n`, "utf-8");

  try {
    const result = await inspectSessionToolCallIntegrity(sessionPath);
    assert.equal(result.hasPendingToolCalls, true);
    assert.deepEqual(result.pendingToolCallIds, ["call_pending"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("inspectSessionToolCallIntegrity clears pending calls with matching tool results", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-integrity-resolved-"));
  const sessionPath = join(root, "session.jsonl");
  const assistantWithToolCall = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_resolved", name: "read", arguments: { path: "package.json" } },
      ],
      stopReason: "toolUse",
    },
  };
  const toolResult = {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call_resolved",
      content: [{ type: "text", text: "{}" }],
    },
  };
  writeFileSync(
    sessionPath,
    `${JSON.stringify(assistantWithToolCall)}\n${JSON.stringify(toolResult)}\n`,
    "utf-8",
  );

  try {
    const result = await inspectSessionToolCallIntegrity(sessionPath);
    assert.equal(result.hasPendingToolCalls, false);
    assert.deepEqual(result.pendingToolCallIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("All session-paths tests passed.");
