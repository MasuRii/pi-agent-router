import { normalizeInputText } from "../input-normalization";

import { buildTaskReferenceIndexById } from "./task-context-references";
import type { TaskContextFromSource } from "./task-tool-adapter";

export type TaskExecutionMode = "parallel" | "chain";

const DEFAULT_TASK_EXECUTION_MODE: TaskExecutionMode = "parallel";
const CHAIN_PREVIOUS_OUTPUT_MAX_CHARS = 8_000;
const PREVIOUS_PLACEHOLDER_TOKEN = "{previous}";

export type ChainTaskReference = {
  id: string;
};

export type RetainedContextReferenceResolver = (
  reference: string,
  fieldName: string,
) => { source?: TaskContextFromSource; error?: string };

export function resolveTaskExecutionMode(value: unknown): {
  mode: TaskExecutionMode;
  error?: string;
} {
  const normalized = normalizeInputText(value).toLowerCase();

  if (!normalized) {
    return { mode: DEFAULT_TASK_EXECUTION_MODE };
  }

  if (normalized === "parallel" || normalized === "chain") {
    return { mode: normalized };
  }

  return {
    mode: DEFAULT_TASK_EXECUTION_MODE,
    error:
      "Task delegation failed: 'mode' must be either 'parallel' or 'chain'.",
  };
}

export function validateChainContextFromReferences(options: {
  tasks: readonly ChainTaskReference[];
  referencesByTaskIndex: readonly (readonly string[])[];
}): string | undefined {
  const indexById = buildTaskReferenceIndexById(options.tasks);

  for (let taskIndex = 0; taskIndex < options.referencesByTaskIndex.length; taskIndex += 1) {
    const references = options.referencesByTaskIndex[taskIndex] || [];
    for (const reference of references) {
      const normalizedReference = normalizeInputText(reference);
      const referencedTaskIndex = indexById.get(normalizedReference.toLowerCase());
      if (referencedTaskIndex === undefined) {
        continue;
      }

      const fieldName = `tasks[${taskIndex}].contextFrom`;
      if (referencedTaskIndex === taskIndex) {
        return `Task delegation failed: ${fieldName} reference '${normalizedReference}' cannot reference the same chain task.`;
      }

      if (referencedTaskIndex > taskIndex) {
        return `Task delegation failed: ${fieldName} reference '${normalizedReference}' points to a later chain task; contextFrom can only reference earlier completed chain tasks or retained delegated sessions.`;
      }
    }
  }

  return undefined;
}

export function resolveChainContextFromSources(options: {
  tasks: readonly ChainTaskReference[];
  taskIndex: number;
  references: readonly string[];
  completedSourcesByTaskId: ReadonlyMap<string, TaskContextFromSource>;
  resolveRetainedReference: RetainedContextReferenceResolver;
  fieldName: string;
}): { sources: TaskContextFromSource[]; error?: string } {
  if (options.taskIndex < 0 || options.taskIndex >= options.tasks.length) {
    return {
      sources: [],
      error: `Task delegation failed: ${options.fieldName} cannot be resolved for invalid chain task index ${options.taskIndex}.`,
    };
  }

  const indexById = buildTaskReferenceIndexById(options.tasks);
  const sources: TaskContextFromSource[] = [];

  for (const reference of options.references) {
    const normalizedReference = normalizeInputText(reference);
    const normalizedReferenceKey = normalizedReference.toLowerCase();
    const referencedTaskIndex = indexById.get(normalizedReferenceKey);

    if (referencedTaskIndex !== undefined) {
      if (referencedTaskIndex === options.taskIndex) {
        return {
          sources: [],
          error: `Task delegation failed: ${options.fieldName} reference '${normalizedReference}' cannot reference the same chain task.`,
        };
      }

      if (referencedTaskIndex > options.taskIndex) {
        return {
          sources: [],
          error: `Task delegation failed: ${options.fieldName} reference '${normalizedReference}' points to a later chain task; contextFrom can only reference earlier completed chain tasks or retained delegated sessions.`,
        };
      }

      const completedSource = options.completedSourcesByTaskId.get(
        normalizedReferenceKey,
      );
      if (!completedSource) {
        return {
          sources: [],
          error: `Task delegation failed: ${options.fieldName} reference '${normalizedReference}' points to an earlier chain task whose final result is not available.`,
        };
      }

      if (
        completedSource.structuredResult === undefined &&
        !normalizeInputText(completedSource.outputText)
      ) {
        return {
          sources: [],
          error: `Task delegation failed: ${options.fieldName} reference '${normalizedReference}' has no completed final response/result for handoff.`,
        };
      }

      sources.push({
        ...completedSource,
        reference: normalizedReference,
      });
      continue;
    }

    const retained = options.resolveRetainedReference(
      reference,
      options.fieldName,
    );
    if (retained.error || !retained.source) {
      return { sources: [], error: retained.error };
    }

    sources.push(retained.source);
  }

  return { sources };
}

function truncatePreviousOutput(output: string, maxChars: number): {
  value: string;
  truncated: boolean;
} {
  const boundedMaxChars = Number.isFinite(maxChars)
    ? Math.max(256, Math.trunc(maxChars))
    : CHAIN_PREVIOUS_OUTPUT_MAX_CHARS;

  if (output.length <= boundedMaxChars) {
    return { value: output, truncated: false };
  }

  const truncatedChars = output.length - boundedMaxChars;
  const retainedPreviewLength = Math.max(0, boundedMaxChars - 80);
  const retainedText = output.slice(0, retainedPreviewLength).trimEnd();
  const notice = `\n...[previous output truncated: ${truncatedChars} chars omitted]`;
  return {
    value: `${retainedText}${notice}`,
    truncated: true,
  };
}

export function applyPreviousOutputSubstitution(options: {
  task: string;
  previousOutput: string;
  maxChars?: number;
}): {
  task: string;
  truncated: boolean;
  placeholderCount: number;
} {
  const sourceTask = typeof options.task === "string" ? options.task : "";
  const placeholderCount = sourceTask.split(PREVIOUS_PLACEHOLDER_TOKEN).length - 1;

  if (placeholderCount === 0) {
    return {
      task: sourceTask,
      truncated: false,
      placeholderCount: 0,
    };
  }

  const normalizedPreviousOutput =
    typeof options.previousOutput === "string"
      ? options.previousOutput.replace(/\r\n/g, "\n").trim()
      : "";
  const truncatedOutput = truncatePreviousOutput(
    normalizedPreviousOutput,
    options.maxChars ?? CHAIN_PREVIOUS_OUTPUT_MAX_CHARS,
  );

  return {
    task: sourceTask.split(PREVIOUS_PLACEHOLDER_TOKEN).join(truncatedOutput.value),
    truncated: truncatedOutput.truncated,
    placeholderCount,
  };
}
