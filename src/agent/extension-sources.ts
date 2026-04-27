/**
 * Dynamic extension source generation for delegated subagents.
 */

import type { Api, AssistantMessageEventStream, Context as LlmContext, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";

import type { Agent, ApiStreamSimpleDelegate, GlobalWithAgentRouterBaseApiStreams } from "../types";

const ACTIVE_AGENT_PROMPT_MODULE_URL = new URL("./active-agent-prompt.ts", import.meta.url).href;
const TEMPERATURE_SUPPORT_MODULE_URL = new URL("./temperature-support.ts", import.meta.url).href;
const DEFAULT_COPILOT_INITIATOR_TARGET_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

export function getAgentRouterBaseApiStreams(): Map<string, ApiStreamSimpleDelegate> {
  const globalScope = globalThis as GlobalWithAgentRouterBaseApiStreams;
  if (!globalScope.__piAgentRouterBaseApiStreams) {
    globalScope.__piAgentRouterBaseApiStreams = new Map<string, ApiStreamSimpleDelegate>();
  }
  return globalScope.__piAgentRouterBaseApiStreams;
}

export function buildDelegatedActiveAgentIdentityExtensionSource(
  agent: Pick<Agent, "name" | "description" | "systemPrompt">,
): string {
  const delegatedAgent = {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
  };

  return [
    "import type { ExtensionAPI } from \"@mariozechner/pi-coding-agent\";",
    `import { buildSystemPromptForActiveAgent } from ${JSON.stringify(ACTIVE_AGENT_PROMPT_MODULE_URL)};`,
    "",
    `const delegatedAgent = ${JSON.stringify(delegatedAgent, null, 2)};`,
    "",
    "export default function delegatedActiveAgentIdentityRuntime(pi: ExtensionAPI): void {",
    '  pi.on("before_agent_start", async (event) => {',
    "    return {",
    '      systemPrompt: buildSystemPromptForActiveAgent(event.systemPrompt, delegatedAgent, { interactionMode: "delegated" }),',
    "    };",
    "  });",
    "}",
    "",
  ].join("\n");
}

export function buildDelegatedTemperatureExtensionSource(temperature: number): string {
  const runtimeTemperature = Number.isFinite(temperature) ? temperature : 1;

  return [
    "import { getApiProvider, type Api, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from \"@mariozechner/pi-ai\";",
    "import type { ExtensionAPI } from \"@mariozechner/pi-coding-agent\";",
    `import { supportsRuntimeTemperatureOption } from ${JSON.stringify(TEMPERATURE_SUPPORT_MODULE_URL)};`,
    "",
    `const runtimeTemperature = ${JSON.stringify(runtimeTemperature)};`,
    "",
    "type ApiStreamSimpleDelegate = (",
    "  model: Model<Api>,",
    "  context: Context,",
    "  options?: SimpleStreamOptions,",
    ") => AssistantMessageEventStream;",
    "",
    "const baseApiStreams = new Map<string, ApiStreamSimpleDelegate>();",
    "const wrappedApis = new Set<string>();",
    "",
    "function ensureWrapper(pi: ExtensionAPI, api: Api): boolean {",
    "  if (wrappedApis.has(api)) return true;",
    "",
    "  let delegate = baseApiStreams.get(api);",
    "  if (!delegate) {",
    "    const provider = getApiProvider(api);",
    "    if (!provider) return false;",
    "    delegate = provider.streamSimple as ApiStreamSimpleDelegate;",
    "    baseApiStreams.set(api, delegate);",
    "  }",
    "",
    "  const providerName = `pi-agent-router-delegated-temperature-${api.replace(/[^a-z0-9]+/gi, \"-\").toLowerCase()}`;",
    "",
    "  try {",
    "    pi.registerProvider(providerName, {",
    "      api,",
    "      streamSimple: (model, context, options) => {",
    "        const base = baseApiStreams.get(model.api);",
    "        if (!base) throw new Error(`No base stream provider for api '${model.api}'.`);",
    "        const typedModel = model as Model<Api>;",
    "        if (!supportsRuntimeTemperatureOption(typedModel)) return base(typedModel, context, options);",
    "        const nextOptions: SimpleStreamOptions = options",
    "          ? { ...options, temperature: runtimeTemperature }",
    "          : { temperature: runtimeTemperature };",
    "        return base(typedModel, context, nextOptions);",
    "      },",
    "    });",
    "    wrappedApis.add(api);",
    "    return true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "export default function delegatedTemperatureRuntime(pi: ExtensionAPI): void {",
    "  pi.on(\"before_agent_start\", async (_event, ctx) => {",
    "    const model = ctx.model;",
    "    if (!model) return {};",
    "    ensureWrapper(pi, model.api as Api);",
    "    return {};",
    "  });",
    "}",
    "",
  ].join("\n");
}

export function buildDelegatedCopilotInitiatorExtensionSource(
  targetApis: readonly string[] = DEFAULT_COPILOT_INITIATOR_TARGET_APIS,
): string {
  return [
    "import { getApiProvider, type Api, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from \"@mariozechner/pi-ai\";",
    "import type { ExtensionAPI } from \"@mariozechner/pi-coding-agent\";",
    "",
    "type ApiStreamSimpleDelegate = (",
    "  model: Model<Api>,",
    "  context: Context,",
    "  options?: SimpleStreamOptions,",
    ") => AssistantMessageEventStream;",
    "",
    "const baseApiStreams = new Map<string, ApiStreamSimpleDelegate>();",
    "const wrappedApis = new Set<string>();",
    `const TARGET_APIS = ${JSON.stringify([...targetApis])} as Api[];`,
    "",
    "function ensureWrapper(pi: ExtensionAPI, api: Api): boolean {",
    "  if (wrappedApis.has(api)) return true;",
    "",
    "  let delegate = baseApiStreams.get(api);",
    "  if (!delegate) {",
    "    const provider = getApiProvider(api);",
    "    if (!provider) return false;",
    "    delegate = provider.streamSimple as ApiStreamSimpleDelegate;",
    "    baseApiStreams.set(api, delegate);",
    "  }",
    "",
    "  const providerName = `pi-agent-router-delegated-copilot-initiator-${api.replace(/[^a-z0-9]+/gi, \"-\").toLowerCase()}`;",
    "",
    "  try {",
    "    pi.registerProvider(providerName, {",
    "      api,",
    "      streamSimple: (model, context, options) => {",
    "        const base = baseApiStreams.get(model.api);",
    "        if (!base) throw new Error(`No base stream provider for api '${model.api}'.`);",
    "",
    "        const provider = (model as Model<Api> & { provider?: string }).provider;",
    "        if (provider !== \"github-copilot\") {",
    "          return base(model as Model<Api>, context, options);",
    "        }",
    "",
    "        const nextHeaders = {",
    "          ...(options?.headers ?? {}),",
    "          \"X-Initiator\": \"agent\",",
    "        };",
    "        const nextOptions: SimpleStreamOptions = options",
    "          ? { ...options, headers: nextHeaders }",
    "          : { headers: nextHeaders };",
    "        return base(model as Model<Api>, context, nextOptions);",
    "      },",
    "    });",
    "    wrappedApis.add(api);",
    "    return true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
    "",
    "export default function delegatedCopilotInitiatorRuntime(pi: ExtensionAPI): void {",
    "  for (const api of TARGET_APIS) {",
    "    ensureWrapper(pi, api);",
    "  }",
    "}",
    "",
  ].join("\n");
}

