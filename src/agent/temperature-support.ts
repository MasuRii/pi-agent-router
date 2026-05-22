import type { Api, Model } from "@earendil-works/pi-ai";

const OPENAI_COMPATIBLE_TEMPERATURE_RESTRICTED_APIS = new Set<string>([
  "azure-openai-responses",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
]);

function getModelId(model: Model<Api>): string {
  const id = typeof model.id === "string" ? model.id : "";
  const tail = id.includes("/") ? id.split("/").pop() : id;
  return (tail || id).toLowerCase();
}

function getModelReference(model: Model<Api>): string {
  const provider = typeof model.provider === "string" ? model.provider : "unknown";
  const id = typeof model.id === "string" ? model.id : "unknown";
  return `${provider}/${id}`;
}

function isOpenAIReasoningModel(model: Model<Api>): boolean {
  if (!OPENAI_COMPATIBLE_TEMPERATURE_RESTRICTED_APIS.has(String(model.api))) {
    return false;
  }

  const id = getModelId(model);

  if (id.startsWith("gpt-5-chat")) {
    return false;
  }

  return Boolean(
    model.reasoning ||
      /^o\d(?:$|[-.])/.test(id) ||
      /^gpt-5(?:$|[-.])/.test(id) ||
      /(?:^|[-.])codex(?:$|[-.])/.test(id),
  );
}

export function getRuntimeTemperatureUnsupportedReason(
  model: Model<Api>,
): string | undefined {
  if (isOpenAIReasoningModel(model)) {
    return `model '${getModelReference(model)}' uses OpenAI-compatible reasoning controls, which reject runtime temperature options`;
  }

  return undefined;
}

export function supportsRuntimeTemperatureOption(model: Model<Api>): boolean {
  return !getRuntimeTemperatureUnsupportedReason(model);
}
