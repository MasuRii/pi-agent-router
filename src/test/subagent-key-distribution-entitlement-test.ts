import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectSubagentProviderIdAsync,
  releaseKeyLeasesForParentSession,
  resetProviderEnvKeyCacheState,
  shouldSkipDelegatedMultiAuthForProviderAsync,
  tryAcquireKeyForSubagent,
} from "../subagent/subagent-key-distribution";

type MockDistributor = {
  acquireForSubagent: (
    sessionId: string,
    providerId: string,
    options?: {
      timeoutMs?: number;
      modelId?: string;
      signal?: AbortSignal;
      parentSessionId?: string;
    },
  ) => Promise<{ credentialId: string; apiKey: string } | null>;
  releaseFromSubagent: (sessionId: string) => void;
  releaseLightweightSessionLeases?: (parentSessionId: string, providerId?: string) => void;
  getLeaseForSession?: (
    sessionId: string,
  ) => Promise<{ credentialId: string; apiKey: string } | null> | { credentialId: string; apiKey: string } | null;
  shouldBypassDelegatedSubagentAcquisition?: (
    providerId: string,
    options?: {
      modelId?: string;
      signal?: AbortSignal;
    },
  ) => Promise<boolean> | boolean;
};

type GlobalWithKeyDistributor = typeof globalThis & {
  __piMultiAuthKeyDistributor?: MockDistributor;
};

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

const globalScope = globalThis as GlobalWithKeyDistributor;
const previousDistributor = globalScope.__piMultiAuthKeyDistributor;

try {
  await runTest("tryAcquireKeyForSubagent passes requested model context into multi-auth selection", async () => {
    let captured:
      | {
          sessionId: string;
          providerId: string;
          options?: {
            timeoutMs?: number;
            modelId?: string;
            signal?: AbortSignal;
            parentSessionId?: string;
          };
        }
      | undefined;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async (sessionId, providerId, options) => {
        captured = { sessionId, providerId, options };
        return {
          credentialId: "openai-codex-1",
          apiKey: "test-api-key",
        };
      },
      releaseFromSubagent: () => undefined,
    };

    const lease = await tryAcquireKeyForSubagent("session-123", "openai-codex", {
      requestedModel: "openai-codex/gpt-5.4",
      timeoutMs: 25,
      parentSessionId: "parent-session-123",
    });

    assert.deepEqual(lease, {
      providerId: "openai-codex",
      envKey: "OPENAI_API_KEY",
      credentialId: "openai-codex-1",
      apiKey: "test-api-key",
    });
    assert.deepEqual(captured, {
      sessionId: "session-123",
      providerId: "openai-codex",
      options: {
        timeoutMs: 25,
        modelId: "gpt-5.4",
        signal: captured?.options?.signal,
        parentSessionId: "parent-session-123",
      },
    });
  });

  await runTest("tryAcquireKeyForSubagent reuses an existing session lease before re-running acquisition", async () => {
    let acquireCalls = 0;
    let leaseLookupSessionId: string | undefined;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async () => {
        acquireCalls += 1;
        return {
          credentialId: "openai-codex-2",
          apiKey: "should-not-be-used",
        };
      },
      getLeaseForSession: async (sessionId) => {
        leaseLookupSessionId = sessionId;
        return {
          credentialId: "openai-codex-1",
          apiKey: "reused-api-key",
        };
      },
      releaseFromSubagent: () => undefined,
    };

    const lease = await tryAcquireKeyForSubagent("session-reuse", "openai-codex", {
      requestedModel: "openai-codex/gpt-5.4",
      timeoutMs: 25,
    });

    assert.deepEqual(lease, {
      providerId: "openai-codex",
      envKey: "OPENAI_API_KEY",
      credentialId: "openai-codex-1",
      apiKey: "reused-api-key",
    });
    assert.equal(leaseLookupSessionId, "session-reuse");
    assert.equal(acquireCalls, 0);
  });

  await runTest("tryAcquireKeyForSubagent bypasses delegated acquisition when only one eligible credential exists", async () => {
    let acquireCalls = 0;
    let bypassCheck:
      | {
          providerId: string;
          modelId?: string;
        }
      | undefined;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async () => {
        acquireCalls += 1;
        return {
          credentialId: "cline",
          apiKey: "should-not-be-used",
        };
      },
      shouldBypassDelegatedSubagentAcquisition: async (providerId, options) => {
        bypassCheck = {
          providerId,
          modelId: options?.modelId,
        };
        return true;
      },
      releaseFromSubagent: () => undefined,
    };

    const lease = await tryAcquireKeyForSubagent("session-single-credential", "cline", {
      requestedModel: "cline/moonshotai/kimi-k2.6",
      timeoutMs: 25,
    });

    assert.equal(lease, null);
    assert.deepEqual(bypassCheck, {
      providerId: "cline",
      modelId: "moonshotai/kimi-k2.6",
    });
    assert.equal(acquireCalls, 0);
  });

  await runTest("releaseKeyLeasesForParentSession forwards lightweight session lease release to multi-auth", () => {
    let releasedParentSessionId: string | undefined;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async () => null,
      releaseFromSubagent: () => undefined,
      releaseLightweightSessionLeases: (parentSessionId) => {
        releasedParentSessionId = parentSessionId;
      },
    };

    releaseKeyLeasesForParentSession(" parent-session-release ");
    assert.equal(releasedParentSessionId, "parent-session-release");
  });

  await runTest("detectSubagentProviderIdAsync and tryAcquireKeyForSubagent honor models.json provider apiKey mappings", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "subagent-provider-env-"));
    const distributorCalls: Array<{ sessionId: string; providerId: string }> = [];

    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              "custom-provider": {
                apiKey: "CUSTOM_PROVIDER_API_KEY",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      globalScope.__piMultiAuthKeyDistributor = {
        acquireForSubagent: async (sessionId, providerId) => {
          distributorCalls.push({ sessionId, providerId });
          return {
            credentialId: `${providerId}-lease-1`,
            apiKey: "distributed-custom-key",
          };
        },
        releaseFromSubagent: () => undefined,
      };

      await withEnv(
        {
          PI_CODING_AGENT_DIR: agentDir,
          CUSTOM_PROVIDER_API_KEY: "parent-custom-provider-key",
        },
        async () => {
          const detectedProvider = await detectSubagentProviderIdAsync({
            requestedModel: "custom-provider/model-a",
            parentEnv: process.env,
          });
          assert.equal(detectedProvider, "custom-provider");

          const lease = await tryAcquireKeyForSubagent("session-custom", "custom-provider", {
            requestedModel: "custom-provider/model-a",
          });
          assert.deepEqual(lease, {
            providerId: "custom-provider",
            envKey: "CUSTOM_PROVIDER_API_KEY",
            credentialId: "custom-provider-lease-1",
            apiKey: "distributed-custom-key",
          });
        },
      );

      assert.deepEqual(distributorCalls, [
        {
          sessionId: "session-custom",
          providerId: "custom-provider",
        },
      ]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  await runTest("shouldSkipDelegatedMultiAuthForProviderAsync returns true only for providers with direct built-in env auth support", async () => {
    const shouldSkip = await shouldSkipDelegatedMultiAuthForProviderAsync("openai");
    assert.equal(shouldSkip, true);
  });

  await runTest("shouldSkipDelegatedMultiAuthForProviderAsync keeps multi-auth loaded for env-backed alias providers", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "subagent-keep-multi-auth-"));

    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              cline: {
                apiKey: "CLINE_API_KEY",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnv(
        {
          PI_CODING_AGENT_DIR: agentDir,
          CLINE_API_KEY: undefined,
        },
        async () => {
          assert.equal(await shouldSkipDelegatedMultiAuthForProviderAsync("openai-codex"), false);
          assert.equal(await shouldSkipDelegatedMultiAuthForProviderAsync("cline"), false);
        },
      );
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  await runTest("shouldSkipDelegatedMultiAuthForProviderAsync returns false for providers without env-backed delegation", async () => {
    const shouldSkip = await shouldSkipDelegatedMultiAuthForProviderAsync("missing-provider");
    assert.equal(shouldSkip, false);
  });
} finally {
  resetProviderEnvKeyCacheState();
  if (previousDistributor) {
    globalScope.__piMultiAuthKeyDistributor = previousDistributor;
  } else {
    delete globalScope.__piMultiAuthKeyDistributor;
  }
}

console.log("All subagent key distribution entitlement tests passed.");
