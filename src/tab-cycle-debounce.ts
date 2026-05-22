import { LINUX_TAB_CYCLE_DEBOUNCE_MS } from "./constants";

export function resolveTabCycleDebounceMs(
  platform: NodeJS.Platform = process.platform as NodeJS.Platform,
): number {
  return platform === "linux" ? LINUX_TAB_CYCLE_DEBOUNCE_MS : 0;
}

export function shouldConsumeTabCycleInput(
  nowMs: number,
  lastTabCycleAtMs: number,
  debounceMs: number,
): boolean {
  return debounceMs > 0 && nowMs - lastTabCycleAtMs < debounceMs;
}
