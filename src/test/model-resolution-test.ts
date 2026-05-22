import assert from "node:assert/strict";

import { resolveAgentModelAfterReadiness } from "../model-resolution";
import type { Agent } from "../types";

type TestModel = { provider: string; id: string; api: string };

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function createContext(models: () => TestModel[]) {
  return {
    modelRegistry: {
      getAll: () => models(),
      getAvailable: () => models(),
      find: (provider: string, modelId: string) =>
        models().find((model) => model.provider === provider && model.id === modelId),
    },
  };
}

await runTest("resolveAgentModelAfterReadiness waits for delayed model registration", async () => {
  let registeredModels: TestModel[] = [];
  let waitCount = 0;
  const agent = { model: "blazeapi/claude-opus-4-7" } as Agent;

  const result = await resolveAgentModelAfterReadiness(createContext(() => registeredModels), agent, {
    maxAttempts: 3,
    waitForReadiness: async () => {
      waitCount += 1;
      registeredModels = [
        { provider: "blazeapi", id: "claude-opus-4-7", api: "openai-completions" },
      ];
    },
  });

  assert.equal(waitCount, 1);
  assert.equal(result.model?.provider, "blazeapi");
  assert.equal(result.model?.id, "claude-opus-4-7");
});

await runTest("resolveAgentModelAfterReadiness returns unresolved model after bounded waits", async () => {
  let waitCount = 0;
  const agent = { model: "blazeapi/claude-opus-4-7" } as Agent;

  const result = await resolveAgentModelAfterReadiness(createContext(() => []), agent, {
    maxAttempts: 3,
    waitForReadiness: async () => {
      waitCount += 1;
    },
  });

  assert.equal(waitCount, 2);
  assert.equal(result.model, undefined);
  assert.equal(result.requested, "blazeapi/claude-opus-4-7");
});

console.log("All model-resolution tests passed.");
