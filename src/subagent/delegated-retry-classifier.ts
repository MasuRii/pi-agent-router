/**
 * Retryable delegated-session error classification.
 *
 * Mirrors the provider/transient failure buckets used by pi-multi-auth while
 * keeping pi-agent-router independent from sibling extensions at runtime.
 */

import type { ProviderRetryDelayHint } from "./credential-backoff";
import { parseProviderRetryDelayHint } from "./credential-backoff";

export type DelegatedRetryableFailure = {
  kind: "quota" | "credential_auth" | "transient";
  message: string;
  retryAfter?: ProviderRetryDelayHint;
};

export type DelegatedRetryClassifierContext = {
  providerId?: string;
  modelId?: string;
};

const CONTEXT_LIMIT_PATTERNS: RegExp[] = [
  /context length/i,
  /context_length_exceeded/i,
  /maximum context/i,
  /max(?:imum)?\s+tokens?/i,
  /token limit/i,
  /prompt is too long/i,
  /input is too long/i,
  /context window/i,
  /num_ctx/i,
];

const AUTH_TOKEN_INVALIDATED_PATTERNS: RegExp[] = [
  /(?:auth(?:entication)?|access|oauth)\s+token[^\n.]*invalidated/i,
  /invalidated[^\n.]*\b(?:auth(?:entication)?|access|oauth)\s+token\b/i,
  /(?:^|[^\p{L}\p{N}])token[_-]?(?:revoked|invalidated)(?:$|[^\p{L}\p{N}])/iu,
  /try\s+signing\s+in\s+again/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /invalid[_-]?api[_-]?key/i,
  /incorrect\s+api\s+key/i,
  /invalid\s+auth(?:entication)?/i,
  /\b401\b/i,
  /unauthorized/i,
  /expired\s+(?:token|session|credential)/i,
  /access token expired/i,
];

const ORGANIZATION_DISABLED_PATTERNS: RegExp[] = [
  /this organization has been disabled/i,
  /organization has been disabled/i,
  /organization[^\n]*disabled/i,
  /invalid_request_error[^\n]*organization/i,
  /\bdeactivated[_\s-]?workspace\b/i,
  /\bworkspace[_\s-]?deactivated\b/i,
  /\bworkspace[^\n]*disabled\b/i,
];

const PERMISSION_PATTERNS: RegExp[] = [
  /\b403\b/i,
  /forbidden/i,
  /permission[_\s-]?denied/i,
  /does not have permission/i,
  /must be a member of an organization/i,
];

const INVALID_REQUEST_PATTERNS: RegExp[] = [
  /\b400\b/i,
  /bad request/i,
  /unsupported endpoint or method/i,
  /unsupported[_\s-]?endpoint/i,
  /invalid[_\s-]?request/i,
  /unknown model/i,
  /unsupported model/i,
  /model[^\n]*(?:not found|not supported)/i,
  /unknown parameter/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/i,
  /too many requests/i,
  /rate\s*-?\s*limit(?:ed|s)?/i,
  /rate_limit_(?:error|exceeded)/i,
  /throttl(?:ed|ing)?/i,
  /secondary rate limit/i,
  /requests? per (?:minute|second|hour)/i,
  /server\s+(?:is\s+)?busy/i,
  /no\s+available\s+slots?/i,
  /all\s+slots?\s+(?:are\s+)?busy/i,
  /too\s+many\s+concurrent/i,
  // Provider-side concurrent request caps (e.g. "Concurrency limit exceeded
  // for account, please retry later"). Semantically a rate limit, not a quota,
  // because the cap is on simultaneous in-flight requests, not cumulative usage.
  /concurrency limit exceeded/i,
];

const QUOTA_PATTERNS: RegExp[] = [
  /insufficient[_-]?quota/i,
  /exceeded your current quota/i,
  /quota exceeded/i,
  /quota\s+exhausted/i,
  /usage limit/i,
  /you\s+have\s+reached\s+(?:(?:your|the)\s+)?(?:usage\s+)?limit/i,
  /credit balance/i,
  /out of credits?/i,
  /monthly (?:spend|usage) limit/i,
  /daily\s+free\s+allocation/i,
  /used\s+up\s+your\s+daily/i,
  /neurons?\s+per\s+day/i,
  /\b10,?000\s+neurons\b/i,
  /resource\s*exhausted/i,
  /RESOURCE_EXHAUSTED/,
  /limit[_\s-]?reached/i,
  /out\s+of\s+memory/i,
  /CUDA[\s_]out[\s_]of[\s_]memory/i,
  /\bOOM\b/,
];

const BALANCE_EXHAUSTED_PATTERNS: RegExp[] = [
  /\bHTTP\s+402\b/i,
  /\b402\b[^\n]*(?:payment|required|verification|top\s*up)/i,
  /payment[_\s-]?required/i,
  /requires?[^\n.]*verification/i,
  /account[^\n.]*requires?[^\n.]*verification/i,
  /verify[^\n.]*(?:phone|phone\s+number)/i,
  /top\s*up/i,
  /outstanding[_\s-]?balance/i,
  /balance[_\s-]?too[_\s-]?low/i,
  /insufficient[_\s-]?balance/i,
  /account[^\n.]*balance[^\n.]*insufficient/i,
  /balance[^\n.]*insufficient/i,
  /no[_\s-]?credits?[_\s-]?(?:remaining|left)/i,
  /account[_\s-]?has[_\s-]?no[_\s-]?credits/i,
  /credits?[_\s-]?depleted/i,
  /balance[_\s-]?depleted/i,
  /please[_\s-]?add[_\s-]?credits/i,
  /please[_\s-]?add[_\s-]?funds/i,
  /insufficient[_\s-]?tokens/i,
  /purchase[_\s-]?more[_\s-]?tokens/i,
  /INSUFFICIENT_TOKENS/,
];

const WEEKLY_QUOTA_PATTERNS: RegExp[] = [
  /weekly\s+(?:usage|credit|limit)/i,
  /your\s+weekly/i,
  /reached your weekly/i,
  /\bweekly\b[^\n.]*\blimit\b/i,
  /\bweekly\b[^\n.]*\bquota\b/i,
  /7-?day\s+(?:limit|window)/i,
  /upgrade for higher limits/i,
];

const REQUEST_TIMEOUT_PATTERNS: RegExp[] = [
  /multi-auth stream timeout/i,
  /\b(?:attempt|idle)_timeout\b/i,
  /stream timed out/i,
  /(?:Kiro|CommandCode) request timed out after \d+ms\.?/i,
  /request timed out/i,
];

const TRANSIENT_BAD_REQUEST_GATEWAY_PATTERNS: RegExp[] = [
  /400\s+(?:<|&lt;)html(?:>|&gt;)[\s\S]*(?:<|&lt;)title(?:>|&gt;)400\s+Bad Request(?:<\/|&lt;\/)title(?:>|&gt;)[\s\S]*(?:<|&lt;)center(?:>|&gt;)\s*alb\s*(?:<\/|&lt;\/)center(?:>|&gt;)/i,
];

const CANCELLATION_PATTERNS: RegExp[] = [
  /delegation aborted/i,
  /dismissed by user/i,
  /router shutdown/i,
  /request was aborted/i,
  /operation was aborted/i,
  /\bAbortError\b/i,
  /\brequest aborted\b/i,
  /\boperation aborted\b/i,
];

const TRANSIENT_PROVIDER_PATTERNS: RegExp[] = [
  ...TRANSIENT_BAD_REQUEST_GATEWAY_PATTERNS,
  /\b5\d\d\b/i,
  /provider.?returned.?error/i,
  /internal[_\s-]?server[_\s-]?error/i,
  /internal[_\s-]?error/i,
  /server[_\s-]?error/i,
  /internal_server_error/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /upstream[^\n]*(?:connect|timeout|error|failed|unavailable)/i,
  /Upstream request failed/i,
  /temporar(?:y|ily) unavailable/i,
  /high traffic/i,
  /overloaded/i,
  /Multi-auth rotation failed[\s\S]*Provider:\s*kiro\b[\s\S]*Reason:\s*I am experiencing high traffic,\s*please try again shortly\.?/i,
  /please try again (?:later|shortly)/i,
  /timeout/i,
  /timed out/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ECONNABORTED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /UND_ERR_[A-Z_]+/i,
  /error sending request/i,
  /failed to send request/i,
  /wsarecv/i,
  /existing connection was forcibly closed/i,
  /forcibly closed by the remote host/i,
  /connection[_\s-]?(?:reset|refused|aborted|lost|closed|error)/i,
  /broken pipe/i,
  /unexpected eof/i,
  /name or service not known/i,
  /no route to host/i,
  /(?:network|host) is unreachable/i,
  /reset before headers/i,
  /http2 request did not get a response/i,
  /websocket[_\s-]?(?:closed|error)/i,
  /other side closed/i,
  /socket hang up/i,
  /network[_\s-]?error/i,
  /fetch failed/i,
  /terminated/i,
  /retry delay/i,
  /ended (?:before|without) completion/i,
  /without completion event/i,
  /without any assistant output or completion payload/i,
  /without a final assistant output/i,
  /stream ended unexpectedly/i,
  /stream ended before message_stop/i,
  // OpenAI-style streaming payloads close with a "finish_reason" sentinel.
  // A response that ends without one indicates a truncated/incomplete stream
  // from the upstream provider, which should be retried rather than surfaced
  // as a hard error.
  /stream ended without finish_reason/i,
  /stream returned an error/i,
  /model\s+(?:is\s+)?not\s+loaded/i,
  /failed\s+to\s+load\s+model/i,
  /llama\s+runner/i,
];

const MODEL_NOT_SUPPORTED_PATTERNS: RegExp[] = [
  /unsupported model/i,
  /model[^\n]*(?:not found|not supported)/i,
  /unknown model/i,
];

const CODEX_CREDENTIAL_MODEL_ACCESS_PATTERNS: RegExp[] = [
  /model[^\n]*(?:not found|not supported|not available|not enabled)/i,
  /not supported when using codex with a chatgpt account/i,
  /(?:do not|don't|does not|doesn't) have access[^\n]*(?:model|gpt)/i,
  /(?:account|plan|subscription)[^\n]*(?:cannot|can't|does not|doesn't|not allowed|not permitted)[^\n]*(?:access|use)/i,
  /requires[^\n]*(?:plus|pro|team|business|enterprise|paid)/i,
];

const KIRO_CREDENTIAL_MODEL_ACCESS_PATTERNS: RegExp[] = [
  /^invalid model\. please select a different model to continue\.?$/i,
  /model[^\n]*(?:not found|not supported|not available|not enabled|invalid)/i,
  /(?:do not|don't|does not|doesn't) have access[^\n]*(?:model|claude|opus|sonnet)/i,
  /(?:account|plan|subscription)[^\n]*(?:cannot|can't|does not|doesn't|not allowed|not permitted)[^\n]*(?:access|use)/i,
  /requires[^\n]*(?:pro|paid|upgrade|subscription)/i,
];

const BLAZEAPI_CREDENTIAL_MODEL_ACCESS_PATTERNS: RegExp[] = [
  /model[^\n]*(?:only available to paid users|paid users only|requires a paid plan|requires paid)/i,
  /(?:account|plan)[^\n]*(?:cannot|can't|does not|doesn't|not allowed|not permitted)[^\n]*(?:access|use)[^\n]*(?:model|claude|opus|sonnet)/i,
  /paid[_\s-]?plan[_\s-]?required/i,
];

const BLAZEAPI_SELECTED_PROVIDER_FAILED_HTTP_400_PATTERNS: RegExp[] = [
  /the selected provider failed this request\s*\(HTTP\s*400\)/i,
];

type PipeDelimitedDelegatedError = {
  summary: string;
  fields: Record<string, string>;
};

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function normalizeProviderId(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeModelId(value: string | undefined): string {
  const rawModelId = (value ?? "").trim().toLowerCase();
  const separatorIndex = rawModelId.indexOf("/");
  return separatorIndex >= 0 ? rawModelId.slice(separatorIndex + 1).trim() : rawModelId;
}

function isCredentialModelIncompatibilityError(
  message: string,
  context?: DelegatedRetryClassifierContext,
): boolean {
  const providerId = normalizeProviderId(context?.providerId);
  const modelId = normalizeModelId(context?.modelId);

  if (providerId === "openai-codex" && modelId.startsWith("gpt-")) {
    return matchesAny(message, CODEX_CREDENTIAL_MODEL_ACCESS_PATTERNS);
  }

  if (providerId === "kiro" && modelId.startsWith("claude-")) {
    return matchesAny(message, KIRO_CREDENTIAL_MODEL_ACCESS_PATTERNS);
  }

  if (providerId === "blazeapi") {
    return matchesAny(message, BLAZEAPI_CREDENTIAL_MODEL_ACCESS_PATTERNS);
  }

  return false;
}

function isRetryableModelAvailabilityError(
  message: string,
  context?: DelegatedRetryClassifierContext,
): boolean {
  if (isCredentialModelIncompatibilityError(message, context)) {
    return true;
  }

  if (normalizeProviderId(context?.providerId) !== "vivgrid") {
    return false;
  }

  return matchesAny(message, MODEL_NOT_SUPPORTED_PATTERNS);
}

function buildRetryableFailure(
  kind: DelegatedRetryableFailure["kind"],
  message: string,
): DelegatedRetryableFailure {
  const retryAfter = parseProviderRetryDelayHint(message);
  return retryAfter ? { kind, message, retryAfter } : { kind, message };
}

function parsePipeDelimitedDelegatedError(message: string): PipeDelimitedDelegatedError | undefined {
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\[[^\]]+\]\s+/.test(line) || !line.includes("|")) {
      continue;
    }

    const segments = line.split("|").map((segment) => segment.trim()).filter(Boolean);
    const summary = segments.shift()?.replace(/^\[[^\]]+\]\s*/, "").trim();
    if (!summary) {
      continue;
    }

    const fields: Record<string, string> = {};
    for (const segment of segments) {
      const separatorIndex = segment.indexOf(":");
      if (separatorIndex <= 0) {
        continue;
      }
      const key = segment.slice(0, separatorIndex).trim().toLowerCase();
      const value = segment.slice(separatorIndex + 1).trim();
      if (/^[a-z][a-z0-9_-]*$/.test(key) && value) {
        fields[key] = value;
      }
    }

    if (fields.reason) {
      return { summary, fields };
    }
  }

  return undefined;
}

function isCredentialAvailabilitySummary(summary: string): boolean {
  return /^credentials?\s+(?:exhausted|unavailable)$/i.test(summary.trim());
}

function isExplicitNonRetryablePipeReason(
  reason: string,
  context?: DelegatedRetryClassifierContext,
): boolean {
  if (matchesAny(reason, CONTEXT_LIMIT_PATTERNS) || matchesAny(reason, CANCELLATION_PATTERNS)) {
    return true;
  }

  if (
    normalizeProviderId(context?.providerId) === "blazeapi" &&
    matchesAny(reason, BLAZEAPI_SELECTED_PROVIDER_FAILED_HTTP_400_PATTERNS)
  ) {
    return false;
  }

  if (matchesAny(reason, TRANSIENT_BAD_REQUEST_GATEWAY_PATTERNS)) {
    return false;
  }

  return matchesAny(reason, INVALID_REQUEST_PATTERNS);
}

function classifyDelegatedRetryableFailureText(
  message: string,
  context?: DelegatedRetryClassifierContext,
): DelegatedRetryableFailure | undefined {
  if (matchesAny(message, CONTEXT_LIMIT_PATTERNS)) {
    return undefined;
  }

  if (
    matchesAny(message, AUTH_TOKEN_INVALIDATED_PATTERNS) ||
    matchesAny(message, AUTH_PATTERNS) ||
    matchesAny(message, ORGANIZATION_DISABLED_PATTERNS) ||
    matchesAny(message, PERMISSION_PATTERNS) ||
    isRetryableModelAvailabilityError(message, context)
  ) {
    return buildRetryableFailure("credential_auth", message);
  }

  if (
    normalizeProviderId(context?.providerId) === "blazeapi" &&
    matchesAny(message, BLAZEAPI_SELECTED_PROVIDER_FAILED_HTTP_400_PATTERNS)
  ) {
    return buildRetryableFailure("transient", message);
  }

  if (matchesAny(message, TRANSIENT_BAD_REQUEST_GATEWAY_PATTERNS)) {
    return buildRetryableFailure("transient", message);
  }

  if (matchesAny(message, INVALID_REQUEST_PATTERNS)) {
    return undefined;
  }

  if (
    matchesAny(message, RATE_LIMIT_PATTERNS) ||
    matchesAny(message, QUOTA_PATTERNS) ||
    matchesAny(message, WEEKLY_QUOTA_PATTERNS) ||
    matchesAny(message, BALANCE_EXHAUSTED_PATTERNS)
  ) {
    return buildRetryableFailure("quota", message);
  }

  if (matchesAny(message, CANCELLATION_PATTERNS)) {
    return undefined;
  }

  if (
    matchesAny(message, REQUEST_TIMEOUT_PATTERNS) ||
    matchesAny(message, TRANSIENT_PROVIDER_PATTERNS)
  ) {
    return buildRetryableFailure("transient", message);
  }

  return undefined;
}

function classifyPipeDelimitedDelegatedFailure(
  message: string,
  context?: DelegatedRetryClassifierContext,
): DelegatedRetryableFailure | undefined | null {
  const parsed = parsePipeDelimitedDelegatedError(message);
  if (!parsed) {
    return undefined;
  }

  const parsedContext: DelegatedRetryClassifierContext = {
    providerId: parsed.fields.provider ?? context?.providerId,
    modelId: parsed.fields.model ?? context?.modelId,
  };
  const reason = parsed.fields.reason;
  const reasonFailure = classifyDelegatedRetryableFailureText(reason, parsedContext);
  if (reasonFailure) {
    return {
      ...reasonFailure,
      message,
    };
  }

  if (isExplicitNonRetryablePipeReason(reason, parsedContext)) {
    return null;
  }

  if (isCredentialAvailabilitySummary(parsed.summary)) {
    return buildRetryableFailure("transient", message);
  }

  return undefined;
}

export function classifyDelegatedRetryableFailure(
  rawMessage: string,
  context?: DelegatedRetryClassifierContext,
): DelegatedRetryableFailure | undefined {
  const message = rawMessage.trim();
  if (!message) {
    return undefined;
  }

  const pipeDelimitedFailure = classifyPipeDelimitedDelegatedFailure(message, context);
  if (pipeDelimitedFailure !== undefined) {
    return pipeDelimitedFailure ?? undefined;
  }

  return classifyDelegatedRetryableFailureText(message, context);
}
