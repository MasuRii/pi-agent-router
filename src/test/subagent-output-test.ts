import assert from "node:assert/strict";

import type { Message } from "@mariozechner/pi-ai";

import {
  appendBoundedOutputSection,
  getLatestSubagentToolCallLabel,
  getSubagentLiveOutputFromMessages,
  getSubagentToolInvocationsFromState,
  processSubagentJsonEventLine,
  summarizeSubagentToolInvocations,
} from "../subagent/subagent-output";
import {
  SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
} from "../constants";
import { createSubagentJsonEventState } from "../subagent/subagent-usage";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("processSubagentJsonEventLine accepts assistant messages with string content", () => {
  const state = createSubagentJsonEventState();

  processSubagentJsonEventLine(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: "<thinking>hidden</thinking>Visible answer",
        usage: {
          input: 12,
          output: 34,
        },
      },
    }),
    state,
  );

  assert.equal(state.messages.length, 1);
  assert.equal(state.usage.turns, 1);
  assert.equal(state.usage.input, 12);
  assert.equal(state.usage.output, 34);
  assert.equal(getSubagentLiveOutputFromMessages(state.messages), "Visible answer");
});

runTest("getSubagentLiveOutputFromMessages preserves string assistant content and tool results", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      timestamp: Date.now(),
      content: "First answer",
    } as Message,
    {
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "src/index.ts" },
        } as Message["content"][number],
      ],
    } as Message,
    {
      role: "tool",
      timestamp: Date.now(),
      content: "Tool completed",
    } as Message,
  ];

  assert.equal(
    getSubagentLiveOutputFromMessages(messages),
    "First answer\n→ read src/index.ts\nTool completed",
  );
});

runTest("summarizeSubagentToolInvocations ignores assistant messages without structured parts", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      timestamp: Date.now(),
      content: "Plain text only",
    } as Message,
    {
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "toolCall",
          name: "grep",
          arguments: { pattern: "task", path: "src" },
        } as Message["content"][number],
        {
          type: "toolCall",
          name: "grep",
          arguments: { pattern: "task", path: "src" },
        } as Message["content"][number],
      ],
    } as Message,
  ];

  assert.deepEqual(summarizeSubagentToolInvocations(messages), [
    {
      name: "grep",
      argumentsPreview: "/task/ in src",
      count: 2,
    },
  ]);
});

runTest("getLatestSubagentToolCallLabel safely skips assistant messages with string content", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      timestamp: Date.now(),
      content: "No tool call yet",
    } as Message,
    {
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "toolCall",
          name: "bash",
          arguments: { command: "npm test" },
        } as Message["content"][number],
      ],
    } as Message,
  ];

  assert.equal(getLatestSubagentToolCallLabel(messages), "[bash] npm test");
});

runTest("appendBoundedOutputSection keeps the most recent derived output within the limit", () => {
  assert.equal(appendBoundedOutputSection("abcd", "efgh", 6), "d\nefgh");
  assert.equal(appendBoundedOutputSection("abcdef", "", 4), "cdef");
});

runTest("processSubagentJsonEventLine keeps bounded message history while preserving incremental output", () => {
  const state = createSubagentJsonEventState({ messageRetentionLimit: 3 });

  const events = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: "First answer",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "src/index.ts" },
          },
        ],
      },
    },
    {
      type: "tool_result_end",
      message: {
        role: "tool",
        content: "Tool result one",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: "Second answer",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "src/index.ts" },
          },
        ],
      },
    },
    {
      type: "tool_result_end",
      message: {
        role: "tool",
        content: "Tool result two",
      },
    },
  ];

  for (const event of events) {
    processSubagentJsonEventLine(JSON.stringify(event), state);
  }

  assert.equal(state.messages.length, 3);
  assert.equal(state.droppedMessageCount, 3);
  assert.equal(
    state.outputText,
    "First answer\n→ read src/index.ts\nTool result one\nSecond answer\n→ read src/index.ts\nTool result two",
  );
  assert.equal(state.latestToolCall, "[read] src/index.ts");
  assert.deepEqual(getSubagentToolInvocationsFromState(state), [
    {
      name: "read",
      argumentsPreview: "src/index.ts",
      count: 2,
    },
  ]);
  assert.equal(
    getSubagentLiveOutputFromMessages(state.messages),
    "Second answer\n→ read src/index.ts\nTool result two",
  );
});

runTest("processSubagentJsonEventLine keeps growth bounded across long streams", () => {
  const state = createSubagentJsonEventState({
    messageRetentionLimit: 4,
    outputTextMaxChars: 32,
  });

  for (let index = 0; index < 20; index += 1) {
    processSubagentJsonEventLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: `Chunk ${index}`,
        },
      }),
      state,
    );
  }

  assert.equal(state.messages.length, 4);
  assert.equal(state.droppedMessageCount, 16);
  assert.equal(state.usage.turns, 20);
  assert.equal(state.outputText.length <= 32, true);
  assert.equal(state.outputText.includes("Chunk 0"), false);
  assert.equal(state.outputText.endsWith("Chunk 17\nChunk 18\nChunk 19"), true);
  assert.equal(getSubagentLiveOutputFromMessages(state.messages), "Chunk 16\nChunk 17\nChunk 18\nChunk 19");
});

runTest("processSubagentJsonEventLine bounds retained messages by total size", () => {
  const state = createSubagentJsonEventState({
    messageRetentionLimit: 10,
    messageRetentionMaxChars: 140,
  });

  const messages = ["A".repeat(80), "B".repeat(80), "C".repeat(80)];
  for (const content of messages) {
    processSubagentJsonEventLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content,
        },
      }),
      state,
    );
  }

  assert.equal(state.messages.length, 1);
  assert.equal(state.droppedMessageCount, 2);
  assert.equal(state.retainedMessageChars <= 140, true);
  assert.equal(getSubagentLiveOutputFromMessages(state.messages), messages[2]);
  assert.equal(state.outputText.includes(messages[0]), true);
  assert.equal(state.outputText.endsWith(messages[2]), true);
});

runTest("processSubagentJsonEventLine bounds tracked tool invocations and previews", () => {
  const state = createSubagentJsonEventState({
    toolInvocationRetentionLimit: 2,
  });

  for (let index = 0; index < 5; index += 1) {
    processSubagentJsonEventLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
              arguments: {
                command: `command-${index}-${"x".repeat(400)}`,
              },
            },
          ],
        },
      }),
      state,
    );
  }

  const invocations = getSubagentToolInvocationsFromState(state);
  assert.equal(invocations.length, 2);
  assert.equal(state.toolInvocationTotalCount, 5);
  assert.equal(
    invocations.every(
      (item) => (item.argumentsPreview?.length ?? 0) <= SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
    ),
    true,
  );
  assert.equal(
    (state.latestToolCall?.length ?? 0) <= SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
    true,
  );
});

console.log("All subagent output tests passed.");
