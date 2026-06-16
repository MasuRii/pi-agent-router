import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubagentTaskRegistryEntry } from "../types";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-router-registry-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
  appendPersistedTaskRegistryEntry,
  loadPersistedTaskRegistryEntries,
  writePersistedTaskRegistry,
} = await import("../task/task-registry-persistence");

const registryDir = join(agentDir, "subagent-sessions");
const registryPath = join(registryDir, ".task-registry.jsonl");

function makeEntry(overrides: Partial<SubagentTaskRegistryEntry> = {}): SubagentTaskRegistryEntry {
  return {
    taskId: "task-1",
    logicalTaskId: "TaskOne",
    sessionPath: "/sessions/task-1",
    parentSessionId: "parent-1",
    delegatedBy: "orchestrator",
    agent: "code",
    cwd: "/repo",
    status: "finished",
    createdAt: 1_000,
    updatedAt: 2_000,
    runCount: 1,
    childSessionIds: ["session-1"],
    lastTask: "Do task one",
    lastFinalResponseText: "Final task response.",
    ...overrides,
  };
}

try {
  runTest("writePersistedTaskRegistry writes atomically loadable snapshots", () => {
    writePersistedTaskRegistry([
      makeEntry(),
      makeEntry({ taskId: "task-2", logicalTaskId: "TaskTwo", childSessionIds: ["session-2"] }),
    ]);

    const loaded = loadPersistedTaskRegistryEntries();

    assert.deepEqual(
      loaded.map((entry) => [entry.taskId, entry.logicalTaskId, entry.childSessionIds]),
      [
        ["task-1", "TaskOne", ["session-1"]],
        ["task-2", "TaskTwo", ["session-2"]],
      ],
    );
    assert.equal(readdirSync(registryDir).some((entry) => entry.endsWith(".tmp")), false);
  });

  runTest("loadPersistedTaskRegistryEntries skips corrupt lines and sanitizes shapes", () => {
    writeFileSync(
      registryPath,
      [
        "{not json}",
        JSON.stringify({ taskId: "missing-status" }),
        JSON.stringify({
          taskId: "valid",
          status: "finished",
          createdAt: "bad",
          updatedAt: 5_000,
          runCount: -10,
          childSessionIds: ["session-ok", 123, null],
          parentSessionId: 42,
          delegatedBy: "orchestrator",
          agent: "code",
          cwd: "/repo",
          lastTask: "Valid task",
          lastOutputFormat: "invalid",
          lastOutputSource: "assistant_output",
          lastOutput: "Safe retained output.",
        }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const loaded = loadPersistedTaskRegistryEntries();

    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], {
      taskId: "valid",
      logicalTaskId: undefined,
      sessionPath: undefined,
      parentSessionId: "",
      delegatedBy: "orchestrator",
      agent: "code",
      cwd: "/repo",
      status: "finished",
      createdAt: 0,
      updatedAt: 5_000,
      runCount: 0,
      childSessionIds: ["session-ok"],
      lastTask: "Valid task",
      lastOutput: "Safe retained output.",
      lastFinalResponseText: undefined,
      lastStructuredResult: undefined,
      lastError: undefined,
      lastExitCode: undefined,
      lastTimedOut: undefined,
      lastDismissedAt: undefined,
      usage: undefined,
      lastOutputSource: "assistant_output",
    });
  });

  runTest("appendPersistedTaskRegistryEntry preserves last-write-wins semantics", () => {
    writePersistedTaskRegistry([makeEntry({ taskId: "task-dupe", lastFinalResponseText: "old" })]);
    appendPersistedTaskRegistryEntry(makeEntry({ taskId: "task-dupe", lastFinalResponseText: "new" }));

    const loaded = loadPersistedTaskRegistryEntries();

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.lastFinalResponseText, "new");
    assert.equal(readFileSync(registryPath, "utf-8").trim().split(/\r?\n/).length, 2);
  });

  console.log("All task registry persistence tests passed.");
} finally {
  if (existsSync(agentDir)) {
    rmSync(agentDir, { recursive: true, force: true });
  }
}
