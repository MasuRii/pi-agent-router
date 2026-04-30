import { normalizeInputText } from "../input-normalization";

export type TaskContextReferenceDescriptor = {
  id: string;
};

export type CurrentBatchContextFromScope = "top-level" | "parallel-task";

export function buildTaskReferenceIndexById(
  tasks: readonly TaskContextReferenceDescriptor[],
): Map<string, number> {
  const indexById = new Map<string, number>();

  for (let index = 0; index < tasks.length; index += 1) {
    const normalizedId = normalizeInputText(tasks[index]?.id).toLowerCase();
    if (!normalizedId || indexById.has(normalizedId)) {
      continue;
    }

    indexById.set(normalizedId, index);
  }

  return indexById;
}

export function validateCurrentBatchContextFromReferences(options: {
  tasks: readonly TaskContextReferenceDescriptor[];
  references: readonly string[];
  fieldName: string;
  scope: CurrentBatchContextFromScope;
}): string | undefined {
  const indexById = buildTaskReferenceIndexById(options.tasks);

  for (const reference of options.references) {
    const normalizedReference = normalizeInputText(reference);
    const referencedTaskIndex = indexById.get(normalizedReference.toLowerCase());
    if (referencedTaskIndex === undefined) {
      continue;
    }

    const referencedTaskId = normalizeInputText(
      options.tasks[referencedTaskIndex]?.id,
    );
    const referencedTaskLabel = referencedTaskId
      ? ` current batch task '${referencedTaskId}'`
      : " a current batch task";

    if (options.scope === "top-level") {
      return `Task delegation failed: ${options.fieldName} reference '${normalizedReference}' matches${referencedTaskLabel}. Top-level contextFrom only accepts retained delegated sessions; use per-task contextFrom in mode="chain" for earlier same-batch results.`;
    }

    return `Task delegation failed: ${options.fieldName} reference '${normalizedReference}' matches${referencedTaskLabel}. Parallel tasks cannot read same-batch results; use mode="chain" with an earlier task id, or reference a retained delegated session.`;
  }

  return undefined;
}
