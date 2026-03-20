import assert from "node:assert/strict";

import type { Message } from "@mariozechner/pi-ai";

import { validateSubagentOutputContract } from "../output-contract";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function assistantMessage(content: Message["content"]): Message {
  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
  } as Message;
}

runTest("validateSubagentOutputContract falls back to assistant text when submit_result is missing", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "text",
        text: "Fallback output",
      } as Message["content"][number],
    ]),
  ];

  const result = validateSubagentOutputContract({
    messages,
    schema: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
      },
    },
    strictness: "compat",
  });

  assert.equal(result.outputText, "Fallback output");
  assert.equal(result.warnings.length > 0, true);
  assert.equal(result.error, undefined);
});

runTest("validateSubagentOutputContract validates submit_result payload against schema", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "toolCall",
        name: "submit_result",
        arguments: {
          result: {
            ok: true,
          },
        },
      } as Message["content"][number],
    ]),
  ];

  const result = validateSubagentOutputContract({
    messages,
    schema: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
      },
      additionalProperties: false,
    },
    strictness: "strict",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.outputText.includes('"ok": true'), true);
});

runTest("validateSubagentOutputContract unwraps report payloads for display", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "toolCall",
        name: "submit_result",
        arguments: {
          report: "## TASK COMPLETION REPORT\n\n- Wrapped output",
        },
      } as Message["content"][number],
    ]),
  ];

  const result = validateSubagentOutputContract({
    messages,
    strictness: "compat",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.outputText, "## TASK COMPLETION REPORT\n\n- Wrapped output");
  assert.equal(result.submitResult, "## TASK COMPLETION REPORT\n\n- Wrapped output");
});

runTest("validateSubagentOutputContract renders nested markdown payloads from supported wrappers", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "toolCall",
        name: "submit_result",
        arguments: {
          result: {
            markdown: "# Summary\n\nVisible content",
          },
        },
      } as Message["content"][number],
    ]),
  ];

  const result = validateSubagentOutputContract({
    messages,
    strictness: "compat",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.outputText, "# Summary\n\nVisible content");
  assert.deepEqual(result.submitResult, {
    markdown: "# Summary\n\nVisible content",
  });
});

runTest("validateSubagentOutputContract returns strict-mode error for invalid schema payload", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "toolCall",
        name: "submit_result",
        arguments: {
          result: {
            ok: "yes",
          },
        },
      } as Message["content"][number],
    ]),
  ];

  const result = validateSubagentOutputContract({
    messages,
    schema: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
      },
    },
    strictness: "strict",
  });

  assert.equal(result.error, "Delegated output schema validation failed in strict mode.");
  assert.equal(result.warnings.length > 0, true);
});

console.log("All output-contract tests passed.");
