import type { Api } from "@mariozechner/pi-ai";

const OPENAI_RESPONSES_APIS = new Set<Api>([
  "openai-responses",
  "azure-openai-responses",
]);
const TEMPERATURE_UNSUPPORTED_APIS = new Set<Api>([
  "openai-codex-responses",
]);
const TEMPERATURE_UNSUPPORTED_PROVIDERS = new Set<string>([
  "openai-codex",
]);

function normalizeIdentifier(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function hasModelToken(modelId: string | undefined, token: string): boolean {
  return normalizeIdentifier(modelId).split(/[^a-z0-9]+/).includes(token);
}

type TemperatureCapabilityModel = {
  api: Api;
  id?: string;
  provider?: string;
  reasoning?: boolean;
};

export function getRuntimeTemperatureUnsupportedReason(
  model: TemperatureCapabilityModel,
): string | undefined {
  if (TEMPERATURE_UNSUPPORTED_APIS.has(model.api)) {
    return `api '${model.api}' does not support runtime temperature`;
  }

  const provider = normalizeIdentifier(model.provider);
  if (TEMPERATURE_UNSUPPORTED_PROVIDERS.has(provider)) {
    return `provider '${model.provider}' does not support runtime temperature`;
  }

  if (OPENAI_RESPONSES_APIS.has(model.api) && hasModelToken(model.id, "codex")) {
    return `model '${model.id}' does not support runtime temperature`;
  }

  if (OPENAI_RESPONSES_APIS.has(model.api) && model.reasoning) {
    return `reasoning model '${model.id}' accepts only the provider default temperature`;
  }

  return undefined;
}

export function supportsRuntimeTemperatureOption(
  model: TemperatureCapabilityModel,
): boolean {
  return getRuntimeTemperatureUnsupportedReason(model) === undefined;
}
