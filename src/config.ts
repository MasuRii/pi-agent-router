import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getErrorMessage } from "./error-utils";

export const PI_AGENT_ROUTER_EXTENSION_ID = "pi-agent-router";

export interface PiAgentRouterConfig {
  debug: boolean;
}

export interface PiAgentRouterConfigLoadResult {
  config: PiAgentRouterConfig;
  created: boolean;
  warning?: string;
}

export const DEFAULT_PI_AGENT_ROUTER_CONFIG: PiAgentRouterConfig = {
  debug: false,
};

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const CONFIG_PATH = join(EXTENSION_ROOT, "config.json");
export const DEBUG_DIR = join(EXTENSION_ROOT, "debug");
export const DEBUG_LOG_PATH = join(DEBUG_DIR, `${PI_AGENT_ROUTER_EXTENSION_ID}-debug.jsonl`);

function cloneDefaultConfig(): PiAgentRouterConfig {
  return {
    debug: DEFAULT_PI_AGENT_ROUTER_CONFIG.debug,
  };
}

function createDefaultConfigContent(): string {
  return `${JSON.stringify(DEFAULT_PI_AGENT_ROUTER_CONFIG, null, 2)}\n`;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function normalizeConfig(raw: unknown): PiAgentRouterConfig {
  const record = toRecord(raw);
  return {
    debug: record.debug === true,
  };
}

function ensureConfigDirectory(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
}

export function ensurePiAgentRouterConfig(
  configPath = CONFIG_PATH,
): { created: boolean; warning?: string } {
  if (existsSync(configPath)) {
    return { created: false };
  }

  try {
    ensureConfigDirectory(configPath);
    writeFileSync(configPath, createDefaultConfigContent(), "utf-8");
    return { created: true };
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      created: false,
      warning: `Failed to initialize pi-agent-router config at '${configPath}': ${message}`,
    };
  }
}

export function loadPiAgentRouterConfig(configPath = CONFIG_PATH): PiAgentRouterConfigLoadResult {
  const ensureResult = ensurePiAgentRouterConfig(configPath);

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return {
      config: normalizeConfig(parsed),
      created: ensureResult.created,
      warning: ensureResult.warning,
    };
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      config: cloneDefaultConfig(),
      created: ensureResult.created,
      warning:
        ensureResult.warning ?? `Failed to read pi-agent-router config at '${configPath}': ${message}`,
    };
  }
}

export function ensurePiAgentRouterDebugDirectory(debugDir = DEBUG_DIR): string | undefined {
  try {
    mkdirSync(debugDir, { recursive: true });
    return undefined;
  } catch (error) {
    const message = getErrorMessage(error);
    return `Failed to create pi-agent-router debug directory '${debugDir}': ${message}`;
  }
}
