import type { Api, Model } from "@earendil-works/pi-ai";

import type { Agent, AgentThinkingLevel } from "../types";

const XIAOMI_PROVIDER_ID_PATTERN = /^xiaomi(?:$|-)/i;

export function shouldForceDelegatedThinkingOff(
  model: Pick<Model<Api>, "provider" | "api"> | undefined,
): boolean {
  return Boolean(
    model &&
      XIAOMI_PROVIDER_ID_PATTERN.test(model.provider) &&
      model.api === "anthropic-messages",
  );
}

export function resolveDelegatedThinkingLevel(
  agent: Agent,
  model: Pick<Model<Api>, "provider" | "api"> | undefined,
): AgentThinkingLevel | undefined {
  // Xiaomi's Anthropic-compatible endpoint emits non-replayable thinking blocks in tool-use sessions.
  // Force delegated continuations to run without thinking until Pi can replay Xiaomi reasoning_content.
  if (shouldForceDelegatedThinkingOff(model)) {
    return "off";
  }

  return agent.thinkingLevel;
}
