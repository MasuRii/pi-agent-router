export type ParallelAbortReason = "signal" | "worker_error";

export type ParallelControlResult = {
  aborted: boolean;
  reason?: ParallelAbortReason;
  firstError?: Error;
  started: number;
  completed: number;
  skipped: number;
};

type CombinedAbortSignal = {
  signal: AbortSignal;
  abortInternal: (error?: Error) => void;
  cleanup: () => void;
  getAbortError: () => Error | undefined;
};

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(typeof value === "string" ? value : "Unknown parallel worker error");
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function normalizeWorkerTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid workerTimeoutMs: expected a positive finite number.");
  }

  return Math.max(1, Math.trunc(value));
}

export function isAbortLikeError(value: unknown): boolean {
  if (!(value instanceof Error)) {
    return false;
  }

  return value.name === "AbortError" || /aborted/i.test(value.message);
}

function createCombinedAbortSignal(options: {
  external?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
}): CombinedAbortSignal {
  const { external, timeoutMs, timeoutMessage } = options;
  const internalController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortError: Error | undefined;

  const abortInternal = (error?: Error): void => {
    if (error && !abortError) {
      abortError = error;
    }

    internalController.abort();
  };

  const onExternalAbort = (): void => {
    abortInternal();
  };

  if (external) {
    if (external.aborted) {
      abortInternal();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  if (timeoutMs !== undefined && !internalController.signal.aborted) {
    timeoutHandle = setTimeout(() => {
      abortInternal(createAbortError(timeoutMessage || `Parallel worker timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  }

  return {
    signal: internalController.signal,
    abortInternal,
    cleanup: () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      external?.removeEventListener("abort", onExternalAbort);
    },
    getAbortError: () => abortError,
  };
}

function createAbortSignalPromise(options: {
  signal: AbortSignal;
  defaultMessage: string;
  getAbortError: () => Error | undefined;
}): {
  promise: Promise<never>;
  cleanup: () => void;
} {
  const { signal, defaultMessage, getAbortError } = options;
  let active = true;
  let rejectAbort: (error: Error) => void = () => undefined;

  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });

  const onAbort = (): void => {
    if (!active) {
      return;
    }

    active = false;
    signal.removeEventListener("abort", onAbort);
    rejectAbort(getAbortError() || createAbortError(defaultMessage));
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    promise,
    cleanup: () => {
      active = false;
      signal.removeEventListener("abort", onAbort);
    },
  };
}

async function runWorkerWithOptionalTimeout<TIn, TOut>(options: {
  item: TIn;
  index: number;
  totalItems: number;
  signal: AbortSignal;
  workerTimeoutMs?: number;
  worker: (item: TIn, index: number, signal: AbortSignal) => Promise<TOut>;
}): Promise<TOut> {
  const { item, index, signal, totalItems, worker, workerTimeoutMs } = options;
  const combined = createCombinedAbortSignal({
    external: signal,
    timeoutMs: workerTimeoutMs,
    timeoutMessage: `Parallel worker ${index + 1}/${totalItems} timed out after ${workerTimeoutMs}ms.`,
  });
  const abortPromise = createAbortSignalPromise({
    signal: combined.signal,
    defaultMessage: `Parallel worker ${index + 1}/${totalItems} aborted.`,
    getAbortError: combined.getAbortError,
  });
  const workerPromise = Promise.resolve().then(() => worker(item, index, combined.signal));

  try {
    return await Promise.race([workerPromise, abortPromise.promise]);
  } finally {
    abortPromise.cleanup();
    combined.cleanup();
  }
}

export async function mapWithAbortAwareConcurrency<TIn, TOut>(options: {
  items: readonly TIn[];
  concurrency: number;
  signal?: AbortSignal;
  workerTimeoutMs?: number;
  abortOnWorkerError?: boolean;
  worker: (item: TIn, index: number, signal: AbortSignal) => Promise<TOut>;
  onSkipped?: (item: TIn, index: number, reason: ParallelAbortReason) => void;
}): Promise<{
  results: Array<TOut | undefined>;
  control: ParallelControlResult;
}> {
  const { items, worker, onSkipped } = options;
  if (items.length === 0) {
    return {
      results: [],
      control: {
        aborted: false,
        started: 0,
        completed: 0,
        skipped: 0,
      },
    };
  }

  const results: Array<TOut | undefined> = Array.from({ length: items.length });

  if (options.signal?.aborted) {
    for (let index = 0; index < items.length; index += 1) {
      onSkipped?.(items[index], index, "signal");
    }

    return {
      results,
      control: {
        aborted: true,
        reason: "signal",
        started: 0,
        completed: 0,
        skipped: items.length,
      },
    };
  }

  const workerTimeoutMs = normalizeWorkerTimeoutMs(options.workerTimeoutMs);
  const limit = Math.max(1, Math.min(Math.trunc(options.concurrency) || 1, items.length));
  const started = new Array<boolean>(items.length).fill(false);

  let nextIndex = 0;
  let startedCount = 0;
  let completedCount = 0;
  let skippedCount = 0;
  let firstError: Error | undefined;
  let abortReason: ParallelAbortReason | undefined;

  const combined = createCombinedAbortSignal({ external: options.signal });

  try {
    const workers = Array.from({ length: limit }, async () => {
      while (true) {
        if (combined.signal.aborted) {
          return;
        }

        const current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) {
          return;
        }

        started[current] = true;
        startedCount += 1;

        try {
          results[current] = await runWorkerWithOptionalTimeout({
            item: items[current],
            index: current,
            totalItems: items.length,
            signal: combined.signal,
            workerTimeoutMs,
            worker,
          });
        } catch (error) {
          const normalizedError = toError(error);
          if (!firstError) {
            firstError = normalizedError;
          }

          const isSignalAbort =
            options.signal?.aborted || isAbortLikeError(normalizedError);

          if (!abortReason) {
            if (isSignalAbort) {
              abortReason = "signal";
            } else if (options.abortOnWorkerError !== false) {
              abortReason = "worker_error";
            }
          }

          if (isSignalAbort || options.abortOnWorkerError !== false) {
            combined.abortInternal();
          }
        } finally {
          completedCount += 1;
        }
      }
    });

    await Promise.allSettled(workers);

    const skipReason: ParallelAbortReason | undefined = abortReason || (options.signal?.aborted ? "signal" : undefined);
    if (skipReason) {
      for (let index = 0; index < items.length; index += 1) {
        if (started[index]) {
          continue;
        }

        skippedCount += 1;
        onSkipped?.(items[index], index, skipReason);
      }
    }

    return {
      results,
      control: {
        aborted: Boolean(skipReason),
        reason: skipReason,
        firstError,
        started: startedCount,
        completed: completedCount,
        skipped: skippedCount,
      },
    };
  } finally {
    combined.cleanup();
  }
}
