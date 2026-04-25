import {
  formatTaskActivityLabel,
  getTaskStatusLabel,
  inferLatestActionFromOutput,
} from "./task-display-formatting";

function normalizeSummary(value: string | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function buildParallelResultActivity(options: {
  status: string;
  latestToolCall?: string;
  latestOutputAction?: string;
  output?: string;
  resultSummary?: string;
  isPartial: boolean;
}): string {
  const running = options.status === "running" || options.status === "queued";

  if (options.isPartial && !running) {
    return getTaskStatusLabel(options.status);
  }

  const inferredActivity =
    formatTaskActivityLabel(options.latestToolCall) ||
    formatTaskActivityLabel(
      options.latestOutputAction ?? inferLatestActionFromOutput(options.output),
    );

  if (running) {
    return inferredActivity || "Delegating structured subtask analysis";
  }

  if (inferredActivity) {
    return inferredActivity;
  }

  const summary = normalizeSummary(options.resultSummary) || "(no output yet)";
  return `Result ${summary}`;
}
