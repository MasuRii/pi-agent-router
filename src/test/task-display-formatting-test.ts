import assert from "node:assert/strict";

import {
  colorizeWithHex,
  formatTaskActivityLabel,
  formatUsageWithoutCost,
  getTaskStatusLabel,
  getTaskStatusTone,
  inferLatestActionFromOutput,
  inferToolCallsFromOutput,
  normalizeHexColor,
  resolveTaskBorderColor,
  toTitleCaseWords,
} from "../task/task-display-formatting";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("inferToolCallsFromOutput counts arrow-prefixed tool lines", () => {
  const output = [
    "→ read src/index.ts",
    "some normal line",
    "  → grep \"task\" .",
  ].join("\n");

  assert.equal(inferToolCallsFromOutput(output), 2);
  assert.equal(inferToolCallsFromOutput(""), 0);
});

runTest("inferLatestActionFromOutput returns the latest tool invocation", () => {
  const output = [
    "→ read src/a.ts",
    "→ grep \"task\" src",
    "done",
  ].join("\n");

  assert.equal(inferLatestActionFromOutput(output), 'grep "task" src');
  assert.equal(inferLatestActionFromOutput("no tool lines"), undefined);
});

runTest("formatTaskActivityLabel formats bracketed and plain tool calls", () => {
  assert.equal(formatTaskActivityLabel("[bash] npm test"), "Bash npm test");
  assert.equal(formatTaskActivityLabel("read src/index.ts"), "Read src/index.ts");
  assert.equal(formatTaskActivityLabel(""), undefined);
});

runTest("toTitleCaseWords normalizes kebab and snake case", () => {
  assert.equal(toTitleCaseWords("code-review"), "Code Review");
  assert.equal(toTitleCaseWords("multi_agent"), "Multi Agent");
});

runTest("status helpers map task status to display label and tone", () => {
  assert.equal(getTaskStatusLabel("finished"), "Completed");
  assert.equal(getTaskStatusLabel("timed_out"), "Timed out");
  assert.equal(getTaskStatusTone("running"), "accent");
  assert.equal(getTaskStatusTone("failed"), "error");
});

runTest("usage formatter excludes currency/cost values", () => {
  const usage = formatUsageWithoutCost({
    input: 1200,
    output: 500,
    cacheRead: 100,
    cacheWrite: 25,
    turns: 3,
  });

  assert.equal(usage?.includes("$"), false);
  assert.equal(usage?.includes("tokens"), true);
  assert.equal(usage?.includes("cache"), true);
});

runTest("hex color helpers normalize and emit ansi truecolor wrappers", () => {
  assert.equal(normalizeHexColor("#abc"), "#AABBCC");
  assert.equal(normalizeHexColor("#50E3C2"), "#50E3C2");
  assert.equal(normalizeHexColor("blue"), undefined);

  const colored = colorizeWithHex("┃", "#50E3C2");
  assert.equal(colored.includes("\u001b[38;5;"), true);
  assert.equal(colored.endsWith("\u001b[39m"), true);
});

runTest("resolveTaskBorderColor prefers explicit colors and falls back by agent", () => {
  assert.equal(resolveTaskBorderColor("code", " blue "), "blue");
  assert.equal(resolveTaskBorderColor("code", undefined), "#4A90E2");
  assert.equal(resolveTaskBorderColor("unknown", undefined), undefined);
});

console.log("All task display formatting tests passed.");
