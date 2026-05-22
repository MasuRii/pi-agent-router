/**
 * Credential cooldown helpers used by delegated subagent credential rotation.
 *
 * These helpers live inside pi-agent-router so the extension can be published
 * without requiring sibling local extensions to exist at runtime.
 */

/**
 * Weekly quota cooldown durations for exponential backoff.
 * Pattern: 12h -> 24h -> 48h -> 72h (max).
 */
export const WEEKLY_QUOTA_COOLDOWN_MS = Object.freeze([
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  48 * 60 * 60 * 1000,
  72 * 60 * 60 * 1000,
] as const);

export const TRANSIENT_COOLDOWN_BASE_MS = 15_000;
export const TRANSIENT_COOLDOWN_MAX_MS = 15 * 60 * 1000;

const RETRY_AFTER_MESSAGE_PATTERN =
  /(?:try\s+again|retry)\s+(?:in|after)\s+~?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|min|hours?|hrs?|hr|days?|d)\b/i;

function resolveRetryAfterUnitMs(unit: string): number | undefined {
  const normalizedUnit = unit.trim().toLowerCase();
  if (["millisecond", "milliseconds", "msec", "msecs", "ms"].includes(normalizedUnit)) {
    return 1;
  }
  if (["second", "seconds", "sec", "secs", "s"].includes(normalizedUnit)) {
    return 1_000;
  }
  if (["minute", "minutes", "min", "mins"].includes(normalizedUnit)) {
    return 60_000;
  }
  if (["hour", "hours", "hr", "hrs", "h"].includes(normalizedUnit)) {
    return 60 * 60_000;
  }
  if (["day", "days", "d"].includes(normalizedUnit)) {
    return 24 * 60 * 60_000;
  }
  return undefined;
}

export function parseRetryAfterCooldownMs(message: string): number | undefined {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    return undefined;
  }

  const match = RETRY_AFTER_MESSAGE_PATTERN.exec(normalizedMessage);
  if (!match) {
    return undefined;
  }

  const value = Number.parseFloat(match[1] || "");
  const unitMs = resolveRetryAfterUnitMs(match[2] || "");
  if (!Number.isFinite(value) || value <= 0 || unitMs === undefined) {
    return undefined;
  }

  const cooldownMs = Math.ceil(value * unitMs);
  return Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : undefined;
}

export type ProviderRetryDelayHint = {
  delayMs: number;
  source: "retry-after-ms" | "retry-after";
  rawValue: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRetryHeaderValue(message: string, headerName: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|[\\s,{;])["']?${escapeRegExp(headerName)}["']?\\s*[:=]\\s*(["']?)([^\\n\\r]+)`,
    "i",
  );
  const match = pattern.exec(message);
  if (!match) {
    return undefined;
  }

  const quote = match[1] || "";
  let value = (match[2] || "").trim();
  if (quote) {
    const quoteEnd = value.indexOf(quote);
    if (quoteEnd >= 0) {
      value = value.slice(0, quoteEnd);
    }
  }

  value = value.replace(/[;,}\]]\s*$/, "").trim();
  return value || undefined;
}

function parsePositiveNumber(value: string): number | undefined {
  const numericMatch = /^\s*(\d+(?:\.\d+)?)/.exec(value);
  if (!numericMatch) {
    return undefined;
  }

  const parsed = Number.parseFloat(numericMatch[1] || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseProviderRetryDelayHint(
  message: string,
  nowMs: number = Date.now(),
): ProviderRetryDelayHint | undefined {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    return undefined;
  }

  const retryAfterMsValue = findRetryHeaderValue(normalizedMessage, "retry-after-ms");
  if (retryAfterMsValue) {
    const retryAfterMs = parsePositiveNumber(retryAfterMsValue);
    if (retryAfterMs !== undefined) {
      const delayMs = Math.ceil(retryAfterMs);
      return delayMs > 0
        ? { delayMs, source: "retry-after-ms", rawValue: retryAfterMsValue }
        : undefined;
    }
  }

  const retryAfterValue = findRetryHeaderValue(normalizedMessage, "retry-after");
  if (!retryAfterValue) {
    return undefined;
  }

  const retryAfterSeconds = parsePositiveNumber(retryAfterValue);
  if (retryAfterSeconds !== undefined) {
    const delayMs = Math.ceil(retryAfterSeconds * 1_000);
    return delayMs > 0
      ? { delayMs, source: "retry-after", rawValue: retryAfterValue }
      : undefined;
  }

  const retryAfterDateMs = Date.parse(retryAfterValue);
  if (!Number.isFinite(retryAfterDateMs)) {
    return undefined;
  }

  const delayMs = Math.ceil(retryAfterDateMs - nowMs);
  return delayMs > 0
    ? { delayMs, source: "retry-after", rawValue: retryAfterValue }
    : undefined;
}

export function computeExponentialBackoffMs(
  baseMs: number,
  attempt: number,
  maxMs: number,
): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const scaled = baseMs * Math.pow(2, safeAttempt - 1);
  return Math.min(maxMs, Math.max(baseMs, scaled));
}

export function getWeeklyQuotaCooldownMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const cooldownIndex = Math.min(
    safeAttempt - 1,
    WEEKLY_QUOTA_COOLDOWN_MS.length - 1,
  );
  return WEEKLY_QUOTA_COOLDOWN_MS[cooldownIndex];
}
