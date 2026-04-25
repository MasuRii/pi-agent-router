/**
 * Subagent output sanitization and extraction utilities.
 */

import { asRecord } from "./record-utils";

const THINKING_BLOCK_PATTERN = /<(thinking|analysis|reasoning)>[\s\S]*?<\/\1>|```(?:thinking|analysis|reasoning)[\s\S]*?```/gi;
const THINKING_LINE_PATTERN = /^\s*(thinking|analysis|reasoning)\s*:\s*/i;
const WRAPPED_TASK_RESULT_PATTERN = /^<task_result>\s*([\s\S]*?)\s*<\/task_result>$/i;
const LEADING_TASK_RESULT_PATTERN = /^<task_result>\s*/i;
const TRAILING_TASK_RESULT_PATTERN = /\s*<\/task_result>$/i;
const STRUCTURED_VALUE_KEYS = ["result", "output", "value", "data"] as const;
const DISPLAY_TEXT_KEYS = ["report", "markdown"] as const;
const MAX_EXTRACTION_DEPTH = 8;

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
