/**
 * Tool call argument formatting and preview utilities.
 */

import { SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS } from "./constants";
import { normalizeInputText } from "./input-normalization";
import { truncatePreview } from "./text-formatting";

export function getToolCallArguments(part: Record<string, unknown>): unknown {
  if ("arguments" in part) {
    return part.arguments;
  }

  if ("input" in part) {
    return part.input;
  }

  if ("params" in part) {
    return part.params;
  }

  return undefined;
}

export function asToolArgumentsObject(argumentsValue: unknown): Record<string, unknown> | undefined {
  if (!argumentsValue) {
    return undefined;
  }

  if (typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
    return argumentsValue as Record<string, unknown>;
  }

  if (typeof argumentsValue !== "string") {
    return undefined;
  }

  const trimmed = argumentsValue.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed JSON-like argument payloads
  }

  return undefined;
}

export function formatToolArgumentValue(value: unknown): string {
  if (typeof value === "string") {
    return normalizeInputText(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const values = value
      .map((entry) => formatToolArgumentValue(entry))
      .filter((entry) => entry.length > 0)
      .slice(0, 4);
    return values.join(", ");
  }

  if (value && typeof value === "object") {
    const objectEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, objectValue]) => `${key}=${formatToolArgumentValue(objectValue)}`)
      .filter((entry) => !entry.endsWith("="))
      .slice(0, 2);
    return objectEntries.join(", ");
  }

  return "";
}

export function getToolStringArgument(
  argumentsObject: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!argumentsObject) {
    return undefined;
  }

  for (const key of keys) {
    if (!(key in argumentsObject)) {
      continue;
    }

    const text = formatToolArgumentValue(argumentsObject[key]);
    if (text) {
      return text;
    }
  }

  return undefined;
}

export function getToolNumberArgument(
  argumentsObject: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  const raw = getToolStringArgument(argumentsObject, keys);
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

export function formatGenericToolArgumentsPreview(argumentsValue: unknown, maxLength: number): string {
  if (argumentsValue === undefined || argumentsValue === null) {
    return "";
  }

  const argumentsObject = asToolArgumentsObject(argumentsValue);
  if (argumentsObject) {
    const preferredKeys = ["path", "command", "pattern", "query", "task", "agent", "id", "name"];

    for (const key of preferredKeys) {
      if (!(key in argumentsObject)) {
        continue;
      }

      const value = formatToolArgumentValue(argumentsObject[key]);
      if (value) {
        return truncatePreview(`${key}=${value}`, maxLength);
      }
    }

    const firstEntry = Object.entries(argumentsObject).find(([, value]) => formatToolArgumentValue(value));
    if (firstEntry) {
      const [key, value] = firstEntry;
      return truncatePreview(`${key}=${formatToolArgumentValue(value)}`, maxLength);
    }

    return "";
  }

  if (typeof argumentsValue === "string") {
    const compact = normalizeInputText(argumentsValue);
    if (!compact || compact === "{}" || compact === "null") {
      return "";
    }
    return truncatePreview(compact, maxLength);
  }

  const value = formatToolArgumentValue(argumentsValue);
  return value ? truncatePreview(value, maxLength) : "";
}

export function formatToolCallArgumentsPreview(
  toolName: string,
  argumentsValue: unknown,
  maxLength = SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
): string {
  const normalizedToolName = normalizeInputText(toolName).toLowerCase();
  const argumentsObject = asToolArgumentsObject(argumentsValue);
  const rawStringArguments = typeof argumentsValue === "string" ? normalizeInputText(argumentsValue) : "";

  if (normalizedToolName === "grep") {
    const pattern = getToolStringArgument(argumentsObject, ["pattern", "query", "regex"]);
    const path = getToolStringArgument(argumentsObject, ["path", "cwd", "directory"]);
    const patternPart = pattern ? `/${pattern}/` : "";

    if (patternPart && path) {
      return truncatePreview(`${patternPart} in ${path}`, maxLength);
    }

    return truncatePreview(patternPart || path || rawStringArguments, maxLength);
  }

  if (normalizedToolName === "ls") {
    const path = getToolStringArgument(argumentsObject, ["path", "cwd", "directory"]);
    return truncatePreview(path || rawStringArguments, maxLength);
  }

  if (normalizedToolName === "read") {
    const path = getToolStringArgument(argumentsObject, ["path", "file"]);
    const offset = getToolNumberArgument(argumentsObject, ["offset", "start", "line", "lineStart"]);
    const limit = getToolNumberArgument(argumentsObject, ["limit", "lineCount", "end"]);

    if (!path) {
      return truncatePreview(rawStringArguments, maxLength);
    }

    if (offset !== undefined && limit !== undefined) {
      return truncatePreview(`${path}:${offset}-${limit}`, maxLength);
    }

    if (offset !== undefined) {
      return truncatePreview(`${path}:${offset}`, maxLength);
    }

    if (limit !== undefined) {
      return truncatePreview(`${path}:1-${limit}`, maxLength);
    }

    return truncatePreview(path, maxLength);
  }

  if (normalizedToolName === "find") {
    const pattern = getToolStringArgument(argumentsObject, ["pattern", "query", "name", "glob"]);
    const path = getToolStringArgument(argumentsObject, ["path", "cwd", "directory"]);
    if (pattern && path) {
      return truncatePreview(`${pattern} in ${path}`, maxLength);
    }

    return truncatePreview(pattern || path || rawStringArguments, maxLength);
  }

  if (normalizedToolName === "bash") {
    const command = getToolStringArgument(argumentsObject, ["command", "cmd"]);
    if (!command && typeof argumentsValue === "string") {
      return truncatePreview(argumentsValue, maxLength);
    }

    return truncatePreview(command || "", maxLength);
  }

  if (normalizedToolName === "edit" || normalizedToolName === "write") {
    const path = getToolStringArgument(argumentsObject, ["path", "file", "target"]);
    return truncatePreview(path || rawStringArguments, maxLength);
  }

  return formatGenericToolArgumentsPreview(argumentsValue, maxLength);
}

export function formatToolInvocationLabel(name: string, argumentsPreview?: string): string {
  if (!argumentsPreview) {
    return name;
  }

  const normalizedToolName = normalizeInputText(name).toLowerCase();
  if (normalizedToolName === "bash") {
    return `${name}: ${argumentsPreview}`;
  }

  if (
    normalizedToolName === "grep" ||
    normalizedToolName === "ls" ||
    normalizedToolName === "read" ||
    normalizedToolName === "find" ||
    normalizedToolName === "edit" ||
    normalizedToolName === "write"
  ) {
    return `${name} ${argumentsPreview}`;
  }

  return `${name}(${argumentsPreview})`;
}

export function formatHumanReadableToolInvocation(
  toolName: string,
  argumentsValue: unknown,
  maxLength = SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS,
): string {
  const argumentsPreview = formatToolCallArgumentsPreview(toolName, argumentsValue, maxLength);
  return formatToolInvocationLabel(toolName, argumentsPreview);
}

export function extractToolTextContent(content: Array<{ type: string; text?: string }>): string {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type !== "text") {
      continue;
    }
    if (typeof part.text === "string" && part.text.trim()) {
      parts.push(part.text.trim());
    }
  }
  return parts.join("\n\n").trim();
}
