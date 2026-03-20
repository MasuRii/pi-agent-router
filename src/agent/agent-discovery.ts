/**
 * Agent discovery, loading, and parsing utilities.
 *
 * Handles finding and parsing agent definitions from .md files.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { Agent, AgentMode, AgentThinkingLevel, AgentScope } from "../types";
import {
  AGENTS_DIR,
  DEFAULT_PRIMARY_AGENTS,
  DEFAULT_PRIMARY_AGENT_SET,
  PRIMARY_MODE_VALUES,
  VALID_THINKING_LEVELS,
  AGENT_EMOJIS,
} from "../constants";

function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const PROJECT_AGENT_SOURCE_DIRS = [
  [".omp", "agents"],
  [".pi", "agents"],
  [".claude", "agents"],
] as const;

const USER_AGENT_SOURCE_DIRS = [join(homedir(), ".omp", "agents"), AGENTS_DIR, join(homedir(), ".claude", "agents")] as const;

export function normalizeAgentMode(value: string | undefined): AgentMode | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "primary" || normalized === "subagent" || normalized === "all") {
    return normalized;
  }

  return undefined;
}

export function normalizeThinkingLevel(value: string | undefined): AgentThinkingLevel | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "none") {
    return "off";
  }

  if (normalized === "max") {
    return "xhigh";
  }

  if (VALID_THINKING_LEVELS.has(normalized as AgentThinkingLevel)) {
    return normalized as AgentThinkingLevel;
  }

  return undefined;
}

export function parseTemperature(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function normalizeAgentColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const expanded = normalized.match(/^#([0-9a-fA-F]{3})$/)
    ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
    : normalized;

  if (!/^#[0-9a-fA-F]{6}$/.test(expanded)) {
    return undefined;
  }

  return expanded.toUpperCase();
}

export function parseAgent(mdPath: string): Agent | null {
  const raw = readFileSync(mdPath, "utf-8").replace(/\r\n/g, "\n");
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return null;

  const body = raw.slice(end + 4).trim();
  if (!body) return null;

  const fm: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (key) fm[key] = value;
  }

  if (!fm.name) return null;

  const thinkingLevel = normalizeThinkingLevel(
    fm.thinkingLevel || fm.thinking || fm.reasoningLevel || fm.reasoningEffort || fm.reasoningeffort || fm.reasoning,
  );

  return {
    name: fm.name,
    description: fm.description || `Agent ${fm.name}`,
    color: normalizeAgentColor(fm.color),
    model: fm.model || undefined,
    mode: normalizeAgentMode(fm.mode),
    thinkingLevel,
    temperature: parseTemperature(fm.temperature),
    systemPrompt: body,
  };
}

export function loadAgents(): Agent[] {
  return loadAgentsFromDir(AGENTS_DIR);
}

export function loadAgentsFromDir(dirPath: string): Agent[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => parseAgent(join(dirPath, entry.name)))
      .filter((agent): agent is Agent => Boolean(agent))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function findNearestProjectAgentDirs(cwd: string): string[] {
  let currentDir = normalizeInputText(cwd) || process.cwd();

  while (true) {
    const candidates = PROJECT_AGENT_SOURCE_DIRS
      .map((segments) => join(currentDir, ...segments))
      .filter((candidate) => isDirectory(candidate));

    if (candidates.length > 0) {
      return candidates;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return [];
    }

    currentDir = parentDir;
  }
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
  const dirs = findNearestProjectAgentDirs(cwd);
  return dirs[0] ?? null;
}

export function discoverAgents(cwd: string, scope: AgentScope): { agents: Agent[]; projectAgentsDir: string | null } {
  const projectAgentDirs = scope === "user" ? [] : findNearestProjectAgentDirs(cwd);
  const userAgentDirs = scope === "project" ? [] : [...USER_AGENT_SOURCE_DIRS].filter((candidate) => isDirectory(candidate));

  const byName = new Map<string, Agent>();
  const precedenceOrder = [
    ...userAgentDirs.slice().reverse(),
    ...projectAgentDirs.slice().reverse(),
  ];

  for (const sourceDir of precedenceOrder) {
    const agents = loadAgentsFromDir(sourceDir);
    for (const agent of agents) {
      byName.set(agent.name, agent);
    }
  }

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    projectAgentsDir: projectAgentDirs[0] ?? null,
  };
}

export function isPrimaryAgent(agent: Agent): boolean {
  if (agent.mode) {
    return PRIMARY_MODE_VALUES.has(agent.mode);
  }

  return DEFAULT_PRIMARY_AGENT_SET.has(agent.name);
}

export function getPrimaryAgents(agents: Agent[]): Agent[] {
  return agents.filter((agent) => isPrimaryAgent(agent));
}

export function getCyclablePrimaryAgents(agents: Agent[]): string[] {
  const primaryNames = new Set(getPrimaryAgents(agents).map((agent) => agent.name));
  const orderedDefaults = DEFAULT_PRIMARY_AGENTS.filter((name) => primaryNames.has(name));
  const extras = [...primaryNames].filter((name) => !DEFAULT_PRIMARY_AGENT_SET.has(name));
  return [...orderedDefaults, ...extras.sort((a, b) => a.localeCompare(b))];
}

export function getAgentEmoji(name: string): string {
  return AGENT_EMOJIS[name] || "🤖";
}

export function getPersistedActiveAgentName(ctx: ExtensionContext): string | null | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== "active_agent") continue;

    const data = entry.data as { name?: unknown } | undefined;
    if (typeof data?.name === "string") return data.name;
    if (data?.name === null) return null;
    return null;
  }
  return undefined;
}
