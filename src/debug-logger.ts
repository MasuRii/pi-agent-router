import { AsyncBufferedLogWriter } from "./async-buffered-log-writer";

import { getErrorMessage } from "./error-utils";

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
  private readonly writer: AsyncBufferedLogWriter;

  constructor(private readonly options: PiAgentRouterDebugLoggerOptions = {}) {
    this.writer = new AsyncBufferedLogWriter({
      enabled: false,
      logPath: this.options.logPath ?? DEBUG_LOG_PATH,
      ensureDirectory: () =>
        ensurePiAgentRouterDebugDirectory(this.options.debugDir ?? DEBUG_DIR),
      createDroppedEntriesLine: (droppedEntries) =>
        `${safeJsonStringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          extension: PI_AGENT_ROUTER_EXTENSION_ID,
          event: "debug_log_overflow",
          droppedEntries,
        })}\n`,
    });
  }

  private initialize(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    const configResult = loadPiAgentRouterConfig(this.options.configPath ?? CONFIG_PATH);
    this.writer.setEnabled(configResult.config.debug);
  }

  private write(
    level: PiAgentRouterDebugLogLevel,
    event: string,
    payload: Record<string, unknown> = {},
  ): string | undefined {
    try {
      this.initialize();
      return this.writer.writeLine(
        `${safeJsonStringify({
          timestamp: new Date().toISOString(),
          level,
          extension: PI_AGENT_ROUTER_EXTENSION_ID,
          event,
          ...payload,
        })}\n`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      return `Failed to buffer pi-agent-router ${level} debug log '${this.options.logPath ?? DEBUG_LOG_PATH}': ${message}`;
    }
  }

  info(event: string, payload: Record<string, unknown> = {}): string | undefined {
    return this.write("info", event, payload);
  }

  warn(event: string, payload: Record<string, unknown> = {}): string | undefined {
    return this.write("warn", event, payload);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}

export const piAgentRouterDebugLogger = new PiAgentRouterDebugLogger();
