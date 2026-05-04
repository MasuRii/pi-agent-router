import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  normalizeAgentMode,
  normalizeThinkingLevel,
  parseTemperature,
} from "./agent/agent-discovery";
import {
  buildDelegatedCopilotInitiatorExtensionSource,
  buildDelegatedTemperatureExtensionSource,
} from "./agent/extension-sources";
import {
  analyzeSubagentOutput,
  createSubagentOutputAnalysisCacheKey,
  SUBAGENT_OUTPUT_ANALYSIS_RAW_CACHE_KEY_MAX_CHARS,
} from "./text-formatting";
import { DEFAULT_PI_AGENT_ROUTER_CONFIG } from "./config";
import {
  SESSIONS_DIR,
  SUBAGENT_STDOUT_CAPTURE_MAX_CHARS,
  SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS,
} from "./constants";
import { parseModelReference } from "./model-resolution";
import { parseDelegatedExtensionRuntimeMetadata } from "./subagent/delegated-extensions";
import { formatDuration } from "./subagent/subagent-execution";
import { buildSessionPathFromHeader, encodeSessionDirectoryForCwd } from "./subagent/session-paths";
import { appendToBoundedTextCapture, createBoundedTextCapture } from "./subagent/subagent-usage";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("normalizeAgentMode accepts valid values case-insensitively", () => {
  assert.equal(normalizeAgentMode("PRIMARY"), "primary");
  assert.equal(normalizeAgentMode(" subagent "), "subagent");
  assert.equal(normalizeAgentMode("all"), "all");
  assert.equal(normalizeAgentMode("invalid"), undefined);
});

runTest("normalizeThinkingLevel maps aliases and rejects unknown values", () => {
  assert.equal(normalizeThinkingLevel("none"), "off");
  assert.equal(normalizeThinkingLevel("MAX"), "xhigh");
  assert.equal(normalizeThinkingLevel("medium"), "medium");
  assert.equal(normalizeThinkingLevel(""), undefined);
  assert.equal(normalizeThinkingLevel("wild"), undefined);
});

runTest("parseTemperature parses finite numbers only", () => {
  assert.equal(parseTemperature("0.7"), 0.7);
  assert.equal(parseTemperature(" 1 "), 1);
  assert.equal(parseTemperature("NaN"), undefined);
  assert.equal(parseTemperature(undefined), undefined);
});

runTest("buildDelegatedTemperatureExtensionSource embeds runtime temperature", () => {
  const source = buildDelegatedTemperatureExtensionSource(0.85);
  assert.equal(source.includes("const runtimeTemperature = 0.85;"), true);

  const fallbackSource = buildDelegatedTemperatureExtensionSource(Number.NaN);
  assert.equal(fallbackSource.includes("const runtimeTemperature = 1;"), true);
});

runTest("buildDelegatedCopilotInitiatorExtensionSource pre-registers wrappers and forces agent initiator for Copilot", () => {
  const source = buildDelegatedCopilotInitiatorExtensionSource();
  assert.equal(source.includes('const TARGET_APIS = ["openai-completions","openai-responses","anthropic-messages"] as Api[];'), true);
  assert.equal(source.includes('ensureWrapper(pi, api);'), true);
  assert.equal(source.includes('provider !== "github-copilot"'), true);
  assert.equal(source.includes('"X-Initiator": "agent"'), true);
  assert.equal(source.includes('before_agent_start'), false);
});

runTest("parseModelReference enforces provider/modelId format", () => {
  assert.deepEqual(parseModelReference("openai/gpt-4.1"), { provider: "openai", modelId: "gpt-4.1" });
  assert.equal(parseModelReference("/gpt-4.1"), undefined);
  assert.equal(parseModelReference("openai/"), undefined);
  assert.equal(parseModelReference("gpt-4.1"), undefined);
});

runTest("formatDuration uses human-friendly units", () => {
  assert.equal(formatDuration(800), "800ms");
  assert.equal(formatDuration(4_000), "4s");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(3_600_000), "1h 0m");
});

runTest("buildSessionPathFromHeader uses cwd-encoded default directory", () => {
  const timestamp = "2026-02-23T10:12:35.420Z";
  const cwd = "/home/administrator/project";

  const expected = join(
    SESSIONS_DIR,
    encodeSessionDirectoryForCwd(cwd),
    "2026-02-23T10-12-35-420Z_abc123.jsonl",
  );

  assert.equal(buildSessionPathFromHeader("abc123", timestamp, cwd), expected);
});

runTest("buildSessionPathFromHeader honors explicit sessionDir override", () => {
  const timestamp = "2026-02-23T10:12:35.420Z";
  const cwd = "/home/administrator/project";
  const sessionDir = join("/tmp", "subagent-sessions", "--custom--");
  const expected = join(resolve(sessionDir), "2026-02-23T10-12-35-420Z_abc123.jsonl");

  assert.equal(buildSessionPathFromHeader("abc123", timestamp, cwd, sessionDir), expected);
});

runTest("appendToBoundedTextCapture keeps tail and tracks truncation", () => {
  const capture = createBoundedTextCapture();
  appendToBoundedTextCapture(capture, "abcdef", 4);
  assert.equal(capture.value, "cdef");
  assert.equal(capture.droppedChars, 2);

  appendToBoundedTextCapture(capture, "gh", 4);
  assert.equal(capture.value, "efgh");
  assert.equal(capture.droppedChars, 4);
});

runTest("stdout partial-line guard keeps bounded buffer after overflow", () => {
  let stdoutBuffer = "";
  let stdoutPartialLineOverflowed = false;
  let droppedPartialStdoutChars = 0;

  const oversizedPiece = "x".repeat(SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS + 4096);
  stdoutBuffer += oversizedPiece;

  const lines = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = lines.pop() || "";

  if (stdoutBuffer.length > SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS) {
    const overflow = stdoutBuffer.length - SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS;
    droppedPartialStdoutChars += overflow;
    stdoutBuffer = stdoutBuffer.slice(-SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS);
    stdoutPartialLineOverflowed = true;
  }

  assert.equal(stdoutBuffer.length, SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS);
  assert.equal(stdoutPartialLineOverflowed, true);
  assert.equal(droppedPartialStdoutChars, 4096);
});

runTest("bounded stdout capture prevents unbounded growth", () => {
  const capture = createBoundedTextCapture();
  appendToBoundedTextCapture(capture, "a".repeat(SUBAGENT_STDOUT_CAPTURE_MAX_CHARS + 1234), SUBAGENT_STDOUT_CAPTURE_MAX_CHARS);
  assert.equal(capture.value.length, SUBAGENT_STDOUT_CAPTURE_MAX_CHARS);
  assert.equal(capture.droppedChars, 1234);
});

runTest("subagent output analysis cache keys do not retain oversized raw output", () => {
  const oversizedOutput = [
    "# Summary",
    "Large stream snapshot",
    "→ read src/index.ts",
    "x".repeat(SUBAGENT_OUTPUT_ANALYSIS_RAW_CACHE_KEY_MAX_CHARS + 1),
  ].join("\n");

  const cacheKey = createSubagentOutputAnalysisCacheKey(oversizedOutput);
  assert.equal(cacheKey.startsWith("sha256:"), true);
  assert.equal(cacheKey.includes(oversizedOutput), false);

  const firstAnalysis = analyzeSubagentOutput(oversizedOutput);
  const secondAnalysis = analyzeSubagentOutput(oversizedOutput);
  assert.equal(secondAnalysis, firstAnalysis);
  assert.equal(firstAnalysis.summary.startsWith("Large stream snapshot"), true);
  assert.deepEqual(firstAnalysis.commands, ["read src/index.ts"]);
});

runTest("delegated subagents do not load local extensions by default", () => {
  const routerSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.equal(routerSource.includes("routerConfig.delegatedExtensions"), true);
  assert.deepEqual(DEFAULT_PI_AGENT_ROUTER_CONFIG.delegatedExtensions, []);
});

runTest("delegated extension metadata declares generic runtime skip rules", () => {
  const result = parseDelegatedExtensionRuntimeMetadata({
    piAgentRouter: {
      delegatedRuntime: {
        skipWhen: ["directEnvAuthAvailable"],
      },
    },
  });

  assert.deepEqual(result.metadata.skipWhen, ["directEnvAuthAvailable"]);
  assert.deepEqual(result.warnings, []);
});

runTest("delegated subagents disable automatic extension discovery before applying the curated extension set", () => {
  const routerSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.equal(routerSource.includes('"--no-extensions"'), true);
});

runTest("resource reload is wired to the shared router cache invalidator", () => {
  const routerSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const reloadSource = readFileSync(new URL("./router-reload.ts", import.meta.url), "utf8");
  assert.equal(routerSource.includes('pi.on("resources_discover"'), true);
  assert.equal(routerSource.includes("invalidateRouterReloadCaches();"), true);
  assert.equal(reloadSource.includes("invalidateAgentDiscoveryCaches();"), true);
  assert.equal(reloadSource.includes("invalidateTaskControlsCache();"), true);
  assert.equal(reloadSource.includes("resetProviderEnvKeyCacheState();"), true);
  assert.equal(reloadSource.includes("invalidateDelegatedExtensionRuntimeCaches();"), true);
});

runTest("windows command-shell invocation truncates multiline args while direct invocation preserves them", () => {
  if (process.platform !== "win32") {
    console.log("[SKIP] Windows-only argument propagation test");
    return;
  }

  const payload = ["Task: ## SUBTASK-TEST", "Parent Goal: Keep this line"].join(String.fromCharCode(10));
  const throughShell = spawnSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", "node", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", payload],
    { encoding: "utf8" },
  );

  const direct = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", payload], {
    encoding: "utf8",
  });

  assert.equal(throughShell.status, 0);
  assert.equal(direct.status, 0);

  assert.equal(throughShell.stdout.trim(), '["Task: ## SUBTASK-TEST"]');
  assert.equal(direct.stdout.trim(), JSON.stringify([payload]));
});

console.log("All pi-agent-router utility tests passed.");
