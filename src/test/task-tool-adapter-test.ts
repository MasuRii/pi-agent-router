import assert from "node:assert/strict";

import { TASK_HISTORY_EXCERPT_MAX_CHARS } from "../constants";
import {
  isTaskBatchItem,
  renderTaskBatchPrompt,
  renderTaskBatchSummary,
  validateTaskBatchItems,
  type TaskBatchItemInput,
} from "../task/task-tool-adapter";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("isTaskBatchItem detects valid task-style objects", () => {
  assert.equal(
    isTaskBatchItem({
      id: "TaskOne",
      description: "Update API usage",
      assignment: "Do the migration.",
    }),
    true,
  );
  assert.equal(
    isTaskBatchItem({ id: "TaskOne", description: "Missing assignment" }),
    false,
  );
});

runTest("validateTaskBatchItems enforces unique non-empty ids", () => {
  const validItems: TaskBatchItemInput[] = [
    { id: "TaskA", description: "A", assignment: "Do A", agent: "code" },
    { id: "TaskB", description: "B", assignment: "Do B", agent: "debug" },
  ];
  assert.equal(validateTaskBatchItems(validItems), undefined);

  const duplicateItems: TaskBatchItemInput[] = [
    { id: "TaskA", description: "A", assignment: "Do A", agent: "code" },
    { id: "taska", description: "B", assignment: "Do B", agent: "debug" },
  ];
  assert.equal(
    validateTaskBatchItems(duplicateItems)?.includes("duplicate task id"),
    true,
  );
});

runTest(
  "renderTaskBatchPrompt includes context, schema, and assignment sections",
  () => {
    const prompt = renderTaskBatchPrompt({
      context: "Shared goal and constraints",
      assignment: "Implement the changes and verify behavior.",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      taskId: "TaskOne",
      description: "Migrate endpoint",
      skills: ["api-design-principles", "nestjs-best-practices"],
    });

    assert.equal(prompt.includes("Background"), true);
    assert.equal(prompt.includes("Task ID: TaskOne"), true);
    assert.equal(
      prompt.includes(
        "Suggested Skills: api-design-principles, nestjs-best-practices",
      ),
      true,
    );
    assert.equal(prompt.includes("Optional Structured Output Schema (JSON, submit_result only):"), true);
    assert.equal(
      prompt.includes(
        "Keep the normal human-facing TASK COMPLETION REPORT unless the assignment explicitly requires machine-readable output.",
      ),
      true,
    );
    assert.equal(prompt.includes("Assignment:"), true);
  },
);

runTest("renderTaskBatchSummary renders task-summary envelope", () => {
  const summary = renderTaskBatchSummary({
    total: 2,
    succeeded: 1,
    failed: 1,
    durationMs: 4200,
    items: [
      {
        id: "TaskOne",
        description: "First task",
        agent: "code",
        status: "completed",
        output: "Done",
      },
      {
        id: "TaskTwo",
        description: "Second task",
        agent: "debug",
        status: "failed",
        error: "Missing file",
      },
    ],
  });

  assert.equal(summary.includes("<task-summary>"), true);
  assert.equal(summary.includes('<task id="TaskOne" agent="code">'), true);
  assert.equal(summary.includes("Missing file"), true);
});

runTest(
  "renderTaskBatchSummary bounds oversized delegated output for stored history",
  () => {
    const longOutput = [
      "## Summary",
      "Completed the long-running task successfully.",
      "",
      "Trace:",
      "A".repeat(TASK_HISTORY_EXCERPT_MAX_CHARS + 512),
      "Tail marker",
    ].join("\n");
    const summary = renderTaskBatchSummary({
      total: 1,
      succeeded: 1,
      failed: 0,
      durationMs: 1000,
      items: [
        {
          id: "TaskLong",
          description: "Long output task",
          agent: "code",
          status: "completed",
          output: longOutput,
        },
      ],
    });

    assert.equal(
      summary.includes("Completed the long-running task successfully."),
      true,
    );
    assert.equal(
      summary.includes("Earlier output truncated for stored history"),
      true,
    );
    assert.equal(summary.includes("Tail marker"), true);
    assert.equal(summary.includes(longOutput), false);
  },
);

runTest("renderTaskBatchSummary escapes XML-sensitive text", () => {
  const summary = renderTaskBatchSummary({
    total: 1,
    succeeded: 1,
    failed: 0,
    durationMs: 1000,
    items: [
      {
        id: 'Task<"A">',
        description: "Result includes XML-sensitive symbols",
        agent: "code&debug",
        status: "completed",
        output: "<task_result>ok & done</task_result>",
      },
    ],
  });

  assert.equal(summary.includes('id="Task&lt;&quot;A&quot;&gt;"'), true);
  assert.equal(summary.includes('agent="code&amp;debug"'), true);
  assert.equal(summary.includes("ok &amp; done"), true);
});

console.log("All task-tool adapter tests passed.");
