import { SPINNER_RENDER_INTERVAL_MS } from "../progress-spinner";
import { analyzeSubagentOutput, truncatePreview } from "../text-formatting";

import type { SubagentExecutionDetails, SubagentExecutionStatus } from "../types";
import { buildParallelResultActivity } from "./parallel-result-activity";

const RESULT_TEXT_PREVIEW_MAX_CHARS = 96;

// Interactive partials stay responsive, but their emission cadence is decoupled
// from the local render-time spinner animation. This keeps live delegation
// progress smooth without flooding router-driven redraw/update paths during
// active streaming.
const TASK_TOOL_INTERACTIVE_PARTIAL_UPDATE_FRAME_MULTIPLIER = 2;
const TASK_TOOL_INTERACTIVE_HEARTBEAT_FRAME_MULTIPLIER = 3;

export const TASK_TOOL_PARTIAL_UPDATE_MIN_INTERVAL_MS = 400;
export const TASK_TOOL_HEARTBEAT_INTERVAL_MS = 1_200;
export const TASK_TOOL_DURATION_UPDATE_INTERVAL_MS = 1_000;

export const TASK_TOOL_INTERACTIVE_PARTIAL_UPDATE_MIN_INTERVAL_MS =
  SPINNER_RENDER_INTERVAL_MS *
  TASK_TOOL_INTERACTIVE_PARTIAL_UPDATE_FRAME_MULTIPLIER;
export const TASK_TOOL_INTERACTIVE_HEARTBEAT_INTERVAL_MS =
  SPINNER_RENDER_INTERVAL_MS * TASK_TOOL_INTERACTIVE_HEARTBEAT_FRAME_MULTIPLIER;
export const TASK_TOOL_INTERACTIVE_UNCHANGED_FRAME_INTERVAL_MS =
  TASK_TOOL_INTERACTIVE_HEARTBEAT_INTERVAL_MS;
export const TASK_TOOL_INTERACTIVE_DURATION_UPDATE_INTERVAL_MS = 1_000;

export type TaskToolUpdateCadenceMode = "interactive" | "non_interactive";

export type TaskToolUpdateCadence = {
  mode: TaskToolUpdateCadenceMode;
  minIntervalMs: number;
  heartbeatIntervalMs: number;
  durationUpdateIntervalMs: number;
  unchangedFrameIntervalMs?: number;
};

type ParallelSummary = NonNullable<SubagentExecutionDetails["summary"]>;
type ParallelResult = NonNullable<SubagentExecutionDetails["results"]>[number];

const NON_INTERACTIVE_OUTPUT_MODES = new Set(["json", "rpc", "print"]);

function normalizeFingerprintText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function normalizeOutputMode(value: unknown): string | undefined {
  const normalized = normalizeFingerprintText(value).toLowerCase();
  return normalized || undefined;
}

function resolveNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function getOutputModeFromArgv(argv: readonly string[] | undefined): string | undefined {
  if (!Array.isArray(argv)) {
    return undefined;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = normalizeFingerprintText(argv[index]);
    if (!token) {
      continue;
    }

    if (token === "--mode") {
      return normalizeOutputMode(argv[index + 1]);
    }

    if (token.startsWith("--mode=")) {
      return normalizeOutputMode(token.slice("--mode=".length));
    }
  }

  return undefined;
}

// Fingerprint the rendered activity label instead of raw streamed text so
// long write/edit/read bursts only refresh partial task output when the
// visible activity meaning changes or heartbeat cadence allows a replay.
function buildRenderedActivityFingerprint(result: ParallelResult): string {
  const outputAnalysis = analyzeSubagentOutput(result.output);
  const activity = buildParallelResultActivity({
    status: result.status,
    latestToolCall: result.latestToolCall,
    latestOutputAction: outputAnalysis.latestAction,
    output: result.output,
    resultSummary: result.resultSummary || outputAnalysis.summary,
    isPartial: true,
  });

  return truncatePreview(
    normalizeFingerprintText(activity),
    RESULT_TEXT_PREVIEW_MAX_CHARS,
  );
}

function buildResultFingerprint(result: ParallelResult): string {
  const activityPreview = buildRenderedActivityFingerprint(result);
  const hasError = normalizeFingerprintText(result.error || "") ? "1" : "0";

  return [
    result.index,
    normalizeFingerprintText(result.delegatedAgent),
    normalizeFingerprintText(result.taskLabel || ""),
    result.status,
    normalizeFingerprintText(result.sessionId || ""),
    String(result.toolCalls ?? ""),
    activityPreview,
    hasError,
    String(result.contractWarnings?.length ?? 0),
  ].join("|");
}

export function buildTaskToolPartialUpdateFingerprint(options: {
  message: string;
  status: SubagentExecutionStatus;
  summary: ParallelSummary;
  results: readonly ParallelResult[];
}): string {
  const summary = options.summary;
  const summaryToken = [
    summary.total,
    summary.succeeded,
    summary.failed,
    summary.aborted,
    summary.running,
    summary.queued,
  ].join(":");

  const resultToken = options.results.map((result) => buildResultFingerprint(result)).join("||");

  return [
    options.status,
    summaryToken,
    normalizeFingerprintText(options.message),
    resultToken,
  ].join("@@");
}

export function resolveTaskToolUpdateCadence(options?: {
  hasUI?: boolean;
  outputMode?: string;
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
}): TaskToolUpdateCadence {
  const outputMode =
    normalizeOutputMode(options?.outputMode) ||
    getOutputModeFromArgv(options?.argv) ||
    normalizeOutputMode(options?.env?.PI_OUTPUT_MODE) ||
    normalizeOutputMode(options?.env?.PI_MODE);

  const forceNonInteractiveByMode =
    typeof outputMode === "string" &&
    NON_INTERACTIVE_OUTPUT_MODES.has(outputMode);

  if (options?.hasUI && !forceNonInteractiveByMode) {
    return {
      mode: "interactive",
      minIntervalMs: TASK_TOOL_INTERACTIVE_PARTIAL_UPDATE_MIN_INTERVAL_MS,
      heartbeatIntervalMs: TASK_TOOL_INTERACTIVE_HEARTBEAT_INTERVAL_MS,
      durationUpdateIntervalMs: TASK_TOOL_INTERACTIVE_DURATION_UPDATE_INTERVAL_MS,
      unchangedFrameIntervalMs:
        TASK_TOOL_INTERACTIVE_UNCHANGED_FRAME_INTERVAL_MS,
    };
  }

  return {
    mode: "non_interactive",
    minIntervalMs: TASK_TOOL_PARTIAL_UPDATE_MIN_INTERVAL_MS,
    heartbeatIntervalMs: TASK_TOOL_HEARTBEAT_INTERVAL_MS,
    durationUpdateIntervalMs: TASK_TOOL_DURATION_UPDATE_INTERVAL_MS,
  };
}

export function createTaskToolPartialUpdateGate(options?: {
  now?: () => number;
  minIntervalMs?: number;
  unchangedFrameIntervalMs?: number;
}): {
  shouldBuildFingerprint: (input?: { force?: boolean }) => boolean;
  shouldEmit: (input: { fingerprint: string; force?: boolean }) => boolean;
} {
  const now = options?.now ?? Date.now;
  const minIntervalMs = resolveNonNegativeInteger(
    options?.minIntervalMs,
    TASK_TOOL_PARTIAL_UPDATE_MIN_INTERVAL_MS,
  );
  const unchangedFrameIntervalMs =
    typeof options?.unchangedFrameIntervalMs === "number" &&
    Number.isFinite(options.unchangedFrameIntervalMs)
      ? Math.max(0, Math.trunc(options.unchangedFrameIntervalMs))
      : undefined;

  let lastFingerprint = "";
  let lastEmittedAt = 0;

  return {
    shouldBuildFingerprint(input: { force?: boolean } = {}): boolean {
      if (input.force || !lastFingerprint) {
        return true;
      }

      const nowMs = now();
      const elapsed = Math.max(0, nowMs - lastEmittedAt);
      return elapsed >= minIntervalMs;
    },

    shouldEmit(input: { fingerprint: string; force?: boolean }): boolean {
      const fingerprint = normalizeFingerprintText(input.fingerprint);
      if (!fingerprint) {
        return false;
      }

      const nowMs = now();
      const elapsed = Math.max(0, nowMs - lastEmittedAt);
      const isUnchangedFingerprint = fingerprint === lastFingerprint;

      if (isUnchangedFingerprint) {
        if (input.force) {
          return false;
        }

        if (
          typeof unchangedFrameIntervalMs !== "number" ||
          elapsed < unchangedFrameIntervalMs
        ) {
          return false;
        }

        lastEmittedAt = nowMs;
        return true;
      }

      if (!input.force && elapsed < minIntervalMs) {
        return false;
      }

      lastFingerprint = fingerprint;
      lastEmittedAt = nowMs;
      return true;
    },
  };
}
