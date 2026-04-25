import { Container, Text } from "@mariozechner/pi-tui";

import { formatDuration } from "../subagent/subagent-execution";
import {
  formatModelReferenceForFooter,
  formatThinkingLevelForDisplay,
  MODEL_FOOTER_ICON,
} from "../model-display";
import {
  analyzeSubagentOutput,
  extractTaskDescriptionFromDelegatedPrompt,
  truncatePreview,
} from "../text-formatting";
import {
  colorizeWithHex,
  formatUsageWithoutCost,
  resolveTaskBorderColor,
  toTitleCaseWords,
} from "./task-display-formatting";
import { buildParallelResultActivity } from "./parallel-result-activity";
import { appendTaskBlock, type TaskDisplayTheme } from "./task-display-primitives";
import {
  formatAttachSubagentOutputHint,
  formatHiddenTasksSummary,
} from "./task-render-hints";

import type { SubagentExecutionDetails } from "../types";

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}


function buildResultFooterLine(
  taskResult: NonNullable<SubagentExecutionDetails["results"]>[number],
  expanded: boolean,
): string | undefined {
  const compactSegments: string[] = [];

  if (typeof taskResult.duration === "number" && Number.isFinite(taskResult.duration)) {
    compactSegments.push(` ${formatDuration(Math.max(0, taskResult.duration))}`);
  }

  const modelLabel = formatModelReferenceForFooter(taskResult.model);
  if (modelLabel) {
    compactSegments.push(`${MODEL_FOOTER_ICON} ${modelLabel}`);
  }

  const thinkingDisplay = formatThinkingLevelForDisplay(taskResult.thinkingLevel, taskResult.model);
  if (thinkingDisplay) {
    compactSegments.push(` ${thinkingDisplay}`);
  }

  const expandedSegments: string[] = [];
  if (expanded) {

    const usage = formatUsageWithoutCost(taskResult.usage);
    if (usage) {
      expandedSegments.push(` ${usage}`);
    }
  }

  const allSegments = [...compactSegments, ...expandedSegments];
  return allSegments.length > 0 ? allSegments.join(" • ") : undefined;
}

export function renderParallelDelegationResult(
  details: SubagentExecutionDetails,
  expanded: boolean,
  theme: TaskDisplayTheme,
  isPartial = false,
): Container {
  const results = details.results || [];
  const container = new Container();

  if (results.length === 0) {
    const fallbackColor = resolveTaskBorderColor(details.delegatedAgent, details.agentColor);
    const border = fallbackColor
      ? colorizeWithHex("▌", fallbackColor, { bold: true })
      : theme.fg("accent", theme.bold("▌"));

    container.addChild(
      new Text(
        `${border} ${theme.fg("dim", "No delegated task results available yet.")}`,
        0,
        0,
      ),
    );
    return container;
  }

  const visibleResults = expanded ? results : results.slice(0, 3);
  for (let index = 0; index < visibleResults.length; index += 1) {
    const taskResult = visibleResults[index]!;
    const outputAnalysis = analyzeSubagentOutput(taskResult.error || taskResult.output);
    const toolCalls = Math.max(0, taskResult.toolCalls ?? outputAnalysis.toolCalls);

    const taskGoal =
      taskResult.taskDescription ||
      extractTaskDescriptionFromDelegatedPrompt(taskResult.delegatedTask) ||
      "(none)";

    const description = `${truncatePreview(taskGoal, 180)} (${pluralize(toolCalls, "toolcall", "toolcalls")})`;

    const digestSummary = isPartial
      ? undefined
      : taskResult.resultSummary || outputAnalysis.summary;

    const activity = buildParallelResultActivity({
      status: taskResult.status,
      latestToolCall: taskResult.latestToolCall,
      latestOutputAction: outputAnalysis.latestAction,
      output: taskResult.output,
      isPartial,
      resultSummary: digestSummary,
    });

    const taskDetailLines: string[] = [];

    if (expanded && taskResult.contractWarnings && taskResult.contractWarnings.length > 0) {
      for (const warning of taskResult.contractWarnings) {
        const normalized = warning.trim();
        if (normalized) {
          taskDetailLines.push(` ${truncatePreview(normalized, 160)}`);
        }
      }
    }

    const hint =
      taskResult.status === "running" || taskResult.status === "queued"
        ? formatAttachSubagentOutputHint(taskResult.sessionId)
        : undefined;

    const borderColor = resolveTaskBorderColor(taskResult.delegatedAgent, taskResult.agentColor);

    appendTaskBlock(container, theme, {
      title: `${toTitleCaseWords(taskResult.delegatedAgent)} Task`,
      description,
      activity,
      status: taskResult.status,
      spinner: taskResult.status === "running",
      hint,
      detailLines: taskDetailLines,
      footerLine: buildResultFooterLine(taskResult, expanded),
      includeSpacer: index > 0,
      borderColorHex: borderColor,
      titleColorHex: borderColor,
    });
  }

  if (!expanded && results.length > visibleResults.length) {
    const hidden = results.length - visibleResults.length;
    const hiddenSummary = formatHiddenTasksSummary(hidden);
    if (hiddenSummary) {
      const border = theme.fg("muted", "▌");
      container.addChild(new Text("", 0, 0));
      container.addChild(
        new Text(
          `${border} ${theme.fg("dim", hiddenSummary)}`,
          0,
          0,
        ),
      );
    }
  }

  return container;
}
