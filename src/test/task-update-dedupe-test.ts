import assert from "node:assert/strict";

import { SPINNER_RENDER_INTERVAL_MS } from "../progress-spinner";
import {
  buildTaskToolPartialUpdateFingerprint,
  createTaskToolPartialUpdateGate,
  resolveTaskToolUpdateCadence,
  TASK_TOOL_HEARTBEAT_INTERVAL_MS,
  TASK_TOOL_INTERACTIVE_HEARTBEAT_INTERVAL_MS,
  TASK_TOOL_INTERACTIVE_PARTIAL_UPDATE_MIN_INTERVAL_MS,
  TASK_TOOL_INTERACTIVE_UNCHANGED_FRAME_INTERVAL_MS,
} from "../task/task-update-dedupe";

import type { SubagentExecutionDetails } from "../types";

type ParallelSummary = NonNullable<SubagentExecutionDetails["summary"]>;
type ParallelResult = NonNullable<SubagentExecutionDetails["results"]>[number];

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function createSummary(overrides: Partial<ParallelSummary> = {}): ParallelSummary {
  return {
    total: 1,
    succeeded: 0,
    failed: 0,
    running: 1,
    queued: 0,
    aborted: 0,
    ...overrides,
  };
}

function createResult(overrides: Partial<ParallelResult> = {}): ParallelResult {
  return {
    index: 1,
    delegatedAgent: "ask",
    delegatedTask: "Investigate renderer output",
    taskLabel: "TaskOne",
    status: "running",
    sessionId: "abcdef123456",
    toolCalls: 1,
    latestToolCall: "read index.ts",
    output: "→ read index.ts",
    ...overrides,
  };
}

runTest("partial update gate dedupes identical frames and throttles rapid changes", () => {
  let now = 1_000;
  const gate = createTaskToolPartialUpdateGate({
    now: () => now,
    minIntervalMs: 400,
  });

  assert.equal(gate.shouldEmit({ fingerprint: "frame-a" }), true);
  assert.equal(gate.shouldEmit({ fingerprint: "frame-a" }), false);

  now += 100;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-b" }), false);

  now += 400;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-b" }), true);
});

runTest("partial update gate skips fingerprint work while cadence suppresses all changes", () => {
  let now = 1_000;
  const gate = createTaskToolPartialUpdateGate({
    now: () => now,
    minIntervalMs: 400,
  });

  assert.equal(gate.shouldBuildFingerprint(), true);
  assert.equal(gate.shouldEmit({ fingerprint: "frame-a" }), true);

  now += 100;
  assert.equal(gate.shouldBuildFingerprint(), false);

  now += 300;
  assert.equal(gate.shouldBuildFingerprint(), true);
});

runTest("partial update gate force option bypasses throttle for changed state", () => {
  let now = 2_000;
  const gate = createTaskToolPartialUpdateGate({
    now: () => now,
    minIntervalMs: 1_000,
  });

  assert.equal(gate.shouldEmit({ fingerprint: "frame-a" }), true);

  now += 50;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-b", force: true }), true);

  now += 50;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-b", force: true }), false);
});

runTest("partial update gate can emit unchanged frames when interactive cadence is enabled", () => {
  let now = 10_000;
  const gate = createTaskToolPartialUpdateGate({
    now: () => now,
    minIntervalMs: 500,
    unchangedFrameIntervalMs: 100,
  });

  assert.equal(gate.shouldEmit({ fingerprint: "frame-a" }), true);

  now += 50;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-a" }), false);

  now += 60;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-a" }), true);

  now += 10;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-b" }), false);

  now += 500;
  assert.equal(gate.shouldEmit({ fingerprint: "frame-b" }), true);
});

runTest("resolveTaskToolUpdateCadence uses reduced interactive heartbeat cadence", () => {
  const cadence = resolveTaskToolUpdateCadence({
    hasUI: true,
    outputMode: "tui",
  });

  assert.equal(cadence.mode, "interactive");
  assert.equal(cadence.minIntervalMs, TASK_TOOL_INTERACTIVE_PARTIAL_UPDATE_MIN_INTERVAL_MS);
  assert.equal(cadence.heartbeatIntervalMs, TASK_TOOL_INTERACTIVE_HEARTBEAT_INTERVAL_MS);
  assert.equal(cadence.unchangedFrameIntervalMs, TASK_TOOL_INTERACTIVE_UNCHANGED_FRAME_INTERVAL_MS);
  assert.ok(cadence.minIntervalMs > SPINNER_RENDER_INTERVAL_MS);
  assert.ok(cadence.heartbeatIntervalMs > SPINNER_RENDER_INTERVAL_MS);
});

runTest("interactive cadence coalesces rapid changed stream frames across spinner ticks", () => {
  const cadence = resolveTaskToolUpdateCadence({ hasUI: true, outputMode: "tui" });
  let now = cadence.minIntervalMs;
  const gate = createTaskToolPartialUpdateGate({
    now: () => now,
    minIntervalMs: cadence.minIntervalMs,
    unchangedFrameIntervalMs: cadence.unchangedFrameIntervalMs,
  });

  let emitted = 0;
  for (let tick = 0; tick < 8; tick += 1) {
    if (gate.shouldEmit({ fingerprint: `frame-${tick}` })) {
      emitted += 1;
    }

    now += SPINNER_RENDER_INTERVAL_MS;
  }

  assert.equal(emitted, 4);
});

runTest("interactive cadence spaces unchanged frames beyond a single spinner tick", () => {
  const cadence = resolveTaskToolUpdateCadence({ hasUI: true, outputMode: "tui" });
  let now = cadence.heartbeatIntervalMs;
  const gate = createTaskToolPartialUpdateGate({
    now: () => now,
    minIntervalMs: cadence.minIntervalMs,
    unchangedFrameIntervalMs: cadence.unchangedFrameIntervalMs,
  });

  const emissions: number[] = [];
  for (let tick = 0; tick < 7; tick += 1) {
    if (gate.shouldEmit({ fingerprint: "steady-frame" })) {
      emissions.push(now);
    }

    now += SPINNER_RENDER_INTERVAL_MS;
  }

  assert.deepEqual(emissions, [cadence.heartbeatIntervalMs, cadence.heartbeatIntervalMs + cadence.unchangedFrameIntervalMs, cadence.heartbeatIntervalMs + cadence.unchangedFrameIntervalMs * 2]);
});

runTest("resolveTaskToolUpdateCadence keeps non-interactive json mode low-spam", () => {
  const cadence = resolveTaskToolUpdateCadence({
    hasUI: true,
    outputMode: "json",
  });

  assert.equal(cadence.mode, "non_interactive");
  assert.equal(cadence.heartbeatIntervalMs, TASK_TOOL_HEARTBEAT_INTERVAL_MS);
  assert.equal(cadence.unchangedFrameIntervalMs, undefined);
});

runTest("resolveTaskToolUpdateCadence treats --mode=json argv as non-interactive", () => {
  const cadence = resolveTaskToolUpdateCadence({
    hasUI: true,
    argv: ["pi", "--mode", "json"],
  });

  assert.equal(cadence.mode, "non_interactive");
  assert.equal(cadence.heartbeatIntervalMs, TASK_TOOL_HEARTBEAT_INTERVAL_MS);
});

runTest("heartbeat simulation shows interactive emits more frames than json mode", () => {
  const interactiveCadence = resolveTaskToolUpdateCadence({ hasUI: true });
  const nonInteractiveCadence = resolveTaskToolUpdateCadence({
    hasUI: false,
    outputMode: "json",
  });

  let interactiveNow = 0;
  let nonInteractiveNow = 0;
  const interactiveGate = createTaskToolPartialUpdateGate({
    now: () => interactiveNow,
    minIntervalMs: interactiveCadence.minIntervalMs,
    unchangedFrameIntervalMs: interactiveCadence.unchangedFrameIntervalMs,
  });
  const nonInteractiveGate = createTaskToolPartialUpdateGate({
    now: () => nonInteractiveNow,
    minIntervalMs: nonInteractiveCadence.minIntervalMs,
    unchangedFrameIntervalMs: nonInteractiveCadence.unchangedFrameIntervalMs,
  });

  let interactiveEmits = 0;
  let nonInteractiveEmits = 0;

  for (let tick = 0; tick < 30; tick += 1) {
    interactiveNow += interactiveCadence.heartbeatIntervalMs;
    nonInteractiveNow += nonInteractiveCadence.heartbeatIntervalMs;

    if (interactiveGate.shouldEmit({ fingerprint: "steady-running-frame" })) {
      interactiveEmits += 1;
    }

    if (nonInteractiveGate.shouldEmit({ fingerprint: "steady-running-frame" })) {
      nonInteractiveEmits += 1;
    }
  }

  console.log(
    `[INFO] heartbeat simulation interactive=${interactiveEmits} nonInteractive=${nonInteractiveEmits}`,
  );

  assert.ok(interactiveEmits >= 25);
  assert.equal(nonInteractiveEmits, 1);
  assert.ok(interactiveEmits > nonInteractiveEmits * 10);
});

runTest("fingerprint ignores duration-only changes but catches meaningful tool changes", () => {
  const summary = createSummary();
  const baseResult = createResult({ duration: 1000 });

  const baseline = buildTaskToolPartialUpdateFingerprint({
    message: "Task delegation progress: 0/1 done",
    status: "running",
    summary,
    results: [baseResult],
  });

  const durationOnly = buildTaskToolPartialUpdateFingerprint({
    message: "Task delegation progress: 0/1 done",
    status: "running",
    summary,
    results: [createResult({ duration: 2000 })],
  });

  const toolChanged = buildTaskToolPartialUpdateFingerprint({
    message: "Task delegation progress: 0/1 done",
    status: "running",
    summary,
    results: [
      createResult({
        latestToolCall: "grep \"Ask Task\" index.ts",
        toolCalls: 2,
      }),
    ],
  });

  assert.equal(durationOnly, baseline);
  assert.notEqual(toolChanged, baseline);
});

runTest("fingerprint coalesces running stream churn until rendered activity changes", () => {
  const summary = createSummary();

  const baseline = buildTaskToolPartialUpdateFingerprint({
    message: "Task delegation progress: 0/1 done",
    status: "running",
    summary,
    results: [
      createResult({
        latestToolCall: undefined,
        output: "→ read src/index.ts\nStreaming more file content",
      }),
    ],
  });

  const sameActivityOutput = buildTaskToolPartialUpdateFingerprint({
    message: "Task delegation progress: 0/1 done",
    status: "running",
    summary,
    results: [
      createResult({
        latestToolCall: undefined,
        output:
          "→ read src/index.ts\nStreaming more file content\nStill reading the same file chunk",
      }),
    ],
  });

  const changedActivityOutput = buildTaskToolPartialUpdateFingerprint({
    message: "Task delegation progress: 0/1 done",
    status: "running",
    summary,
    results: [
      createResult({
        latestToolCall: undefined,
        output: "→ edit src/index.ts\nApplying replacement",
      }),
    ],
  });

  assert.equal(sameActivityOutput, baseline);
  assert.notEqual(changedActivityOutput, baseline);
});

console.log("All task update dedupe tests passed.");
