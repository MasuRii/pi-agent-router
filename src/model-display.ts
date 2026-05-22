/**
 * Model footer formatting utilities.
 */

import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

import { normalizeInputText } from "./input-normalization";

const PROVIDER_ALIASES: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  aistudio: "Google AI Studio",
  "github-copilot": "GitHub Copilot",
  nvidia: "NVIDIA",
  myproxy: "MyProxy",
  xai: "xAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
};

export const MODEL_FOOTER_ICON = "";


function titleCaseToken(token: string): string {
  const normalized = token.trim();
  if (!normalized) {
    return "";
  }

  const lower = normalized.toLowerCase();
  if (lower === "gpt") {
    return "GPT";
  }

  if (lower === "ai") {
    return "AI";
  }

  if (/^\d+(?:\.\d+)*[a-z]?$/.test(lower)) {
    return lower;
  }

  return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
}

function formatProviderName(provider: string | undefined): string | undefined {
  const normalizedProvider = normalizeInputText(provider).toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }

  if (PROVIDER_ALIASES[normalizedProvider]) {
    return PROVIDER_ALIASES[normalizedProvider];
  }

  const firstToken = normalizedProvider.split(/[/:]/)[0] || normalizedProvider;
  if (PROVIDER_ALIASES[firstToken]) {
    return PROVIDER_ALIASES[firstToken];
  }

  const words = firstToken
    .split(/[-_]+/)
    .map((token) => titleCaseToken(token))
    .filter(Boolean);

  return words.length > 0 ? words.join(" ") : undefined;
}

function mergeConsecutiveNumericTokens(tokens: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (/^\d+$/.test(tokens[i]!)) {
      let numericGroup = tokens[i]!;
      while (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1]!)) {
        i++;
        numericGroup += `.${tokens[i]!}`;
      }
      result.push(numericGroup);
    } else {
      result.push(tokens[i]!);
    }
    i++;
  }
  return result;
}

function formatModelId(modelId: string): string {
  const normalized = normalizeInputText(modelId).replace(/\s+/g, "-");
  if (!normalized) {
    return "Unknown Model";
  }

  const lower = normalized.toLowerCase();
  if (lower === "gpt") {
    return "GPT";
  }

  if (lower.startsWith("gpt-")) {
    const suffix = normalized.slice(4);
    const suffixTokens = suffix
      .split(/[-_]+/)
      .map((token) => titleCaseToken(token))
      .filter(Boolean);

    if (suffixTokens.length === 0) {
      return "GPT";
    }

    const [firstToken, ...restTokens] = suffixTokens;
    if (!firstToken) {
      return `GPT ${restTokens.join(" ")}`.trim();
    }

    if (restTokens.length === 0) {
      return `GPT-${firstToken}`;
    }

    return `GPT-${firstToken} ${restTokens.join(" ")}`;
  }

  const tokens = normalized
    .split(/[-_]+/)
    .map((token) => titleCaseToken(token))
    .filter(Boolean);

  if (tokens.length === 0) {
    return normalized;
  }

  const merged = mergeConsecutiveNumericTokens(tokens);
  let result = merged.join(" ");

  if (result.startsWith("Claude ")) {
    result = result.slice(7);
  }

  return result;
}

export function formatModelReferenceForFooter(modelReference: string | undefined): string | undefined {
  const normalized = normalizeInputText(modelReference);
  if (!normalized) {
    return undefined;
  }

  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === normalized.length - 1) {
    return formatModelId(normalized);
  }

  const provider = normalized.slice(0, separatorIndex);
  const modelId = normalized.slice(separatorIndex + 1);
  const providerLabel = formatProviderName(provider);
  const modelLabel = formatModelId(modelId);

  if (!providerLabel) {
    return modelLabel;
  }

  if (modelLabel.toLowerCase().includes(providerLabel.toLowerCase())) {
    return modelLabel;
  }

  return `${modelLabel} (${providerLabel})`;
}

const THINKING_LEVEL_HIERARCHY: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function normalizeThinkingLevelForDisplay(level: string | undefined): ModelThinkingLevel | undefined {
  const normalized = normalizeInputText(level).toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "none" || normalized === "disabled") {
    return "off";
  }

  if (normalized === "min") {
    return "minimal";
  }

  if (normalized === "med") {
    return "medium";
  }

  if (normalized === "max") {
    return "xhigh";
  }

  return THINKING_LEVEL_HIERARCHY.includes(normalized as ModelThinkingLevel)
    ? normalized as ModelThinkingLevel
    : undefined;
}

function formatThinkingDisplayLabel(value: string | undefined): string | undefined {
  const normalized = normalizeInputText(value).toLowerCase();
  if (!normalized || normalized === "off" || normalized === "none" || normalized === "disabled") {
    return undefined;
  }

  return normalized;
}

function supportsMappedThinkingLevel(
  level: ModelThinkingLevel,
  thinkingLevelMap: ThinkingLevelMap | undefined,
): boolean {
  if (level === "off") {
    return true;
  }

  if (!thinkingLevelMap) {
    return true;
  }

  const mapped = thinkingLevelMap[level];
  if (mapped === null) {
    return false;
  }

  // Pi treats an explicit map as authoritative for xhigh: absent xhigh means
  // the model does not expose a max/xhigh tier, while absent lower tiers fall
  // back to the canonical Pi labels.
  if (level === "xhigh") {
    return mapped !== undefined;
  }

  return true;
}

function resolveDisplayThinkingLevel(
  level: ModelThinkingLevel,
  thinkingLevelMap: ThinkingLevelMap | undefined,
): ModelThinkingLevel {
  if (supportsMappedThinkingLevel(level, thinkingLevelMap)) {
    return level;
  }

  const requestedIndex = THINKING_LEVEL_HIERARCHY.indexOf(level);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVEL_HIERARCHY[index]!;
    if (supportsMappedThinkingLevel(candidate, thinkingLevelMap)) {
      return candidate;
    }
  }

  return "off";
}

function hasLegacyMaxThinkingReference(modelReference: string | undefined): boolean {
  const modelLower = normalizeInputText(modelReference).toLowerCase();
  if (!modelLower) {
    return false;
  }

  const isAnthropicStyle = modelLower.includes("anthropic") || modelLower.includes("claude");
  if (!isAnthropicStyle) {
    return false;
  }

  // Compatibility for older task details that only persisted a model string.
  // Metadata-driven thinkingLevelMap remains authoritative when available.
  return /claude[-\s_/]*(?:opus[-\s_/]*)?4[.-]?[67]\b|claude[-\s_/]*opus[-\s_/]*4[.-]?[67]\b/.test(modelLower);
}

export function formatThinkingLevelForDisplay(
  level: string | undefined,
  modelReference: string | undefined,
  thinkingLevelMap?: ThinkingLevelMap,
): string | undefined {
  const requestedLevel = normalizeThinkingLevelForDisplay(level);
  if (!requestedLevel || requestedLevel === "off") {
    return undefined;
  }

  const displayLevel = resolveDisplayThinkingLevel(requestedLevel, thinkingLevelMap);
  if (displayLevel === "off") {
    return undefined;
  }

  const mappedDisplay = displayLevel === "xhigh"
    ? formatThinkingDisplayLabel(thinkingLevelMap?.[displayLevel] ?? undefined)
    : undefined;
  if (mappedDisplay) {
    return mappedDisplay;
  }

  if (displayLevel === "xhigh" && hasLegacyMaxThinkingReference(modelReference)) {
    return "max";
  }

  return displayLevel;
}
