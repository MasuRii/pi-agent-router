import { normalizeInputText } from "../input-normalization";
import type { SubagentExecutionStatus } from "../types";
import { normalizeSafeSessionIdentifier } from "../subagent/session-paths";

export type RecoveredTaskSummaryReference = {
  id: string;
  sessionId?: string;
  status: SubagentExecutionStatus;
  outputText?: string;
};

type SessionHistoryEntry = {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

const TASK_SUMMARY_OPEN_TAG = "<task-summary";
const TASK_BLOCK_PATTERN = /<task\s+([^>]*)>([\s\S]*?)<\/task>/g;

const MAX_UNICODE_CODE_POINT = 0x10ffff;

function decodeNumericXmlEntity(match: string, codePoint: string, radix: number): string {
  const parsed = Number.parseInt(codePoint, radix);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_UNICODE_CODE_POINT) {
    return match;
  }

  return String.fromCodePoint(parsed);
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (match, codePoint: string) => decodeNumericXmlEntity(match, codePoint, 10))
    .replace(/&#x([\da-fA-F]+);/g, (match, codePoint: string) => decodeNumericXmlEntity(match, codePoint, 16))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readAttribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}="([^"]*)"`);
  const match = pattern.exec(attributes);
  return match ? decodeXmlText(match[1] || "") : undefined;
}

function readElementText(body: string, name: string): string | undefined {
  const pattern = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`);
  const match = pattern.exec(body);
  return match ? decodeXmlText(match[1] || "") : undefined;
}

function normalizeRecoveredStatus(value: string | undefined): SubagentExecutionStatus {
  const normalized = normalizeInputText(value).toLowerCase().replace(/[\s-]+/g, "_");

  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "succeeded" ||
    normalized === "success"
  ) {
    return "finished";
  }

  if (normalized === "timedout" || normalized === "timeout") {
    return "timed_out";
  }

  if (
    normalized === "blocked" ||
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "finished" ||
    normalized === "failed" ||
    normalized === "timed_out" ||
    normalized === "killed" ||
    normalized === "aborted"
  ) {
    return normalized;
  }

  return "failed";
}

function extractTextContent(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
    }
  }

  return texts;
}

function parseTaskSummaryText(text: string): RecoveredTaskSummaryReference[] {
  if (!text.includes(TASK_SUMMARY_OPEN_TAG)) {
    return [];
  }

  const references: RecoveredTaskSummaryReference[] = [];
  for (const match of text.matchAll(TASK_BLOCK_PATTERN)) {
    const attributes = match[1] || "";
    const body = match[2] || "";
    const id = normalizeInputText(readAttribute(attributes, "id"));
    if (!id) {
      continue;
    }

    const sessionId = normalizeSafeSessionIdentifier(readElementText(body, "session"));
    const resultText = normalizeInputText(readElementText(body, "result"));
    const outputText = resultText && resultText !== "(no output)" ? resultText : undefined;
    references.push({
      id,
      sessionId,
      status: normalizeRecoveredStatus(readElementText(body, "status")),
      outputText,
    });
  }

  return references;
}

export function recoverTaskSummaryReferencesFromSessionEntries(
  entries: readonly unknown[],
): RecoveredTaskSummaryReference[] {
  const referencesByKey = new Map<string, RecoveredTaskSummaryReference>();

  for (const entry of entries) {
    const record = entry as SessionHistoryEntry;
    if (record?.type !== "message" || record.message?.role !== "toolResult") {
      continue;
    }

    for (const text of extractTextContent(record.message.content)) {
      for (const reference of parseTaskSummaryText(text)) {
        referencesByKey.set(`${reference.id.toLowerCase()}:${reference.sessionId || ""}`, reference);
      }
    }
  }

  return [...referencesByKey.values()];
}
