import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_PATH } from "../config";
import {
  KEY_DISTRIBUTION_ATTEMPT_CACHE_MAX_ENTRIES,
  clearSubagentTransientKeyError,
  clearWeeklyQuotaAttempts,
  detectSubagentProviderIdAsync,
  isRetryableCredentialAuthError,
  shouldInheritParentCredentialEnvForProvider,
  releaseKeyLeasesForParentSession,
  reportSubagentCredentialAuthError,
  reportSubagentKeyError,
  reportSubagentTransientKeyError,
  resetProviderEnvKeyCacheState,
  shouldSkipDelegatedMultiAuthForProviderAsync,
  tryAcquireKeyForSubagent,
} from "../subagent/subagent-key-distribution";

type MockDelegatedCredentialRequest = {
  sessionId: string;
  providerId: string;
  timeoutMs?: number;
  modelId?: string;
  modelRef?: string;
  api?: string;
  signal?: AbortSignal;
  parentSessionId?: string;
};

type MockDistributor = {
  acquireForSubagent: (
    request: MockDelegatedCredentialRequest,
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
      modelRef?: string;
      api?: string;
      signal?: AbortSignal;
    },
  ) => Promise<boolean> | boolean;
  getDelegatedCredentialRoutingCapabilities?: (
    request: MockDelegatedCredentialRequest,
  ) => Promise<unknown> | unknown;
  applyCooldown?: (
    credentialId: string,
    durationMs: number,
    reason: string,
    providerId?: string,
    isWeekly?: boolean,
    errorMessage?: string,
  ) => Promise<void> | void;
  disableCredential?: (
    credentialId: string,
    reason: string,
    providerId?: string,
  ) => Promise<void> | void;
  clearTransientError?: (credentialId: string, providerId?: string) => Promise<void> | void;
};

type GlobalWithKeyDistributor = typeof globalThis & {
  __piMultiAuthKeyDistributor?: MockDistributor;
};

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function writeKeyDistributionRouterConfig(
  providerEnvKeys: Record<string, string>,
  directEnvDelegationProviderIds: string[],
): void {
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        debug: false,
        providerEnvKeys,
        directEnvDelegationProviderIds,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function withExtensionRouterConfig(fn: () => Promise<void>): Promise<void> {
  const hadConfig = existsSync(CONFIG_PATH);
  const previousConfig = hadConfig ? readFileSync(CONFIG_PATH, "utf-8") : undefined;

  try {
    await fn();
  } finally {
    resetProviderEnvKeyCacheState();
    if (hadConfig && previousConfig !== undefined) {
      writeFileSync(CONFIG_PATH, previousConfig, "utf-8");
    } else if (existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
    resetProviderEnvKeyCacheState();
  }
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
    let captured: MockDelegatedCredentialRequest | undefined;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async (request) => {
        captured = request;
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
      timeoutMs: 25,
      modelId: "gpt-5.4",
      modelRef: "openai-codex/gpt-5.4",
      api: undefined,
      signal: captured?.signal,
      parentSessionId: "parent-session-123",
    });
  });

  await runTest("tryAcquireKeyForSubagent passes resolved unqualified Codex model context", async () => {
    let captured: MockDelegatedCredentialRequest | undefined;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async (request) => {
        captured = request;
        return {
          credentialId: "openai-codex-1",
          apiKey: "test-distributed-key",
        };
      },
      releaseFromSubagent: () => undefined,
    };

    const lease = await tryAcquireKeyForSubagent("session-unqualified", "openai-codex", {
      requestedModel: "gpt-5.4",
      timeoutMs: 25,
      modelContext: {
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        modelRef: "openai-codex/gpt-5.4",
        api: "openai-responses",
      },
    });

    assert.equal(lease?.providerId, "openai-codex");
    assert.deepEqual(captured, {
      sessionId: "session-unqualified",
      providerId: "openai-codex",
      timeoutMs: 25,
      modelId: "gpt-5.4",
      modelRef: "openai-codex/gpt-5.4",
      api: "openai-responses",
      signal: captured?.signal,
      parentSessionId: undefined,
    });
  });

  await runTest("tryAcquireKeyForSubagent fails closed for Codex without model context", async () => {
    let acquireCalls = 0;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async () => {
        acquireCalls += 1;
        return {
          credentialId: "openai-codex-1",
          apiKey: "test-distributed-key",
        };
      },
      releaseFromSubagent: () => undefined,
    };

    await withEnv({ OPENAI_API_KEY: "parent-env-key" }, async () => {
      const lease = await tryAcquireKeyForSubagent("session-missing-model", "openai-codex", {
        timeoutMs: 25,
      });
      assert.equal(lease, null);
      assert.equal(acquireCalls, 0);
      assert.equal(shouldInheritParentCredentialEnvForProvider("openai-codex"), false);
    });
  });

  await runTest("provider credential fallback policy defaults Codex to distributed-only", async () => {
    await withEnv({ OPENAI_API_KEY: "parent-env-key" }, async () => {
      assert.equal(shouldInheritParentCredentialEnvForProvider("openai-codex"), false);
      assert.equal(shouldInheritParentCredentialEnvForProvider("openai"), true);
    });
  });

  await runTest("tryAcquireKeyForSubagent enforces distributed-only timeout fallback policy", async () => {
    let acquireCalls = 0;

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async () => {
        acquireCalls += 1;
        return new Promise(() => undefined);
      },
      releaseFromSubagent: () => undefined,
    };

    await withEnv({ OPENAI_API_KEY: "parent-env-key" }, async () => {
      const lease = await tryAcquireKeyForSubagent("session-timeout", "openai-codex", {
        requestedModel: "openai-codex/gpt-5.4",
        timeoutMs: 5,
      });
      assert.equal(lease, null);
      assert.equal(acquireCalls, 1);
      assert.equal(shouldInheritParentCredentialEnvForProvider("openai-codex"), false);
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
        acquireForSubagent: async (request) => {
          distributorCalls.push({
            sessionId: request.sessionId,
            providerId: request.providerId,
          });
          return {
            credentialId: `${request.providerId}-lease-1`,
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

  await runTest("key distribution config slices stay cached until provider env key reset", async () => {
    await withExtensionRouterConfig(async () => {
      writeKeyDistributionRouterConfig(
        {
          "cached-env-provider": "CACHED_ENV_PROVIDER_API_KEY",
          "cached-direct-provider": "CACHED_DIRECT_PROVIDER_API_KEY",
        },
        ["cached-direct-provider"],
      );
      resetProviderEnvKeyCacheState();

      assert.equal(
        await detectSubagentProviderIdAsync({ requestedModel: "cached-env-provider/model-a" }),
        "cached-env-provider",
      );
      assert.equal(await shouldSkipDelegatedMultiAuthForProviderAsync("cached-direct-provider"), true);

      writeKeyDistributionRouterConfig(
        {
          "reloaded-env-provider": "RELOADED_ENV_PROVIDER_API_KEY",
          "reloaded-direct-provider": "RELOADED_DIRECT_PROVIDER_API_KEY",
        },
        ["reloaded-direct-provider"],
      );

      assert.equal(
        await detectSubagentProviderIdAsync({ requestedModel: "cached-env-provider/model-b" }),
        "cached-env-provider",
      );
      assert.equal(
        await detectSubagentProviderIdAsync({ requestedModel: "reloaded-env-provider/model-c" }),
        undefined,
      );
      assert.equal(await shouldSkipDelegatedMultiAuthForProviderAsync("cached-direct-provider"), true);
      assert.equal(await shouldSkipDelegatedMultiAuthForProviderAsync("reloaded-direct-provider"), false);

      resetProviderEnvKeyCacheState();

      assert.equal(
        await detectSubagentProviderIdAsync({ requestedModel: "cached-env-provider/model-d" }),
        undefined,
      );
      assert.equal(
        await detectSubagentProviderIdAsync({ requestedModel: "reloaded-env-provider/model-e" }),
        "reloaded-env-provider",
      );
      assert.equal(await shouldSkipDelegatedMultiAuthForProviderAsync("cached-direct-provider"), false);
      assert.equal(await shouldSkipDelegatedMultiAuthForProviderAsync("reloaded-direct-provider"), true);
    });
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

  await runTest("credential auth errors are retryable and disable the failed credential", async () => {
    const disabledCredentials: Array<{ credentialId: string; reason: string }> = [];

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async () => null,
      releaseFromSubagent: () => undefined,
      disableCredential: (credentialId, reason) => {
        disabledCredentials.push({ credentialId, reason });
      },
    };

    assert.equal(
      isRetryableCredentialAuthError(
        "Your authentication token has been invalidated. Please try signing in again.",
      ),
      true,
    );

    await reportSubagentCredentialAuthError(
      "session-auth",
      "auth-invalidated",
      "Your authentication token has been invalidated. Please try signing in again.",
    );

    assert.equal(disabledCredentials.length, 1);
    assert.equal(disabledCredentials[0]?.credentialId, "auth-invalidated");
    assert.equal(disabledCredentials[0]?.reason.includes("session-"), true);
  });

  await runTest("key error attempt tracking is bounded and preserves cached attempts", async () => {
    const cooldownsByCredential = new Map<string, number[]>();

    globalScope.__piMultiAuthKeyDistributor = {
      acquireForSubagent: async () => null,
      releaseFromSubagent: () => undefined,
      applyCooldown: (credentialId, durationMs) => {
        const cooldowns = cooldownsByCredential.get(credentialId) ?? [];
        cooldowns.push(durationMs);
        cooldownsByCredential.set(credentialId, cooldowns);
      },
      clearTransientError: () => undefined,
    };

    await reportSubagentKeyError("session-weekly", "weekly-preserved", "weekly usage limit reached");
    await reportSubagentKeyError("session-weekly", "weekly-preserved", "weekly usage limit reached");
    const preservedWeeklyCooldowns = cooldownsByCredential.get("weekly-preserved") ?? [];
    assert.equal(preservedWeeklyCooldowns.length, 2);
    assert.equal(preservedWeeklyCooldowns[1] > preservedWeeklyCooldowns[0], true);

    await reportSubagentTransientKeyError("session-transient", "transient-preserved", "internal server error");
    await reportSubagentTransientKeyError("session-transient", "transient-preserved", "internal server error");
    const preservedTransientCooldowns = cooldownsByCredential.get("transient-preserved") ?? [];
    assert.equal(preservedTransientCooldowns.length, 2);
    assert.equal(preservedTransientCooldowns[1] > preservedTransientCooldowns[0], true);

    const firstWeeklyCredential = "weekly-bounded-0";
    await reportSubagentKeyError("session-weekly", firstWeeklyCredential, "weekly usage limit reached");
    const firstWeeklyCooldown = cooldownsByCredential.get(firstWeeklyCredential)?.[0];
    assert.equal(typeof firstWeeklyCooldown, "number");

    for (let index = 1; index <= KEY_DISTRIBUTION_ATTEMPT_CACHE_MAX_ENTRIES; index += 1) {
      await reportSubagentKeyError(
        "session-weekly",
        `weekly-bounded-${index}`,
        "weekly usage limit reached",
      );
    }

    await reportSubagentKeyError("session-weekly", firstWeeklyCredential, "weekly usage limit reached");
    assert.equal(cooldownsByCredential.get(firstWeeklyCredential)?.[1], firstWeeklyCooldown);

    const firstTransientCredential = "transient-bounded-0";
    await reportSubagentTransientKeyError("session-transient", firstTransientCredential, "internal server error");
    const firstTransientCooldown = cooldownsByCredential.get(firstTransientCredential)?.[0];
    assert.equal(typeof firstTransientCooldown, "number");

    for (let index = 1; index <= KEY_DISTRIBUTION_ATTEMPT_CACHE_MAX_ENTRIES; index += 1) {
      await reportSubagentTransientKeyError(
        "session-transient",
        `transient-bounded-${index}`,
        "internal server error",
      );
    }

    await reportSubagentTransientKeyError("session-transient", firstTransientCredential, "internal server error");
    assert.equal(cooldownsByCredential.get(firstTransientCredential)?.[1], firstTransientCooldown);

    clearWeeklyQuotaAttempts("weekly-preserved");
    clearWeeklyQuotaAttempts(firstWeeklyCredential);
    clearSubagentTransientKeyError("transient-preserved");
    clearSubagentTransientKeyError(firstTransientCredential);
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
