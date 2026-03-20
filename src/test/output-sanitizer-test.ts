import assert from "node:assert/strict";

import {
  sanitizeSubagentResultForDisplay,
  stripSubagentThinkingContent,
} from "../output-sanitizer";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("stripSubagentThinkingContent removes supported thinking block variants", () => {
  const rawText = [
    "Visible intro",
    "<thinking>hidden one</thinking>",
    "```analysis",
    "hidden two",
    "```",
    "reasoning: hidden three",
    "Visible outro   ",
  ].join("\n");

  assert.equal(stripSubagentThinkingContent(rawText), "Visible intro\n\nVisible outro");
});

runTest("sanitizeSubagentResultForDisplay unwraps task_result payloads and strips metadata", () => {
  const rawText = [
    "<task_result>",
    "Answer line",
    "<REASONING>hidden block</REASONING>",
    "```thinking",
    "hidden fence",
    "```",
    "analysis: hidden line",
    "Final line",
    "</task_result>",
  ].join("\r\n");

  assert.equal(sanitizeSubagentResultForDisplay(rawText), "Answer line\n\nFinal line");
});

runTest("sanitizeSubagentResultForDisplay unwraps report payloads into markdown", () => {
  const rawText = [
    "<task_result>",
    '{"report":"## TASK COMPLETION REPORT\\n\\n- Wrapped output"}',
    "</task_result>",
  ].join("\n");

  assert.equal(
    sanitizeSubagentResultForDisplay(rawText),
    "## TASK COMPLETION REPORT\n\n- Wrapped output",
  );
});

runTest("sanitizeSubagentResultForDisplay unwraps nested markdown payloads", () => {
  const rawText = JSON.stringify({
    result: {
      markdown: "# Summary\n\nVisible content",
    },
  });

  assert.equal(sanitizeSubagentResultForDisplay(rawText), "# Summary\n\nVisible content");
});

runTest("sanitizeSubagentResultForDisplay preserves unsupported JSON payloads", () => {
  const rawText = '{"ok":true,"details":[1,2,3]}';
  assert.equal(sanitizeSubagentResultForDisplay(rawText), rawText);
});

runTest("sanitizeSubagentResultForDisplay preserves plain output without thinking markers", () => {
  assert.equal(sanitizeSubagentResultForDisplay("Completed successfully."), "Completed successfully.");
});

console.log("All output-sanitizer tests passed.");
