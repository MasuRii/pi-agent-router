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

const SENSITIVE_KEY_PATTERN = /api[_-]?key|authorization|access|refresh|id[_-]?token|token|secret|password|client[_-]?secret|credential|code[_-]?verifier|verifier|state|^code$|key$/i;
const TOKEN_QUERY_PARAM = /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|client_secret|code|state|code_verifier|verifier)=)[^&#\s]+/gi;
const AUTHORIZATION_VALUE = /\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi;
const BEARER_VALUE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_LIKE_VALUE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g;
const TOKEN_ASSIGNMENT = /\b((?:access|refresh|id)[_-]?token|api[_-]?key|apikey|client[_-]?secret|token|code[_-]?verifier|verifier|state|code)\s*[:=]\s*["']?[^"'\s&,;]+/gi;

export interface PiAgentRouterDebugLoggerOptions {
  configPath?: string;
  debugDir?: string;
  logPath?: string;
}

function redactSensitiveString(value: string): string {
  return value
    .replace(TOKEN_QUERY_PARAM, "$1[REDACTED]")
    .replace(AUTHORIZATION_VALUE, "$1[REDACTED]")
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(TOKEN_ASSIGNMENT, "$1=[REDACTED]")
    .replace(JWT_LIKE_VALUE, "[REDACTED]");
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, currentValue) => {
    if (key !== "" && SENSITIVE_KEY_PATTERN.test(key)) {
      return "[REDACTED]";
    }

    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: redactSensitiveString(currentValue.message),
        stack: currentValue.stack ? redactSensitiveString(currentValue.stack) : undefined,
        cause: currentValue.cause,
      };
    }

    if (typeof currentValue === "string") {
      return redactSensitiveString(currentValue);
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
      createDroppedWriteFailuresLine: (metadata) =>
        `${safeJsonStringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          extension: PI_AGENT_ROUTER_EXTENSION_ID,
          event: "debug_log_write_failures_dropped",
          ...metadata,
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

  dispose(): Promise<void> {
    return this.writer.dispose();
  }
}

export const piAgentRouterDebugLogger = new PiAgentRouterDebugLogger();
