import assert from "node:assert/strict";

import { renderParallelDelegationResult } from "../task/parallel-delegation-renderer";
import { renderTaskDelegationCall } from "../task/task-call-renderer";
import { renderSingleDelegationResult } from "../task/task-result-renderer";
import type { TaskDisplayTheme } from "../task/task-display-primitives";
import type { SubagentExecutionDetails } from "../types";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

const theme: TaskDisplayTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function renderNodeText(node: unknown): string {
  const record = node as {
    text?: unknown;
    children?: unknown[];
    render?: (width: number) => string[];
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  if (Array.isArray(record.children)) {
    return record.children.map(renderNodeText).join("\n");
  }

  if (typeof record.render === "function") {
    return record.render(200).join("\n");
  }

  return "";
}

function makeDetails(overrides: Partial<SubagentExecutionDetails> = {}): SubagentExecutionDetails {
  return {
    delegatedBy: "orchestrator",
    delegatedAgent: "code",
    delegatedTask: "Task ID: RenderTask\nDescription: Inspect renderer output\n\nAssignment:\nSummarize behavior.",
    status: "finished",
    sessionId: "12345678-aaaa-bbbb-cccc-123456789abc",
    duration: 61_000,
    model: "openai/gpt-4.1",
    thinkingLevel: "medium",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 150,
      turns: 2,
    },
    ...overrides,
  };
}

runTest("renderTaskDelegationCall reports invalid payloads and valid delegation summaries", () => {
  const invalidText = renderNodeText(renderTaskDelegationCall({ tasks: [] }, theme));
  assert.equal(invalidText.includes("invalid payload: no task items"), true);

  const validText = renderNodeText(renderTaskDelegationCall({
    mode: "chain",
    tasks: [
      { id: "one", description: "One", assignment: "Do one", agent: "code" },
      { id: "two", description: "Two", assignment: "Do two", agent: "review" },
    ],
  }, theme));
  assert.equal(validText.includes("2 tasks"), true);
  assert.equal(validText.includes("chain"), true);
  assert.equal(validText.includes("code, review"), true);
});

runTest("renderSingleDelegationResult shows running state and attach hints", () => {
  const rendered = renderNodeText(renderSingleDelegationResult({
    result: { content: [{ type: "text", text: "" }] },
    details: makeDetails({
      status: "running",
      liveOutput: "Preparing analysis",
    }),
    status: "running",
    isPartial: true,
    expanded: false,
    theme,
  }));

  assert.equal(rendered.includes("Code Task"), true);
  assert.equal(rendered.includes("Inspect renderer output"), true);
  assert.equal(rendered.includes("⌨ Type /attach 12345678 to view output"), true);
});

runTest("renderSingleDelegationResult shows final summaries, warnings, and footer metadata", () => {
  const rendered = renderNodeText(renderSingleDelegationResult({
    result: { content: [{ type: "text", text: "Final renderer summary." }] },
    details: makeDetails({
      contractWarnings: ["Missing submit_result payload", "Fallback text used"],
    }),
    status: "finished",
    isPartial: false,
    expanded: true,
    theme,
  }));

  assert.equal(rendered.includes("Output contract incomplete"), true);
  assert.equal(rendered.includes("Missing submit_result payload"), true);
  assert.equal(rendered.includes("Fallback text used"), true);
  assert.equal(rendered.includes("GPT-4.1 (OpenAI)"), true);
  assert.equal(rendered.includes("medium"), true);
  assert.equal(rendered.includes("tokens 100 in / 50 out"), true);
});

runTest("renderParallelDelegationResult handles empty and compact hidden-result states", () => {
  const emptyText = renderNodeText(renderParallelDelegationResult(
    makeDetails({ results: [] }),
    false,
    theme,
  ));
  assert.equal(emptyText.includes("No delegated task results available yet."), true);

  const rendered = renderNodeText(renderParallelDelegationResult(makeDetails({
    results: [1, 2, 3, 4].map((index) => ({
      index,
      delegatedAgent: index === 4 ? "review" : "code",
      delegatedTask: `Task ID: Task${index}\nDescription: Render task ${index}\n\nAssignment:\nDo ${index}.`,
      taskDescription: `Render task ${index}`,
      status: "finished",
      output: `Final output ${index}`,
      toolCalls: index,
    })),
  }), false, theme));

  assert.equal(rendered.includes("Render task 1"), true);
  assert.equal(rendered.includes("Render task 3"), true);
  assert.equal(rendered.includes("Render task 4"), false);
  assert.equal(rendered.includes("… 1 additional task(s) hidden • Ctrl+O"), true);
});

runTest("renderParallelDelegationResult shows expanded warnings and running hints", () => {
  const rendered = renderNodeText(renderParallelDelegationResult(makeDetails({
    results: [
      {
        index: 1,
        delegatedAgent: "code",
        delegatedTask: "Task ID: TaskOne\nDescription: Running render\n\nAssignment:\nRun.",
        taskDescription: "Running render",
        status: "running",
        sessionId: "87654321-bbbb-cccc-dddd-abcdefabcdef",
        output: "",
        latestToolCall: "read src/index.ts",
        toolCalls: 1,
      },
      {
        index: 2,
        delegatedAgent: "review",
        delegatedTask: "Task ID: TaskTwo\nDescription: Warning render\n\nAssignment:\nReview.",
        taskDescription: "Warning render",
        status: "finished",
        output: "Final review output",
        contractWarnings: ["Structured result missing"],
        toolCalls: 0,
      },
    ],
  }), true, theme, true));

  assert.equal(rendered.includes("Running render"), true);
  assert.equal(rendered.includes("⌨ Type /attach 87654321 to view output"), true);
  assert.equal(rendered.includes("Structured result missing"), true);
});

console.log("All task renderer tests passed.");
