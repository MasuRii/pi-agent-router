import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createBoundedCache } from "../cache/bounded-cache";
import {
  AGENT_DIR,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_MAX_CONFIGURABLE_CONCURRENCY,
  SUBAGENT_MAX_CONCURRENCY,
  SUBAGENT_MIN_CONCURRENCY,
  SUBAGENT_MIN_TIMEOUT_MS,
  TASK_CONTROLS_CACHE_MAX_ENTRIES,
} from "../constants";
import { CONFIG_PATH, loadPiAgentRouterConfig } from "../config";
import { piAgentRouterDebugLogger } from "../debug-logger";
import { normalizeInputText } from "../input-normalization";
import type { OutputContractStrictness } from "../output-contract";
import { asRecord } from "../record-utils";
import type { CacheDebugCounters, TaskControlsCacheSnapshot } from "../types";

export type AgentRouterTaskControls = {
  maxConcurrency: number;
  maxRecursionDepth: number;
  eagerDelegation: boolean;
  defaultTimeoutMs: number;
  outputStrictness: OutputContractStrictness;
};

export interface TaskControlsResolutionOptions {
  configPath?: string;
  globalSettingsPath?: string;
  projectSettingsPath?: string;
}

const DEFAULT_TASK_CONTROLS: AgentRouterTaskControls = {
  maxConcurrency: SUBAGENT_MAX_CONCURRENCY,
  maxRecursionDepth: 3,
  eagerDelegation: false,
  defaultTimeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
  outputStrictness: "compat",
};

const taskControlsCache = createBoundedCache<string, { controls: AgentRouterTaskControls; warnings: string[] }>(
  TASK_CONTROLS_CACHE_MAX_ENTRIES,
);
const taskControlsInflightLoads = new Map<
  string,
  Promise<{ controls: AgentRouterTaskControls; warnings: string[] }>
>();

const taskControlsCounters: Omit<CacheDebugCounters, "size" | "maxEntries"> = {
  hits: 0,
  misses: 0,
  invalidations: 0,
  evictions: 0,
};

let taskControlsCacheRevision = 0;


function cloneTaskControls(controls: AgentRouterTaskControls): AgentRouterTaskControls {
  return { ...controls };
}

function cloneTaskControlsResult(result: {
  controls: AgentRouterTaskControls;
  warnings: string[];
}): { controls: AgentRouterTaskControls; warnings: string[] } {
  return {
    controls: cloneTaskControls(result.controls),
    warnings: [...result.warnings],
  };
}

function getTaskControlsCacheCounters(): TaskControlsCacheSnapshot {
  return {
    ...taskControlsCounters,
    size: taskControlsCache.size(),
    maxEntries: TASK_CONTROLS_CACHE_MAX_ENTRIES,
  };
}

function logTaskControlsCacheEvent(event: string, payload: Record<string, unknown> = {}): void {
  void piAgentRouterDebugLogger.info(event, {
    ...payload,
    cache: getTaskControlsCacheSnapshot(),
  });
}

function getTaskControlsEnvSignature(): string {
  return [
    process.env.PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY ?? "",
    process.env.PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS ?? "",
    process.env.PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS ?? "",
  ].join("\u0000");
}

function getTaskControlsConfigSignature(options: TaskControlsResolutionOptions = {}): string {
  return [
    resolve(options.configPath ?? CONFIG_PATH),
    resolve(options.globalSettingsPath ?? join(AGENT_DIR, "settings.json")),
    options.projectSettingsPath ? resolve(options.projectSettingsPath) : "nearest-project-settings",
  ].join("\u0000");
}

function createTaskControlsCacheKey(
  cwd: string,
  options: TaskControlsResolutionOptions = {},
): string {
  return `${resolve(cwd)}\u0000${getTaskControlsEnvSignature()}\u0000${getTaskControlsConfigSignature(options)}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function getTaskControlsCacheSnapshot(): TaskControlsCacheSnapshot {
  return getTaskControlsCacheCounters();
}

export function invalidateTaskControlsCache(): void {
  const removedEntries = taskControlsCache.size();
  taskControlsCacheRevision += 1;
  taskControlsCache.clear();
  taskControlsInflightLoads.clear();
  taskControlsCounters.invalidations += removedEntries;

  if (removedEntries > 0) {
    logTaskControlsCacheEvent("task.controls_cache_invalidated", {
      removedEntries,
    });
  }
}

export function resetTaskControlsCacheState(): void {
  taskControlsCacheRevision += 1;
  taskControlsCache.clear();
  taskControlsInflightLoads.clear();
  taskControlsCounters.hits = 0;
  taskControlsCounters.misses = 0;
  taskControlsCounters.invalidations = 0;
  taskControlsCounters.evictions = 0;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

async function readJsonFileAsync(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function findNearestProjectSettingsPath(cwd: string): string | undefined {
  let current = resolve(cwd);

  while (true) {
    const candidate = join(current, ".pi", "settings.json");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

async function findNearestProjectSettingsPathAsync(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);

  while (true) {
    const candidate = join(current, ".pi", "settings.json");
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function pickTaskSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!settings) {
    return {};
  }

  const fromAgentRouter = asRecord(settings.agentRouter);
  const fromAgentRouterTask = asRecord(fromAgentRouter?.task);
  if (fromAgentRouterTask) {
    return fromAgentRouterTask;
  }

  const fromTaskRouter = asRecord(settings.taskRouter);
  if (fromTaskRouter) {
    return fromTaskRouter;
  }

  const fromTask = asRecord(settings.task);
  if (fromTask) {
    return fromTask;
  }

  return {};
}

function parseNumberSetting(
  value: unknown,
  fallback: number,
  options: { min: number; max: number; field: string },
  warnings: string[],
): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`Invalid task setting '${options.field}': expected a finite number, got ${JSON.stringify(value)}.`);
    return fallback;
  }

  const normalized = Math.trunc(value);
  if (normalized < options.min || normalized > options.max) {
    warnings.push(
      `Invalid task setting '${options.field}': expected value between ${options.min} and ${options.max}, got ${normalized}.`,
    );
    return fallback;
  }

  return normalized;
}

function parseBooleanSetting(value: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    warnings.push(`Invalid task setting '${field}': expected boolean, got ${JSON.stringify(value)}.`);
    return fallback;
  }

  return value;
}

function parseStrictnessSetting(
  value: unknown,
  fallback: OutputContractStrictness,
  warnings: string[],
): OutputContractStrictness {
  if (value === undefined) {
    return fallback;
  }

  const normalized = normalizeInputText(value).toLowerCase();
  if (normalized === "compat" || normalized === "strict") {
    return normalized;
  }

  warnings.push(`Invalid task setting 'outputStrictness': expected 'compat' or 'strict', got ${JSON.stringify(value)}.`);
  return fallback;
}

function buildTaskControlsResult(
  cwd: string,
  options: TaskControlsResolutionOptions = {},
): {
  controls: AgentRouterTaskControls;
  warnings: string[];
} {
  const warnings: string[] = [];

  const routerConfigResult = loadPiAgentRouterConfig(options.configPath ?? CONFIG_PATH);
  if (routerConfigResult.warning) {
    warnings.push(routerConfigResult.warning);
  }

  const globalSettingsPath = options.globalSettingsPath ?? join(AGENT_DIR, "settings.json");
  const projectSettingsPath = options.projectSettingsPath ?? findNearestProjectSettingsPath(cwd);

  const globalTaskSettings = pickTaskSettings(readJsonFile(globalSettingsPath));
  const projectTaskSettings = pickTaskSettings(projectSettingsPath ? readJsonFile(projectSettingsPath) : undefined);

  const merged: Record<string, unknown> = {
    maxConcurrency: routerConfigResult.config.maxParallelDelegationConcurrency,
    ...globalTaskSettings,
    ...projectTaskSettings,
  };

  const envMaxConcurrency = process.env.PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY;
  if (envMaxConcurrency !== undefined) {
    merged.maxConcurrency = Number.parseInt(envMaxConcurrency, 10);
  }

  const envTimeout = process.env.PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS;
  if (envTimeout !== undefined) {
    merged.defaultTimeoutMs = Number.parseInt(envTimeout, 10);
  }

  const envStrictness = process.env.PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS;
  if (envStrictness !== undefined) {
    merged.outputStrictness = envStrictness;
  }

  return {
    controls: {
      maxConcurrency: parseNumberSetting(merged.maxConcurrency, DEFAULT_TASK_CONTROLS.maxConcurrency, {
        min: SUBAGENT_MIN_CONCURRENCY,
        max: SUBAGENT_MAX_CONFIGURABLE_CONCURRENCY,
        field: "maxConcurrency",
      }, warnings),
      maxRecursionDepth: parseNumberSetting(merged.maxRecursionDepth, DEFAULT_TASK_CONTROLS.maxRecursionDepth, {
        min: 1,
        max: 8,
        field: "maxRecursionDepth",
      }, warnings),
      eagerDelegation: parseBooleanSetting(merged.eagerDelegation, DEFAULT_TASK_CONTROLS.eagerDelegation, "eagerDelegation", warnings),
      defaultTimeoutMs: parseNumberSetting(merged.defaultTimeoutMs, DEFAULT_TASK_CONTROLS.defaultTimeoutMs, {
        min: SUBAGENT_MIN_TIMEOUT_MS,
        max: 12 * 60 * 60 * 1000,
        field: "defaultTimeoutMs",
      }, warnings),
      outputStrictness: parseStrictnessSetting(merged.outputStrictness, DEFAULT_TASK_CONTROLS.outputStrictness, warnings),
    },
    warnings,
  };
}

async function buildTaskControlsResultAsync(
  cwd: string,
  options: TaskControlsResolutionOptions = {},
): Promise<{
  controls: AgentRouterTaskControls;
  warnings: string[];
}> {
  const warnings: string[] = [];

  const routerConfigResult = loadPiAgentRouterConfig(options.configPath ?? CONFIG_PATH);
  if (routerConfigResult.warning) {
    warnings.push(routerConfigResult.warning);
  }

  const globalSettingsPath = options.globalSettingsPath ?? join(AGENT_DIR, "settings.json");
  const projectSettingsPath = options.projectSettingsPath ?? (await findNearestProjectSettingsPathAsync(cwd));

  const [globalSettings, projectSettings] = await Promise.all([
    readJsonFileAsync(globalSettingsPath),
    projectSettingsPath ? readJsonFileAsync(projectSettingsPath) : Promise.resolve(undefined),
  ]);

  const globalTaskSettings = pickTaskSettings(globalSettings);
  const projectTaskSettings = pickTaskSettings(projectSettings);

  const merged: Record<string, unknown> = {
    maxConcurrency: routerConfigResult.config.maxParallelDelegationConcurrency,
    ...globalTaskSettings,
    ...projectTaskSettings,
  };

  const envMaxConcurrency = process.env.PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY;
  if (envMaxConcurrency !== undefined) {
    merged.maxConcurrency = Number.parseInt(envMaxConcurrency, 10);
  }

  const envTimeout = process.env.PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS;
  if (envTimeout !== undefined) {
    merged.defaultTimeoutMs = Number.parseInt(envTimeout, 10);
  }

  const envStrictness = process.env.PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS;
  if (envStrictness !== undefined) {
    merged.outputStrictness = envStrictness;
  }

  return {
    controls: {
      maxConcurrency: parseNumberSetting(merged.maxConcurrency, DEFAULT_TASK_CONTROLS.maxConcurrency, {
        min: SUBAGENT_MIN_CONCURRENCY,
        max: SUBAGENT_MAX_CONFIGURABLE_CONCURRENCY,
        field: "maxConcurrency",
      }, warnings),
      maxRecursionDepth: parseNumberSetting(merged.maxRecursionDepth, DEFAULT_TASK_CONTROLS.maxRecursionDepth, {
        min: 1,
        max: 8,
        field: "maxRecursionDepth",
      }, warnings),
      eagerDelegation: parseBooleanSetting(merged.eagerDelegation, DEFAULT_TASK_CONTROLS.eagerDelegation, "eagerDelegation", warnings),
      defaultTimeoutMs: parseNumberSetting(merged.defaultTimeoutMs, DEFAULT_TASK_CONTROLS.defaultTimeoutMs, {
        min: SUBAGENT_MIN_TIMEOUT_MS,
        max: 12 * 60 * 60 * 1000,
        field: "defaultTimeoutMs",
      }, warnings),
      outputStrictness: parseStrictnessSetting(merged.outputStrictness, DEFAULT_TASK_CONTROLS.outputStrictness, warnings),
    },
    warnings,
  };
}

export function resolveTaskControls(
  cwd: string,
  options: TaskControlsResolutionOptions = {},
): {
  controls: AgentRouterTaskControls;
  warnings: string[];
} {
  const cacheKey = createTaskControlsCacheKey(cwd, options);
  const cachedResult = taskControlsCache.get(cacheKey);
  if (cachedResult) {
    taskControlsCounters.hits += 1;
    return cloneTaskControlsResult(cachedResult);
  }

  taskControlsCounters.misses += 1;
  const result = buildTaskControlsResult(cwd, options);

  const setResult = taskControlsCache.set(cacheKey, {
    controls: cloneTaskControls(result.controls),
    warnings: [...result.warnings],
  });
  if (setResult.evicted) {
    taskControlsCounters.evictions += 1;
    logTaskControlsCacheEvent("task.controls_cache_evicted", {
      evictedKey: setResult.evicted.key,
    });
  }

  return cloneTaskControlsResult(result);
}

export async function resolveTaskControlsAsync(
  cwd: string,
  options: TaskControlsResolutionOptions = {},
): Promise<{
  controls: AgentRouterTaskControls;
  warnings: string[];
}> {
  const cacheKey = createTaskControlsCacheKey(cwd, options);
  const cachedResult = taskControlsCache.get(cacheKey);
  if (cachedResult) {
    taskControlsCounters.hits += 1;
    return cloneTaskControlsResult(cachedResult);
  }

  const inflightLoad = taskControlsInflightLoads.get(cacheKey);
  if (inflightLoad) {
    return cloneTaskControlsResult(await inflightLoad);
  }

  taskControlsCounters.misses += 1;
  const cacheRevision = taskControlsCacheRevision;

  const loadPromise = (async (): Promise<{ controls: AgentRouterTaskControls; warnings: string[] }> => {
    const result = await buildTaskControlsResultAsync(cwd, options);

    if (cacheRevision === taskControlsCacheRevision) {
      const setResult = taskControlsCache.set(cacheKey, {
        controls: cloneTaskControls(result.controls),
        warnings: [...result.warnings],
      });
      if (setResult.evicted) {
        taskControlsCounters.evictions += 1;
        logTaskControlsCacheEvent("task.controls_cache_evicted", {
          evictedKey: setResult.evicted.key,
        });
      }
    }

    return cloneTaskControlsResult(result);
  })();

  taskControlsInflightLoads.set(cacheKey, loadPromise);

  try {
    return cloneTaskControlsResult(await loadPromise);
  } finally {
    if (taskControlsInflightLoads.get(cacheKey) === loadPromise) {
      taskControlsInflightLoads.delete(cacheKey);
    }
  }
}
