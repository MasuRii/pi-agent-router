import assert from "node:assert/strict";

import { hasExtensiveDelegatedProgressForCredentialRetry } from "../subagent/subagent-run-progress";
import type { SubagentRunResult } from "../types";

function createRun(overrides: Partial<SubagentRunResult> = {}): SubagentRunResult {
  return {
    code: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

const codexUsageLimitError =
  'Codex error: {"type":"error","error":{"type":"usage_limit_reached","message":"The usage limit has been reached"},"status_code":429}';

const repeatedEmptyCodexErrorMessages = Array.from({ length: 9 }, () => ({
  role: "assistant",
  content: [],
  provider: "openai-codex",
  model: "gpt-5.5",
  stopReason: "error",
  errorMessage: codexUsageLimitError,
})) as unknown as SubagentRunResult["messages"];

const emptyErrorOnlyRun = createRun({
  messages: repeatedEmptyCodexErrorMessages,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 9,
  },
});

assert.equal(
  hasExtensiveDelegatedProgressForCredentialRetry(emptyErrorOnlyRun, {
    outputText: "",
    structuredError: codexUsageLimitError,
    toolInvocationCount: 0,
  }),
  false,
);

assert.equal(
  hasExtensiveDelegatedProgressForCredentialRetry(
    createRun({
      usage: {
        input: 50_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 50_000,
        turns: 9,
      },
    }),
    {
      outputText: "",
      structuredError: codexUsageLimitError,
      toolInvocationCount: 0,
    },
  ),
  true,
);

assert.equal(
  hasExtensiveDelegatedProgressForCredentialRetry(
    createRun({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 2,
      },
    }),
    {
      outputText: "",
      toolInvocationCount: 12,
    },
  ),
  true,
);

console.log("All subagent run progress tests passed.");
