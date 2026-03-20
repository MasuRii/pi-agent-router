function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const AGENT_BORDER_COLOR_FALLBACK = new Map<string, string>([
  ["architect", "#50E3C2"],
  ["ask", "#9013FE"],
  ["code", "#4A90E2"],
  ["debug", "#F5A623"],
  ["devops", "#6C5CE7"],
  ["docs", "#417505"],
  ["git", "#D0021B"],
  ["orchestrator", "#7ED321"],
  ["product", "#8B572A"],
  ["refactor", "#4A4A4A"],
  ["researcher", "#F8E71C"],
  ["security", "#B00020"],
  ["test", "#E74C3C"],
  ["ui", "#FF6F61"],
]);

function stripAnsiCodes(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export type TaskStatusTone = "success" | "warning" | "error" | "dim" | "accent";

export type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  turns?: number;
};

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function formatCompactMetric(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (normalized < 1_000) {
    return String(Math.trunc(normalized));
  }

  if (normalized < 100_000) {
    const compact = (normalized / 1_000).toFixed(1);
    return `${compact.endsWith(".0") ? compact.slice(0, -2) : compact}k`;
  }

  if (normalized < 1_000_000) {
    return `${Math.round(normalized / 1_000)}k`;
  }

  const compact = (normalized / 1_000_000).toFixed(1);
  return `${compact.endsWith(".0") ? compact.slice(0, -2) : compact}m`;
}

export function formatUsageWithoutCost(usage: UsageLike | undefined): string | undefined {
  if (!usage) {
    return undefined;
  }

  const input = asFiniteNumber(usage.input);
  const output = asFiniteNumber(usage.output);
  const cacheRead = asFiniteNumber(usage.cacheRead);
  const cacheWrite = asFiniteNumber(usage.cacheWrite);
  const turns = asFiniteNumber(usage.turns);

  const segments: string[] = [];
  if (input > 0 || output > 0) {
    segments.push(`tokens ${formatCompactMetric(input)} in / ${formatCompactMetric(output)} out`);
  }

  if (cacheRead > 0 || cacheWrite > 0) {
    segments.push(`cache ${formatCompactMetric(cacheRead)}/${formatCompactMetric(cacheWrite)}`);
  }

  if (turns > 0) {
    segments.push(`${formatCompactMetric(turns)} turn${turns === 1 ? "" : "s"}`);
  }

  return segments.length > 0 ? segments.join(" • ") : undefined;
}

export function normalizeHexColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeInputText(value);
  if (!normalized) {
    return undefined;
  }

  const shortMatch = normalized.match(/^#([0-9a-fA-F]{3})$/);
  if (shortMatch) {
    const r = shortMatch[1]?.[0] || "0";
    const g = shortMatch[1]?.[1] || "0";
    const b = shortMatch[1]?.[2] || "0";
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }

  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return undefined;
  }

  return normalized.toUpperCase();
}

export function resolveTaskBorderColor(
  agentName: string | undefined,
  providedColor: string | undefined,
): string | undefined {
  const normalizedProvided = normalizeInputText(providedColor);
  if (normalizedProvided) {
    return normalizedProvided;
  }

  const normalizedAgentName = normalizeInputText(agentName).toLowerCase();
  if (!normalizedAgentName) {
    return undefined;
  }

  return AGENT_BORDER_COLOR_FALLBACK.get(normalizedAgentName);
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  const toCube = (channel: number) => {
    if (channel < 48) return 0;
    if (channel < 114) return 1;
    return Math.min(5, Math.max(0, Math.round((channel - 35) / 40)));
  };

  const rc = toCube(r);
  const gc = toCube(g);
  const bc = toCube(b);
  return 16 + 36 * rc + 6 * gc + bc;
}

export function colorizeWithHex(
  text: string,
  hexColor: string | undefined,
  options: { bold?: boolean } = {},
): string {
  const normalized = normalizeHexColor(hexColor);
  if (!normalized) {
    return text;
  }

  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);

  if (![r, g, b].every((channel) => Number.isFinite(channel))) {
    return text;
  }

  const ansi256 = rgbToAnsi256(r, g, b);
  if (options.bold) {
    return `\u001b[1;38;5;${ansi256}m${text}\u001b[22;39m`;
  }

  return `\u001b[38;5;${ansi256}m${text}\u001b[39m`;
}

export function toTitleCaseWords(value: string): string {
  const normalized = normalizeInputText(value)
    .replace(/[\-_]+/g, " ")
    .replace(/\s+/g, " ");

  if (!normalized) {
    return "Unknown";
  }

  return normalized
    .split(" ")
    .filter(Boolean)
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

export function inferToolCallsFromOutput(output: string | undefined): number {
  if (!output) {
    return 0;
  }

  const matches = output.match(/^\s*→\s+/gm);
  return matches ? matches.length : 0;
}

export function inferLatestActionFromOutput(output: string | undefined): string | undefined {
  if (!output) {
    return undefined;
  }

  const lines = output.replace(/\r\n/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = stripAnsiCodes(lines[index] || "");
    const toolCallMatch = line.match(/^\s*→\s*(.+)$/);
    if (!toolCallMatch || !toolCallMatch[1]) {
      continue;
    }

    const invocation = normalizeInputText(stripAnsiCodes(toolCallMatch[1]));
    if (invocation) {
      return invocation;
    }
  }

  return undefined;
}

export function formatTaskActivityLabel(invocation: string | undefined): string | undefined {
  const normalized = normalizeInputText(stripAnsiCodes(invocation || ""));
  if (!normalized) {
    return undefined;
  }

  const bracketMatch = normalized.match(/^\[(.+?)\]\s*(.*)$/);
  if (bracketMatch) {
    const toolName = toTitleCaseWords(bracketMatch[1] || "tool");
    const remainder = normalizeInputText(bracketMatch[2]);
    return remainder ? `${toolName} ${remainder}` : toolName;
  }

  const segments = normalized.split(/\s+/);
  const toolName = toTitleCaseWords(segments[0] || "tool");
  const remainder = normalizeInputText(normalized.slice((segments[0] || "").length));
  return remainder ? `${toolName} ${remainder}` : toolName;
}

export function getTaskStatusTone(status: string): TaskStatusTone {
  if (status === "finished") {
    return "accent";
  }

  if (status === "running" || status === "queued" || status === "aborted") {
    return "accent";
  }

  if (status === "failed" || status === "timed_out" || status === "killed" || status === "blocked") {
    return "error";
  }

  return "dim";
}

export function getTaskStatusLabel(status: string): string {
  if (status === "finished") {
    return "Completed";
  }

  if (status === "running") {
    return "Running";
  }

  if (status === "queued") {
    return "Queued";
  }

  if (status === "aborted") {
    return "Aborted";
  }

  if (status === "timed_out") {
    return "Timed out";
  }

  if (status === "failed") {
    return "Failed";
  }

  if (status === "killed") {
    return "Killed";
  }

  if (status === "blocked") {
    return "Blocked";
  }

  return toTitleCaseWords(status);
}
