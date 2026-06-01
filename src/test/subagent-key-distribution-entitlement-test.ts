import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getOrCreateDelegatedAuthBrokerRegistry,
  prepareSubagentAuthForLaunch,
  releaseSubagentAuthForLaunch,
  releaseSubagentAuthForParentSession,
  reportSubagentAuthAttemptResult,
  resetProviderEnvKeyCacheState,
  type DelegatedAuthBroker,
} from "../subagent/subagent-key-distribution";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const finalize = (): void => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetProviderEnvKeyCacheState();
  };

  resetProviderEnvKeyCacheState();
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

const registry = getOrCreateDelegatedAuthBrokerRegistry();
for (const broker of registry.list()) {
  registry.unregister(broker.id);
}

try {
  await runTest("prepareSubagentAuthForLaunch uses generic self-managed delegated auth broker", async () => {
    let capturedProviderId: string | undefined;
    const broker: DelegatedAuthBroker = {
      id: "test-auth-broker",
      capabilities: ["delegated-auth"],
      prepareSubagentAuth: (request) => {
        capturedProviderId = request.providerId;
        return {
          mode: "self-managed",
          extensionDirs: ["/extensions/test-auth-broker"],
          env: {
            PI_DELEGATED_AUTH_RUNTIME_DIR: "/runtime/root",
          },
        };
      },
    };
    registry.register(broker);

    const prepared = await prepareSubagentAuthForLaunch({
      providerId: "OpenAI-Codex",
      requestedModel: "openai-codex/gpt-5.4",
      parentSessionId: "parent-1",
      subagentSessionId: "child-1",
      parentEnv: {},
    });

    assert.equal(capturedProviderId, "openai-codex");
    assert.deepEqual(prepared, {
      mode: "self-managed",
      brokerId: "test-auth-broker",
      extensionDirs: ["/extensions/test-auth-broker"],
      env: {
        PI_DELEGATED_AUTH_RUNTIME_DIR: "/runtime/root",
      },
      inheritedEnvKeys: [],
      leaseId: undefined,
    });
    registry.unregister(broker.id);
  });

  await runTest("prepareSubagentAuthForLaunch supports broker-owned lease env without router credential fields", async () => {
    const broker: DelegatedAuthBroker = {
      id: "lease-auth-broker",
      capabilities: ["delegated-auth"],
      prepareSubagentAuth: () => ({
        mode: "lease",
        leaseId: "lease-42",
        env: {
          OPENAI_API_KEY: "temporary-key",
          PI_DELEGATED_AUTH_LEASE_ID: "lease-42",
        },
      }),
    };
    registry.register(broker);

    const prepared = await prepareSubagentAuthForLaunch({
      providerId: "openai",
      subagentSessionId: "child-lease",
      parentEnv: {},
    });

    assert.equal(prepared.mode, "lease");
    assert.equal(prepared.brokerId, "lease-auth-broker");
    assert.equal(prepared.leaseId, "lease-42");
    assert.deepEqual(prepared.env, {
      OPENAI_API_KEY: "temporary-key",
      PI_DELEGATED_AUTH_LEASE_ID: "lease-42",
    });
    registry.unregister(broker.id);
  });

  await runTest("standalone fallback inherits detected direct parent env when available", async () => {
    await withEnv({ OPENAI_API_KEY: "parent-key" }, async () => {
      const prepared = await prepareSubagentAuthForLaunch({
        providerId: "openai",
        subagentSessionId: "child-direct",
        parentEnv: process.env,
      });

      assert.equal(prepared.mode, "direct-env");
      assert.deepEqual(prepared.inheritedEnvKeys, ["OPENAI_API_KEY"]);
      assert.equal(prepared.failureMessage, undefined);
    });
  });

  await runTest("standalone fallback returns actionable failure when no broker or direct env exists", async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const prepared = await prepareSubagentAuthForLaunch({
        providerId: "openai",
        requestedModel: "openai/gpt-5",
        subagentSessionId: "child-missing",
        parentEnv: process.env,
      });

      assert.equal(prepared.mode, "none");
      assert.match(prepared.failureMessage || "", /No delegated auth broker is registered/);
      assert.match(prepared.failureMessage || "", /OPENAI_API_KEY/);
    });
  });

  await runTest("broker release and attempt result callbacks receive generic lease metadata", async () => {
    const releases: unknown[] = [];
    const reports: unknown[] = [];
    const broker: DelegatedAuthBroker = {
      id: "callbacks-auth-broker",
      capabilities: ["delegated-auth"],
      prepareSubagentAuth: () => ({
        mode: "lease",
        leaseId: "lease-callback",
        env: {
          TEST_API_KEY: "secret",
        },
      }),
      release: (request) => {
        releases.push(request);
      },
      reportAttemptResult: (result) => {
        reports.push(result);
      },
    };
    registry.register(broker);

    const prepared = await prepareSubagentAuthForLaunch({
      providerId: "test-provider",
      subagentSessionId: "child-callback",
    });

    await reportSubagentAuthAttemptResult(prepared, {
      providerId: "test-provider",
      subagentSessionId: "child-callback",
      exitCode: 1,
      timedOut: false,
      stderr: "failed",
    });
    releaseSubagentAuthForLaunch(prepared, {
      parentSessionId: "parent-callback",
      subagentSessionId: "child-callback",
      providerId: "test-provider",
    });
    releaseSubagentAuthForParentSession(" parent-callback ");

    assert.deepEqual(reports, [{
      providerId: "test-provider",
      subagentSessionId: "child-callback",
      exitCode: 1,
      timedOut: false,
      stderr: "failed",
      mode: "lease",
      leaseId: "lease-callback",
    }]);
    assert.deepEqual(releases, [
      {
        leaseId: "lease-callback",
        parentSessionId: "parent-callback",
        subagentSessionId: "child-callback",
        providerId: "test-provider",
      },
      {
        parentSessionId: "parent-callback",
        subagentSessionId: "",
      },
    ]);
    registry.unregister(broker.id);
  });
} finally {
  for (const broker of registry.list()) {
    registry.unregister(broker.id);
  }
  resetProviderEnvKeyCacheState();
}

console.log("All delegated auth broker tests passed.");
