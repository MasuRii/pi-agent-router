import assert from "node:assert/strict";

import { SUBAGENT_DEFAULT_TIMEOUT_MS, SUBAGENT_MAX_CONCURRENCY } from "../constants";
import { resolveTaskControls } from "../task/task-controls";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

runTest("resolveTaskControls accepts valid environment overrides", () => {
  withEnv(
    {
      PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: "3",
      PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: "2400000",
      PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: "strict",
    },
    () => {
      const { controls, warnings } = resolveTaskControls(process.cwd());
      assert.equal(controls.maxConcurrency, 3);
      assert.equal(controls.defaultTimeoutMs, 2400000);
      assert.equal(controls.outputStrictness, "strict");
      assert.equal(warnings.length, 0);
    },
  );
});

runTest("resolveTaskControls falls back with validation warnings for invalid overrides", () => {
  withEnv(
    {
      PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: "0",
      PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: "5000",
      PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: "invalid",
    },
    () => {
      const { controls, warnings } = resolveTaskControls(process.cwd());
      assert.equal(controls.maxConcurrency, SUBAGENT_MAX_CONCURRENCY);
      assert.equal(controls.defaultTimeoutMs, SUBAGENT_DEFAULT_TIMEOUT_MS);
      assert.equal(controls.outputStrictness, "compat");
      assert.equal(warnings.length >= 1, true);
    },
  );
});

console.log("All task-controls tests passed.");
