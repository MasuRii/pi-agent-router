import { Text } from "@mariozechner/pi-tui";

type TaskCallTheme = {
  fg(color: string, text: string): string;
  bold?: (text: string) => string;
};

type TaskCallItem = {
  id: string;
  description: string;
  assignment: string;
  agent: string;
};

function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function resolveMode(rawMode: unknown): "parallel" | "chain" {
  return normalizeInputText(rawMode).toLowerCase() === "chain"
    ? "chain"
    : "parallel";
}

function extractTaskItems(args: Record<string, unknown>): TaskCallItem[] {
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];

  return rawTasks
    .map((item) => toRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      id: normalizeInputText(item.id),
      description: normalizeInputText(item.description),
      assignment: normalizeInputText(item.assignment),
      agent: normalizeInputText(item.agent),
    }));
}

function summarizeAgents(tasks: readonly TaskCallItem[]): string {
  const uniqueAgents = [...new Set(tasks.map((task) => task.agent).filter(Boolean))];
  if (uniqueAgents.length === 0) {
    return "unknown agents";
  }

  if (uniqueAgents.length <= 3) {
    return uniqueAgents.join(", ");
  }

  return `${uniqueAgents.slice(0, 3).join(", ")} +${uniqueAgents.length - 3} more`;
}

export function renderTaskDelegationCall(
  args: Record<string, unknown>,
  theme: TaskCallTheme,
): Text {
  const tasks = extractTaskItems(args);
  const mode = resolveMode(args.mode);
  const title = theme.fg(
    "toolTitle",
    typeof theme.bold === "function" ? theme.bold("Task") : "Task",
  );

  if (tasks.length === 0) {
    return new Text(
      `${title} ${theme.fg("warning", "invalid payload: no task items")}`,
      0,
      0,
    );
  }

  const headline = `${title} ${theme.fg("accent", pluralize(tasks.length, "task", "tasks"))} ${theme.fg("dim", `(${mode} • ${summarizeAgents(tasks)})`)}`;

  return new Text(headline, 0, 0);
}
