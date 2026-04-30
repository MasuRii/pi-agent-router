import assert from "node:assert/strict";

import {
  resolveChainContextFromSources,
  validateChainContextFromReferences,
} from "../task/task-chain-mode";
import { validateCurrentBatchContextFromReferences } from "../task/task-context-references";
import { renderTaskContextFromText } from "../task/task-tool-adapter";
import type { TaskContextFromSource } from "../task/task-tool-adapter";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

const chainTasks = [
  { id: "featureTestSeed" },
  { id: "agnosticSanitizerPlan" },
  { id: "consumer" },
];

runTest("resolveChainContextFromSources resolves earlier same-batch chain results by id", () => {
  const completedSources = new Map<string, TaskContextFromSource>([
    [
      "featuretestseed",
      {
        reference: "featureTestSeed",
        taskId: "task-seed",
        sessionId: "session-seed",
        status: "finished",
        outputText: "Final seed result only.",
      },
    ],
  ]);

  const resolved = resolveChainContextFromSources({
    tasks: chainTasks,
    taskIndex: 1,
    references: ["featureTestSeed"],
    completedSourcesByTaskId: completedSources,
    resolveRetainedReference: () => ({
      error: "retained sessions should not be consulted for earlier chain ids",
    }),
    fieldName: "tasks[1].contextFrom",
  });

  assert.equal(resolved.error, undefined);
  assert.equal(resolved.sources.length, 1);
  assert.equal(resolved.sources[0]?.taskId, "task-seed");
  assert.equal(resolved.sources[0]?.outputText, "Final seed result only.");
});

runTest("validateChainContextFromReferences rejects same-item and forward references", () => {
  assert.equal(
    validateChainContextFromReferences({
      tasks: chainTasks,
      referencesByTaskIndex: [[], ["agnosticSanitizerPlan"], []],
    }),
    "Task delegation failed: tasks[1].contextFrom reference 'agnosticSanitizerPlan' cannot reference the same chain task.",
  );

  assert.equal(
    validateChainContextFromReferences({
      tasks: chainTasks,
      referencesByTaskIndex: [["consumer"], [], []],
    }),
    "Task delegation failed: tasks[0].contextFrom reference 'consumer' points to a later chain task; contextFrom can only reference earlier completed chain tasks or retained delegated sessions.",
  );
});

runTest("validateCurrentBatchContextFromReferences rejects non-chain same-batch refs", () => {
  assert.equal(
    validateCurrentBatchContextFromReferences({
      tasks: chainTasks,
      references: ["consumer"],
      fieldName: "contextFrom",
      scope: "top-level",
    }),
    "Task delegation failed: contextFrom reference 'consumer' matches current batch task 'consumer'. Top-level contextFrom only accepts retained delegated sessions; use per-task contextFrom in mode=\"chain\" for earlier same-batch results.",
  );

  assert.equal(
    validateCurrentBatchContextFromReferences({
      tasks: chainTasks,
      references: ["agnosticSanitizerPlan"],
      fieldName: "tasks[1].contextFrom",
      scope: "parallel-task",
    }),
    "Task delegation failed: tasks[1].contextFrom reference 'agnosticSanitizerPlan' matches current batch task 'agnosticSanitizerPlan'. Parallel tasks cannot read same-batch results; use mode=\"chain\" with an earlier task id, or reference a retained delegated session.",
  );

  assert.equal(
    validateCurrentBatchContextFromReferences({
      tasks: chainTasks,
      references: ["retained-session-id"],
      fieldName: "tasks[1].contextFrom",
      scope: "parallel-task",
    }),
    undefined,
  );
});

runTest("resolveChainContextFromSources preserves retained-session contextFrom references", () => {
  const retainedSource: TaskContextFromSource = {
    reference: "previous-session",
    taskId: "task-previous",
    sessionId: "session-previous",
    status: "finished",
    outputText: "Retained final result.",
  };
  const resolved = resolveChainContextFromSources({
    tasks: chainTasks,
    taskIndex: 1,
    references: ["previous-session"],
    completedSourcesByTaskId: new Map(),
    resolveRetainedReference: (reference) => ({
      source: { ...retainedSource, reference },
    }),
    fieldName: "tasks[1].contextFrom",
  });

  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.sources, [retainedSource]);
});

runTest("rendered chain contextFrom handoff contains final result only", () => {
  const completedSources = new Map<string, TaskContextFromSource>([
    [
      "featuretestseed",
      {
        reference: "featureTestSeed",
        taskId: "task-seed",
        sessionId: "session-seed",
        status: "finished",
        outputText: [
          "Earlier streamed transcript.",
          "→ read hidden.txt",
          "",
          "Final response handoff.",
        ].join("\n"),
      },
    ],
  ]);
  const resolved = resolveChainContextFromSources({
    tasks: chainTasks,
    taskIndex: 2,
    references: ["featureTestSeed"],
    completedSourcesByTaskId: completedSources,
    resolveRetainedReference: () => ({ error: "unexpected retained lookup" }),
    fieldName: "tasks[2].contextFrom",
  });
  const contextText = renderTaskContextFromText(resolved.sources);

  assert.equal(resolved.error, undefined);
  assert.equal(contextText?.includes("Final response handoff."), true);
  assert.equal(contextText?.includes("Earlier streamed transcript."), false);
  assert.equal(contextText?.includes("hidden.txt"), false);
  assert.equal(contextText?.includes("→"), false);
});

console.log("All task chain mode tests passed.");
