import assert from "node:assert/strict";

import {
  SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
} from "../constants";
import {
  asToolArgumentsObject,
  formatHumanReadableToolInvocation,
  formatToolArgumentValue,
  formatToolCallArgumentsPreview,
  getToolNumberArgument,
  getToolStringArgument,
} from "../tool-formatting";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("asToolArgumentsObject parses object payloads and ignores unsupported values", () => {
  assert.deepEqual(asToolArgumentsObject('{"path":"src/index.ts"}'), { path: "src/index.ts" });
  assert.equal(asToolArgumentsObject("[1,2,3]"), undefined);
  assert.equal(asToolArgumentsObject("not json"), undefined);
});

runTest("tool argument helpers normalize strings and nested values", () => {
  const args = {
    path: "  src/index.ts  ",
    offset: "42",
    meta: {
      agent: "code",
      status: "running",
    },
  };

  assert.equal(getToolStringArgument(args, ["path"]), "src/index.ts");
  assert.equal(getToolNumberArgument(args, ["offset"]), 42);
  assert.equal(formatToolArgumentValue(args.meta), "agent=code, status=running");
});

runTest("formatToolCallArgumentsPreview keeps specialized previews concise", () => {
  assert.equal(
    formatToolCallArgumentsPreview("read", { path: "src/index.ts", offset: 20, limit: 40 }),
    "src/index.ts:20-40",
  );
  assert.equal(
    formatToolCallArgumentsPreview("grep", { pattern: "task", path: "src" }),
    "/task/ in src",
  );
  assert.equal(
    formatToolCallArgumentsPreview("bash", { command: "npm test -- --runInBand" }, 12),
    "npm test --…",
  );
});

runTest("formatHumanReadableToolInvocation reuses preview formatting for labels", () => {
  assert.equal(
    formatHumanReadableToolInvocation("read", { path: "src/index.ts" }),
    "read src/index.ts",
  );
  assert.equal(
    formatHumanReadableToolInvocation("bash", { command: "npm test" }),
    "bash: npm test",
  );
  assert.equal(
    formatHumanReadableToolInvocation("custom_tool", { agent: "code" }),
    "custom_tool(agent=code)",
  );
});

runTest("formatToolCallArgumentsPreview bounds default preview length", () => {
  const preview = formatToolCallArgumentsPreview("bash", {
    command: "x".repeat(SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS + 40),
  });

  assert.equal(preview.length, SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS);
  assert.equal(preview.endsWith("…"), true);
});

console.log("All tool formatting tests passed.");
