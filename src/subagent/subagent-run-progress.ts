import type { SubagentRunResult, SubagentUsage } from "../types";

export type DelegatedProgressSignals = {
  outputText: string;
  toolInvocationCount: number;
  structuredError?: string;
};

function isPositiveFiniteNumber(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasMeteredUsage(usage: SubagentUsage | undefined): boolean {
  if (!usage) {
    return false;
  }

  return (
    isPositiveFiniteNumber(usage.input) ||
    isPositiveFiniteNumber(usage.output) ||
    isPositiveFiniteNumber(usage.cacheRead) ||
    isPositiveFiniteNumber(usage.cacheWrite) ||
    isPositiveFiniteNumber(usage.cost) ||
    isPositiveFiniteNumber(usage.contextTokens)
  );
}

function isEmptyStructuredErrorOnlyRun(
  run: SubagentRunResult,
  signals: DelegatedProgressSignals,
): boolean {
  return (
    Boolean(signals.structuredError?.trim()) &&
    signals.outputText.trim().length === 0 &&
    signals.toolInvocationCount <= 0 &&
    !hasMeteredUsage(run.usage)
  );
}

export function hasExtensiveDelegatedProgressForCredentialRetry(
  run: SubagentRunResult,
  signals: DelegatedProgressSignals,
): boolean {
  if (isEmptyStructuredErrorOnlyRun(run, signals)) {
    return false;
  }

  const usage = run.usage;
  return (
    signals.toolInvocationCount >= 12 ||
    (usage?.turns ?? 0) >= 6 ||
    (usage?.input ?? 0) >= 50_000 ||
    signals.outputText.length >= 24_000
  );
}
