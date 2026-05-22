import assert from "node:assert/strict";

import {
  PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV,
  PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV,
  PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV,
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

runTest("createSubagentBaseEnv only forwards allowlisted parent env keys and strips runtime injection keys", () => {
  const env = createSubagentBaseEnv({
    PATH: "/usr/bin",
    HOME: "/home/tester",
    NODE_OPTIONS: "--require ./malicious-loader.js",
    NODE_PATH: "/tmp/node-path",
    BUN_OPTIONS: "--preload ./malicious-loader.ts",
    npm_config_node_options: "--require ./npm-loader.js",
    OPENAI_API_KEY: "parent-key",
    CUSTOM_SECRET: "do-not-forward",
  }, {
    inheritedEnvKeys: ["OPENAI_API_KEY", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "npm_config_node_options"],
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.OPENAI_API_KEY, "parent-key");
  assert.equal("NODE_OPTIONS" in env, false);
  assert.equal("NODE_PATH" in env, false);
  assert.equal("BUN_OPTIONS" in env, false);
  assert.equal("npm_config_node_options" in env, false);
  assert.equal("CUSTOM_SECRET" in env, false);
});

runTest("buildSubagentSpawnEnv injects runtime markers and delegated credential overrides", () => {
  const env = buildSubagentSpawnEnv({
    parentEnv: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "parent-key",
      UNRELATED_TOKEN: "keep-out",
    },
    parentSessionId: "parent-session-1",
    isolatedAgentDir: "/tmp/isolated-agent",
    inheritedEnvKeys: ["OPENAI_API_KEY"],
    delegatedCredential: {
      providerId: "openai-codex",
      credentialId: "openai-codex-3",
      envKey: "OPENAI_API_KEY",
      apiKey: "leased-key",
    },
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/isolated-agent");
  assert.equal(env.OPENAI_API_KEY, "leased-key");
  assert.equal(env[PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV], "openai-codex");
  assert.equal(env[PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV], "openai-codex-3");
  assert.equal(env[PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV], "leased-key");
  assert.equal(env[PI_AGENT_ROUTER_SUBAGENT_ENV], "1");
  assert.equal(env[PI_AGENT_ROUTER_PARENT_SESSION_ID_ENV], "parent-session-1");
  assert.equal("UNRELATED_TOKEN" in env, false);
});

runTest("buildSubagentSpawnEnv does not write delegated credentials to dangerous env keys", () => {
  const env = buildSubagentSpawnEnv({
    parentEnv: {},
    delegatedCredential: {
      providerId: "custom-provider",
      credentialId: "custom-provider-1",
      envKey: "NODE_OPTIONS",
      apiKey: "leased-key",
    },
  });

  assert.equal("NODE_OPTIONS" in env, false);
  assert.equal(env[PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV], "custom-provider");
  assert.equal(env[PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV], "custom-provider-1");
  assert.equal(env[PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV], "leased-key");
});

runTest("buildSubagentSpawnEnv enables model-discovery cache-only startup for resolved delegated models", () => {
  const env = buildSubagentSpawnEnv({
    parentEnv: {
      PI_MODEL_DISCOVERY_CACHE_ONLY: "parent-value-must-not-leak",
    },
    modelDiscoveryCacheOnly: true,
  });

  assert.equal(env[PI_MODEL_DISCOVERY_CACHE_ONLY_ENV], "1");
});

console.log("All subagent runtime env tests passed.");
