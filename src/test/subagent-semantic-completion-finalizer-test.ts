import assert from "node:assert/strict";

import {
  createSubagentSemanticCompletionFinalizer,
  type SubagentSemanticCompletionFinalizeEvent,
} from "../subagent/semantic-completion-finalizer";
import { processSubagentJsonEventLine } from "../subagent/subagent-output";
import { createSubagentJsonEventState } from "../subagent/subagent-usage";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

type ScheduledTimer = {
  callback: () => void;
  delayMs: number;
  active: boolean;
};

function createFakeTimers() {
  const scheduled: ScheduledTimer[] = [];

  return {
    scheduled,
    timers: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const timer: ScheduledTimer = { callback, delayMs, active: true };
        scheduled.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        (handle as unknown as ScheduledTimer).active = false;
      },
    },
    runNext: () => {
      const timer = scheduled.find((entry) => entry.active);
      assert.ok(timer, "expected an active scheduled timer");
      timer.active = false;
      timer.callback();
      return timer.delayMs;
    },
    runAll: () => {
      while (scheduled.some((entry) => entry.active)) {
        const timer = scheduled.find((entry) => entry.active);
        assert.ok(timer);
        timer.active = false;
        timer.callback();
      }
    },
  };
}

function buildAssistantEvent(options: {
  text?: string;
  stopReason?: string;
  type?: "message_start" | "message_update" | "message_end";
  content?: unknown;
}): string {
  return JSON.stringify({
    type: options.type ?? "message_end",
    message: {
      role: "assistant",
      content: options.content ?? [{ type: "text", text: options.text ?? "" }],
      stopReason: options.stopReason,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 2 },
    },
  });
}

function buildToolResultEvent(): string {
  return JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "tool",
      content: "tool output",
    },
  });
}

const terminalAnswer = "Universal final assistant answer.";

await runTest("semantic completion detector uses terminal assistant stop events without report text", () => {
  const state = createSubagentJsonEventState();

  const updateResult = processSubagentJsonEventLine(
    buildAssistantEvent({ type: "message_update", stopReason: "stop", text: terminalAnswer }),
    state,
  );
  assert.equal(updateResult.semanticCompletion, undefined);

  const finalResult = processSubagentJsonEventLine(
    buildAssistantEvent({ stopReason: "stop", text: terminalAnswer }),
    state,
  );
  assert.equal(finalResult.semanticCompletion?.stopReason, "stop");
  assert.equal(finalResult.semanticCompletion?.finalResponseText, terminalAnswer);
  assert.equal(state.finalResponseText, terminalAnswer);
});

await runTest("semantic completion detector ignores non-terminal and unsafe terminal events", () => {
  const cases = [
    buildAssistantEvent({ type: "message_start", stopReason: "stop", text: terminalAnswer }),
    buildAssistantEvent({ type: "message_update", stopReason: "stop", text: terminalAnswer }),
    buildAssistantEvent({ stopReason: "length", text: terminalAnswer }),
    buildAssistantEvent({ stopReason: "toolUse", text: terminalAnswer }),
    buildAssistantEvent({ stopReason: "error", text: terminalAnswer }),
    buildAssistantEvent({ stopReason: "aborted", text: terminalAnswer }),
    buildAssistantEvent({
      stopReason: "stop",
      content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/index.ts" } }],
    }),
    buildToolResultEvent(),
  ];

  for (const eventLine of cases) {
    const state = createSubagentJsonEventState();
    const result = processSubagentJsonEventLine(eventLine, state);
    assert.equal(result.semanticCompletion, undefined);
  }
});

await runTest("semantic completion finalizer resolves old close-event hang without long sleeps", () => {
  const timerApi = createFakeTimers();
  const state = createSubagentJsonEventState();
  const processResult = processSubagentJsonEventLine(
    buildAssistantEvent({ stopReason: "stop", text: terminalAnswer }),
    state,
  );
  assert.ok(processResult.semanticCompletion);

  let processRunning = true;
  const terminateSignals: NodeJS.Signals[] = [];
  const finalized: SubagentSemanticCompletionFinalizeEvent[] = [];
  let terminationStarted = 0;

  const finalizer = createSubagentSemanticCompletionFinalizer({
    completionGraceMs: 50,
    hardKillDelayMs: 10,
    forcedFinalizeGraceMs: 5,
    timers: timerApi.timers,
    isProcessStillRunning: () => processRunning,
    terminateProcess: (signal) => {
      terminateSignals.push(signal);
      if (signal === "SIGKILL") {
        processRunning = false;
      }
    },
    onTerminationStarted: () => {
      terminationStarted += 1;
    },
    onFinalize: (event) => finalized.push(event),
  });

  finalizer.recordSemanticCompletion(processResult.semanticCompletion);

  assert.equal(finalized.length, 0);
  assert.equal(timerApi.runNext(), 50);
  assert.equal(terminationStarted, 1);
  assert.deepEqual(terminateSignals, ["SIGTERM"]);
  assert.equal(finalized.length, 0);

  assert.equal(timerApi.runNext(), 10);
  assert.deepEqual(terminateSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(processRunning, false);

  assert.equal(timerApi.runNext(), 15);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].signal.stopReason, "stop");
  assert.equal(finalized[0].signal.finalResponseText, terminalAnswer);
  assert.equal(finalized[0].forcedAfterMs, 65);
});

await runTest("semantic completion finalizer delays termination after post-completion process activity", () => {
  const timerApi = createFakeTimers();
  const state = createSubagentJsonEventState();
  const processResult = processSubagentJsonEventLine(
    buildAssistantEvent({ stopReason: "stop", text: terminalAnswer }),
    state,
  );
  assert.ok(processResult.semanticCompletion);

  const terminateSignals: NodeJS.Signals[] = [];
  let terminationStarted = 0;

  const finalizer = createSubagentSemanticCompletionFinalizer({
    completionGraceMs: 50,
    hardKillDelayMs: 10,
    forcedFinalizeGraceMs: 5,
    timers: timerApi.timers,
    isProcessStillRunning: () => true,
    terminateProcess: (signal) => {
      terminateSignals.push(signal);
    },
    onTerminationStarted: () => {
      terminationStarted += 1;
    },
    onFinalize: () => undefined,
  });

  finalizer.recordSemanticCompletion(processResult.semanticCompletion);
  assert.equal(timerApi.scheduled.length, 1);
  assert.equal(timerApi.scheduled[0].active, true);

  finalizer.recordProcessActivity();

  assert.equal(timerApi.scheduled.length, 2);
  assert.equal(timerApi.scheduled[0].active, false);
  assert.equal(timerApi.scheduled[1].active, true);

  assert.equal(timerApi.runNext(), 50);
  assert.equal(terminationStarted, 1);
  assert.deepEqual(terminateSignals, ["SIGTERM"]);
});

await runTest("semantic completion finalizer cancels when process close completes first", () => {
  const timerApi = createFakeTimers();
  const state = createSubagentJsonEventState();
  const processResult = processSubagentJsonEventLine(
    buildAssistantEvent({ stopReason: "stop", text: terminalAnswer }),
    state,
  );
  assert.ok(processResult.semanticCompletion);

  const finalized: SubagentSemanticCompletionFinalizeEvent[] = [];
  const finalizer = createSubagentSemanticCompletionFinalizer({
    completionGraceMs: 50,
    hardKillDelayMs: 10,
    forcedFinalizeGraceMs: 5,
    timers: timerApi.timers,
    isProcessStillRunning: () => true,
    terminateProcess: () => {
      throw new Error("should not terminate after close path stops finalizer");
    },
    onFinalize: (event) => finalized.push(event),
  });

  finalizer.recordSemanticCompletion(processResult.semanticCompletion);
  finalizer.stop();
  timerApi.runAll();

  assert.equal(finalized.length, 0);
});

console.log("All subagent semantic completion finalizer tests passed.");
