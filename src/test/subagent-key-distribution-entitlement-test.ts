import assert from "node:assert/strict";

import { tryAcquireKeyForSubagent } from "../subagent/subagent-key-distribution";

type MockDistributor = {
  acquireForSubagent: (
    sessionId: string,
    providerId: string,
    options?: { timeoutMs?: number; modelId?: string },
  ) => Promise<{ credentialId: string; apiKey: string } | null>;
  releaseFromSubagent: (sessionId: string) => void;
};

type GlobalWithKeyDistributor = typeof globalThis & {
  __piMultiAuthKeyDistributor?: MockDistributor;
};

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

const globalScope = globalThis as GlobalWithKeyDistributor;
const previousDistributor = globalScope.__piMultiAuthKeyDistributor;

try {
  await runTest("tryAcquireKeyForSubagent passes requested model context into multi-auth selection", async () => {
    let captured:
      | { sessionId: string; providerId: string; options?: { timeoutMs?: number; modelId?: string } }
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
      },
    });
  });
} finally {
  if (previousDistributor) {
    globalScope.__piMultiAuthKeyDistributor = previousDistributor;
  } else {
    delete globalScope.__piMultiAuthKeyDistributor;
  }
}

console.log("All subagent key distribution entitlement tests passed.");