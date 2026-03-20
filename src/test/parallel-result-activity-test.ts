import assert from "node:assert/strict";

import { buildParallelResultActivity } from "../task/parallel-result-activity";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("partial finished updates show stable status instead of leaking final summary", () => {
  const activity = buildParallelResultActivity({
    status: "finished",
    latestToolCall: "read index.ts",
    output: "Final answer: secret implementation details.",
    resultSummary: "secret implementation details",
    isPartial: true,
  });

  assert.equal(activity, "Completed");
  assert.equal(activity.includes("secret"), false);
  assert.equal(activity.includes("Read index.ts"), false);
});

runTest("partial failed updates suppress error summaries during progress rendering", () => {
  const activity = buildParallelResultActivity({
    status: "failed",
    output: "Traceback: sensitive stack details",
    resultSummary: "sensitive stack details",
    isPartial: true,
  });

  assert.equal(activity, "Failed");
  assert.equal(activity.includes("sensitive"), false);
});

runTest("running updates still surface the latest tool activity", () => {
  const activity = buildParallelResultActivity({
    status: "running",
    latestToolCall: "grep delegated-task src",
    output: "→ grep delegated-task src",
    isPartial: true,
  });

  assert.equal(activity, "Grep delegated-task src");
});

runTest("final finished rendering still shows result summaries when no activity is available", () => {
  const activity = buildParallelResultActivity({
    status: "finished",
    output: "Completed all tasks successfully.",
    resultSummary: "Completed all tasks successfully.",
    isPartial: false,
  });

  assert.equal(activity, "Result Completed all tasks successfully.");
});

console.log("All parallel result activity tests passed.");
