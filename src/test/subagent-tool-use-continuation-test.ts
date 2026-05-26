import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
  getLatestAssistantStopReason,
  isToolUseStopReason,
  shouldContinueDelegatedToolUse,
} from "../subagent/tool-use-continuation";
import type { SubagentRunResult } from "../types";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function assistantMessage(stopReason: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" } as Message["content"][number]],
    stopReason,
    timestamp: Date.now(),
  } as Message;
}

function buildRun(overrides: Partial<SubagentRunResult> = {}): SubagentRunResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    sessionPath: "C:/Users/Administrator/.pi/agent/subagent-sessions/example/session.jsonl",
    messages: [assistantMessage("toolUse")],
    ...overrides,
  };
}

runTest("tool-use continuation recognizes common stopReason spellings", () => {
  assert.equal(isToolUseStopReason("toolUse"), true);
  assert.equal(isToolUseStopReason("tool_use"), true);
  assert.equal(isToolUseStopReason("tool-use"), true);
  assert.equal(isToolUseStopReason("stop"), false);
});

runTest("tool-use continuation allows nonzero delegated process exits", () => {
  const run = buildRun({ code: 1 });
  assert.equal(getLatestAssistantStopReason(run), "toolUse");
  assert.equal(shouldContinueDelegatedToolUse(run), true);
});

runTest("tool-use continuation can use retained session path fallback", () => {
  const run = buildRun({ code: 1, sessionPath: undefined });
  assert.equal(shouldContinueDelegatedToolUse(run, "C:/retained/session.jsonl"), true);
});

runTest("tool-use continuation rejects terminal, timed-out, and sessionless runs", () => {
  assert.equal(shouldContinueDelegatedToolUse(buildRun({ timedOut: true })), false);
  assert.equal(shouldContinueDelegatedToolUse(buildRun({ sessionPath: undefined })), false);
  assert.equal(
    shouldContinueDelegatedToolUse(buildRun({ messages: [assistantMessage("toolUse"), assistantMessage("stop")] })),
    false,
  );
});

console.log("All subagent tool-use continuation tests passed.");
