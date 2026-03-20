export type TimerHandle = ReturnType<typeof setTimeout>;

export function clearPendingTimer(timer: TimerHandle | undefined): void {
  if (timer === undefined) {
    return;
  }

  clearTimeout(timer);
}

export function unrefTimer(timer: TimerHandle): void {
  const timerWithUnref =
    typeof timer === "object" && timer !== null
      ? (timer as { unref?: () => void })
      : undefined;

  if (typeof timerWithUnref?.unref === "function") {
    timerWithUnref.unref();
  }
}
