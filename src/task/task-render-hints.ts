function normalizeSessionId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function formatAttachSubagentOutputHint(
  sessionId: string | undefined,
): string | undefined {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    return undefined;
  }

  return `/attach ${normalized.slice(0, 8)} view subagent output`;
}

export function formatHiddenTasksSummary(hiddenTaskCount: number): string | undefined {
  if (!Number.isFinite(hiddenTaskCount) || hiddenTaskCount <= 0) {
    return undefined;
  }

  const hidden = Math.max(1, Math.trunc(hiddenTaskCount));
  return `… ${hidden} additional task(s) hidden • Ctrl+O`;
}
