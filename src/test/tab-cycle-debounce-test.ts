import assert from "node:assert/strict";

import { LINUX_TAB_CYCLE_DEBOUNCE_MS } from "../constants";
import { resolveTabCycleDebounceMs, shouldConsumeTabCycleInput } from "../tab-cycle-debounce";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("tab-cycle debounce applies only on Linux", () => {
  assert.equal(resolveTabCycleDebounceMs("linux"), LINUX_TAB_CYCLE_DEBOUNCE_MS);
  assert.equal(resolveTabCycleDebounceMs("win32"), 0);
  assert.equal(resolveTabCycleDebounceMs("darwin"), 0);
});

runTest("tab-cycle debounce consumes only events inside the debounce window", () => {
  assert.equal(shouldConsumeTabCycleInput(1_100, 1_000, LINUX_TAB_CYCLE_DEBOUNCE_MS), true);
  assert.equal(shouldConsumeTabCycleInput(1_200, 1_000, LINUX_TAB_CYCLE_DEBOUNCE_MS), false);
  assert.equal(shouldConsumeTabCycleInput(1_100, 1_000, 0), false);
});
