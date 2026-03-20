import assert from "node:assert/strict";

import {
  clearStaleSubagentSessionsForNewSession,
  clearSubagentSessionsForParentShutdown,
  listVisibleSubagentSessions,
} from "../subagent/subagent-session-state";
import type { SubagentSession } from "../types";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function createSession(overrides: Partial<SubagentSession>): SubagentSession {
  return {
    id: overrides.id ?? "session-id",
    taskId: overrides.taskId ?? "task-id",
    parentSessionId: overrides.parentSessionId ?? "parent-a",
    delegatedBy: overrides.delegatedBy ?? "code",
    agent: overrides.agent ?? "code",
    task: overrides.task ?? "Do work",
    cwd: overrides.cwd ?? "/tmp",
    status: overrides.status ?? "finished",
    startedAt: overrides.startedAt ?? 0,
    stderr: overrides.stderr ?? "",
    ...overrides,
  };
}

runTest("listVisibleSubagentSessions filters to the active parent session and hides dismissed entries", () => {
  const sessions = [
    createSession({ id: "finished-current", parentSessionId: "current", status: "finished", startedAt: 100 }),
    createSession({ id: "running-current", parentSessionId: "current", status: "running", startedAt: 200 }),
    createSession({ id: "queued-current", parentSessionId: "current", status: "queued", startedAt: 300 }),
    createSession({ id: "running-other", parentSessionId: "other", status: "running", startedAt: 400 }),
    createSession({ id: "dismissed-current", parentSessionId: "current", status: "running", dismissed: true, startedAt: 500 }),
  ];

  const visibleSessions = listVisibleSubagentSessions(sessions, "current");

  assert.deepEqual(
    visibleSessions.map((session) => session.id),
    ["running-current", "queued-current", "finished-current"],
  );
});

runTest("clearStaleSubagentSessionsForNewSession preserves active work from other parent sessions", () => {
  const staleRunning = createSession({ id: "stale-running", parentSessionId: "old", status: "running", startedAt: 50 });
  const staleQueued = createSession({ id: "stale-queued", parentSessionId: "old", status: "queued", startedAt: 60 });
  const staleFinished = createSession({ id: "stale-finished", parentSessionId: "old", status: "finished", startedAt: 10 });
  const currentRunning = createSession({ id: "current-running", parentSessionId: "current", status: "running", startedAt: 100 });

  const sessionsById = new Map<string, SubagentSession>([
    [staleRunning.id, staleRunning],
    [staleQueued.id, staleQueued],
    [staleFinished.id, staleFinished],
    [currentRunning.id, currentRunning],
  ]);
  const cleaned: string[] = [];

  const result = clearStaleSubagentSessionsForNewSession(sessionsById, "current", {
    cleanupSessionArtifacts: (session) => {
      cleaned.push(session.id);
    },
  });

  assert.deepEqual(result, { removedCount: 1, retainedActiveCount: 2 });
  assert.deepEqual(cleaned, ["stale-finished"]);
  assert.equal(sessionsById.has("stale-finished"), false);
  assert.equal(sessionsById.has("stale-running"), true);
  assert.equal(sessionsById.has("stale-queued"), true);
  assert.equal(staleRunning.dismissed, undefined);
  assert.equal(staleQueued.dismissed, undefined);
});

runTest("new session visibility excludes other-parent sessions without deleting their active indicators", () => {
  const staleRunning = createSession({ id: "stale-running", parentSessionId: "old", status: "running", startedAt: 50 });
  const currentRunning = createSession({ id: "current-running", parentSessionId: "current", status: "running", startedAt: 100 });
  const currentFinished = createSession({ id: "current-finished", parentSessionId: "current", status: "finished", startedAt: 20 });

  const sessionsById = new Map<string, SubagentSession>([
    [staleRunning.id, staleRunning],
    [currentRunning.id, currentRunning],
    [currentFinished.id, currentFinished],
  ]);

  clearStaleSubagentSessionsForNewSession(sessionsById, "current", {
    cleanupSessionArtifacts: () => {
      throw new Error("cleanup should not run for active cross-session work");
    },
  });

  assert.deepEqual(
    listVisibleSubagentSessions(sessionsById.values(), "current").map((session) => session.id),
    ["current-running", "current-finished"],
  );
  assert.deepEqual(
    listVisibleSubagentSessions(sessionsById.values(), "old").map((session) => session.id),
    ["stale-running"],
  );
});

runTest("clearSubagentSessionsForParentShutdown only targets the shutting-down parent session", () => {
  const currentRunning = createSession({ id: "current-running", parentSessionId: "current", status: "running", startedAt: 100 });
  const currentFinished = createSession({ id: "current-finished", parentSessionId: "current", status: "finished", startedAt: 80 });
  const otherRunning = createSession({ id: "other-running", parentSessionId: "other", status: "running", startedAt: 120 });
  const otherFinished = createSession({ id: "other-finished", parentSessionId: "other", status: "finished", startedAt: 40 });

  const sessionsById = new Map<string, SubagentSession>([
    [currentRunning.id, currentRunning],
    [currentFinished.id, currentFinished],
    [otherRunning.id, otherRunning],
    [otherFinished.id, otherFinished],
  ]);
  const cleaned: string[] = [];

  const result = clearSubagentSessionsForParentShutdown(sessionsById, "current", {
    cleanupSessionArtifacts: (session) => {
      cleaned.push(session.id);
    },
  });

  assert.deepEqual(result, {
    removedCount: 1,
    terminatedSessionIds: ["current-running"],
  });
  assert.deepEqual(cleaned, ["current-finished"]);
  assert.equal(sessionsById.has("current-running"), true);
  assert.equal(sessionsById.has("current-finished"), false);
  assert.equal(sessionsById.has("other-running"), true);
  assert.equal(sessionsById.has("other-finished"), true);
  assert.deepEqual(
    listVisibleSubagentSessions(sessionsById.values(), "other").map((session) => session.id),
    ["other-running", "other-finished"],
  );
});

console.log("All subagent session state tests passed.");
