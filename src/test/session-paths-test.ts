import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareIsolatedAgentDirectoryAsync,
  resolveExistingWorkingDirectoryAsync,
  resolveSubagentSessionDirectoryAsync,
  resolveSubagentWorkingDirectoryAsync,
} from "../subagent/session-paths";

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
  const root = mkdtempSync(join(tmpdir(), "session-paths-existing-"));
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "session.jsonl");
  writeFileSync(sessionPath, "", "utf-8");

  try {
    const result = await resolveSubagentSessionDirectoryAsync(root, sessionPath);
    assert.deepEqual(result, { sessionDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("All session-paths tests passed.");
