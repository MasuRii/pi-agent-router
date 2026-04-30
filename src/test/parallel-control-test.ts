import assert from "node:assert/strict";

import { mapWithAbortAwareConcurrency } from "../task/parallel-control";

function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve(testFn()).then(() => {
    console.log(`[PASS] ${name}`);
  });
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      handler();
    };

    const onAbort = (): void => {
      finish(() => {
        reject(createAbortError("worker aborted"));
      });
    };

    const timer = setTimeout(() => {
      finish(resolve);
    }, delayMs);

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runAll(): Promise<void> {
  await runTest("mapWithAbortAwareConcurrency preserves output indexes", async () => {
    const { results, control } = await mapWithAbortAwareConcurrency({
      items: [1, 2, 3, 4],
      concurrency: 3,
      worker: async (item) => {
        await sleep(5);
        return item * 10;
      },
    });

    assert.deepEqual(results, [10, 20, 30, 40]);
    assert.equal(control.aborted, false);
    assert.equal(control.skipped, 0);
  });

  await runTest("mapWithAbortAwareConcurrency supports opt-in worker timeouts without affecting fast workers", async () => {
    const { results, control } = await mapWithAbortAwareConcurrency({
      items: [1, 2, 3],
      concurrency: 2,
      workerTimeoutMs: 50,
      worker: async (item, _index, signal) => {
        assert.equal(signal.aborted, false);
        await sleep(5);
        return item * 2;
      },
    });

    assert.deepEqual(results, [2, 4, 6]);
    assert.equal(control.aborted, false);
    assert.equal(control.skipped, 0);
  });

  await runTest("mapWithAbortAwareConcurrency continues peers after worker-local abort when fail-fast is disabled", async () => {
    const skipped: number[] = [];

    const { results, control } = await mapWithAbortAwareConcurrency({
      items: [1, 2, 3, 4],
      concurrency: 2,
      abortOnWorkerError: false,
      worker: async (item) => {
        if (item === 2) {
          throw createAbortError("Delegated task dismissed by user.");
        }

        await sleep(5);
        return item;
      },
      onSkipped: (_item, index) => {
        skipped.push(index);
      },
    });

    assert.deepEqual(results, [1, undefined, 3, 4]);
    assert.equal(control.aborted, false);
    assert.equal(control.skipped, 0);
    assert.deepEqual(skipped, []);
  });

  await runTest("mapWithAbortAwareConcurrency fail-fast treats worker-local aborts as worker errors", async () => {
    const skipped: number[] = [];

    const { control } = await mapWithAbortAwareConcurrency({
      items: [1, 2, 3, 4],
      concurrency: 2,
      worker: async (item) => {
        if (item === 2) {
          throw createAbortError("Delegated task dismissed by user.");
        }

        await sleep(20);
        return item;
      },
      onSkipped: (_item, index) => {
        skipped.push(index);
      },
    });

    assert.equal(control.aborted, true);
    assert.equal(control.reason, "worker_error");
    assert.equal(control.firstError?.message, "Delegated task dismissed by user.");
    assert.equal(skipped.length >= 1, true);
  });

  await runTest("mapWithAbortAwareConcurrency fail-fast aborts queued work on first worker error", async () => {
    const skipped: number[] = [];

    const { results, control } = await mapWithAbortAwareConcurrency({
      items: [1, 2, 3, 4],
      concurrency: 2,
      worker: async (item) => {
        if (item === 2) {
          throw new Error("boom");
        }

        await sleep(20);
        return item;
      },
      onSkipped: (_item, index) => {
        skipped.push(index);
      },
    });

    assert.equal(control.aborted, true);
    assert.equal(control.reason, "worker_error");
    assert.equal(control.firstError?.message, "boom");
    assert.equal(skipped.length >= 1, true);
    assert.equal(results[1], undefined);
  });

  await runTest("mapWithAbortAwareConcurrency aborts slow workers when workerTimeoutMs is set", async () => {
    const skipped: number[] = [];

    const { results, control } = await mapWithAbortAwareConcurrency({
      items: [1, 2, 3],
      concurrency: 2,
      workerTimeoutMs: 10,
      worker: async (item, _index, signal) => {
        await sleepWithAbort(50, signal);
        return item;
      },
      onSkipped: (_item, index, reason) => {
        skipped.push(index);
        assert.equal(reason, "signal");
      },
    });

    assert.deepEqual(results, [undefined, undefined, undefined]);
    assert.equal(control.aborted, true);
    assert.equal(control.reason, "signal");
    assert.match(control.firstError?.message || "", /timed out after 10ms/i);
    assert.equal(control.started, 2);
    assert.equal(control.completed, 2);
    assert.equal(control.skipped, 1);
    assert.deepEqual(skipped, [2]);
  });

  await runTest("mapWithAbortAwareConcurrency enforces workerTimeoutMs even when a worker ignores AbortSignal", async () => {
    const startedAt = Date.now();

    const { results, control } = await mapWithAbortAwareConcurrency({
      items: [1],
      concurrency: 1,
      workerTimeoutMs: 20,
      worker: async () => new Promise<number>(() => undefined),
    });

    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(results, [undefined]);
    assert.equal(control.aborted, true);
    assert.equal(control.reason, "signal");
    assert.match(control.firstError?.message || "", /timed out after 20ms/i);
    assert.equal(control.started, 1);
    assert.equal(control.completed, 1);
    assert.equal(control.skipped, 0);
    assert.equal(elapsedMs < 150, true);
  });

  await runTest("mapWithAbortAwareConcurrency respects external abort signal", async () => {
    const controller = new AbortController();
    const skipped: number[] = [];

    const promise = mapWithAbortAwareConcurrency({
      items: [1, 2, 3],
      concurrency: 1,
      signal: controller.signal,
      worker: async () => {
        await sleep(40);
        return "done";
      },
      onSkipped: (_item, index) => {
        skipped.push(index);
      },
    });

    setTimeout(() => {
      controller.abort();
    }, 10);

    const { control } = await promise;
    assert.equal(control.aborted, true);
    assert.equal(control.reason, "signal");
    assert.equal(skipped.length >= 1, true);
  });

  await runTest("mapWithAbortAwareConcurrency short-circuits already-aborted signals", async () => {
    const controller = new AbortController();
    controller.abort();

    const skipped: number[] = [];
    let workerCalls = 0;

    const { results, control } = await mapWithAbortAwareConcurrency({
      items: [1, 2, 3],
      concurrency: 3,
      signal: controller.signal,
      worker: async () => {
        workerCalls += 1;
        return "done";
      },
      onSkipped: (_item, index) => {
        skipped.push(index);
      },
    });

    assert.deepEqual(results, [undefined, undefined, undefined]);
    assert.equal(workerCalls, 0);
    assert.equal(control.aborted, true);
    assert.equal(control.reason, "signal");
    assert.equal(control.started, 0);
    assert.equal(control.completed, 0);
    assert.equal(control.skipped, 3);
    assert.deepEqual(skipped, [0, 1, 2]);
  });

  await runTest("mapWithAbortAwareConcurrency rejects invalid workerTimeoutMs values", async () => {
    await assert.rejects(
      () =>
        mapWithAbortAwareConcurrency({
          items: [1],
          concurrency: 1,
          workerTimeoutMs: 0,
          worker: async (item) => item,
        }),
      /Invalid workerTimeoutMs: expected a positive finite number\./,
    );
  });

  console.log("All parallel-control tests passed.");
}

runAll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
