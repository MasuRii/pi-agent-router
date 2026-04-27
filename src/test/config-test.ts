import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PI_AGENT_ROUTER_CONFIG,
  loadPiAgentRouterConfig,
} from "../config";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("loadPiAgentRouterConfig creates default config when absent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-router-config-"));
  const configPath = join(root, "nested", "config.json");

  try {
    const result = loadPiAgentRouterConfig(configPath);
    assert.equal(result.created, true);
    assert.deepEqual(result.config, DEFAULT_PI_AGENT_ROUTER_CONFIG);

    const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    assert.deepEqual(persisted, DEFAULT_PI_AGENT_ROUTER_CONFIG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("loadPiAgentRouterConfig accepts valid parallel delegation concurrency", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-router-config-"));
  const configPath = join(root, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({ debug: true, maxParallelDelegationConcurrency: 6 }, null, 2)}\n`,
      "utf-8",
    );

    const result = loadPiAgentRouterConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(result.warning, undefined);
    assert.equal(result.config.debug, true);
    assert.equal(result.config.maxParallelDelegationConcurrency, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("loadPiAgentRouterConfig warns and preserves default concurrency for invalid values", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-router-config-"));
  const configPath = join(root, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({ debug: false, maxParallelDelegationConcurrency: 0 }, null, 2)}\n`,
      "utf-8",
    );

    const result = loadPiAgentRouterConfig(configPath);
    assert.equal(result.created, false);
    assert.equal(
      result.config.maxParallelDelegationConcurrency,
      DEFAULT_PI_AGENT_ROUTER_CONFIG.maxParallelDelegationConcurrency,
    );
    assert.match(result.warning || "", /maxParallelDelegationConcurrency/);
    assert.match(result.warning || "", /between 1 and 16/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("loadPiAgentRouterConfig accepts unified delegated extension entries", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-router-config-"));
  const configPath = join(root, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        delegatedExtensions: [
          "pi-fast-mode",
          ["pi-context-injector", "context-injector"],
          {
            candidates: ["pi-multi-auth", "multi-auth"],
            skipWhen: "directEnvAuthAvailable",
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );

    const result = loadPiAgentRouterConfig(configPath);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config.delegatedExtensions, [
      { candidates: ["pi-fast-mode"], skipWhen: [] },
      { candidates: ["pi-context-injector", "context-injector"], skipWhen: [] },
      {
        candidates: ["pi-multi-auth", "multi-auth"],
        skipWhen: ["directEnvAuthAvailable"],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("loadPiAgentRouterConfig converts legacy delegated extension config", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-router-config-"));
  const configPath = join(root, "config.json");

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        delegatedExtensions: {
          requiredExtensionCandidates: [["pi-permission-system"]],
          optionalExtensionNames: ["pi-multi-auth"],
          delegatedMultiAuthExtensionNames: ["pi-multi-auth"],
        },
      }, null, 2)}\n`,
      "utf-8",
    );

    const result = loadPiAgentRouterConfig(configPath);
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.config.delegatedExtensions, [
      { candidates: ["pi-permission-system"], skipWhen: [] },
      { candidates: ["pi-multi-auth"], skipWhen: ["directEnvAuthAvailable"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("All config tests passed.");
