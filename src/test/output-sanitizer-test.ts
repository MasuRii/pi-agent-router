import assert from "node:assert/strict";

import {
  sanitizeStructuredSubagentResultForHandoff,
  sanitizeSubagentFinalResponseForHandoff,
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

runTest("sanitizeSubagentFinalResponseForHandoff removes streamed tool transcript prefixes", () => {
  const rawText = [
    "Earlier streamed content.",
    "→ read src/index.ts",
    "",
    "Final response only.",
  ].join("\n");

  assert.equal(
    sanitizeSubagentFinalResponseForHandoff(rawText),
    "Final response only.",
  );
});

runTest("sanitizeSubagentFinalResponseForHandoff keeps arbitrary final text and removes tool calls", () => {
  const rawText = [
    "→ grep contextFrom src",
    "Plain final result in an agent-specific format.",
    "",
    "Details stayed visible.",
    "→ read hidden.txt",
  ].join("\n");

  const sanitized = sanitizeSubagentFinalResponseForHandoff(rawText);
  assert.equal(sanitized.includes("Plain final result in an agent-specific format."), true);
  assert.equal(sanitized.includes("Details stayed visible."), true);
  assert.equal(sanitized.includes("→"), false);
});

runTest("sanitizeSubagentFinalResponseForHandoff preserves report-style output as ordinary final text", () => {
  const rawText = [
    "→ grep contextFrom src",
    "## TASK COMPLETION REPORT",
    "",
    "### Summary",
    "Completed without leaking transcript lines.",
    "→ read hidden.txt",
  ].join("\n");

  const sanitized = sanitizeSubagentFinalResponseForHandoff(rawText);
  assert.equal(sanitized.includes("## TASK COMPLETION REPORT"), true);
  assert.equal(sanitized.includes("Completed without leaking transcript lines."), true);
  assert.equal(sanitized.includes("→"), false);
});

runTest("sanitizeSubagentFinalResponseForHandoff can reject pre-tool streamed text when no terminal final exists", () => {
  const rawText = [
    "Streaming analysis before tool use.",
    "→ read hidden.txt",
  ].join("\n");

  assert.equal(
    sanitizeSubagentFinalResponseForHandoff(rawText, {
      allowPreToolTextWhenNoTrailingFinal: false,
    }),
    "",
  );
});

runTest("sanitizeStructuredSubagentResultForHandoff recursively strips transcript lines from strings", () => {
  const sanitized = sanitizeStructuredSubagentResultForHandoff({
    report: "Final report\n→ read secret.txt",
    nested: {
      items: ["Keep this detail\n→ grep hidden src"],
      jsonText: '{"summary":"Nested JSON summary\\n→ read nested-secret.txt"}',
    },
  });

  assert.deepEqual(sanitized, {
    report: "Final report",
    nested: {
      items: ["Keep this detail"],
      jsonText: JSON.stringify({ summary: "Nested JSON summary" }, null, 2),
    },
  });
});

console.log("All output-sanitizer tests passed.");
