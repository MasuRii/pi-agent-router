import { normalizeInputText } from "../input-normalization";
import type { Agent, SubagentTaskItemInput, TaskStyleDelegationItem } from "../types";

export type NormalizedTaskDelegation = {
  agent: string;
  task: string;
  cwd?: string;
  taskLabel?: string;
  taskDescription?: string;
  assignment: string;
  skills?: string[];
  contextFromReferences: string[];
  retry: boolean;
  retryFrom?: string;
};

export function normalizeTaskDelegations(options: {
  providedTasks: readonly SubagentTaskItemInput[];
  taskStyleMetadata: readonly TaskStyleDelegationItem[];
  contextFromReferencesByIndex: readonly (readonly string[] | undefined)[];
}): NormalizedTaskDelegation[] {
  return options.providedTasks.map((task, index) => {
    const metadata = options.taskStyleMetadata[index];
    return {
      agent: normalizeInputText(task.agent),
      task: normalizeInputText(task.task),
      cwd: normalizeInputText(task.cwd) || undefined,
      taskLabel: metadata?.id,
      taskDescription: metadata?.description || metadata?.id,
      assignment: metadata?.assignment || "",
      skills: metadata?.skills,
      contextFromReferences: [...(options.contextFromReferencesByIndex[index] || [])],
      retry: metadata?.retry === true,
      retryFrom: metadata?.retryFrom,
    };
  });
}

export function findInvalidTaskDelegationIndex(
  tasks: readonly Pick<NormalizedTaskDelegation, "agent" | "task">[],
): number {
  return tasks.findIndex((task) => !task.agent || !task.task);
}

export function getQueuedDelegationLabel(
  mode: "parallel" | "chain",
  taskCount: number,
): string {
  if (mode === "chain") {
    return "Chain delegation";
  }

  return taskCount === 1 ? "Task delegation" : "Parallel delegation";
}

export function findUnknownTaskAgents(
  tasks: readonly Pick<NormalizedTaskDelegation, "agent">[],
  availableAgents: readonly Pick<Agent, "name">[],
): string[] {
  const agentsByName = new Set(availableAgents.map((agent) => agent.name));
  return [
    ...new Set(
      tasks
        .map((task) => task.agent)
        .filter((agentName) => !agentsByName.has(agentName)),
    ),
  ];
}

export function formatUnknownTaskAgentsLabel(unknownTaskAgents: readonly string[]): string {
  return unknownTaskAgents.length === 1
    ? `Unknown agent: ${unknownTaskAgents[0]}`
    : `Unknown agents: ${unknownTaskAgents.join(", ")}`;
}
