import { appendFileSync } from "node:fs";

import {
  CONFIG_PATH,
  DEBUG_DIR,
  DEBUG_LOG_PATH,
  PI_AGENT_ROUTER_EXTENSION_ID,
  ensurePiAgentRouterDebugDirectory,
  loadPiAgentRouterConfig,
} from "./config";

type PiAgentRouterDebugLogLevel = "info" | "warn";

export interface PiAgentRouterDebugLoggerOptions {
  configPath?: string;
  debugDir?: string;
  logPath?: string;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }
      seen.add(currentValue);
    }

    return currentValue;
  });
}

export class PiAgentRouterDebugLogger {
  private initialized = false;
  private enabled = false;

  constructor(private readonly options: PiAgentRouterDebugLoggerOptions = {}) {}

  private initialize(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    const configResult = loadPiAgentRouterConfig(this.options.configPath ?? CONFIG_PATH);
    this.enabled = configResult.config.debug;
  }

  private write(
    level: PiAgentRouterDebugLogLevel,
    event: string,
    payload: Record<string, unknown> = {},
  ): string | undefined {
    try {
      this.initialize();
      if (!this.enabled) {
        return undefined;
      }

      const debugDirectoryError = ensurePiAgentRouterDebugDirectory(
        this.options.debugDir ?? DEBUG_DIR,
      );
      if (debugDirectoryError) {
        return debugDirectoryError;
      }

      const logPath = this.options.logPath ?? DEBUG_LOG_PATH;
      const line = safeJsonStringify({
        timestamp: new Date().toISOString(),
        level,
        extension: PI_AGENT_ROUTER_EXTENSION_ID,
        event,
        ...payload,
      });
      appendFileSync(logPath, `${line}\n`, "utf-8");
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write pi-agent-router ${level} debug log '${this.options.logPath ?? DEBUG_LOG_PATH}': ${message}`;
    }
  }

  info(event: string, payload: Record<string, unknown> = {}): string | undefined {
    return this.write("info", event, payload);
  }

  warn(event: string, payload: Record<string, unknown> = {}): string | undefined {
    return this.write("warn", event, payload);
  }
}

export const piAgentRouterDebugLogger = new PiAgentRouterDebugLogger();
