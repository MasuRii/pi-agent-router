import assert from "node:assert/strict";

import {
  findInvalidTaskDelegationIndex,
  findUnknownTaskAgents,
  formatUnknownTaskAgentsLabel,
  getQueuedDelegationLabel,
  normalizeTaskDelegations,
} from "../task/task-execution-validation";
import type { Agent, SubagentTaskItemInput, TaskStyleDelegationItem } from "../types";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("normalizeTaskDelegations trims executable task fields and carries task metadata", () => {
  const providedTasks: SubagentTaskItemInput[] = [
    { agent: " code ", task: " Do work ", cwd: " /tmp/project " },
  ];
  const taskStyleMetadata: TaskStyleDelegationItem[] = [
    {
      id: "task-1",
      description: "Implement seam",
      assignment: "Do work",
      skills: ["typescript"],
      agent: "code",
      retry: true,
      retryFrom: "prior-task",
    },
  ];

  assert.deepEqual(
    normalizeTaskDelegations({
      providedTasks,
      taskStyleMetadata,
      contextFromReferencesByIndex: [["upstream"]],
    }),
    [
      {
        agent: "code",
        task: "Do work",
        cwd: "/tmp/project",
        taskLabel: "task-1",
        taskDescription: "Implement seam",
        assignment: "Do work",
        skills: ["typescript"],
        contextFromReferences: ["upstream"],
        retry: true,
        retryFrom: "prior-task",
      },
    ],
  );
});

runTest("task delegation validation helpers preserve queued labels and error ordering", () => {
  assert.equal(getQueuedDelegationLabel("chain", 1), "Chain delegation");
  assert.equal(getQueuedDelegationLabel("parallel", 1), "Task delegation");
  assert.equal(getQueuedDelegationLabel("parallel", 2), "Parallel delegation");

  assert.equal(
    findInvalidTaskDelegationIndex([
      { agent: "code", task: "ok" },
      { agent: "", task: "missing agent" },
    ]),
    1,
  );
});

runTest("findUnknownTaskAgents dedupes unknown delegated agents in first-seen order", () => {
  const availableAgents: Agent[] = [
    { name: "code", description: "Code", systemPrompt: "" } as Agent,
    { name: "ask", description: "Ask", systemPrompt: "" } as Agent,
  ];

  const unknownAgents = findUnknownTaskAgents(
    [
      { agent: "architect" },
      { agent: "code" },
      { agent: "architect" },
      { agent: "debug" },
    ],
    availableAgents,
  );

  assert.deepEqual(unknownAgents, ["architect", "debug"]);
  assert.equal(formatUnknownTaskAgentsLabel(["architect"]), "Unknown agent: architect");
  assert.equal(
    formatUnknownTaskAgentsLabel(unknownAgents),
    "Unknown agents: architect, debug",
  );
});

console.log("All task execution validation tests passed.");
