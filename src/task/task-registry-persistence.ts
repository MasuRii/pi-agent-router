/**
 * File-backed persistence for the subagent task registry.
 *
 * The registry is stored as NDJSON (JSONL).  Each line is a complete
 * SubagentTaskRegistryEntry snapshot; duplicate taskIds resolve with
 * last-write-wins semantics when loading.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { SUBAGENT_SESSIONS_DIR } from "../constants";
import { getErrorMessage } from "../error-utils";
import { piAgentRouterDebugLogger } from "../debug-logger";
import type { SubagentExecutionStatus, SubagentTaskRegistryEntry } from "../types";

const TASK_REGISTRY_FILE_NAME = ".task-registry.jsonl";

const VALID_STATUSES = new Set<SubagentExecutionStatus>([
  "blocked",
  "queued",
  "running",
  "finished",
  "failed",
  "timed_out",
  "killed",
  "aborted",
]);

const VALID_OUTPUT_FORMATS = new Set<NonNullable<SubagentTaskRegistryEntry["lastOutputFormat"]>>([
  "structured",
  "human_text",
  "empty",
]);

const VALID_OUTPUT_SOURCES = new Set<NonNullable<SubagentTaskRegistryEntry["lastOutputSource"]>>([
  "submit_result",
  "streamed_output",
  "assistant_output",
  "assistant_error",
  "empty",
]);

function getTaskRegistryFilePath(): string {
  return join(SUBAGENT_SESSIONS_DIR, TASK_REGISTRY_FILE_NAME);
}

function ensureSubagentSessionsDir(): void {
  try {
    mkdirSync(SUBAGENT_SESSIONS_DIR, { recursive: true });
  } catch {
    // directory may already exist
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sanitizePersistedTaskRegistryEntry(
  value: unknown,
): SubagentTaskRegistryEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const taskId = asString(record.taskId)?.trim();
  const status = asString(record.status) as SubagentExecutionStatus | undefined;
  if (!taskId || !status || !VALID_STATUSES.has(status)) {
    return undefined;
  }

  const createdAt = asNumber(record.createdAt) ?? 0;
  const updatedAt = asNumber(record.updatedAt) ?? createdAt;
  const runCount = Math.max(0, Math.trunc(asNumber(record.runCount) ?? 0));
  const lastExitCode = asNumber(record.lastExitCode);

  const entry: SubagentTaskRegistryEntry = {
    taskId,
    logicalTaskId: asString(record.logicalTaskId),
    sessionPath: asString(record.sessionPath),
    parentSessionId: asString(record.parentSessionId) ?? "",
    delegatedBy: asString(record.delegatedBy) ?? "",
    agent: asString(record.agent) ?? "",
    cwd: asString(record.cwd) ?? "",
    status,
    createdAt,
    updatedAt,
    runCount,
    childSessionIds: asStringArray(record.childSessionIds),
    lastTask: asString(record.lastTask) ?? "",
    lastOutput: asString(record.lastOutput),
    lastFinalResponseText: asString(record.lastFinalResponseText),
    lastStructuredResult: record.lastStructuredResult,
    lastError: asString(record.lastError),
    lastExitCode,
    lastTimedOut: typeof record.lastTimedOut === "boolean" ? record.lastTimedOut : undefined,
    lastDismissedAt: asNumber(record.lastDismissedAt),
    usage: valueHasUsageShape(record.usage) ? record.usage : undefined,
  };

  const outputFormat = asString(record.lastOutputFormat) as SubagentTaskRegistryEntry["lastOutputFormat"];
  if (outputFormat && VALID_OUTPUT_FORMATS.has(outputFormat)) {
    entry.lastOutputFormat = outputFormat;
  }

  const outputSource = asString(record.lastOutputSource) as SubagentTaskRegistryEntry["lastOutputSource"];
  if (outputSource && VALID_OUTPUT_SOURCES.has(outputSource)) {
    entry.lastOutputSource = outputSource;
  }

  return entry;
}

function valueHasUsageShape(value: unknown): value is SubagentTaskRegistryEntry["usage"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cost",
    "contextTokens",
    "turns",
  ].every((key) => asNumber(record[key]) !== undefined);
}

/**
 * Load all persisted registry entries from disk.
 * Duplicate taskIds are resolved last-write-wins.
 */
export function loadPersistedTaskRegistryEntries(): SubagentTaskRegistryEntry[] {
  const path = getTaskRegistryFilePath();
  if (!existsSync(path)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    piAgentRouterDebugLogger.warn("task_registry.load_error", { error: getErrorMessage(error) });
    return [];
  }

  const seen = new Map<string, SubagentTaskRegistryEntry>();

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = sanitizePersistedTaskRegistryEntry(JSON.parse(line));
      if (entry) {
        seen.set(entry.taskId, entry);
      }
    } catch {
      // skip corrupt lines
    }
  }

  return [...seen.values()];
}

/**
 * Overwrite the entire persisted registry with the provided entries.
 */
export function writePersistedTaskRegistry(
  entries: Iterable<SubagentTaskRegistryEntry>,
): void {
  const path = getTaskRegistryFilePath();
  ensureSubagentSessionsDir();

  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(JSON.stringify(entry));
  }
  lines.push(""); // trailing newline

  try {
    writeFileSync(tempPath, lines.join("\n"), "utf-8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // best-effort cleanup only
    }
    piAgentRouterDebugLogger.warn("task_registry.write_error", { error: getErrorMessage(error) });
  }
}

/**
 * Append a single entry to the persisted registry.
 * Callers should ensure periodic compaction via
 * `writePersistedTaskRegistry` to remove duplicates.
 */
export function appendPersistedTaskRegistryEntry(
  entry: SubagentTaskRegistryEntry,
): void {
  const path = getTaskRegistryFilePath();
  ensureSubagentSessionsDir();

  try {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(path, line, "utf-8");
  } catch (error) {
    piAgentRouterDebugLogger.warn("task_registry.append_error", { error: getErrorMessage(error) });
  }
}
