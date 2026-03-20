/**
 * Subagent usage tracking and metrics utilities.
 */

import {
  SUBAGENT_DERIVED_OUTPUT_MAX_CHARS,
  SUBAGENT_PARSED_MESSAGE_MAX_COUNT,
  SUBAGENT_PARSED_MESSAGE_MAX_CHARS,
  SUBAGENT_TOOL_INVOCATION_MAX_ENTRIES,
} from "../constants";
import type { SubagentUsage, SubagentJsonEventState, BoundedTextCapture } from "../types";

export function createEmptySubagentUsage(): SubagentUsage {
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

function normalizePositiveLimit(value: unknown, defaultValue: number, label: string): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected a positive finite number.`);
  }

  return Math.max(1, Math.trunc(value));
}

export function createSubagentJsonEventState(options: {
  sessionDir?: string;
  messageRetentionLimit?: number;
  messageRetentionMaxChars?: number;
  outputTextMaxChars?: number;
  toolInvocationRetentionLimit?: number;
} = {}): SubagentJsonEventState {
  return {
    messages: [],
    messageWeights: [],
    retainedMessageChars: 0,
    messageRetentionLimit: normalizePositiveLimit(
      options.messageRetentionLimit,
      SUBAGENT_PARSED_MESSAGE_MAX_COUNT,
      "messageRetentionLimit",
    ),
    messageRetentionMaxChars: normalizePositiveLimit(
      options.messageRetentionMaxChars,
      SUBAGENT_PARSED_MESSAGE_MAX_CHARS,
      "messageRetentionMaxChars",
    ),
    droppedMessageCount: 0,
    outputText: "",
    outputTextMaxChars: normalizePositiveLimit(
      options.outputTextMaxChars,
      SUBAGENT_DERIVED_OUTPUT_MAX_CHARS,
      "outputTextMaxChars",
    ),
    usage: createEmptySubagentUsage(),
    malformedEventCount: 0,
    latestToolCall: undefined,
    sessionDir: options.sessionDir,
    toolInvocationMap: new Map(),
    toolInvocationRetentionLimit: normalizePositiveLimit(
      options.toolInvocationRetentionLimit,
      SUBAGENT_TOOL_INVOCATION_MAX_ENTRIES,
      "toolInvocationRetentionLimit",
    ),
    toolInvocationTotalCount: 0,
  };
}

export function createBoundedTextCapture(): BoundedTextCapture {
  return {
    value: "",
    droppedChars: 0,
  };
}

export function appendToBoundedTextCapture(capture: BoundedTextCapture, piece: string, maxChars: number): void {
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

export function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function mergeUsageTotals(target: SubagentUsage, value: unknown): void {
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

export function cloneSubagentUsage(usage: SubagentUsage): SubagentUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
    contextTokens: usage.contextTokens,
    turns: usage.turns,
  };
}

export function parseSubagentUsage(value: unknown): SubagentUsage | undefined {
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

export function formatSubagentUsageSummary(usage: SubagentUsage): string {
  const segments: string[] = [];

  if (usage.input > 0 || usage.output > 0) {
    segments.push(`tokens in/out ${usage.input}/${usage.output}`);
  }

  if (usage.contextTokens > 0) {
    segments.push(`context ${usage.contextTokens}`);
  }

  if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
    segments.push(`cache r/w ${usage.cacheRead}/${usage.cacheWrite}`);
  }

  if (usage.turns > 0) {
    segments.push(`turns ${usage.turns}`);
  }

  if (usage.cost > 0) {
    segments.push(`cost $${usage.cost.toFixed(4)}`);
  }

  return segments.join(" • ");
}
