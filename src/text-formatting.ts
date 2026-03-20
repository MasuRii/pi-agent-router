/**
 * Text formatting and display utilities.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  DEFAULT_AGENT,
  INLINE_OPEN_BOX_TARGET_WIDTH,
  TASK_HISTORY_EXCERPT_MAX_CHARS,
  TASK_HISTORY_SUMMARY_MAX_CHARS,
} from "./constants";
import { getPersistedActiveAgentName } from "./agent/agent-discovery";
import { sanitizeSubagentResultForDisplay } from "./output-sanitizer";
import type { SubagentOutputDigest, AgentScope } from "./types";

function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeAgentScope(value: unknown): AgentScope {
  const normalized = normalizeInputText(value).toLowerCase();
  if (normalized === "user" || normalized === "project" || normalized === "both") {
    return normalized;
  }
  return "both";
}

export function isOrchestratorAgent(agentName: string): boolean {
  return normalizeInputText(agentName).toLowerCase() === DEFAULT_AGENT;
}

export function getDelegatingAgentName(ctx: ExtensionContext, currentActiveAgent: string | null): string {
  const persistedAgent = getPersistedActiveAgentName(ctx);
  if (typeof persistedAgent === "string") {
    const normalizedPersisted = normalizeInputText(persistedAgent);
    if (normalizedPersisted) {
      return normalizedPersisted;
    }
  }

  if (persistedAgent === null) {
    return "none";
  }

  const normalizedActiveAgent = normalizeInputText(currentActiveAgent);
  if (normalizedActiveAgent) {
    return normalizedActiveAgent;
  }

  return "none";
}

export function truncatePreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export type RetainedHistoryText = {
  excerpt?: string;
  summary?: string;
  truncated: boolean;
};

function buildRetainedHistoryExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const notice = "[Earlier output truncated for stored history; showing the most recent excerpt.]";
  const availableChars = Math.max(0, maxChars - notice.length - 2);
  if (availableChars === 0) {
    return truncatePreview(notice, maxChars);
  }

  const excerpt = text.slice(-availableChars).trimStart();
  return `${notice}\n\n${excerpt}`;
}

export function buildRetainedHistoryText(
  rawText: string | undefined,
  options: {
    maxChars?: number;
    maxSummaryChars?: number;
  } = {},
): RetainedHistoryText {
  const sanitized = sanitizeSubagentResultForDisplay(rawText || "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!sanitized) {
    return { truncated: false };
  }

  const maxChars = Number.isFinite(options.maxChars)
    ? Math.max(256, Math.trunc(options.maxChars || 0))
    : TASK_HISTORY_EXCERPT_MAX_CHARS;
  const maxSummaryChars = Number.isFinite(options.maxSummaryChars)
    ? Math.max(64, Math.trunc(options.maxSummaryChars || 0))
    : TASK_HISTORY_SUMMARY_MAX_CHARS;
  const digest = buildSubagentOutputDigest(sanitized);
  const summary = truncatePreview(digest.summary || sanitized, maxSummaryChars);
  const truncated = sanitized.length > maxChars;

  return {
    excerpt: truncated
      ? buildRetainedHistoryExcerpt(sanitized, maxChars)
      : sanitized,
    summary: summary || undefined,
    truncated,
  };
}

export function normalizeSummaryLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*+•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^`+|`+$/g, "")
    .trim();
}

export function extractSummaryFromMarkdownSections(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() || "";
    const headingMatch = line.match(/^#{1,6}\s*summary\s*:?[ \t]*(.*)$/i);
    if (!headingMatch) {
      continue;
    }

    const inlineSummary = normalizeSummaryLine(headingMatch[1] || "");
    if (inlineSummary) {
      return inlineSummary;
    }

    const collected: string[] = [];
    for (let offset = index + 1; offset < lines.length; offset += 1) {
      const sectionLineRaw = lines[offset] || "";
      const sectionLine = sectionLineRaw.trim();
      if (!sectionLine) {
        if (collected.length > 0) {
          break;
        }
        continue;
      }

      if (/^#{1,6}\s+/.test(sectionLine) || /^```/.test(sectionLine) || /^[-*_]{3,}$/.test(sectionLine)) {
        break;
      }

      const normalizedLine = normalizeSummaryLine(sectionLine);
      if (normalizedLine) {
        collected.push(normalizedLine);
      }

      if (collected.length >= 4) {
        break;
      }
    }

    if (collected.length > 0) {
      return collected.join(" ");
    }
  }

  return undefined;
}

export function extractFallbackSummary(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const collected: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }

    if (line.startsWith("→") || /^<\/?[a-z]/i.test(line) || /^```/.test(line)) {
      continue;
    }

    const normalizedLine = normalizeSummaryLine(line);
    if (!normalizedLine) {
      continue;
    }

    collected.push(normalizedLine);
    if (collected.length >= 2) {
      break;
    }
  }

  if (collected.length === 0) {
    return undefined;
  }

  return collected.join(" ");
}

export function extractToolCommandPreviews(text: string, maxCommands = 4): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    if (commands.length >= maxCommands) {
      break;
    }

    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let command = "";
    const arrowMatch = line.match(/^→\s*(.+)$/);
    if (arrowMatch && arrowMatch[1]) {
      command = arrowMatch[1].trim();
    } else {
      const bulletMatch = line.match(/^[•*\-]\s*(?:→\s*)?((?:bash|read|grep|find|ls|edit|write)\b.+)$/i);
      if (bulletMatch && bulletMatch[1]) {
        command = bulletMatch[1].trim();
      }
    }

    if (!command || seen.has(command)) {
      continue;
    }

    seen.add(command);
    commands.push(command);
  }

  return commands;
}

export function buildSubagentOutputDigest(rawText: string | undefined): SubagentOutputDigest {
  const sanitized = sanitizeSubagentResultForDisplay(rawText || "");
  if (!sanitized) {
    return {
      summary: "(no output yet)",
      commands: [],
    };
  }

  const summaryCandidate = extractSummaryFromMarkdownSections(sanitized) || extractFallbackSummary(sanitized) || sanitized;
  const summary = summaryCandidate.replace(/\s+/g, " ").trim() || "(no output yet)";

  return {
    summary,
    commands: extractToolCommandPreviews(sanitized),
  };
}

export function extractTaskDescriptionFromDelegatedPrompt(task: string | undefined): string | undefined {
  const normalized = (task || "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return undefined;
  }

  const match = normalized.match(/^Task Description:\s*(.+)$/im);
  if (match && match[1]) {
    return match[1].trim();
  }

  return undefined;
}

export function buildOpenRuleLine(prefix: string, fillCharacter: string, targetWidth = INLINE_OPEN_BOX_TARGET_WIDTH): string {
  const normalizedFillCharacter = fillCharacter || "─";
  const fillCount = Math.max(8, targetWidth - prefix.length);
  return `${prefix}${normalizedFillCharacter.repeat(fillCount)}`;
}

export function wrapPlainText(text: string, maxWidth: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [""];
  }

  const width = Math.max(16, maxWidth);
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };

  for (const word of words) {
    if (!word) {
      continue;
    }

    if (word.length > width) {
      pushCurrent();
      for (let index = 0; index < word.length; index += width) {
        lines.push(word.slice(index, index + width));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }

    pushCurrent();
    current = word;
  }

  pushCurrent();

  return lines.length > 0 ? lines : [""];
}

function clampWrappedLines(lines: readonly string[], maxLines: number, wrapWidth: number): string[] {
  const normalizedMaxLines = Math.max(1, Math.trunc(maxLines));
  if (lines.length <= normalizedMaxLines) {
    return [...lines];
  }

  const visible = lines.slice(0, normalizedMaxLines);
  const lastIndex = visible.length - 1;
  const lastLine = visible[lastIndex] || "";
  const maxLastLineLength = Math.max(1, wrapWidth);
  const truncatedLastLine = maxLastLineLength <= 1
    ? "…"
    : `${lastLine.slice(0, Math.max(0, maxLastLineLength - 1)).trimEnd()}…`;

  visible[lastIndex] = truncatedLastLine || "…";
  return visible;
}

export function buildWrappedPrefixedLines(options: {
  firstPrefix: string;
  continuationPrefix: string;
  text: string;
  targetWidth?: number;
  maxLines?: number;
}): string[] {
  const firstPrefix = options.firstPrefix;
  const continuationPrefix = options.continuationPrefix;
  const targetWidth = options.targetWidth ?? INLINE_OPEN_BOX_TARGET_WIDTH;
  const firstWidth = Math.max(16, targetWidth - firstPrefix.length);
  const continuationWidth = Math.max(16, targetWidth - continuationPrefix.length);
  const wrapWidth = Math.max(16, Math.min(firstWidth, continuationWidth));

  const wrapped = wrapPlainText(options.text, wrapWidth);
  const maxLines = typeof options.maxLines === "number" && Number.isFinite(options.maxLines)
    ? Math.max(1, Math.trunc(options.maxLines))
    : undefined;
  const visibleLines = maxLines ? clampWrappedLines(wrapped, maxLines, wrapWidth) : wrapped;

  return visibleLines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`);
}
