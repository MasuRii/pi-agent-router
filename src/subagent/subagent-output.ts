/**
 * Subagent output extraction and processing utilities.
 */

import type { Message } from "@mariozechner/pi-ai";

import type { SubagentJsonEventState, SubagentToolInvocation } from "../types";
import { normalizeInputText } from "../input-normalization";
import {
  SUBAGENT_DERIVED_OUTPUT_MAX_CHARS,
  SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
  SUBAGENT_TOOL_NAME_MAX_CHARS,
} from "../constants";
import { stripSubagentThinkingContent } from "../output-sanitizer";
import { buildSessionPathFromHeader } from "./session-paths";
import { mergeUsageTotals } from "./subagent-usage";
import { truncatePreview } from "../text-formatting";
import {
  formatHumanReadableToolInvocation,
  formatToolCallArgumentsPreview,
  formatToolInvocationLabel,
  getToolCallArguments,
} from "../tool-formatting";

export function extractMessageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  let out = "";
  for (const part of message.content) {
    if (
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      out += part.text;
    }
  }
  return out.trim();
}

function getMessageContentParts(message: Message): Message["content"] | undefined {
  return Array.isArray(message.content) ? message.content : undefined;
}

function getContentPartRecord(part: unknown): Record<string, unknown> | undefined {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return undefined;
  }

  return part as Record<string, unknown>;
}

function getContentPartType(part: unknown): string | undefined {
  const record = getContentPartRecord(part);
  return typeof record?.type === "string" ? record.type : undefined;
}

function getSanitizedMessageText(message: Message): string {
  return stripSubagentThinkingContent(extractMessageText(message));
}

function normalizeToolCallName(value: unknown): string {
  const normalized = normalizeInputText(typeof value === "string" ? value : "");
  return truncatePreview(normalized, SUBAGENT_TOOL_NAME_MAX_CHARS) || "(unknown)";
}

function estimateRetainedValueWeight(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): number {
  if (typeof value === "string") {
    return value.length;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? 8 : 0;
  }

  if (typeof value === "boolean") {
    return 4;
  }

  if (typeof value === "bigint") {
    return value.toString().length;
  }

  if (value === null || value === undefined || depth >= 12) {
    return 0;
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry) => total + 2 + estimateRetainedValueWeight(entry, seen, depth + 1),
      2,
    );
  }

  if (typeof value !== "object") {
    return 0;
  }

  if (seen.has(value)) {
    return 0;
  }

  seen.add(value);
  let total = 2;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    total += key.length + 2 + estimateRetainedValueWeight(entry, seen, depth + 1);
  }

  return total;
}

function getRetainedMessageWeight(message: Message): number {
  return Math.max(1, estimateRetainedValueWeight(message));
}

type ParsedToolCall = {
  name: string;
  argumentsPreview?: string;
};

type ParsedMessageDetails = {
  outputSections: string[];
  latestToolCall?: string;
  toolCalls: ParsedToolCall[];
};

export function appendBoundedOutputSection(
  currentOutput: string,
  section: string,
  maxChars = SUBAGENT_DERIVED_OUTPUT_MAX_CHARS,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return "";
  }

  const boundedMaxChars = Math.max(1, Math.trunc(maxChars));
  const nextOutput = currentOutput && section ? `${currentOutput}\n${section}` : currentOutput || section;
  if (!nextOutput) {
    return "";
  }

  return nextOutput.length <= boundedMaxChars
    ? nextOutput
    : nextOutput.slice(-boundedMaxChars);
}

function refreshDerivedOutputState(state: SubagentJsonEventState): void {
  state.outputText = appendBoundedOutputSection(
    state.committedOutputText,
    state.liveOutputText,
    state.outputTextMaxChars,
  );
  state.latestToolCall = state.liveLatestToolCall || state.committedLatestToolCall;
}

function clearLiveMessageState(state: SubagentJsonEventState): void {
  state.liveOutputText = "";
  state.liveLatestToolCall = undefined;
  refreshDerivedOutputState(state);
}

function setLiveMessageState(state: SubagentJsonEventState, message: Message): void {
  const details = parseMessageDetails(message);
  state.liveOutputText = details.outputSections.join("\n").trim();
  state.liveLatestToolCall = details.latestToolCall;
  refreshDerivedOutputState(state);
}

function appendOutputSections(
  state: SubagentJsonEventState,
  sections: readonly string[],
): void {
  if (sections.length === 0) {
    return;
  }

  const combinedSection = sections.join("\n").trim();
  if (!combinedSection) {
    return;
  }

  state.committedOutputText = appendBoundedOutputSection(
    state.committedOutputText,
    combinedSection,
    state.outputTextMaxChars,
  );
}

function retainBoundedMessage(state: SubagentJsonEventState, message: Message): void {
  const weight = getRetainedMessageWeight(message);
  state.messages.push(message);
  state.messageWeights.push(weight);
  state.retainedMessageChars += weight;

  while (
    state.messages.length > state.messageRetentionLimit ||
    state.retainedMessageChars > state.messageRetentionMaxChars
  ) {
    if (state.messages.length === 0) {
      break;
    }

    state.messages.shift();
    const removedWeight = state.messageWeights.shift() ?? 0;
    state.retainedMessageChars = Math.max(0, state.retainedMessageChars - removedWeight);
    state.droppedMessageCount += 1;
  }
}

function recordToolInvocation(state: SubagentJsonEventState, toolCall: ParsedToolCall): void {
  state.toolInvocationTotalCount += 1;

  const signature = `${toolCall.name}\u0000${toolCall.argumentsPreview ?? ""}`;
  const existing = state.toolInvocationMap.get(signature);
  if (existing) {
    existing.count += 1;
    return;
  }

  if (state.toolInvocationMap.size >= state.toolInvocationRetentionLimit) {
    return;
  }

  state.toolInvocationMap.set(signature, {
    name: toolCall.name,
    argumentsPreview: toolCall.argumentsPreview,
    count: 1,
  });
}

function parseMessageDetails(message: Message): ParsedMessageDetails {
  const outputSections: string[] = [];
  const toolCalls: ParsedToolCall[] = [];
  let latestToolCall: string | undefined;

  if (message.role === "assistant") {
    const parts = getMessageContentParts(message);
    if (!parts) {
      const text = getSanitizedMessageText(message);
      if (text) {
        outputSections.push(text);
      }

      return {
        outputSections,
        latestToolCall,
        toolCalls,
      };
    }

    for (const part of parts) {
      const partType = getContentPartType(part);
      if (partType === "text") {
        const textPart = getContentPartRecord(part);
        const text = typeof textPart?.text === "string" ? stripSubagentThinkingContent(textPart.text) : "";
        if (text) {
          outputSections.push(text);
        }
        continue;
      }

      if (partType !== "toolCall") {
        continue;
      }

      const toolCallPart = getContentPartRecord(part) ?? {};
      const name = normalizeToolCallName(toolCallPart.name);
      const argumentsValue = getToolCallArguments(toolCallPart);
      const argumentsPreview = formatToolCallArgumentsPreview(name, argumentsValue);
      const invocationLabel = truncatePreview(
        formatHumanReadableToolInvocation(name, argumentsValue, SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS),
        SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
      );
      outputSections.push(`→ ${invocationLabel}`);
      toolCalls.push({
        name,
        argumentsPreview: argumentsPreview || undefined,
      });
      latestToolCall = truncatePreview(
        argumentsPreview ? `[${name}] ${argumentsPreview}` : `[${name}]`,
        SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
      );
    }

    return {
      outputSections,
      latestToolCall,
      toolCalls,
    };
  }

  if (message.role === "tool") {
    const text = getSanitizedMessageText(message);
    if (text) {
      outputSections.push(text);
    }
  }

  return {
    outputSections,
    latestToolCall,
    toolCalls,
  };
}

function appendMessageToState(message: Message, state: SubagentJsonEventState): void {
  retainBoundedMessage(state, message);

  const details = parseMessageDetails(message);
  appendOutputSections(state, details.outputSections);

  for (const toolCall of details.toolCalls) {
    recordToolInvocation(state, toolCall);
  }

  if (details.latestToolCall) {
    state.committedLatestToolCall = details.latestToolCall;
  }

  refreshDerivedOutputState(state);
}

export function getSubagentToolInvocationsFromState(state: SubagentJsonEventState): SubagentToolInvocation[] {
  return [...state.toolInvocationMap.values()].map((item) => ({ ...item }));
}

export function processSubagentJsonEventLine(line: string, state: SubagentJsonEventState): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    state.malformedEventCount += 1;
    return;
  }

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }

  const eventRecord = event as Record<string, unknown>;
  const eventType = typeof eventRecord.type === "string" ? eventRecord.type : "";

  if (eventType === "session") {
    const sessionId = normalizeInputText(eventRecord.id);
    const timestamp = normalizeInputText(eventRecord.timestamp);
    const cwd = normalizeInputText(eventRecord.cwd);
    const sessionDirOverride = normalizeInputText(state.sessionDir);

    if (sessionId && timestamp && (cwd || sessionDirOverride)) {
      state.sessionPath = buildSessionPathFromHeader(sessionId, timestamp, cwd, sessionDirOverride || undefined);
    }
    return;
  }

  if (
    eventType === "message_start" ||
    eventType === "message_update" ||
    eventType === "message_end" ||
    eventType === "tool_result_end"
  ) {
    const messageValue = eventRecord.message;
    if (!messageValue || typeof messageValue !== "object" || Array.isArray(messageValue)) {
      return;
    }

    const rawMessage = messageValue as { content?: unknown; usage?: unknown; role?: unknown };
    if (typeof rawMessage.content !== "string" && !Array.isArray(rawMessage.content)) {
      return;
    }

    const message = messageValue as Message;

    if (eventType === "message_start") {
      if (message.role === "assistant") {
        setLiveMessageState(state, message);
      }
      return;
    }

    if (eventType === "message_update") {
      if (message.role === "assistant") {
        setLiveMessageState(state, message);
      }
      return;
    }

    if (eventType === "message_end" && message.role === "assistant") {
      clearLiveMessageState(state);
    }

    appendMessageToState(message, state);

    if (eventType === "message_end" && message.role === "assistant") {
      state.usage.turns += 1;
      mergeUsageTotals(state.usage, rawMessage.usage);
    }
    return;
  }

  if (eventType === "usage") {
    mergeUsageTotals(state.usage, eventRecord.usage ?? eventRecord);
  }
}

export function getSubagentOutputFromMessages(messages: readonly Message[]): string {
  const fullTranscript = getSubagentLiveOutputFromMessages(messages);
  if (fullTranscript) {
    return fullTranscript;
  }

  let assistantText = "";
  const toolText: string[] = [];

  for (const message of messages) {
    const text = stripSubagentThinkingContent(extractMessageText(message));
    if (!text) {
      continue;
    }

    if (message.role === "assistant") {
      assistantText = text;
      continue;
    }

    if (message.role === "tool") {
      toolText.push(text);
    }
  }

  if (assistantText) {
    return assistantText;
  }

  return stripSubagentThinkingContent(toolText.join("\n").trim());
}

export function getSubagentLiveOutputFromMessages(messages: readonly Message[]): string {
  const sections: string[] = [];

  for (const message of messages) {
    sections.push(...parseMessageDetails(message).outputSections);
  }

  return stripSubagentThinkingContent(sections.join("\n").trim());
}

export function summarizeSubagentToolInvocations(messages: readonly Message[]): SubagentToolInvocation[] {
  const bySignature = new Map<string, SubagentToolInvocation>();

  for (const message of messages) {
    for (const toolCall of parseMessageDetails(message).toolCalls) {
      const signature = `${toolCall.name}\u0000${toolCall.argumentsPreview ?? ""}`;
      const existing = bySignature.get(signature);
      if (existing) {
        existing.count += 1;
      } else {
        bySignature.set(signature, {
          name: toolCall.name,
          argumentsPreview: toolCall.argumentsPreview,
          count: 1,
        });
      }
    }
  }

  return [...bySignature.values()];
}

export function countSubagentToolInvocations(invocations: readonly SubagentToolInvocation[] | undefined): number {
  if (!invocations || invocations.length === 0) {
    return 0;
  }

  return invocations.reduce((total, item) => total + Math.max(0, Math.trunc(item.count || 0)), 0);
}

export function getLatestSubagentToolCallLabel(
  messages: readonly Message[],
  maxLength = SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
): string | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") {
      continue;
    }

    const parts = getMessageContentParts(message);
    if (!parts) {
      continue;
    }

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (!part || getContentPartType(part) !== "toolCall") {
        continue;
      }

      const toolCallPart = getContentPartRecord(part) ?? {};
      const name = normalizeToolCallName(toolCallPart.name);
      const argumentsPreview = formatToolCallArgumentsPreview(name, getToolCallArguments(toolCallPart), maxLength);
      return truncatePreview(
        argumentsPreview ? `[${name}] ${argumentsPreview}` : `[${name}]`,
        maxLength,
      );
    }
  }

  return undefined;
}

export function formatToolInvocationPreview(invocations: readonly SubagentToolInvocation[] | undefined): string {
  if (!invocations || invocations.length === 0) {
    return "(none yet)";
  }

  const visible = invocations.slice(0, 4).map((item) => {
    const label = formatToolInvocationLabel(item.name, item.argumentsPreview);
    return item.count > 1 ? `${label}×${item.count}` : label;
  });
  const suffix = invocations.length > 4 ? `, +${invocations.length - 4} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

export function sameToolInvocations(
  left: readonly SubagentToolInvocation[] | undefined,
  right: readonly SubagentToolInvocation[] | undefined,
): boolean {
  if (left === right) {
    return true;
  }

  const leftLength = left?.length ?? 0;
  const rightLength = right?.length ?? 0;
  if (leftLength !== rightLength) {
    return false;
  }

  for (let index = 0; index < leftLength; index++) {
    const leftItem = left?.[index];
    const rightItem = right?.[index];
    if (!leftItem || !rightItem) {
      return false;
    }

    if (
      leftItem.name !== rightItem.name ||
      leftItem.argumentsPreview !== rightItem.argumentsPreview ||
      leftItem.count !== rightItem.count
    ) {
      return false;
    }
  }

  return true;
}

export { normalizeInputText };

export {
  formatHumanReadableToolInvocation,
  getToolCallArguments,
} from "../tool-formatting";
