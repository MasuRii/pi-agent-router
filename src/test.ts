import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

type AgentMode = "primary" | "subagent" | "all";
type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const VALID_THINKING_LEVELS = new Set<AgentThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const SUBAGENT_STDOUT_CAPTURE_MAX_CHARS = 2 * 1024 * 1024;
const SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS = 4 * 1024 * 1024;

function normalizeAgentMode(value: string | undefined): AgentMode | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "primary" || normalized === "subagent" || normalized === "all") {
    return normalized;
  }

  return undefined;
}

function normalizeThinkingLevel(value: string | undefined): AgentThinkingLevel | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "none") {
    return "off";
  }

  if (normalized === "max") {
    return "xhigh";
  }

  if (VALID_THINKING_LEVELS.has(normalized as AgentThinkingLevel)) {
    return normalized as AgentThinkingLevel;
  }

  return undefined;
}

function parseTemperature(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function buildDelegatedTemperatureExtensionSource(temperature: number): string {
  const runtimeTemperature = Number.isFinite(temperature) ? temperature : 1;
  return `const runtimeTemperature = ${JSON.stringify(runtimeTemperature)};`;
}

function buildDelegatedCopilotInitiatorExtensionSource(): string {
  return [
    "const TARGET_APIS: Api[] = [\"openai-completions\", \"openai-responses\", \"anthropic-messages\"];",
    "for (const api of TARGET_APIS) {",
    "ensureWrapper(pi, api);",
    "const provider = (model as Model<Api> & { provider?: string }).provider;",
    "if (provider !== \"github-copilot\") {",
    "\"X-Initiator\": \"agent\"",
  ].join("\n");
}

type BoundedTextCapture = {
  value: string;
  droppedChars: number;
};

function createBoundedTextCapture(): BoundedTextCapture {
  return {
    value: "",
    droppedChars: 0,
  };
}

function appendToBoundedTextCapture(capture: BoundedTextCapture, piece: string, maxChars: number): void {
  if (!piece) {
    return;
  }

  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    capture.droppedChars += piece.length;
    return;
  }

  const combined = `${capture.value}${piece}`;
  if (combined.length <= maxChars) {
    capture.value = combined;
    return;
  }

  const overflow = combined.length - maxChars;
  capture.value = combined.slice(overflow);
  capture.droppedChars += overflow;
}

function parseModelReference(modelReference: string | undefined): { provider: string; modelId: string } | undefined {
  if (!modelReference) {
    return undefined;
  }

  const trimmed = modelReference.trim();
  if (!trimmed) {
    return undefined;
  }

  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return undefined;
  }

  return {
    provider: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
}

const SESSIONS_DIR = join("/tmp", ".pi", "agent", "sessions");

function encodeSessionDirectoryForCwd(cwd: string): string {
  let normalized = cwd;
  if (normalized.startsWith("/") || normalized.startsWith("\\")) {
    normalized = normalized.slice(1);
  }

  return `--${normalized.replaceAll("/", "-").replaceAll("\\", "-").replaceAll(":", "-")}--`;
}

function buildSessionPathFromHeader(id: string, timestamp: string, cwd: string, sessionDir?: string): string {
  const baseSessionDir = sessionDir ? resolve(sessionDir) : join(SESSIONS_DIR, encodeSessionDirectoryForCwd(cwd));
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  return join(baseSessionDir, `${fileTimestamp}_${id}.jsonl`);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }

  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

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
  assert.equal(source.includes('TARGET_APIS: Api[]'), true);
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
