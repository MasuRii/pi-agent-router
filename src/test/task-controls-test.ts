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
  resolveRetryControlsAsync,
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

function writeRouterConfig(root: string, settings: Record<string, unknown>): string {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  return configPath;
}

await runTest("resolveTaskControlsAsync uses extension config maxParallelDelegationConcurrency", async () => {
  resetTaskControlsCacheState();
  const root = mkdtempSync(join(tmpdir(), "task-controls-router-config-"));

  try {
    const configPath = writeRouterConfig(root, {
      debug: false,
      maxParallelDelegationConcurrency: 6,
    });

    await withEnv(
      {
        PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: undefined,
        PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: undefined,
        PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: undefined,
      },
      async () => {
        const { controls, warnings } = await resolveTaskControlsAsync(root, {
          configPath,
          globalSettingsPath: join(root, "missing-global-settings.json"),
        });
        assert.equal(controls.maxConcurrency, 6);
        assert.equal(warnings.length, 0);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("resolveTaskControlsAsync reports invalid extension config concurrency", async () => {
  resetTaskControlsCacheState();
  const root = mkdtempSync(join(tmpdir(), "task-controls-router-config-"));

  try {
    const configPath = writeRouterConfig(root, {
      debug: false,
      maxParallelDelegationConcurrency: 17,
    });

    await withEnv(
      {
        PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY: undefined,
        PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS: undefined,
        PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS: undefined,
      },
      async () => {
        const { controls, warnings } = await resolveTaskControlsAsync(root, {
          configPath,
          globalSettingsPath: join(root, "missing-global-settings.json"),
        });
        assert.equal(controls.maxConcurrency, SUBAGENT_MAX_CONCURRENCY);
        assert.equal(warnings.some((warning) => warning.includes("maxParallelDelegationConcurrency")), true);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

await runTest("resolveRetryControlsAsync follows Pi retry settings defaults and project overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "retry-controls-"));
  const nested = join(root, "workspace", "feature");

  try {
    mkdirSync(nested, { recursive: true });
    const globalSettingsPath = join(root, "settings.json");
    writeFileSync(globalSettingsPath, JSON.stringify({ retry: { enabled: true, maxRetries: 8, baseDelayMs: 2000 } }), "utf-8");
    writeProjectTaskSettings(root, { retry: { maxRetries: 5 } });

    const { controls, warnings } = await resolveRetryControlsAsync(nested, { globalSettingsPath });
    assert.deepEqual(controls, { enabled: true, maxRetries: 5, baseDelayMs: 2000 });
    assert.equal(warnings.length, 0);

    const defaults = await resolveRetryControlsAsync(nested, {
      globalSettingsPath: join(root, "missing-settings.json"),
      projectSettingsPath: join(root, "missing-project-settings.json"),
    });
    assert.deepEqual(defaults.controls, { enabled: true, maxRetries: 3, baseDelayMs: 2000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("resolveRetryControlsAsync falls back and warns for invalid retry number settings", async () => {
  const cases: Array<{
    name: string;
    retry: Record<string, unknown>;
    expectedControls: { maxRetries: number; baseDelayMs: number };
    warningIncludes: string[];
  }> = [
    {
      name: "non-number maxRetries",
      retry: { maxRetries: "8" },
      expectedControls: { maxRetries: 3, baseDelayMs: 2000 },
      warningIncludes: ["retry.maxRetries", "finite number"],
    },
    {
      name: "negative maxRetries",
      retry: { maxRetries: -1 },
      expectedControls: { maxRetries: 3, baseDelayMs: 2000 },
      warningIncludes: ["retry.maxRetries", "between 0 and 32"],
    },
    {
      name: "out-of-range baseDelayMs",
      retry: { baseDelayMs: 999999999 },
      expectedControls: { maxRetries: 3, baseDelayMs: 2000 },
      warningIncludes: ["retry.baseDelayMs", "between 0 and 3600000"],
    },
  ];

  for (const testCase of cases) {
    const root = mkdtempSync(join(tmpdir(), `retry-controls-invalid-${testCase.name.replace(/\W+/g, "-")}-`));
    try {
      writeProjectTaskSettings(root, { retry: testCase.retry });
      const { controls, warnings } = await resolveRetryControlsAsync(root, {
        globalSettingsPath: join(root, "missing-settings.json"),
      });

      assert.equal(controls.enabled, true);
      assert.equal(controls.maxRetries, testCase.expectedControls.maxRetries);
      assert.equal(controls.baseDelayMs, testCase.expectedControls.baseDelayMs);
      assert.equal(warnings.length, 1);
      assert.equal(testCase.warningIncludes.every((fragment) => warnings[0]?.includes(fragment)), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
