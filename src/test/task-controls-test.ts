import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_MAX_CONCURRENCY,
  TASK_CONTROLS_CACHE_MAX_ENTRIES,
} from "../constants";
import {
  getTaskControlsCacheSnapshot,
  invalidateTaskControlsCache,
  resetTaskControlsCacheState,
  resolveTaskControls,
  resolveTaskControlsAsync,
} from "../task/task-controls";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const finalize = (): void => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(finalize);
    }

    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

function writeProjectTaskSettings(root: string, settings: Record<string, unknown>): void {
  const settingsDir = join(root, ".pi");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

await runTest("resolveTaskControlsAsync accepts valid environment overrides", async () => {
  resetTaskControlsCacheState();
  await withEnv(
    {
      PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: "3",
      PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: "2400000",
      PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: "strict",
    },
    async () => {
      const { controls, warnings } = await resolveTaskControlsAsync(process.cwd());
      assert.equal(controls.maxConcurrency, 3);
      assert.equal(controls.defaultTimeoutMs, 2400000);
      assert.equal(controls.outputStrictness, "strict");
      assert.equal(warnings.length, 0);
    },
  );
});

await runTest("resolveTaskControlsAsync falls back with validation warnings for invalid overrides", async () => {
  resetTaskControlsCacheState();
  await withEnv(
    {
      PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: "0",
      PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: "5000",
      PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: "invalid",
    },
    async () => {
      const { controls, warnings } = await resolveTaskControlsAsync(process.cwd());
      assert.equal(controls.maxConcurrency, SUBAGENT_MAX_CONCURRENCY);
      assert.equal(controls.defaultTimeoutMs, SUBAGENT_DEFAULT_TIMEOUT_MS);
      assert.equal(controls.outputStrictness, "compat");
      assert.equal(warnings.length >= 1, true);
    },
  );
});

await runTest("resolveTaskControlsAsync caches hits and refreshes after invalidation", async () => {
  resetTaskControlsCacheState();
  const root = mkdtempSync(join(tmpdir(), "task-controls-cache-"));
  const nested = join(root, "src", "feature");

  try {
    mkdirSync(nested, { recursive: true });
    writeProjectTaskSettings(root, {
      agentRouter: {
        task: {
          maxRecursionDepth: 5,
        },
      },
    });

    await withEnv(
      {
        PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: undefined,
        PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: undefined,
        PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: undefined,
      },
      async () => {
        const first = await resolveTaskControlsAsync(nested);
        assert.equal(first.controls.maxRecursionDepth, 5);

        let snapshot = getTaskControlsCacheSnapshot();
        assert.equal(snapshot.misses, 1);
        assert.equal(snapshot.hits, 0);

        const second = await resolveTaskControlsAsync(nested);
        assert.equal(second.controls.maxRecursionDepth, 5);

        snapshot = getTaskControlsCacheSnapshot();
        assert.equal(snapshot.hits, 1);
        assert.equal(snapshot.misses, 1);

        writeProjectTaskSettings(root, {
          agentRouter: {
            task: {
              maxRecursionDepth: 6,
            },
          },
        });

        const cached = await resolveTaskControlsAsync(nested);
        assert.equal(cached.controls.maxRecursionDepth, 5);

        invalidateTaskControlsCache();

        snapshot = getTaskControlsCacheSnapshot();
        assert.equal(snapshot.invalidations, 1);

        const refreshed = await resolveTaskControlsAsync(nested);
        assert.equal(refreshed.controls.maxRecursionDepth, 6);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("resolveTaskControlsAsync bounded cache evicts least-recently-used entries", async () => {
  resetTaskControlsCacheState();
  const roots: string[] = [];

  try {
    await withEnv(
      {
        PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: undefined,
        PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: undefined,
        PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: undefined,
      },
      async () => {
        for (let index = 0; index < TASK_CONTROLS_CACHE_MAX_ENTRIES + 2; index += 1) {
          const root = mkdtempSync(join(tmpdir(), `task-controls-eviction-${index}-`));
          roots.push(root);
          const nested = join(root, "workspace", String(index));
          mkdirSync(nested, { recursive: true });
          writeProjectTaskSettings(root, {
            agentRouter: {
              task: {
                maxRecursionDepth: (index % 8) + 1,
              },
            },
          });
          await resolveTaskControlsAsync(nested);
        }
      },
    );

    const snapshot = getTaskControlsCacheSnapshot();
    assert.equal(snapshot.size <= TASK_CONTROLS_CACHE_MAX_ENTRIES, true);
    assert.equal(snapshot.evictions >= 1, true);
  } finally {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

await runTest("resolveTaskControls sync API preserves compatibility", () => {
  resetTaskControlsCacheState();
  const result = resolveTaskControls(process.cwd());
  assert.equal(typeof result.controls.maxConcurrency, "number");
});

console.log("All task-controls tests passed.");
