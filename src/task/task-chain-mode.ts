import { normalizeInputText } from "../input-normalization";

export type TaskExecutionMode = "parallel" | "chain";

const DEFAULT_TASK_EXECUTION_MODE: TaskExecutionMode = "parallel";
const CHAIN_PREVIOUS_OUTPUT_MAX_CHARS = 8_000;
const PREVIOUS_PLACEHOLDER_TOKEN = "{previous}";

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
