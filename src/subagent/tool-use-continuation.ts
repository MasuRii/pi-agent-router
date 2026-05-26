import { normalizeInputText } from "./subagent-output";
import type { SubagentRunResult } from "../types";

export function getLatestAssistantStopReason(run: SubagentRunResult): string | undefined {
  const messages = run.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as Record<string, unknown> | undefined;
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }

    return normalizeInputText(candidate.stopReason);
  }

  return undefined;
}

export function isToolUseStopReason(stopReason: string | undefined): boolean {
  const normalized = normalizeInputText(stopReason).toLowerCase();
  return normalized === "tooluse" || normalized === "tool_use" || normalized === "tool-use";
}

export function shouldContinueDelegatedToolUse(
  run: SubagentRunResult,
  fallbackSessionPath?: string,
): boolean {
  return (
    !run.timedOut &&
    isToolUseStopReason(getLatestAssistantStopReason(run)) &&
    Boolean(run.sessionPath || fallbackSessionPath)
  );
}
