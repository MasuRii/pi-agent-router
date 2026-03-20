import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  AGENT_DIR,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_MAX_CONCURRENCY,
  SUBAGENT_MIN_TIMEOUT_MS,
} from "../constants";
import type { OutputContractStrictness } from "../output-contract";

export type AgentRouterTaskControls = {
  maxConcurrency: number;
  maxRecursionDepth: number;
  eagerDelegation: boolean;
  defaultTimeoutMs: number;
  outputStrictness: OutputContractStrictness;
};

const DEFAULT_TASK_CONTROLS: AgentRouterTaskControls = {
  maxConcurrency: SUBAGENT_MAX_CONCURRENCY,
  maxRecursionDepth: 3,
  eagerDelegation: false,
  defaultTimeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
  outputStrictness: "compat",
};

function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
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

export function resolveTaskControls(cwd: string): {
  controls: AgentRouterTaskControls;
  warnings: string[];
} {
  const warnings: string[] = [];

  const globalSettingsPath = join(AGENT_DIR, "settings.json");
  const projectSettingsPath = findNearestProjectSettingsPath(cwd);

  const globalTaskSettings = pickTaskSettings(readJsonFile(globalSettingsPath));
  const projectTaskSettings = pickTaskSettings(projectSettingsPath ? readJsonFile(projectSettingsPath) : undefined);

  const merged: Record<string, unknown> = {
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

  const controls: AgentRouterTaskControls = {
    maxConcurrency: parseNumberSetting(merged.maxConcurrency, DEFAULT_TASK_CONTROLS.maxConcurrency, {
      min: 1,
      max: 16,
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
  };

  return { controls, warnings };
}
