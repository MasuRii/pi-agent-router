import type { SubagentSemanticCompletionSignal } from "./semantic-completion-detector";

type TimerHandle = ReturnType<typeof setTimeout>;

type TimerApi = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type SubagentSemanticCompletionFinalizeEvent = {
  signal: SubagentSemanticCompletionSignal;
  forcedAfterMs: number;
};

export type SubagentSemanticCompletionTerminationEvent = {
  signal: SubagentSemanticCompletionSignal;
};

export type SubagentSemanticCompletionFinalizerOptions = {
  completionGraceMs: number;
  hardKillDelayMs: number;
  forcedFinalizeGraceMs: number;
  timers?: TimerApi;
  isProcessStillRunning: () => boolean;
  terminateProcess: (signal: NodeJS.Signals) => void;
  onTerminateError?: (error: unknown, signal: NodeJS.Signals) => void;
  onTerminationStarted?: (event: SubagentSemanticCompletionTerminationEvent) => void;
  onFinalize: (event: SubagentSemanticCompletionFinalizeEvent) => void;
};

function normalizeDelayMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function createSubagentSemanticCompletionFinalizer(
  options: SubagentSemanticCompletionFinalizerOptions,
): {
  recordSemanticCompletion: (signal: SubagentSemanticCompletionSignal) => void;
  recordProcessActivity: () => void;
  stop: () => void;
} {
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: TimerHandle) => clearTimeout(handle),
  };
  const completionGraceMs = normalizeDelayMs(options.completionGraceMs);
  const hardKillDelayMs = normalizeDelayMs(options.hardKillDelayMs);
  const forcedFinalizeGraceMs = normalizeDelayMs(options.forcedFinalizeGraceMs);

  let stopped = false;
  let terminationStarted = false;
  let graceTimer: TimerHandle | undefined;
  let hardKillTimer: TimerHandle | undefined;
  let forcedFinalizeTimer: TimerHandle | undefined;
  let latestSignal: SubagentSemanticCompletionSignal | undefined;

  const clearTimer = (timer: TimerHandle | undefined): undefined => {
    if (timer) {
      timers.clearTimeout(timer);
    }
    return undefined;
  };

  const terminate = (signal: NodeJS.Signals): void => {
    try {
      options.terminateProcess(signal);
    } catch (error) {
      options.onTerminateError?.(error, signal);
    }
  };

  const forceFinalize = (): void => {
    forcedFinalizeTimer = undefined;
    if (stopped || !latestSignal) {
      return;
    }

    options.onFinalize({
      signal: latestSignal,
      forcedAfterMs: completionGraceMs + hardKillDelayMs + forcedFinalizeGraceMs,
    });
  };

  const startTermination = (): void => {
    graceTimer = undefined;
    if (stopped || terminationStarted || !latestSignal) {
      return;
    }

    terminationStarted = true;
    options.onTerminationStarted?.({ signal: latestSignal });

    if (!options.isProcessStillRunning()) {
      options.onFinalize({ signal: latestSignal, forcedAfterMs: completionGraceMs });
      return;
    }

    terminate("SIGTERM");

    hardKillTimer = timers.setTimeout(() => {
      hardKillTimer = undefined;
      if (stopped || !options.isProcessStillRunning()) {
        return;
      }
      terminate("SIGKILL");
    }, hardKillDelayMs);

    forcedFinalizeTimer = timers.setTimeout(forceFinalize, hardKillDelayMs + forcedFinalizeGraceMs);
  };

  const scheduleGrace = (): void => {
    graceTimer = clearTimer(graceTimer);
    if (stopped || terminationStarted || !latestSignal) {
      return;
    }

    graceTimer = timers.setTimeout(startTermination, completionGraceMs);
  };

  const recordProcessActivity = (): void => {
    if (stopped || terminationStarted || !latestSignal) {
      return;
    }

    scheduleGrace();
  };

  return {
    recordSemanticCompletion: (signal: SubagentSemanticCompletionSignal): void => {
      if (stopped || terminationStarted) {
        return;
      }
      latestSignal = signal;
      scheduleGrace();
    },
    recordProcessActivity,
    stop: (): void => {
      stopped = true;
      graceTimer = clearTimer(graceTimer);
      hardKillTimer = clearTimer(hardKillTimer);
      forcedFinalizeTimer = clearTimer(forcedFinalizeTimer);
    },
  };
}
