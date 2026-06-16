import assert from "node:assert/strict";

import { selectRetainedCompletionErrorText } from "../subagent/completion-error-retention";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("successful delegated completion does not retain stale stderr as task error", () => {
  const retained = selectRetainedCompletionErrorText({
    terminalFailure: false,
    failureSummarySource: "final task report",
    sessionStderr: "Multi-auth rotation failed for provider xiaomi-token-plan-sgp, model mimo-v2.5-pro: 429 Too many requests.",
    runStderr: "Multi-auth rotation failed for provider xiaomi-token-plan-sgp, model mimo-v2.5-pro: 429 Too many requests.",
  });

  assert.equal(retained, "");
});

await runTest("failed delegated completion retains terminal failure summary", () => {
  const retained = selectRetainedCompletionErrorText({
    terminalFailure: true,
    failureSummarySource: "Multi-auth rotation failed for provider openai-codex, model gpt-5.5: Unauthorized.",
    sessionStderr: "",
    runStderr: "",
  });

  assert.equal(retained, "Multi-auth rotation failed for provider openai-codex, model gpt-5.5: Unauthorized.");
});
