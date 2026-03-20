import { Container, Text } from "@mariozechner/pi-tui";

import { formatDuration } from "../subagent/subagent-execution";
import {
  formatModelReferenceForFooter,
  formatThinkingLevelForDisplay,
  MODEL_FOOTER_ICON,
} from "../model-display";
import {
  buildSubagentOutputDigest,
  extractTaskDescriptionFromDelegatedPrompt,
  truncatePreview,
} from "../text-formatting";
import { extractToolTextContent } from "../tool-formatting";
import {
  colorizeWithHex,
  formatTaskActivityLabel,
  formatUsageWithoutCost,
  inferLatestActionFromOutput,
  inferToolCallsFromOutput,
  resolveTaskBorderColor,
  toTitleCaseWords,
} from "./task-display-formatting";
import { appendTaskBlock, type TaskDisplayTheme } from "./task-display-primitives";
import { formatAttachSubagentOutputHint } from "./task-render-hints";

import type { SubagentExecutionDetails, SubagentExecutionStatus } from "../types";

type ToolResultLike = {
  isError?: boolean;
  content: Array<{
    type: string;
    text?: string;
  }>;
};

function extractToolResultText(result: ToolResultLike): string {
  return (
    extractToolTextContent(
      result.content.map((part) => ({
        type: part.type,
        text: part.type === "text" ? part.text : undefined,
      })),
    ) || ""
  );
}

function getDigestSource(
  result: ToolResultLike,
  details: SubagentExecutionDetails | undefined,
  isPartial: boolean,
  status: SubagentExecutionStatus,
): string {
  if (isPartial && details?.attached && typeof details.liveOutput === "string") {
    return details.liveOutput;
  }

  if (isPartial && typeof details?.liveOutput === "string") {
    return details.liveOutput;
  }

  if (!isPartial && status !== "running" && status !== "queued") {
    return extractToolResultText(result);
  }

  return "";
}

function renderWarningLines(
  container: Container,
  theme: TaskDisplayTheme,
  warnings: readonly string[],
  borderColor: string | undefined,
): void {
  const border = borderColor
    ? colorizeWithHex("▌", borderColor, { bold: true })
    : theme.fg("accent", theme.bold("▌"));

  for (const warning of warnings) {
    const normalized = warning.trim();
    if (!normalized) {
      continue;
    }

    container.addChild(
      new Text(`${border} ${theme.fg("warning", ` ${normalized}`)}`, 0, 0),
    );
  }
}

function buildFooterLine(
  details: SubagentExecutionDetails | undefined,
  expanded: boolean,
): string | undefined {
  if (!details) {
    return undefined;
  }

  const compactSegments: string[] = [];

  if (typeof details.duration === "number" && Number.isFinite(details.duration)) {
    compactSegments.push(` ${formatDuration(Math.max(0, details.duration))}`);
  }

  const modelLabel = formatModelReferenceForFooter(details.model);
  if (modelLabel) {
    compactSegments.push(`${MODEL_FOOTER_ICON} ${modelLabel}`);
  }

  const thinkingDisplay = formatThinkingLevelForDisplay(details.thinkingLevel, details.model);
  if (thinkingDisplay) {
    compactSegments.push(` ${thinkingDisplay}`);
  }

  const expandedSegments: string[] = [];
  if (expanded) {

    const usage = formatUsageWithoutCost(details.usage);
    if (usage) {
      expandedSegments.push(` ${usage}`);
    }
  }

  const allSegments = [...compactSegments, ...expandedSegments];
  return allSegments.length > 0 ? allSegments.join(" • ") : undefined;
}

export function renderSingleDelegationResult(options: {
  result: ToolResultLike;
  details?: SubagentExecutionDetails;
  status: SubagentExecutionStatus;
  isPartial: boolean;
  expanded: boolean;
  theme: TaskDisplayTheme;
}): Container {
  const { result, details, status, isPartial, expanded, theme } = options;
  const running = status === "running" || status === "queued";

  const digestSource = getDigestSource(result, details, isPartial, status);
  const digest = buildSubagentOutputDigest(digestSource);

  const latestAction = formatTaskActivityLabel(
    inferLatestActionFromOutput(digestSource),
  );

  const fallbackSummary =
    (digest.summary || "(no output yet)").replace(/\s+/g, " ").trim() ||
    "(no output yet)";

  const activity = running
    ? latestAction || "Delegating structured subtask analysis"
    : latestAction || `Result ${fallbackSummary}`;

  const taskGoal =
    extractTaskDescriptionFromDelegatedPrompt(details?.delegatedTask) ||
    details?.delegatedTask ||
    "(none)";

  const inferredToolCalls = inferToolCallsFromOutput(digestSource);
  const toolCalls = Math.max(inferredToolCalls, digest.commands.length);

  const detailLines: string[] = [];
  if (expanded && digest.commands.length > 0) {
    for (const command of digest.commands.slice(0, 6)) {
      detailLines.push(` ${truncatePreview(command, 160)}`);
    }
  }

  const hint =
    running && details?.sessionId
      ? formatAttachSubagentOutputHint(details.sessionId)
      : undefined;

  const titleAgent = toTitleCaseWords(details?.delegatedAgent || "task");
  const description = `${truncatePreview(taskGoal, 180)} (${toolCalls} toolcalls)`;
  const borderColor = resolveTaskBorderColor(details?.delegatedAgent, details?.agentColor);

  const container = new Container();
  appendTaskBlock(container, theme, {
    title: `${titleAgent} Task`,
    description,
    activity,
    status,
    spinner: running,
    hint,
    detailLines,
    footerLine: buildFooterLine(details, expanded),
    borderColorHex: borderColor,
    titleColorHex: borderColor,
  });

  if (details?.contractWarnings && details.contractWarnings.length > 0) {
    container.addChild(new Text("", 0, 0));
    renderWarningLines(container, theme, details.contractWarnings, borderColor);
  }

  return container;
}
