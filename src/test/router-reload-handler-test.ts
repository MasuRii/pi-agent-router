import assert from "node:assert/strict";

import {
  ROUTER_RELOAD_EVENT_NAME,
  registerRouterReloadHandler,
  shouldInvalidateRouterReloadCaches,
} from "../router-reload-handler";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("router reload predicate only accepts reload resource discovery events", () => {
  assert.equal(shouldInvalidateRouterReloadCaches({ reason: "reload" }), true);
  assert.equal(shouldInvalidateRouterReloadCaches({ reason: "startup" }), false);
  assert.equal(shouldInvalidateRouterReloadCaches(undefined), false);
});

await runTest("router reload handler registers resources_discover and invalidates on reload", async () => {
  let registeredName = "";
  let registeredHandler: ((event: { reason?: string }) => Promise<void> | void) | undefined;
  let invalidations = 0;

  registerRouterReloadHandler(
    {
      on(name: string, handler: (event: { reason?: string }) => Promise<void> | void): void {
        registeredName = name;
        registeredHandler = handler;
      },
    } as never,
    () => {
      invalidations += 1;
    },
  );

  assert.equal(registeredName, ROUTER_RELOAD_EVENT_NAME);
  assert.equal(typeof registeredHandler, "function");

  await registeredHandler?.({ reason: "startup" });
  assert.equal(invalidations, 0);

  await registeredHandler?.({ reason: "reload" });
  assert.equal(invalidations, 1);
});

console.log("All router reload handler tests passed.");
