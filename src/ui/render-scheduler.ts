/**
 * Coalesces frequent extension-driven UI render requests.
 *
 * Pi's TUI already batches same-tick renders, but subagent stdout/stderr can
 * arrive across many event-loop turns. This scheduler caps extension-triggered
 * redraw pressure so spinner animations stay smooth during heavy delegation.
 */

import { clearPendingTimer, type TimerHandle, unrefTimer } from "./timer-utils";

export type UiRenderScheduler = {
  request: (options?: { immediate?: boolean }) => void;
  cancel: () => void;
};

type SchedulerTimer = TimerHandle;

function normalizeMinIntervalMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 48;
  }

  return Math.max(16, Math.trunc(value));
}

export function createUiRenderScheduler(options: {
  render: () => void;
  minIntervalMs?: number;
  now?: () => number;
}): UiRenderScheduler {
  const minIntervalMs = normalizeMinIntervalMs(options.minIntervalMs);
  const now = options.now ?? Date.now;
  let timer: SchedulerTimer | undefined;
  let queued = false;
  let lastRenderAt = 0;

  const flush = (): void => {
    clearPendingTimer(timer);
    timer = undefined;

    if (!queued) {
      return;
    }

    queued = false;
    lastRenderAt = now();
    options.render();
  };

  const scheduleFlush = (delayMs: number): void => {
    if (timer) {
      return;
    }

    timer = setTimeout(() => {
      flush();
    }, Math.max(0, Math.trunc(delayMs)));
    unrefTimer(timer);
  };

  return {
    request(requestOptions: { immediate?: boolean } = {}): void {
      queued = true;

      if (requestOptions.immediate) {
        flush();
        return;
      }

      const elapsedMs = Math.max(0, now() - lastRenderAt);
      if (elapsedMs >= minIntervalMs) {
        scheduleFlush(0);
        return;
      }

      scheduleFlush(minIntervalMs - elapsedMs);
    },
    cancel(): void {
      queued = false;
      clearPendingTimer(timer);
      timer = undefined;
    },
  };
}
