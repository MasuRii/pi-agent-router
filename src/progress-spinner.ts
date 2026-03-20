import { type TimerHandle, unrefTimer } from "./ui/timer-utils";

/**
 * Progress spinner helpers for in-progress task titles and footer widgets.
 */

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const CIRCULAR_SPINNER_FRAMES = ["◜", "◠", "◝", "◞", "◡", "◟"] as const;

export const BRAILLE_SPINNER_INTERVAL_MS = 80;
export const CIRCULAR_SPINNER_INTERVAL_MS = 80;
export const SPINNER_RENDER_INTERVAL_MS = Math.min(
  BRAILLE_SPINNER_INTERVAL_MS,
  CIRCULAR_SPINNER_INTERVAL_MS,
);

export type SpinnerRenderLoop = {
  stop: () => void;
};

type SpinnerTimer = TimerHandle;

function normalizeSpinnerNow(now: number): number {
  return Number.isFinite(now) ? Math.max(0, Math.trunc(now)) : Date.now();
}

function normalizeSpinnerInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return SPINNER_RENDER_INTERVAL_MS;
  }

  return Math.max(16, Math.trunc(intervalMs));
}

function getSpinnerFrame(
  frames: readonly string[],
  intervalMs: number,
  now = Date.now(),
): string {
  const normalizedNow = normalizeSpinnerNow(now);
  const normalizedInterval = normalizeSpinnerInterval(intervalMs);
  const frameIndex = Math.floor(normalizedNow / normalizedInterval) % frames.length;
  return frames[frameIndex] || frames[0] || "•";
}

function getAlignedDelay(now: number, intervalMs: number): number {
  const remainder = now % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}

export function createSpinnerRenderLoop(options: {
  onTick: () => void;
  shouldRender?: () => boolean;
  intervalMs?: number;
  now?: () => number;
}): SpinnerRenderLoop {
  const intervalMs = normalizeSpinnerInterval(
    options.intervalMs ?? SPINNER_RENDER_INTERVAL_MS,
  );
  const now = options.now ?? Date.now;
  const shouldRender = options.shouldRender ?? (() => true);
  let timer: SpinnerTimer | undefined;
  let stopped = false;

  const scheduleNextTick = (): void => {
    if (stopped) {
      return;
    }

    const delay = getAlignedDelay(normalizeSpinnerNow(now()), intervalMs);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) {
        return;
      }

      if (shouldRender()) {
        options.onTick();
      }

      scheduleNextTick();
    }, delay);
    unrefTimer(timer);
  };

  scheduleNextTick();

  return {
    stop() {
      stopped = true;
      if (!timer) {
        return;
      }

      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function getBrailleSpinnerFrame(now = Date.now()): string {
  return getSpinnerFrame(BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS, now);
}

export function getCircularSpinnerFrame(now = Date.now()): string {
  return getSpinnerFrame(CIRCULAR_SPINNER_FRAMES, CIRCULAR_SPINNER_INTERVAL_MS, now);
}
