import type { Message } from "@earendil-works/pi-ai";

import { normalizeInputText } from "../input-normalization";
import { stripSubagentThinkingContent } from "../output-sanitizer";

export type SubagentSemanticCompletionSignal = {
  stopReason: "stop";
  finalResponseText: string;
};

function normalizeTerminalStopReason(value: unknown): "stop" | undefined {
  return normalizeInputText(value).toLowerCase() === "stop" ? "stop" : undefined;
}

function getContentPartRecord(part: unknown): Record<string, unknown> | undefined {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return undefined;
  }

  return part as Record<string, unknown>;
}

function assistantMessageHasToolCall(message: Message): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((part) => getContentPartRecord(part)?.type === "toolCall");
}

function extractAssistantText(message: Message): string {
  if (message.role !== "assistant") {
    return "";
  }

  if (typeof message.content === "string") {
    return stripSubagentThinkingContent(message.content).trim();
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  const textSections: string[] = [];
  for (const part of message.content) {
    const record = getContentPartRecord(part);
    if (record?.type !== "text" || typeof record.text !== "string") {
      continue;
    }

    const text = stripSubagentThinkingContent(record.text).trim();
    if (text) {
      textSections.push(text);
    }
  }

  return textSections.join("\n").trim();
}

export function detectSubagentSemanticCompletion(
  message: Message,
): SubagentSemanticCompletionSignal | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }

  const stopReason = normalizeTerminalStopReason((message as Record<string, unknown>).stopReason);
  if (!stopReason || assistantMessageHasToolCall(message)) {
    return undefined;
  }

  return {
    stopReason,
    finalResponseText: extractAssistantText(message),
  };
}
