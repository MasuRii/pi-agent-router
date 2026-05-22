import { readFile } from "node:fs/promises";

import { normalizeInputText } from "../input-normalization";
import { getErrorMessage } from "../error-utils";

export type SessionToolCallIntegrity = {
  hasPendingToolCalls: boolean;
  pendingToolCallIds: string[];
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractToolCallId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizeInputText(value.id) || normalizeInputText(value.toolCallId) || undefined;
}

function extractAssistantToolCallIds(message: Record<string, unknown>): string[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const ids: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }

    const type = normalizeInputText(part.type);
    if (type !== "toolCall" && type !== "tool-call" && type !== "tool_use" && type !== "toolUse") {
      continue;
    }

    const id = extractToolCallId(part);
    if (id) {
      ids.push(id);
    }
  }

  return ids;
}

function extractToolResultIds(message: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const messageToolCallId = normalizeInputText(message.toolCallId);
  if (messageToolCallId) {
    ids.push(messageToolCallId);
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return ids;
  }

  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }

    const type = normalizeInputText(part.type);
    if (type !== "tool-result" && type !== "toolResult") {
      continue;
    }

    const id = extractToolCallId(part);
    if (id) {
      ids.push(id);
    }
  }

  return ids;
}

export async function inspectSessionToolCallIntegrity(
  sessionPath: string,
): Promise<SessionToolCallIntegrity> {
  const normalizedSessionPath = normalizeInputText(sessionPath);
  if (!normalizedSessionPath) {
    return {
      hasPendingToolCalls: false,
      pendingToolCallIds: [],
      error: "Session path is empty.",
    };
  }

  let content: string;
  try {
    content = await readFile(normalizedSessionPath, "utf-8");
  } catch (error) {
    return {
      hasPendingToolCalls: false,
      pendingToolCallIds: [],
      error: `Failed to inspect retained session '${normalizedSessionPath}': ${getErrorMessage(error)}`,
    };
  }

  const pending = new Map<string, number>();
  let sequence = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || !isRecord(parsed.message)) {
      continue;
    }

    const message = parsed.message;
    const role = normalizeInputText(message.role);
    if (role === "assistant") {
      for (const id of extractAssistantToolCallIds(message)) {
        pending.set(id, sequence);
        sequence += 1;
      }
      continue;
    }

    if (role === "toolResult" || role === "tool") {
      for (const id of extractToolResultIds(message)) {
        pending.delete(id);
      }
    }
  }

  const pendingToolCallIds = [...pending.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([id]) => id);

  return {
    hasPendingToolCalls: pendingToolCallIds.length > 0,
    pendingToolCallIds,
  };
}
