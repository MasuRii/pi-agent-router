/**
 * Model footer formatting utilities.
 */

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

function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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

export function formatThinkingLevelForDisplay(
  level: string | undefined,
  modelReference: string | undefined,
): string | undefined {
  const normalized = normalizeInputText(level).toLowerCase();
  if (!normalized || normalized === "off" || normalized === "none") {
    return undefined;
  }

  if (normalized === "xhigh") {
    const modelLower = (modelReference ?? "").toLowerCase();
    const isOpus46 = modelLower.includes("opus-4.6") || modelLower.includes("opus-4-6");
    const isAnthropicStyle = modelLower.includes("anthropic") || modelLower.includes("claude");
    if (isOpus46 && isAnthropicStyle) {
      return "max";
    }
  }

  return normalized;
}
