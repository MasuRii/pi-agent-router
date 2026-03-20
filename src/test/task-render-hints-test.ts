import assert from "node:assert/strict";

import {
  formatAttachSubagentOutputHint,
  formatHiddenTasksSummary,
} from "../task/task-render-hints";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("formatAttachSubagentOutputHint omits nerdfont icon prefix", () => {
  const hint = formatAttachSubagentOutputHint("abcdef1234567890");
  assert.equal(hint, "/attach abcdef12 view subagent output");
  assert.equal(hint?.startsWith("󰘍"), false);
});

runTest("formatAttachSubagentOutputHint returns undefined for empty ids", () => {
  assert.equal(formatAttachSubagentOutputHint("  "), undefined);
  assert.equal(formatAttachSubagentOutputHint(undefined), undefined);
});

runTest("formatHiddenTasksSummary includes Ctrl+O expand hint", () => {
  assert.equal(
    formatHiddenTasksSummary(2),
    "… 2 additional task(s) hidden • Ctrl+O",
  );
  assert.equal(formatHiddenTasksSummary(0), undefined);
});

console.log("All task-render hint tests passed.");
