import { normalizeInputText } from "../input-normalization";
import type { Agent } from "../types";

export const BUILT_IN_DELEGATED_AGENT_COLOR_FALLBACKS = new Map<string, string>([
  ["architect", "#50E3C2"],
  ["ask", "#9013FE"],
  ["code", "#4A90E2"],
  ["debug", "#F5A623"],
  ["devops", "#6C5CE7"],
  ["docs", "#417505"],
  ["git", "#D0021B"],
  ["orchestrator", "#7ED321"],
  ["product", "#8B572A"],
  ["refactor", "#4A4A4A"],
  ["researcher", "#F8E71C"],
  ["security", "#B00020"],
  ["test", "#2D9CDB"],
  ["ui", "#FF6F61"],
]);

export function buildDelegatedAgentColorFallbackMap(
  agents: readonly Pick<Agent, "name" | "color">[],
): Map<string, string> {
  return new Map(
    agents
      .filter((agent) => typeof agent.color === "string" && agent.color.trim().length > 0)
      .map((agent) => [normalizeInputText(agent.name).toLowerCase(), agent.color!] as const),
  );
}

export function resolveDelegatedAgentColor(options: {
  agentName: string;
  agent: Pick<Agent, "color"> | undefined;
  fallbackUserAgentColors: ReadonlyMap<string, string | undefined>;
  builtInAgentColorFallbacks?: ReadonlyMap<string, string>;
}): string | undefined {
  const {
    agentName,
    agent,
    fallbackUserAgentColors,
    builtInAgentColorFallbacks = BUILT_IN_DELEGATED_AGENT_COLOR_FALLBACKS,
  } = options;
  const normalizedAgentName = normalizeInputText(agentName).toLowerCase();
  const configuredColor = normalizeInputText(agent?.color);
  if (configuredColor) {
    return configuredColor;
  }

  const fallbackColor = fallbackUserAgentColors.get(normalizedAgentName);
  if (normalizeInputText(fallbackColor)) {
    return normalizeInputText(fallbackColor);
  }

  return builtInAgentColorFallbacks.get(normalizedAgentName);
}
