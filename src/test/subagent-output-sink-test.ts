import assert from "node:assert/strict";

import {
  LazyTailTextBuffer,
  createOutputSink,
} from "../subagent/subagent-output-sink";

async function runTest(name: string, testFn: () => void | Promise<void>): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("tail buffer keeps only the most recent text after many appends", () => {
  const buffer = new LazyTailTextBuffer(8);

  buffer.append("ab");
  buffer.append("cd");
  buffer.append("ef");
  buffer.append("gh");
  buffer.append("ij");

  assert.equal(buffer.text(), "cdefghij");
  assert.ok(buffer.bytes() >= buffer.text().length);
});

await runTest("tail buffer keeps the tail from a single oversized chunk", () => {
  const buffer = new LazyTailTextBuffer(5);
  buffer.append("abcdefghij");
  assert.equal(buffer.text(), "fghij");
});

await runTest("output sink retains only the configured tail in memory", async () => {
  const sink = createOutputSink({
    inMemoryMaxChars: 6,
  });

  sink.push("ab");
  sink.push("cd");
  sink.push("ef");
  sink.push("gh");

  const summary = await sink.close();

  assert.equal(summary.tailText, "cdefgh");
  assert.equal(summary.totalChars, 8);
  assert.ok(summary.totalBytes >= 8);
  assert.equal(summary.droppedChars, 2);
});

await runTest("output sink preserves the live tail after an oversized chunk", async () => {
  const sink = createOutputSink({
    inMemoryMaxChars: 5,
  });

  sink.push("abcdefghi");
  const summary = await sink.close();

  assert.equal(summary.tailText, "efghi");
  assert.equal(summary.totalChars, 9);
  assert.equal(summary.droppedChars, 4);
});

console.log("All subagent output sink tests passed.");
