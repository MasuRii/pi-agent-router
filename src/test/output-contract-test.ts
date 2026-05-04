import assert from "node:assert/strict";

import type { Message } from "@mariozechner/pi-ai";

import {
  normalizeDelegatedOutput,
  validateSubagentOutputContract,
} from "../output-contract";

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

runTest("normalizeDelegatedOutput prefers explicit submit_result payloads", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "text",
        text: "Fallback output",
      } as Message["content"][number],
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

  const result = normalizeDelegatedOutput({
    messages,
    fallbackOutputText: "Fallback output",
  });

  assert.equal(result.outputText, "# Summary\n\nVisible content");
  assert.equal(result.source, "submit_result");
  assert.equal(result.format, "structured");
  assert.deepEqual(result.submitResult, {
    markdown: "# Summary\n\nVisible content",
  });
});

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
  assert.equal(result.source, "assistant_output");
  assert.equal(result.format, "human_text");
  assert.equal(result.warnings.length > 0, true);
  assert.equal(
    result.warnings[0],
    "Structured output schema was provided, but the subagent returned a human-readable final response instead of submit_result. Preserved the final response text.",
  );
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
  assert.equal(result.source, "submit_result");
  assert.equal(result.format, "structured");
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

runTest("normalizeDelegatedOutput strips nested transcript lines from structured output text", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "toolCall",
        name: "submit_result",
        arguments: {
          result: {
            summary: "Done",
            details: "Visible detail\n→ read secret.txt",
            nested: {
              value: "Keep this\n→ grep hidden src",
            },
          },
        },
      } as Message["content"][number],
    ]),
  ];

  const result = normalizeDelegatedOutput({ messages });

  assert.equal(result.outputText.includes("Visible detail"), true);
  assert.equal(result.outputText.includes("Keep this"), true);
  assert.equal(result.outputText.includes("→"), false);
  assert.equal(result.outputText.includes("secret.txt"), false);
  assert.equal(result.outputText.includes("grep hidden"), false);
});

runTest("normalizeDelegatedOutput parses JSON strings nested in submit_result result fields", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "toolCall",
        name: "submit_result",
        arguments: {
          result: '{"ok":true,"summary":"Done"}',
        },
      } as Message["content"][number],
    ]),
  ];

  const result = normalizeDelegatedOutput({
    messages,
    schema: {
      type: "object",
      required: ["ok", "summary"],
      properties: {
        ok: { type: "boolean" },
        summary: { type: "string" },
      },
      additionalProperties: false,
    },
    strictness: "strict",
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.submitResult, {
    ok: true,
    summary: "Done",
  });
  assert.equal(result.outputText.includes('"summary": "Done"'), true);
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

runTest("validateSubagentOutputContract returns strict-mode error when schema requires submit_result", () => {
  const messages: Message[] = [
    assistantMessage([
      {
        type: "text",
        text: "## TASK COMPLETION REPORT\n\nCompleted successfully.",
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

  assert.equal(
    result.error,
    "Delegated output must call submit_result when schema validation is strict.",
  );
  assert.equal(result.outputText, "## TASK COMPLETION REPORT\n\nCompleted successfully.");
  assert.equal(result.source, "assistant_output");
  assert.equal(result.format, "human_text");
});

runTest("normalizeDelegatedOutput uses latest assistant final response instead of streamed tool transcript", () => {
  const messages: Message[] = [
    assistantMessage("Investigating before final response."),
    assistantMessage([
      {
        type: "toolCall",
        name: "read",
        arguments: { path: "secret.txt" },
      } as Message["content"][number],
    ]),
    {
      role: "tool",
      content: "secret tool result must not be handed off",
      timestamp: Date.now(),
    } as Message,
    assistantMessage("Final response only."),
  ];

  const result = normalizeDelegatedOutput({
    messages,
    fallbackOutputText: [
      "Investigating before final response.",
      "→ read secret.txt",
      "secret tool result must not be handed off",
      "Final response only.",
    ].join("\n"),
  });

  assert.equal(result.outputText, "Final response only.");
  assert.equal(result.source, "assistant_output");
  assert.equal(result.outputText.includes("→ read"), false);
  assert.equal(result.outputText.includes("secret tool result"), false);
});

runTest("normalizeDelegatedOutput extracts fallback final response without tool-call transcript lines", () => {
  const result = normalizeDelegatedOutput({
    messages: [],
    fallbackOutputText: [
      "Streaming analysis before tool use.",
      "→ read src/index.ts",
      "",
      "Final fallback response only.",
    ].join("\n"),
  });

  assert.equal(result.outputText, "Final fallback response only.");
  assert.equal(result.source, "streamed_output");
  assert.equal(result.outputText.includes("→ read"), false);
  assert.equal(result.outputText.includes("Streaming analysis"), false);
});

runTest("normalizeDelegatedOutput uses captured final response before ambiguous streamed transcript", () => {
  const result = normalizeDelegatedOutput({
    messages: [],
    finalResponseText: "Plain final answer from arbitrary agent.",
    fallbackOutputText: [
      "Earlier streamed content.",
      "→ read secret.txt",
      "secret tool result must not be handed off",
    ].join("\n"),
  });

  assert.equal(result.outputText, "Plain final answer from arbitrary agent.");
  assert.equal(result.source, "assistant_output");
  assert.equal(result.outputText.includes("secret"), false);
});

runTest("normalizeDelegatedOutput omits ambiguous streamed transcripts without terminal final text", () => {
  const result = normalizeDelegatedOutput({
    messages: [],
    fallbackOutputText: [
      "Streaming analysis before tool use.",
      "→ read secret.txt",
      "secret tool result must not be handed off",
    ].join("\n"),
  });

  assert.equal(result.outputText, "");
  assert.equal(result.source, "empty");
  assert.equal(result.warnings.includes("No handoff-safe terminal final response was available; omitted ambiguous streamed transcript text."), true);
});

runTest("normalizeDelegatedOutput surfaces compact assistant error messages", () => {
  const result = normalizeDelegatedOutput({
    messages: [
      {
        role: "assistant",
        content: [],
        timestamp: Date.now(),
        stopReason: "error",
        errorMessage: [
          "Multi-auth rotation failed",
          "Provider: openai-codex",
          "Model: gpt-5.5",
          "Reason: Provider request failed after credential rotation was exhausted.",
          "Action: Review the provider response below, then retry with another credential/provider if needed.",
          "Verbose provider response: " + "x".repeat(5_000),
        ].join("\n"),
      } as Message,
    ],
  });

  assert.equal(result.source, "assistant_error");
  assert.equal(result.format, "human_text");
  assert.equal(result.error, result.outputText);
  assert.equal(result.outputText.includes("Multi-auth rotation failed"), true);
  assert.equal(result.outputText.includes("Provider: openai-codex"), true);
  assert.equal(result.outputText.includes("x".repeat(1_000)), false);
  assert.equal(result.outputText.length <= 1_200, true);
});

console.log("All output-contract tests passed.");
