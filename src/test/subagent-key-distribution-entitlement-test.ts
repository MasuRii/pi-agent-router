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

async function withTempAgentDir(
  files: Record<string, unknown>,
  fn: (agentDir: string) => Promise<void> | void,
): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-router-auth-json-"));
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(agentDir, fileName), `${JSON.stringify(content, null, 2)}\n`, "utf-8");
  }

  try {
    await withEnv({ PI_CODING_AGENT_DIR: agentDir, MYPROXY_API_KEY: undefined }, () => fn(agentDir));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    resetProviderEnvKeyCacheState();
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

  await runTest("standalone fallback allows existing primary auth.json API key without env or broker", async () => {
    await withTempAgentDir(
      {
        "auth.json": {
          myproxy: {
            type: "api_key",
            key: "auth-json-key",
          },
        },
        "models.json": {
          providers: {
            myproxy: {
              apiKey: "$MYPROXY_API_KEY",
            },
          },
        },
      },
      async () => {
        const prepared = await prepareSubagentAuthForLaunch({
          providerId: "myproxy",
          requestedModel: "myproxy/gpt-5.5",
          subagentSessionId: "child-auth-json-primary",
          parentEnv: process.env,
        });

        assert.equal(prepared.mode, "auth-json");
        assert.deepEqual(prepared.inheritedEnvKeys, []);
        assert.deepEqual(prepared.env, {});
        assert.equal(prepared.failureMessage, undefined);
      },
    );
  });

  await runTest("standalone fallback recognizes suffixed auth.json API key credentials", async () => {
    await withTempAgentDir(
      {
        "auth.json": {
          "myproxy-1": {
            type: "api_key",
            key: "backup-auth-json-key",
          },
        },
      },
      async () => {
        const prepared = await prepareSubagentAuthForLaunch({
          providerId: "myproxy",
          requestedModel: "myproxy/gpt-5.5",
          subagentSessionId: "child-auth-json-suffixed",
          parentEnv: process.env,
        });

        assert.equal(prepared.mode, "auth-json");
        assert.deepEqual(prepared.inheritedEnvKeys, []);
        assert.equal(prepared.failureMessage, undefined);
      },
    );
  });

  await runTest("delegated broker remains preferred over auth.json fallback", async () => {
    await withTempAgentDir(
      {
        "auth.json": {
          myproxy: {
            type: "api_key",
            key: "auth-json-key",
          },
        },
      },
      async () => {
        const broker: DelegatedAuthBroker = {
          id: "broker-before-auth-json",
          capabilities: ["delegated-auth"],
          prepareSubagentAuth: () => ({
            mode: "lease",
            leaseId: "lease-before-auth-json",
            env: {
              MYPROXY_API_KEY: "leased-key",
            },
          }),
        };
        registry.register(broker);
        try {
          const prepared = await prepareSubagentAuthForLaunch({
            providerId: "myproxy",
            requestedModel: "myproxy/gpt-5.5",
            subagentSessionId: "child-broker-before-auth-json",
            parentEnv: process.env,
          });

          assert.equal(prepared.mode, "lease");
          assert.equal(prepared.brokerId, "broker-before-auth-json");
          assert.equal(prepared.leaseId, "lease-before-auth-json");
        } finally {
          registry.unregister(broker.id);
        }
      },
    );
  });

  await runTest("direct parent env remains preferred over auth.json fallback", async () => {
    await withTempAgentDir(
      {
        "auth.json": {
          myproxy: {
            type: "api_key",
            key: "auth-json-key",
          },
        },
        "models.json": {
          providers: {
            myproxy: {
              apiKey: "$MYPROXY_API_KEY",
            },
          },
        },
      },
      async () => {
        process.env.MYPROXY_API_KEY = "parent-env-key";
        const prepared = await prepareSubagentAuthForLaunch({
          providerId: "myproxy",
          requestedModel: "myproxy/gpt-5.5",
          subagentSessionId: "child-env-before-auth-json",
          parentEnv: process.env,
        });

        assert.equal(prepared.mode, "direct-env");
        assert.deepEqual(prepared.inheritedEnvKeys, ["MYPROXY_API_KEY"]);
      },
    );
  });

  await runTest("standalone fallback ignores unusable auth.json credentials", async () => {
    await withTempAgentDir(
      {
        "auth.json": {
          myproxy: {
            type: "api_key",
            key: "   ",
          },
          "myproxy-1": {
            type: "oauth",
            access: "oauth-access-token",
            refresh: "oauth-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        "models.json": {
          providers: {
            myproxy: {
              apiKey: "$MYPROXY_API_KEY",
            },
          },
        },
      },
      async () => {
        const prepared = await prepareSubagentAuthForLaunch({
          providerId: "myproxy",
          requestedModel: "myproxy/gpt-5.5",
          subagentSessionId: "child-auth-json-unusable",
          parentEnv: process.env,
        });

        assert.equal(prepared.mode, "none");
        assert.match(prepared.failureMessage || "", /MYPROXY_API_KEY/);
      },
    );
  });

  await runTest("standalone fallback ignores invalid auth.json content", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-router-invalid-auth-json-"));
    try {
      writeFileSync(join(agentDir, "auth.json"), "{not-json", "utf-8");
      await withEnv({ PI_CODING_AGENT_DIR: agentDir, MYPROXY_API_KEY: undefined }, async () => {
        const prepared = await prepareSubagentAuthForLaunch({
          providerId: "myproxy",
          requestedModel: "myproxy/gpt-5.5",
          subagentSessionId: "child-invalid-auth-json",
          parentEnv: process.env,
        });

        assert.equal(prepared.mode, "none");
        assert.match(prepared.failureMessage || "", /No delegated auth broker is registered/);
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      resetProviderEnvKeyCacheState();
    }
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
