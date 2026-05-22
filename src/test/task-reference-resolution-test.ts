import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createTaskReferenceResolver,
  type TaskReferenceResolverState,
} from "../task/task-reference-resolution";
import type { SubagentSession, SubagentTaskRegistryEntry } from "../types";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function makeRegistryEntry(
  overrides: Partial<SubagentTaskRegistryEntry> = {},
): SubagentTaskRegistryEntry {
  return {
    taskId: "task-1",
    logicalTaskId: "TaskOne",
    parentSessionId: "parent-1",
    delegatedBy: "orchestrator",
    agent: "code",
    cwd: "/repo",
    status: "finished",
    createdAt: 1_000,
    updatedAt: 2_000,
    runCount: 1,
    childSessionIds: [],
    lastTask: "Do task one",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SubagentSession> = {}): SubagentSession {
  return {
    id: "session-1",
    taskId: "task-1",
    logicalTaskId: "TaskOne",
    sessionPath: "/sessions/session-1",
    parentSessionId: "parent-1",
    delegatedBy: "orchestrator",
    agent: "code",
    task: "Do task one",
    cwd: "/repo",
    status: "finished",
    startedAt: 1_000,
    finishedAt: 2_000,
    stderr: "",
    ...overrides,
  };
}

function createState(options: {
  sessions?: SubagentSession[];
  registryEntries?: SubagentTaskRegistryEntry[];
} = {}): TaskReferenceResolverState {
  return {
    subagentSessions: new Map((options.sessions || []).map((session) => [session.id, session])),
    subagentTaskRegistry: new Map((options.registryEntries || []).map((entry) => [entry.taskId, entry])),
  };
}

function createHistoryContext(entries: readonly unknown[]): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
}

runTest("resolveContextFromText resolves retained registry output by logical task id", () => {
  const resolver = createTaskReferenceResolver(createState({
    registryEntries: [
      makeRegistryEntry({
        taskId: "task-alpha",
        logicalTaskId: "AlphaPlan",
        sessionPath: "/sessions/alpha",
        lastFinalResponseText: "Final alpha plan only.",
      }),
    ],
  }));

  const resolved = resolver.resolveContextFromText(["AlphaPlan"], "parent-1", "contextFrom");

  assert.equal(resolved.error, undefined);
  assert.equal(resolved.text?.includes("Previous delegated final results supplied via contextFrom:"), true);
  assert.equal(resolved.text?.includes("Final alpha plan only."), true);
});

runTest("hydrateRecoveredTaskReferencesFromSessionHistory enables retained task-summary references", () => {
  const resolver = createTaskReferenceResolver(createState());
  const ctx = createHistoryContext([
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: [
              '<task-summary total="1">',
              '<task id="HistoryTask" agent="code">',
              '<status>finished</status>',
              '<session>history-session</session>',
              '<result>Recovered final response.</result>',
              '</task>',
              '</task-summary>',
            ].join("\n"),
          },
        ],
      },
    },
  ]);

  resolver.hydrateRecoveredTaskReferencesFromSessionHistory(ctx, "parent-1");
  const resolved = resolver.resolveContextFromText(["HistoryTask"], "parent-1", "contextFrom");

  assert.equal(resolved.error, undefined);
  assert.equal(resolved.text?.includes("Recovered final response."), true);
});

runTest("resolveRetainedContextFromSource rejects running retained references", () => {
  const resolver = createTaskReferenceResolver(createState({
    sessions: [
      makeSession({
        id: "running-session",
        taskId: "running-task",
        logicalTaskId: "RunningTask",
        status: "running",
      }),
    ],
  }));

  const resolved = resolver.resolveRetainedContextFromSource(
    "RunningTask",
    "parent-1",
    "tasks[0].contextFrom",
  );

  assert.equal(
    resolved.error,
    "Task delegation failed: tasks[0].contextFrom reference 'RunningTask' is not available because the delegated session is running.",
  );
});

runTest("resolveTaskReference reports ambiguous partial references", () => {
  const resolver = createTaskReferenceResolver(createState({
    registryEntries: [
      makeRegistryEntry({ taskId: "alpha-task", logicalTaskId: "AlphaTask" }),
      makeRegistryEntry({ taskId: "alpine-task", logicalTaskId: "AlpineTask" }),
    ],
  }));

  const resolved = resolver.resolveTaskReference("alp", "parent-1", "contextFrom");

  assert.match(resolved.error || "", /is ambiguous/);
  assert.match(resolved.error || "", /Use a full taskId or sessionId/);
});

runTest("resolveImplicitDismissedRetryReference resumes most recently dismissed retained session", () => {
  const resolver = createTaskReferenceResolver(createState({
    sessions: [
      makeSession({
        id: "older-session",
        taskId: "older-task",
        logicalTaskId: "RetryTask",
        sessionPath: "/sessions/older",
        dismissed: true,
        finishedAt: 5_000,
      }),
      makeSession({
        id: "newer-session",
        taskId: "newer-task",
        logicalTaskId: "RetryTask",
        sessionPath: "/sessions/newer",
        dismissed: true,
        finishedAt: 6_000,
      }),
    ],
  }));

  const resolved = resolver.resolveImplicitDismissedRetryReference("RetryTask", "parent-1");

  assert.deepEqual(resolved, {
    taskId: "newer-task",
    sessionPath: "/sessions/newer",
    autoResumed: true,
  });
});

runTest("resolveRetryReference rejects retained references without session paths", () => {
  const resolver = createTaskReferenceResolver(createState({
    registryEntries: [makeRegistryEntry({ sessionPath: undefined })],
  }));

  const resolved = resolver.resolveRetryReference("TaskOne", "parent-1", "tasks[0].retry");

  assert.equal(
    resolved.error,
    "Task delegation failed: tasks[0].retry reference 'TaskOne' cannot be retried because no retained session path is available.",
  );
});

console.log("All task reference resolution tests passed.");
