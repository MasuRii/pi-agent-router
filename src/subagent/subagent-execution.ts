/**
 * Subagent execution status, details, and result handling.
 */

import { randomUUID } from "node:crypto";

import type { SubagentUsage, SubagentExecutionStatus, SubagentExecutionDetails, SubagentSession } from "../types";
import {
  DEFAULT_AGENT,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_MIN_TIMEOUT_MS,
  TASK_HISTORY_SUMMARY_MAX_CHARS,
} from "../constants";
import {
  extractTaskDescriptionFromDelegatedPrompt,
  truncatePreview,
} from "../text-formatting";

function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseOptionalText(value: unknown): string | undefined {
  const normalized = normalizeInputText(value);
  return normalized || undefined;
}

function parseOptionalDurationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.trunc(value));
}

function createEmptySubagentUsage(): SubagentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function mergeUsageTotals(target: SubagentUsage, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const usage = value as Record<string, unknown>;
  target.input += asFiniteNumber(usage.input);
  target.output += asFiniteNumber(usage.output);
  target.cacheRead += asFiniteNumber(usage.cacheRead);
  target.cacheWrite += asFiniteNumber(usage.cacheWrite);

  const totalTokens = usage.totalTokens ?? usage.contextTokens;
  if (totalTokens !== undefined) {
    target.contextTokens = asFiniteNumber(totalTokens);
  }

  const cost = usage.cost;
  if (typeof cost === "number") {
    target.cost += asFiniteNumber(cost);
  } else if (cost && typeof cost === "object" && !Array.isArray(cost)) {
    const costRecord = cost as Record<string, unknown>;
    target.cost += asFiniteNumber(costRecord.total);
  }
}

function parseSubagentUsage(value: unknown): SubagentUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const usageState = createEmptySubagentUsage();
  mergeUsageTotals(usageState, value);
  usageState.turns = asFiniteNumber((value as Record<string, unknown>).turns);

  if (
    usageState.input === 0 &&
    usageState.output === 0 &&
    usageState.cacheRead === 0 &&
    usageState.cacheWrite === 0 &&
    usageState.cost === 0 &&
    usageState.contextTokens === 0 &&
    usageState.turns === 0
  ) {
    return undefined;
  }

  return usageState;
}

export function resolveSubagentTimeoutMs(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return SUBAGENT_DEFAULT_TIMEOUT_MS;
  }

  return Math.max(SUBAGENT_MIN_TIMEOUT_MS, Math.trunc(timeoutMs));
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = Array.from({ length: items.length });
  let nextIndex = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }

      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

export function parseSubagentExecutionStatus(value: unknown): SubagentExecutionStatus {
  const statusRaw = normalizeInputText(value);
  if (
    statusRaw === "blocked" ||
    statusRaw === "queued" ||
    statusRaw === "running" ||
    statusRaw === "finished" ||
    statusRaw === "failed" ||
    statusRaw === "timed_out" ||
    statusRaw === "killed" ||
    statusRaw === "aborted"
  ) {
    return statusRaw;
  }

  return "failed";
}

export function summarizeParallelResults(results: SubagentExecutionDetails["results"]): {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  queued: number;
  aborted: number;
} {
  const list = results || [];
  const summary = {
    total: list.length,
    succeeded: 0,
    failed: 0,
    running: 0,
    queued: 0,
    aborted: 0,
  };

  for (const result of list) {
    if (result.status === "finished") {
      summary.succeeded += 1;
    } else if (result.status === "running") {
      summary.running += 1;
    } else if (result.status === "queued") {
      summary.queued += 1;
    } else if (result.status === "aborted") {
      summary.aborted += 1;
      summary.failed += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

export function aggregateUsageFromResults(results: SubagentExecutionDetails["results"]): SubagentUsage | undefined {
  const list = results || [];
  let hasUsage = false;
  const total = createEmptySubagentUsage();

  for (const result of list) {
    if (!result.usage) {
      continue;
    }

    hasUsage = true;
    total.input += result.usage.input;
    total.output += result.usage.output;
    total.cacheRead += result.usage.cacheRead;
    total.cacheWrite += result.usage.cacheWrite;
    total.cost += result.usage.cost;
    total.contextTokens += result.usage.contextTokens;
    total.turns += result.usage.turns;
  }

  return hasUsage ? total : undefined;
}

const EXECUTION_DETAILS_TASK_MAX_CHARS = 480;
const EXECUTION_DETAILS_OUTPUT_MAX_CHARS = 1_200;
const EXECUTION_DETAILS_ERROR_MAX_CHARS = 800;
const EXECUTION_DETAILS_LIVE_OUTPUT_MAX_CHARS = 320;
const EXECUTION_DETAILS_TOOL_CALL_MAX_CHARS = 220;
const EXECUTION_DETAILS_WARNING_MAX_CHARS = 220;
const EXECUTION_DETAILS_WARNING_MAX_ENTRIES = 8;

function compactExecutionText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = normalizeInputText(value);
  if (!normalized) {
    return undefined;
  }

  return truncatePreview(normalized, maxChars);
}

function compactExecutionWarnings(warnings: readonly string[] | undefined): string[] | undefined {
  if (!warnings || warnings.length === 0) {
    return undefined;
  }

  const compacted = warnings
    .map((warning) => compactExecutionText(warning, EXECUTION_DETAILS_WARNING_MAX_CHARS))
    .filter((warning): warning is string => Boolean(warning));

  if (compacted.length === 0) {
    return undefined;
  }

  return compacted.slice(0, EXECUTION_DETAILS_WARNING_MAX_ENTRIES);
}

function compactDelegatedTask(
  delegatedTask: string,
  taskDescription?: string,
): string {
  const preferredLabel =
    compactExecutionText(taskDescription, EXECUTION_DETAILS_TASK_MAX_CHARS) ||
    compactExecutionText(
      extractTaskDescriptionFromDelegatedPrompt(delegatedTask),
      EXECUTION_DETAILS_TASK_MAX_CHARS,
    ) ||
    compactExecutionText(delegatedTask, EXECUTION_DETAILS_TASK_MAX_CHARS);

  return preferredLabel || "";
}

function compactExecutionResults(
  results: SubagentExecutionDetails["results"],
): SubagentExecutionDetails["results"] {
  if (!results) {
    return undefined;
  }

  return results.map((result) => ({
    ...result,
    delegatedTask: compactDelegatedTask(
      result.delegatedTask,
      result.taskDescription,
    ),
    taskDescription: compactExecutionText(
      result.taskDescription,
      EXECUTION_DETAILS_TASK_MAX_CHARS,
    ),
    latestToolCall: compactExecutionText(
      result.latestToolCall,
      EXECUTION_DETAILS_TOOL_CALL_MAX_CHARS,
    ),
    output: compactExecutionText(result.output, EXECUTION_DETAILS_OUTPUT_MAX_CHARS),
    error: compactExecutionText(result.error, EXECUTION_DETAILS_ERROR_MAX_CHARS),
    resultSummary: compactExecutionText(
      result.resultSummary,
      TASK_HISTORY_SUMMARY_MAX_CHARS,
    ),
    abortReason: compactExecutionText(
      result.abortReason,
      EXECUTION_DETAILS_ERROR_MAX_CHARS,
    ),
    contractWarnings: compactExecutionWarnings(result.contractWarnings),
  }));
}

export function createSubagentExecutionDetails(
  delegatedBy: string,
  delegatedAgent: string,
  delegatedTask: string,
  status: SubagentExecutionStatus,
  options: {
    mode?: "single" | "parallel" | "chain" | "task";
    attached?: boolean;
    liveOutput?: string;
    sessionId?: string;
    taskId?: string;
    parentSessionId?: string;
    exitCode?: number;
    timedOut?: boolean;
    agentColor?: string;
    model?: string;
    thinkingLevel?: string;
    duration?: number;
    usage?: SubagentUsage;
    summary?: SubagentExecutionDetails["summary"];
    results?: SubagentExecutionDetails["results"];
    contractWarnings?: string[];
    aborted?: boolean;
  } = {},
): SubagentExecutionDetails {
  return {
    mode: options.mode || "single",
    delegatedBy,
    delegatedAgent,
    delegatedTask: compactDelegatedTask(delegatedTask),
    agentColor: options.agentColor,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    duration: options.duration,
    status,
    attached: options.attached,
    liveOutput: compactExecutionText(
      options.liveOutput,
      EXECUTION_DETAILS_LIVE_OUTPUT_MAX_CHARS,
    ),
    sessionId: options.sessionId,
    taskId: options.taskId,
    parentSessionId: options.parentSessionId,
    exitCode: options.exitCode,
    timedOut: options.timedOut,
    usage: options.usage,
    summary: options.summary,
    results: compactExecutionResults(options.results),
    contractWarnings: compactExecutionWarnings(options.contractWarnings),
    aborted: options.aborted,
  };
}

export function parseSubagentExecutionDetails(value: unknown): SubagentExecutionDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const modeRaw = normalizeInputText(record.mode);
  const mode = modeRaw === "parallel" ? "parallel" : modeRaw === "chain" ? "chain" : modeRaw === "task" ? "task" : "single";
  const delegatedBy = normalizeInputText(record.delegatedBy);
  const delegatedAgent = normalizeInputText(record.delegatedAgent || record.agent);
  const delegatedTask = typeof record.delegatedTask === "string" ? record.delegatedTask : "";
  const agentColor = parseOptionalText(record.agentColor ?? record.agent_color);
  const model = parseOptionalText(record.model);
  const thinkingLevel = parseOptionalText(record.thinkingLevel ?? record.thinking_level);
  const duration = parseOptionalDurationMs(record.duration ?? record.durationMs ?? record.duration_ms);
  const status = parseSubagentExecutionStatus(record.status);

  if (!delegatedAgent) {
    return undefined;
  }

  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  const taskId = typeof record.taskId === "string" ? record.taskId : typeof record.task_id === "string" ? record.task_id : undefined;
  const parentSessionId =
    typeof record.parentSessionId === "string"
      ? record.parentSessionId
      : typeof record.parent_session_id === "string"
        ? record.parent_session_id
        : undefined;
  const attached = typeof record.attached === "boolean" ? record.attached : undefined;
  const liveOutput =
    typeof record.liveOutput === "string"
      ? record.liveOutput
      : typeof record.live_output === "string"
        ? record.live_output
        : undefined;
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
  const timedOut = typeof record.timedOut === "boolean" ? record.timedOut : undefined;
  const usage = parseSubagentUsage(record.usage);
  const aborted = typeof record.aborted === "boolean" ? record.aborted : undefined;
  const contractWarnings = Array.isArray(record.contractWarnings)
    ? record.contractWarnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
    : undefined;

  let results: SubagentExecutionDetails["results"];
  if (Array.isArray(record.results)) {
    results = record.results
      .map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return undefined;
        }

        const taskRecord = item as Record<string, unknown>;
        const taskAgent = normalizeInputText(taskRecord.delegatedAgent || taskRecord.agent);
        if (!taskAgent) {
          return undefined;
        }

        const parsedToolCalls =
          typeof taskRecord.toolCalls === "number" && Number.isFinite(taskRecord.toolCalls)
            ? Math.max(0, Math.trunc(taskRecord.toolCalls))
            : undefined;

        return {
          index: typeof taskRecord.index === "number" ? Math.max(1, Math.trunc(taskRecord.index)) : index + 1,
          delegatedAgent: taskAgent,
          delegatedTask: typeof taskRecord.delegatedTask === "string" ? taskRecord.delegatedTask : "",
          agentColor: parseOptionalText(taskRecord.agentColor ?? taskRecord.agent_color),
          taskLabel: typeof taskRecord.taskLabel === "string" ? taskRecord.taskLabel : undefined,
          taskDescription: typeof taskRecord.taskDescription === "string" ? taskRecord.taskDescription : undefined,
          model: parseOptionalText(taskRecord.model),
          thinkingLevel: parseOptionalText(taskRecord.thinkingLevel ?? taskRecord.thinking_level),
          duration: parseOptionalDurationMs(taskRecord.duration ?? taskRecord.durationMs ?? taskRecord.duration_ms),
          status: parseSubagentExecutionStatus(taskRecord.status),
          sessionId: typeof taskRecord.sessionId === "string" ? taskRecord.sessionId : undefined,
          exitCode: typeof taskRecord.exitCode === "number" ? taskRecord.exitCode : undefined,
          timedOut: typeof taskRecord.timedOut === "boolean" ? taskRecord.timedOut : undefined,
          usage: parseSubagentUsage(taskRecord.usage),
          toolCalls: parsedToolCalls,
          latestToolCall: typeof taskRecord.latestToolCall === "string" ? taskRecord.latestToolCall : undefined,
          output: typeof taskRecord.output === "string" ? taskRecord.output : undefined,
          error: typeof taskRecord.error === "string" ? taskRecord.error : undefined,
          resultSummary: typeof taskRecord.resultSummary === "string" ? taskRecord.resultSummary : undefined,
          abortReason: typeof taskRecord.abortReason === "string" ? taskRecord.abortReason : undefined,
          contractWarnings: Array.isArray(taskRecord.contractWarnings)
            ? taskRecord.contractWarnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
            : undefined,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }

  const summaryValue = record.summary;
  let summary: SubagentExecutionDetails["summary"] | undefined;
  if (summaryValue && typeof summaryValue === "object" && !Array.isArray(summaryValue)) {
    const summaryRecord = summaryValue as Record<string, unknown>;
    summary = {
      total: asFiniteNumber(summaryRecord.total),
      succeeded: asFiniteNumber(summaryRecord.succeeded),
      failed: asFiniteNumber(summaryRecord.failed),
      running: asFiniteNumber(summaryRecord.running),
      queued: asFiniteNumber(summaryRecord.queued),
      aborted: asFiniteNumber(summaryRecord.aborted),
    };
  } else if (results) {
    summary = summarizeParallelResults(results);
  }

  const effectiveUsage = usage || aggregateUsageFromResults(results);

  return {
    mode,
    delegatedBy: delegatedBy || DEFAULT_AGENT,
    delegatedAgent,
    delegatedTask,
    agentColor,
    model,
    thinkingLevel,
    duration,
    status,
    attached,
    liveOutput,
    sessionId,
    taskId,
    parentSessionId,
    exitCode,
    timedOut,
    usage: effectiveUsage,
    summary,
    results,
    contractWarnings,
    aborted,
  };
}

export function getSubagentStatusDisplay(
  status: SubagentExecutionStatus,
): { label: string; color: "success" | "warning" | "error" } {
  if (status === "queued") {
    return { label: "⏸ QUEUED", color: "warning" };
  }

  if (status === "running") {
    return { label: "⏳ Executing...", color: "warning" };
  }

  if (status === "finished") {
    return { label: "✓ COMPLETED", color: "success" };
  }

  if (status === "blocked") {
    return { label: "✗ BLOCKED", color: "error" };
  }

  if (status === "timed_out") {
    return { label: "✗ TIMED OUT", color: "error" };
  }

  if (status === "killed") {
    return { label: "✗ KILLED", color: "error" };
  }

  if (status === "aborted") {
    return { label: "✗ ABORTED", color: "warning" };
  }

  return { label: "✗ FAILED", color: "error" };
}

export function formatDuration(milliseconds: number): string {
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

export function normalizeSessionReference(reference: string): string {
  return reference.trim().toLowerCase();
}

export function generateUniqueTaskId(registry: ReadonlyMap<string, unknown>): string {
  let candidate = randomUUID();
  while (registry.has(candidate)) {
    candidate = randomUUID();
  }
  return candidate;
}

export function resolveSessionByReference(reference: string, sessions: readonly SubagentSession[]): SubagentSession | undefined {
  const normalized = normalizeSessionReference(reference);
  if (!normalized) {
    return undefined;
  }

  const exact = sessions.find((session) => session.id.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }

  const matches = sessions.filter((session) => session.id.toLowerCase().startsWith(normalized));
  if (matches.length === 1) {
    return matches[0];
  }

  return undefined;
}
