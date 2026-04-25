/**
 * Constants and configuration values for pi-agent-router extension.
 */

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";

import type { AgentMode, AgentThinkingLevel } from "./types";

export const AGENT_DIR = getAgentDir();
export const AGENTS_DIR = join(AGENT_DIR, "agents");
export const SESSIONS_DIR = join(AGENT_DIR, "sessions");
export const SUBAGENT_SESSIONS_DIR = join(AGENT_DIR, "subagent-sessions");

export const DEFAULT_AGENT = "orchestrator";
export const DEFAULT_PRIMARY_AGENTS = ["code", "ask", "debug", "architect", "orchestrator"] as const;
export const DEFAULT_PRIMARY_AGENT_SET = new Set<string>(DEFAULT_PRIMARY_AGENTS);
export const PRIMARY_MODE_VALUES = new Set<AgentMode>(["primary", "all"]);
export const VALID_THINKING_LEVELS = new Set<AgentThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const AGENT_EMOJIS: Record<string, string> = {
  code: "💻",
  ask: "❓",
  debug: "🐛",
  architect: "🏗️",
  orchestrator: "🎯",
};

export const AGENT_DISCOVERY_CACHE_MAX_ENTRIES = 64;
export const TASK_CONTROLS_CACHE_MAX_ENTRIES = 64;
export const SUBAGENT_SESSION_RETENTION_MAX_COMPLETED = 64;

export const SUBAGENT_WIDGET_KEY = "subagent-background-sessions";
export const SUBAGENT_WIDGET_ACTIVE_RENDER_INTERVAL_MS = 1_000;
export const FINISHED_SUBAGENT_TTL_MS = 30 * 60 * 1000;
export const SUBAGENT_TASK_REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;
export const SUBAGENT_HARD_KILL_DELAY_MS = 5_000;
export const SUBAGENT_MAX_CONCURRENCY = 4;
export const SUBAGENT_MIN_TIMEOUT_MS = 30 * 60 * 1000;
export const SUBAGENT_DEFAULT_TIMEOUT_MS = SUBAGENT_MIN_TIMEOUT_MS;
export const SUBAGENT_PARSED_MESSAGE_MAX_COUNT = 128;
export const SUBAGENT_PARSED_MESSAGE_MAX_CHARS = 256 * 1024;
export const SUBAGENT_TOOL_INVOCATION_MAX_ENTRIES = 256;
export const SUBAGENT_TOOL_ARGUMENT_PREVIEW_MAX_CHARS = 240;
export const SUBAGENT_TOOL_NAME_MAX_CHARS = 80;
export const SUBAGENT_STDOUT_CAPTURE_MAX_CHARS = 2 * 1024 * 1024;
export const SUBAGENT_DERIVED_OUTPUT_MAX_CHARS = 256 * 1024;
export const SUBAGENT_STDERR_CAPTURE_MAX_CHARS = 512 * 1024;
export const SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS = 4 * 1024 * 1024;
export const TASK_HISTORY_EXCERPT_MAX_CHARS = 1024 * 1024;
export const TASK_HISTORY_SUMMARY_MAX_CHARS = 320;
export const LINUX_TAB_CYCLE_DEBOUNCE_MS = 180;

export const INLINE_OPEN_BOX_TARGET_WIDTH = 118;
