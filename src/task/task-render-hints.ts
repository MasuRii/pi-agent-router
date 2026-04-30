import { normalizeInputText } from "../input-normalization";

export function formatAttachSubagentOutputHint(
  sessionId: string | undefined,
  action = "view output",
): string | undefined {
  const normalized = normalizeInputText(sessionId);
  const normalizedAction = normalizeInputText(action) || "view output";
  if (!normalized) {
    return undefined;
  }

  return `⌨ Type /attach ${normalized.slice(0, 8)} to ${normalizedAction}`;
}

export function formatHiddenTasksSummary(hiddenTaskCount: number): string | undefined {
  if (!Number.isFinite(hiddenTaskCount) || hiddenTaskCount <= 0) {
    return undefined;
  }

  const hidden = Math.max(1, Math.trunc(hiddenTaskCount));
  return `… ${hidden} additional task(s) hidden • Ctrl+O`;
}
