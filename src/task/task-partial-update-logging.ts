import { getErrorMessage } from "../error-utils";

export const TASK_PARTIAL_UPDATE_RENDER_FAILED_EVENT = "task.partial_update_render_failed";

export type TaskPartialUpdateDebugLogger = {
  warn: (event: string, payload?: Record<string, unknown>) => unknown;
};

export function logTaskPartialUpdateRenderFailure(
  logger: TaskPartialUpdateDebugLogger,
  error: unknown,
): void {
  void logger.warn(TASK_PARTIAL_UPDATE_RENDER_FAILED_EVENT, {
    message: getErrorMessage(error),
  });
}
