import { buildRetainedHistoryText } from "../text-formatting";

export type TaskBatchItemInput = {
  id: string;
  description: string;
  assignment: string;
  skills?: string[];
  cwd?: string;
  agent: string;
};

export type TaskBatchSummaryItem = {
  id: string;
  description: string;
  agent: string;
  status: string;
  output?: string;
  error?: string;
};

export function isTaskBatchItem(value: unknown): value is TaskBatchItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.description === "string" && typeof record.assignment === "string";
}

export function validateTaskBatchItems(items: readonly TaskBatchItemInput[]): string | undefined {
  if (items.length === 0) {
    return "Task delegation failed: 'tasks' must contain at least one task item.";
  }

  const seenIds = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const task = items[index];
    const id = task.id.trim();
    const assignment = task.assignment.trim();
    const agent = typeof task.agent === "string" ? task.agent.trim() : "";

    if (!id) {
      return `Task delegation failed: tasks[${index}] requires a non-empty 'id'.`;
    }

    if (id.length > 32) {
      return `Task delegation failed: tasks[${index}] id '${id}' exceeds 32 characters.`;
    }

    if (!assignment) {
      return `Task delegation failed: tasks[${index}] requires a non-empty 'assignment'.`;
    }

    if (!agent) {
      return `Task delegation failed: tasks[${index}] requires a non-empty 'agent'.`;
    }

    const normalizedId = id.toLowerCase();
    if (seenIds.has(normalizedId)) {
      const firstIndex = seenIds.get(normalizedId) ?? 0;
      return `Task delegation failed: duplicate task id '${id}' found at indexes ${firstIndex} and ${index}.`;
    }
    seenIds.set(normalizedId, index);
  }

  return undefined;
}

function stringifySchema(schema: unknown): string | undefined {
  if (schema === undefined || schema === null) {
    return undefined;
  }

  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return undefined;
  }
}

function formatSkillList(skills: readonly string[] | undefined): string | undefined {
  if (!skills || skills.length === 0) {
    return undefined;
  }

  const normalized = skills.map((skill) => skill.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.join(", ");
}

export function renderTaskBatchPrompt(options: {
  context?: string;
  assignment: string;
  schema?: unknown;
  taskId: string;
  description: string;
  skills?: readonly string[];
}): string {
  const context = options.context?.trim() || "";
  const assignment = options.assignment.trim();
  const schemaText = stringifySchema(options.schema);
  const skillList = formatSkillList(options.skills);

  const sections: string[] = [];

  if (context) {
    sections.push("─── Background ─────────────────────────────────────────────");
    sections.push(context);
    sections.push("");
  }

  sections.push("─── Task ───────────────────────────────────────────────────");
  sections.push(`Task ID: ${options.taskId}`);
  sections.push(`Task Description: ${options.description.trim() || "(none)"}`);

  if (skillList) {
    sections.push(`Suggested Skills: ${skillList}`);
  }

  if (schemaText) {
    sections.push("Expected Output Schema (JSON):");
    sections.push("```json");
    sections.push(schemaText);
    sections.push("```");
    sections.push("Return the final answer as JSON that matches this schema whenever possible.");
  }

  sections.push("");
  sections.push("Assignment:");
  sections.push(assignment);

  return sections.join("\n").trim();
}

function normalizeSummaryText(value: string | undefined): string {
  if (!value) {
    return "(no output)";
  }

  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "(no output)";
  }

  return normalized;
}

function buildTaskItemResultText(value: string | undefined): string {
  const retained = buildRetainedHistoryText(value);
  const excerpt = normalizeSummaryText(retained.excerpt);
  const summary = retained.summary?.replace(/\s+/g, " ").trim();

  if (retained.truncated && summary && summary !== excerpt) {
    return `${summary}\n\n${excerpt}`;
  }

  return excerpt || summary || "(no output)";
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderTaskBatchSummary(options: {
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  items: readonly TaskBatchSummaryItem[];
}): string {
  const durationSeconds = Math.max(0, Math.round(options.durationMs / 1000));
  const header = `${options.succeeded}/${options.total} succeeded, ${options.failed} failed [${durationSeconds}s]`;

  const body = options.items
    .map((item) => {
      const retainedResultText = buildTaskItemResultText(item.error || item.output);
      const summaryText = escapeXmlText(retainedResultText);
      return [
        `<task id="${escapeXmlText(item.id)}" agent="${escapeXmlText(item.agent)}">`,
        `<description>${escapeXmlText(item.description)}</description>`,
        `<status>${escapeXmlText(item.status)}</status>`,
        `<result>${summaryText}</result>`,
        `</task>`,
      ].join("\n");
    })
    .join("\n---\n");

  return [
    `<task-summary>`,
    `<header>${escapeXmlText(header)}</header>`,
    body,
    `</task-summary>`,
  ].join("\n\n");
}
