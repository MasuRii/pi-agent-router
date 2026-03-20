import assert from "node:assert/strict";

import { createOutputSink } from "../subagent/subagent-output-sink";

async function runTest(name: string, testFn: () => void | Promise<void>): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("large-stream simulation keeps each sink within its retained-memory envelope", async () => {
  const inMemoryMaxChars = 256;
  const sinks = Array.from({ length: 4 }, () =>
    createOutputSink({
      inMemoryMaxChars,
    }),
  );

  const chunk = "0123456789abcdef".repeat(32);
  for (let tick = 0; tick < 48; tick += 1) {
    for (const sink of sinks) {
      sink.push(chunk);
    }
  }

  const summaries = await Promise.all(sinks.map((sink) => sink.close()));
  const retainedChars = summaries.reduce(
    (total, summary) => total + summary.tailText.length,
    0,
  );

  for (const summary of summaries) {
    assert.ok(summary.tailText.length <= inMemoryMaxChars);
    assert.ok(summary.droppedChars > 0);
  }

  assert.ok(retainedChars <= sinks.length * inMemoryMaxChars);
});

await runTest("single dominant chunk still retains only the configured tail", async () => {
  const sink = createOutputSink({
    inMemoryMaxChars: 64,
  });

  sink.push("A".repeat(8));
  sink.push("B".repeat(4_096));

  const summary = await sink.close();

  assert.equal(summary.tailText, "B".repeat(64));
  assert.ok(summary.droppedChars >= 4_032);
});

console.log("All subagent memory regression tests passed.");
