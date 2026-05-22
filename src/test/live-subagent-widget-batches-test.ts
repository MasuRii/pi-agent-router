import assert from "node:assert/strict";

import { createLiveSubagentWidgetBatchTracker } from "../subagent/live-subagent-widget-batches";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("live widget batches report queued sessions for the active parent only", () => {
  const renderRequests: boolean[] = [];
  let activeParentSessionId = "parent-a";
  const tracker = createLiveSubagentWidgetBatchTracker({
    requestRender: (immediate = true) => {
      renderRequests.push(immediate);
    },
    getActiveParentSessionId: () => activeParentSessionId,
  });

  tracker.registerBatch("batch-a", "parent-a", 3.8);
  tracker.trackSession("batch-a", "session-a");
  tracker.trackSession("batch-a", "session-b");

  assert.deepEqual(renderRequests, [true, false, false]);
  assert.equal(tracker.resolveTotalCount([{ id: "session-a" }]), 3);
  assert.equal(tracker.resolveTotalCount([{ id: "session-a" }, { id: "other-session" }]), 4);

  activeParentSessionId = "parent-b";
  assert.equal(tracker.resolveTotalCount([{ id: "session-a" }]), undefined);

  tracker.registerBatch("batch-b", "parent-b", 2);
  assert.equal(tracker.resolveTotalCount([]), 2);
});

runTest("live widget batches preserve render invalidation semantics", () => {
  const renderRequests: boolean[] = [];
  const tracker = createLiveSubagentWidgetBatchTracker({
    requestRender: (immediate = true) => {
      renderRequests.push(immediate);
    },
    getActiveParentSessionId: () => "",
  });

  tracker.trackSession("missing", "session-a");
  tracker.clearBatch("missing");
  assert.deepEqual(renderRequests, []);

  tracker.registerBatch("batch", "parent", -1);
  assert.equal(tracker.resolveTotalCount([]), undefined);

  tracker.registerBatch("batch", "parent", 1);
  tracker.trackSession("batch", "session-a");
  tracker.trackSession("batch", "session-a");
  tracker.clearBatch("batch");
  tracker.clearBatch("batch");

  assert.deepEqual(renderRequests, [true, true, false, false, true]);
  assert.equal(tracker.resolveTotalCount([{ id: "session-a" }]), undefined);
});

console.log("All live subagent widget batch tests passed.");
