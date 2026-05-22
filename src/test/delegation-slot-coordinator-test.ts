import assert from "node:assert/strict";

import {
  createDelegationSlotCoordinator,
  ROUTER_DELEGATION_RESET_MESSAGE,
  ROUTER_SHUTDOWN_ABORT_MESSAGE,
} from "../subagent/delegation-slot-coordinator";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("delegation slot coordinator resumes queued work in FIFO order", async () => {
  const coordinator = createDelegationSlotCoordinator();

  assert.deepEqual(await coordinator.acquireSlot(undefined, 1), { queued: false });

  const queued: string[] = [];
  const firstQueued = coordinator.acquireSlot(undefined, 1).then((result) => {
    queued.push(`first:${result.queued}`);
  });
  const secondQueued = coordinator.acquireSlot(undefined, 1).then((result) => {
    queued.push(`second:${result.queued}`);
  });

  await Promise.resolve();
  assert.deepEqual(queued, []);

  coordinator.releaseSlot();
  await firstQueued;
  assert.deepEqual(queued, ["first:true"]);

  coordinator.releaseSlot();
  await secondQueued;
  assert.deepEqual(queued, ["first:true", "second:true"]);
});

await runTest("delegation slot coordinator removes aborted queued requests", async () => {
  const coordinator = createDelegationSlotCoordinator();
  const abortController = new AbortController();

  assert.deepEqual(await coordinator.acquireSlot(undefined, 1), { queued: false });
  const abortedRequest = coordinator.acquireSlot(abortController.signal, 1);
  const survivingRequest = coordinator.acquireSlot(undefined, 1);

  abortController.abort();
  await assert.rejects(
    abortedRequest,
    /Delegation request was aborted while waiting for an available slot\./,
  );

  coordinator.releaseSlot();
  assert.deepEqual(await survivingRequest, { queued: true });
});

await runTest("delegation slot coordinator rejects queued and future work during shutdown", async () => {
  const coordinator = createDelegationSlotCoordinator();

  assert.deepEqual(await coordinator.acquireSlot(undefined, 1), { queued: false });
  const queuedRequest = coordinator.acquireSlot(undefined, 1);

  coordinator.setShutdownInProgress(true);
  assert.equal(coordinator.cancelQueuedDelegations(ROUTER_SHUTDOWN_ABORT_MESSAGE), 1);
  await assert.rejects(queuedRequest, /pi-agent-router is shutting down/);
  await assert.rejects(
    coordinator.acquireSlot(undefined, 1),
    /pi-agent-router is shutting down/,
  );
});

await runTest("delegation slot coordinator reset clears active slots and cancels queue", async () => {
  const coordinator = createDelegationSlotCoordinator();

  assert.deepEqual(await coordinator.acquireSlot(undefined, 1), { queued: false });
  const queuedRequest = coordinator.acquireSlot(undefined, 1);

  assert.equal(coordinator.reset(ROUTER_DELEGATION_RESET_MESSAGE), 1);
  await assert.rejects(queuedRequest, /reset its delegation state/);

  assert.deepEqual(await coordinator.acquireSlot(undefined, 1), { queued: false });
});

console.log("All delegation slot coordinator tests passed.");
