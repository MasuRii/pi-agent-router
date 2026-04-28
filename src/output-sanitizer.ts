/**
 * Subagent output sanitization and extraction utilities.
 */

import { asRecord } from "./record-utils";

const THINKING_BLOCK_PATTERN = /<(thinking|analysis|reasoning)>[\s\S]*?<\/\1>|```(?:thinking|analysis|reasoning)[\s\S]*?```/gi;
const THINKING_LINE_PATTERN = /^\s*(thinking|analysis|reasoning)\s*:\s*/i;
const WRAPPED_TASK_RESULT_PATTERN = /^<task_result>\s*([\s\S]*?)\s*<\/task_result>$/i;
const LEADING_TASK_RESULT_PATTERN = /^<task_result>\s*/i;
const TRAILING_TASK_RESULT_PATTERN = /\s*<\/task_result>$/i;
const TOOL_TRANSCRIPT_LINE_PATTERN = /^\s*(?:[-*+•]\s*)?→\s+\S/;
const STRUCTURED_VALUE_KEYS = ["result", "output", "value", "data"] as const;
const DISPLAY_TEXT_KEYS = ["report", "markdown"] as const;
const MAX_EXTRACTION_DEPTH = 8;
const MAX_STRUCTURED_SANITIZATION_DEPTH = 32;
const STRUCTURED_SANITIZATION_DEPTH_EXCEEDED = "[Structured result depth exceeded during contextFrom sanitization]";
const STRUCTURED_SANITIZATION_CIRCULAR_REFERENCE = "[Circular structured result reference omitted during contextFrom sanitization]";

function unwrapTaskResultEnvelope(rawText: string): string {
  const text = rawText.replace(/\r\n/g, "\n").trim();
  const wrappedMatch = text.match(WRAPPED_TASK_RESULT_PATTERN);
  if (wrappedMatch) {
    return (wrappedMatch[1] || "").trim();
  }

  return text
    .replace(LEADING_TASK_RESULT_PATTERN, "")
    .replace(TRAILING_TASK_RESULT_PATTERN, "")
    .trim();
}

function parseJsonObjectString(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

export function stripSubagentThinkingContent(rawText: string): string {
  if (!rawText.trim()) {
    return "";
  }

  const normalizedText = rawText.replace(/\r\n/g, "\n");
  const withoutThinkingBlocks = normalizedText.replace(THINKING_BLOCK_PATTERN, "\n");

  const lines = withoutThinkingBlocks
    .split("\n")
    .filter((line) => !THINKING_LINE_PATTERN.test(line))
    .map((line) => line.replace(/\s+$/g, ""));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractHumanReadableSubagentOutput(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_EXTRACTION_DEPTH) {
    return undefined;
  }

  if (typeof value === "string") {
    const normalized = unwrapTaskResultEnvelope(value);
    const parsed = parseJsonObjectString(normalized);
    if (parsed) {
      return extractHumanReadableSubagentOutput(parsed, depth + 1);
    }

    return stripSubagentThinkingContent(normalized);
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of DISPLAY_TEXT_KEYS) {
    if (typeof record[key] !== "string") {
      continue;
    }

    const extracted = extractHumanReadableSubagentOutput(record[key], depth + 1);
    if (extracted !== undefined) {
      return extracted;
    }
  }

  for (const key of STRUCTURED_VALUE_KEYS) {
    if (!(key in record)) {
      continue;
    }

    const extracted = extractHumanReadableSubagentOutput(record[key], depth + 1);
    if (extracted !== undefined) {
      return extracted;
    }
  }

  return undefined;
}

export function sanitizeSubagentResultForDisplay(rawText: string): string {
  if (!rawText.trim()) {
    return "";
  }

  const text = rawText.replace(/\r\n/g, "\n").trim();
  const extracted = extractHumanReadableSubagentOutput(text);
  if (extracted !== undefined) {
    return extracted;
  }

  return stripSubagentThinkingContent(unwrapTaskResultEnvelope(text));
}

function trimEmptyBoundaryLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }

  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function removeToolTranscriptLines(lines: readonly string[]): string[] {
  return lines.filter((line) => !TOOL_TRANSCRIPT_LINE_PATTERN.test(line));
}

function parseJsonContainerString(value: string): unknown | undefined {
  const trimmed = value.trim();
  const isJsonContainer = (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!isJsonContainer) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeStructuredStringForHandoff(value: string): string {
  const parsedContainer = parseJsonContainerString(value);
  if (parsedContainer !== undefined) {
    const sanitizedContainer = sanitizeStructuredSubagentResultForHandoff(parsedContainer);
    try {
      return JSON.stringify(sanitizedContainer, null, 2);
    } catch {
      return "";
    }
  }

  const sanitized = sanitizeSubagentResultForDisplay(value);
  if (!sanitized) {
    return "";
  }

  return trimEmptyBoundaryLines(
    removeToolTranscriptLines(sanitized.replace(/\r\n/g, "\n").split("\n")),
  )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeStructuredSubagentResultForHandoff(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return sanitizeStructuredStringForHandoff(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_STRUCTURED_SANITIZATION_DEPTH) {
    return STRUCTURED_SANITIZATION_DEPTH_EXCEEDED;
  }

  if (seen.has(value)) {
    return STRUCTURED_SANITIZATION_CIRCULAR_REFERENCE;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const sanitizedArray = value.map((entry) => sanitizeStructuredSubagentResultForHandoff(entry, seen, depth + 1));
    seen.delete(value);
    return sanitizedArray;
  }

  const sanitizedRecord: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitizedRecord[key] = sanitizeStructuredSubagentResultForHandoff(entry, seen, depth + 1);
  }

  seen.delete(value);
  return sanitizedRecord;
}

function findLastToolTranscriptLine(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (TOOL_TRANSCRIPT_LINE_PATTERN.test(lines[index] || "")) {
      return index;
    }
  }

  return -1;
}

export type FinalResponseHandoffSanitizerOptions = {
  allowPreToolTextWhenNoTrailingFinal?: boolean;
};

export function containsToolTranscriptLine(rawText: string): boolean {
  return rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => TOOL_TRANSCRIPT_LINE_PATTERN.test(line));
}

function selectFinalResponseCandidateLines(
  lines: readonly string[],
  options: FinalResponseHandoffSanitizerOptions,
): string[] {
  const lastToolLineIndex = findLastToolTranscriptLine(lines);
  if (lastToolLineIndex < 0) {
    return [...lines];
  }

  if (options.allowPreToolTextWhenNoTrailingFinal === false) {
    const lineAfterTool = lines[lastToolLineIndex + 1];
    if (lineAfterTool !== undefined && !lineAfterTool.trim()) {
      return trimEmptyBoundaryLines(
        removeToolTranscriptLines(lines.slice(lastToolLineIndex + 2)),
      );
    }

    return [];
  }

  const trailingLines = trimEmptyBoundaryLines(
    removeToolTranscriptLines(lines.slice(lastToolLineIndex + 1)),
  );
  if (trailingLines.length > 0) {
    return trailingLines;
  }

  return removeToolTranscriptLines(lines);
}

export function sanitizeSubagentFinalResponseForHandoff(
  rawText: string,
  options: FinalResponseHandoffSanitizerOptions = {},
): string {
  const sanitized = sanitizeSubagentResultForDisplay(rawText);
  if (!sanitized) {
    return "";
  }

  const lines = sanitized.replace(/\r\n/g, "\n").split("\n");
  const candidateLines = selectFinalResponseCandidateLines(lines, options);

  return trimEmptyBoundaryLines(removeToolTranscriptLines(candidateLines))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
