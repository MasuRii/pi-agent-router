import assert from "node:assert/strict";

import {
  PI_DELEGATED_AUTH_RUNTIME_DIR_ENV,
  PI_MODEL_DISCOVERY_CACHE_ONLY_ENV,
  PI_AGENT_ROUTER_PARENT_SESSION_ID_ENV,
  PI_AGENT_ROUTER_SUBAGENT_ENV,
  buildSubagentSpawnEnv,
  createSubagentBaseEnv,
} from "../subagent/subagent-runtime-env";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("createSubagentBaseEnv only forwards allowlisted parent env keys and explicit inherited keys", () => {
  const env = createSubagentBaseEnv({
    PATH: "/usr/bin",
    HOME: "/home/tester",
    NODE_OPTIONS: "--require ./malicious-loader.js",
    NODE_PATH: "/tmp/node-path",
    BUN_OPTIONS: "--preload ./malicious-loader.ts",
    npm_config_node_options: "--require ./npm-loader.js",
    OPENAI_API_KEY: "parent-key",
    PI_TIMING: "1",
    CUSTOM_SECRET: "do-not-forward",
  }, {
    inheritedEnvKeys: ["OPENAI_API_KEY", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "npm_config_node_options"],
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.OPENAI_API_KEY, "parent-key");
  assert.equal(env.PI_TIMING, "1");
  assert.equal("NODE_OPTIONS" in env, false);
  assert.equal("NODE_PATH" in env, false);
  assert.equal("BUN_OPTIONS" in env, false);
  assert.equal("npm_config_node_options" in env, false);
  assert.equal("CUSTOM_SECRET" in env, false);
});

runTest("buildSubagentSpawnEnv injects generic delegated auth runtime and broker env", () => {
  const env = buildSubagentSpawnEnv({
    parentEnv: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "parent-key",
      UNRELATED_TOKEN: "keep-out",
    },
    parentSessionId: "parent-session-1",
    isolatedAgentDir: "/tmp/isolated-agent",
    delegatedAuthRuntimeDir: "/tmp/runtime-agent",
    inheritedEnvKeys: ["OPENAI_API_KEY"],
    delegatedAuthEnv: {
      OPENAI_API_KEY: "broker-key",
      PI_DELEGATED_AUTH_LEASE_ID: "lease-1",
      NODE_OPTIONS: "must-not-inject",
    },
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/isolated-agent");
  assert.equal(env[PI_DELEGATED_AUTH_RUNTIME_DIR_ENV], "/tmp/runtime-agent");
  assert.equal(env.OPENAI_API_KEY, "broker-key");
  assert.equal(env.PI_DELEGATED_AUTH_LEASE_ID, "lease-1");
  assert.equal("NODE_OPTIONS" in env, false);
  assert.equal(env[PI_AGENT_ROUTER_SUBAGENT_ENV], "1");
  assert.equal(env[PI_AGENT_ROUTER_PARENT_SESSION_ID_ENV], "parent-session-1");
  assert.equal("UNRELATED_TOKEN" in env, false);
});

runTest("buildSubagentSpawnEnv enables pi-model-discovery cache-only startup for resolved delegated models", () => {
  const env = buildSubagentSpawnEnv({
    parentEnv: {
      PI_MODEL_DISCOVERY_CACHE_ONLY: "parent-value-must-not-leak",
    },
    modelDiscoveryCacheOnly: true,
  });

  assert.equal(env[PI_MODEL_DISCOVERY_CACHE_ONLY_ENV], "1");
});

console.log("All subagent runtime env tests passed.");
