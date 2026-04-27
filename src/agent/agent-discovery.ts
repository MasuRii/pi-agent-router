/**
 * Agent discovery, loading, and parsing utilities.
 *
 * Handles finding and parsing agent definitions from .md files.
 */

import { readFileSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { createBoundedCache } from "../cache/bounded-cache";
import { mapWithAbortAwareConcurrency } from "../task/parallel-control";
import {
  AGENT_DIR,
  AGENTS_DIR,
  AGENT_DISCOVERY_CACHE_MAX_ENTRIES,
  PRIMARY_MODE_VALUES,
  VALID_THINKING_LEVELS,
} from "../constants";
import { loadPiAgentRouterConfig } from "../config";
import type { AgentDiscoveryConfig } from "../config";
import { piAgentRouterDebugLogger } from "../debug-logger";
import { normalizeInputText } from "../input-normalization";
import { isDirectory, isDirectoryAsync } from "../subagent/session-paths";
import type {
  Agent,
  AgentDiscoveryCacheSnapshot,
  AgentMode,
  AgentThinkingLevel,
  AgentScope,
  CacheDebugCounters,
} from "../types";


export const AGENT_MARKDOWN_PARSE_CONCURRENCY = 8;

type AgentDiscoveryConfigSlices = {
  agentDiscovery: AgentDiscoveryConfig;
  primaryAgents: readonly string[];
  primaryAgentSet: ReadonlySet<string>;
  agentEmojis: Readonly<Record<string, string>>;
};

let cachedAgentDiscoveryConfigSlices: AgentDiscoveryConfigSlices | undefined;

function getConfiguredAgentDiscoverySlices(): AgentDiscoveryConfigSlices {
  if (cachedAgentDiscoveryConfigSlices) {
    return cachedAgentDiscoveryConfigSlices;
  }

  const config = loadPiAgentRouterConfig().config;
  cachedAgentDiscoveryConfigSlices = {
    agentDiscovery: {
      projectSourceDirs: [...config.agentDiscovery.projectSourceDirs],
      userSourceDirs: [...config.agentDiscovery.userSourceDirs],
    },
    primaryAgents: [...config.primaryAgents],
    primaryAgentSet: new Set(config.primaryAgents),
    agentEmojis: { ...config.agentEmojis },
  };
  return cachedAgentDiscoveryConfigSlices;
}

function resetConfiguredAgentDiscoverySlices(): void {
  cachedAgentDiscoveryConfigSlices = undefined;
}

function getConfiguredAgentDiscovery(): AgentDiscoveryConfig {
  return getConfiguredAgentDiscoverySlices().agentDiscovery;
}

function stripLeadingPathSeparators(value: string): string {
  return value.replace(/^[\\/]+/, "");
}

function resolveConfiguredUserPath(rawPath: string): string {
  const normalizedPath = normalizeInputText(rawPath);
  if (!normalizedPath) {
    return resolve(AGENTS_DIR);
  }

  if (normalizedPath === "~") {
    return homedir();
  }

  if (normalizedPath.startsWith("~/") || normalizedPath.startsWith("~\\")) {
    return join(homedir(), stripLeadingPathSeparators(normalizedPath.slice(1)));
  }

  if (normalizedPath === "{home}") {
    return homedir();
  }

  if (normalizedPath.startsWith("{home}/") || normalizedPath.startsWith("{home}\\")) {
    return join(homedir(), stripLeadingPathSeparators(normalizedPath.slice("{home}".length)));
  }

  if (normalizedPath === "{agentDir}") {
    return AGENT_DIR;
  }

  if (normalizedPath.startsWith("{agentDir}/") || normalizedPath.startsWith("{agentDir}\\")) {
    return join(AGENT_DIR, stripLeadingPathSeparators(normalizedPath.slice("{agentDir}".length)));
  }

  return resolve(normalizedPath);
}

function getConfiguredUserAgentSourceDirs(): string[] {
  return getConfiguredAgentDiscovery().userSourceDirs.map((sourceDir) =>
    resolveConfiguredUserPath(sourceDir),
  );
}

const agentDirectoryCache = createBoundedCache<string, Agent[]>(AGENT_DISCOVERY_CACHE_MAX_ENTRIES);
const agentDiscoveryCache = createBoundedCache<string, { agents: Agent[]; projectAgentsDir: string | null }>(
  AGENT_DISCOVERY_CACHE_MAX_ENTRIES,
);
const agentDirectoryInflightLoads = new Map<string, Promise<Agent[]>>();
const agentDiscoveryInflightLoads = new Map<string, Promise<{ agents: Agent[]; projectAgentsDir: string | null }>>();

const agentDirectoryCounters: Omit<CacheDebugCounters, "size" | "maxEntries"> = {
  hits: 0,
  misses: 0,
  invalidations: 0,
  evictions: 0,
};

const agentDiscoveryCounters: Omit<CacheDebugCounters, "size" | "maxEntries"> = {
  hits: 0,
  misses: 0,
  invalidations: 0,
  evictions: 0,
};

let agentDiscoveryCacheRevision = 0;

function cloneAgent(agent: Agent): Agent {
  return { ...agent };
}

function cloneAgents(agents: readonly Agent[]): Agent[] {
  return agents.map((agent) => cloneAgent(agent));
}

function getAgentDirectoryCacheCounters(): CacheDebugCounters {
  return {
    ...agentDirectoryCounters,
    size: agentDirectoryCache.size(),
    maxEntries: AGENT_DISCOVERY_CACHE_MAX_ENTRIES,
  };
}

function getAgentDiscoveryCounters(): CacheDebugCounters {
  return {
    ...agentDiscoveryCounters,
    size: agentDiscoveryCache.size(),
    maxEntries: AGENT_DISCOVERY_CACHE_MAX_ENTRIES,
  };
}

function logAgentDiscoveryCacheEvent(event: string, payload: Record<string, unknown> = {}): void {
  void piAgentRouterDebugLogger.info(event, {
    ...payload,
    cache: getAgentDiscoveryCacheSnapshot(),
  });
}

function normalizeDirectoryCacheKey(dirPath: string): string {
  const normalizedDirPath = normalizeInputText(dirPath);
  if (!normalizedDirPath) {
    return resolve(AGENTS_DIR);
  }

  return resolve(normalizedDirPath);
}

function createDiscoveryCacheKey(cwd: string, scope: AgentScope): string {
  const normalizedCwd = normalizeInputText(cwd) || process.cwd();
  return `${scope}\u0000${resolve(normalizedCwd)}`;
}

function parseAgentContent(rawContent: string): Agent | null {
  const raw = rawContent.replace(/\r\n/g, "\n");
  if (!raw.startsWith("---\n")) {
    return null;
  }

  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return null;
  }

  const body = raw.slice(end + 4).trim();
  if (!body) {
    return null;
  }

  const fm: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (key) {
      fm[key] = value;
    }
  }

  if (!fm.name) {
    return null;
  }

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

export function getAgentDiscoveryCacheSnapshot(): AgentDiscoveryCacheSnapshot {
  return {
    directory: getAgentDirectoryCacheCounters(),
    discovery: getAgentDiscoveryCounters(),
  };
}

export function invalidateAgentDiscoveryCaches(): void {
  const removedDirectoryEntries = agentDirectoryCache.size();
  const removedDiscoveryEntries = agentDiscoveryCache.size();

  agentDiscoveryCacheRevision += 1;
  resetConfiguredAgentDiscoverySlices();
  agentDirectoryCache.clear();
  agentDiscoveryCache.clear();
  agentDirectoryInflightLoads.clear();
  agentDiscoveryInflightLoads.clear();
  agentDirectoryCounters.invalidations += removedDirectoryEntries;
  agentDiscoveryCounters.invalidations += removedDiscoveryEntries;

  if (removedDirectoryEntries > 0 || removedDiscoveryEntries > 0) {
    logAgentDiscoveryCacheEvent("agent.discovery_cache_invalidated", {
      removedDirectoryEntries,
      removedDiscoveryEntries,
    });
  }
}

export function resetAgentDiscoveryCacheState(): void {
  agentDiscoveryCacheRevision += 1;
  resetConfiguredAgentDiscoverySlices();
  agentDirectoryCache.clear();
  agentDiscoveryCache.clear();
  agentDirectoryInflightLoads.clear();
  agentDiscoveryInflightLoads.clear();
  agentDirectoryCounters.hits = 0;
  agentDirectoryCounters.misses = 0;
  agentDirectoryCounters.invalidations = 0;
  agentDirectoryCounters.evictions = 0;
  agentDiscoveryCounters.hits = 0;
  agentDiscoveryCounters.misses = 0;
  agentDiscoveryCounters.invalidations = 0;
  agentDiscoveryCounters.evictions = 0;
}

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
  return parseAgentContent(readFileSync(mdPath, "utf-8"));
}

export async function parseAgentAsync(mdPath: string): Promise<Agent | null> {
  const raw = await readFile(mdPath, "utf-8");
  return parseAgentContent(raw);
}

export function loadAgents(options?: { cwd?: string; scope?: AgentScope }): Agent[] {
  const scope = options?.scope ?? "user";
  if (scope !== "user" || options?.cwd) {
    const cwd = options?.cwd ?? process.cwd();
    return discoverAgents(cwd, scope).agents;
  }

  return loadAgentsFromDir(AGENTS_DIR);
}

export async function loadAgentsAsync(options?: {
  cwd?: string;
  scope?: AgentScope;
}): Promise<Agent[]> {
  const scope = options?.scope ?? "user";
  if (scope !== "user" || options?.cwd) {
    const cwd = options?.cwd ?? process.cwd();
    return (await discoverAgentsAsync(cwd, scope)).agents;
  }

  return loadAgentsFromDirAsync(AGENTS_DIR);
}

export function loadAgentsFromDir(dirPath: string): Agent[] {
  const cacheKey = normalizeDirectoryCacheKey(dirPath);
  const cachedAgents = agentDirectoryCache.get(cacheKey);
  if (cachedAgents) {
    agentDirectoryCounters.hits += 1;
    return cloneAgents(cachedAgents);
  }

  agentDirectoryCounters.misses += 1;

  const agents = (() => {
    try {
      return readdirSync(cacheKey, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => parseAgent(join(cacheKey, entry.name)))
        .filter((agent): agent is Agent => Boolean(agent))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  })();

  const setResult = agentDirectoryCache.set(cacheKey, cloneAgents(agents));
  if (setResult.evicted) {
    agentDirectoryCounters.evictions += 1;
    logAgentDiscoveryCacheEvent("agent.directory_cache_evicted", {
      evictedDirectory: setResult.evicted.key,
    });
  }

  return cloneAgents(agents);
}

export async function loadAgentsFromDirAsync(dirPath: string): Promise<Agent[]> {
  const cacheKey = normalizeDirectoryCacheKey(dirPath);
  const cachedAgents = agentDirectoryCache.get(cacheKey);
  if (cachedAgents) {
    agentDirectoryCounters.hits += 1;
    return cloneAgents(cachedAgents);
  }

  const inflightLoad = agentDirectoryInflightLoads.get(cacheKey);
  if (inflightLoad) {
    return cloneAgents(await inflightLoad);
  }

  agentDirectoryCounters.misses += 1;
  const cacheRevision = agentDiscoveryCacheRevision;

  const loadPromise = (async (): Promise<Agent[]> => {
    try {
      const entries = await readdir(cacheKey, { withFileTypes: true });
      const markdownEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
      const parseResult = await mapWithAbortAwareConcurrency({
        items: markdownEntries,
        concurrency: AGENT_MARKDOWN_PARSE_CONCURRENCY,
        worker: (entry) => parseAgentAsync(join(cacheKey, entry.name)),
      });
      if (parseResult.control.firstError) {
        throw parseResult.control.firstError;
      }

      const parsedAgents = parseResult.results;
      const agents = parsedAgents
        .filter((agent): agent is Agent => Boolean(agent))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (cacheRevision === agentDiscoveryCacheRevision) {
        const setResult = agentDirectoryCache.set(cacheKey, cloneAgents(agents));
        if (setResult.evicted) {
          agentDirectoryCounters.evictions += 1;
          logAgentDiscoveryCacheEvent("agent.directory_cache_evicted", {
            evictedDirectory: setResult.evicted.key,
          });
        }
      }

      return cloneAgents(agents);
    } catch {
      if (cacheRevision === agentDiscoveryCacheRevision) {
        const setResult = agentDirectoryCache.set(cacheKey, []);
        if (setResult.evicted) {
          agentDirectoryCounters.evictions += 1;
          logAgentDiscoveryCacheEvent("agent.directory_cache_evicted", {
            evictedDirectory: setResult.evicted.key,
          });
        }
      }

      return [];
    }
  })();

  agentDirectoryInflightLoads.set(cacheKey, loadPromise);

  try {
    return cloneAgents(await loadPromise);
  } finally {
    if (agentDirectoryInflightLoads.get(cacheKey) === loadPromise) {
      agentDirectoryInflightLoads.delete(cacheKey);
    }
  }
}

function findNearestProjectAgentDirs(cwd: string): string[] {
  let currentDir = resolve(normalizeInputText(cwd) || process.cwd());
  const projectSourceDirs = getConfiguredAgentDiscovery().projectSourceDirs;

  while (true) {
    const candidates = projectSourceDirs
      .map((sourceDir) => resolve(currentDir, sourceDir))
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

async function findNearestProjectAgentDirsAsync(cwd: string): Promise<string[]> {
  let currentDir = resolve(normalizeInputText(cwd) || process.cwd());
  const projectSourceDirs = getConfiguredAgentDiscovery().projectSourceDirs;

  while (true) {
    const candidateResults = await Promise.all(
      projectSourceDirs.map(async (sourceDir) => {
        const candidate = resolve(currentDir, sourceDir);
        return (await isDirectoryAsync(candidate)) ? candidate : null;
      }),
    );
    const candidates = candidateResults.filter((candidate): candidate is string => Boolean(candidate));

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

export async function findNearestProjectAgentsDirAsync(cwd: string): Promise<string | null> {
  const dirs = await findNearestProjectAgentDirsAsync(cwd);
  return dirs[0] ?? null;
}

export function discoverAgents(cwd: string, scope: AgentScope): { agents: Agent[]; projectAgentsDir: string | null } {
  const cacheKey = createDiscoveryCacheKey(cwd, scope);
  const cachedResult = agentDiscoveryCache.get(cacheKey);
  if (cachedResult) {
    agentDiscoveryCounters.hits += 1;
    return {
      agents: cloneAgents(cachedResult.agents),
      projectAgentsDir: cachedResult.projectAgentsDir,
    };
  }

  agentDiscoveryCounters.misses += 1;

  const projectAgentDirs = scope === "user" ? [] : findNearestProjectAgentDirs(cwd);
  const userAgentDirs = scope === "project" ? [] : getConfiguredUserAgentSourceDirs().filter((candidate) => isDirectory(candidate));

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

  const result = {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    projectAgentsDir: projectAgentDirs[0] ?? null,
  };

  const setResult = agentDiscoveryCache.set(cacheKey, {
    agents: cloneAgents(result.agents),
    projectAgentsDir: result.projectAgentsDir,
  });
  if (setResult.evicted) {
    agentDiscoveryCounters.evictions += 1;
    logAgentDiscoveryCacheEvent("agent.discovery_cache_evicted", {
      evictedKey: setResult.evicted.key,
    });
  }

  return {
    agents: cloneAgents(result.agents),
    projectAgentsDir: result.projectAgentsDir,
  };
}

export async function discoverAgentsAsync(
  cwd: string,
  scope: AgentScope,
): Promise<{ agents: Agent[]; projectAgentsDir: string | null }> {
  const cacheKey = createDiscoveryCacheKey(cwd, scope);
  const cachedResult = agentDiscoveryCache.get(cacheKey);
  if (cachedResult) {
    agentDiscoveryCounters.hits += 1;
    return {
      agents: cloneAgents(cachedResult.agents),
      projectAgentsDir: cachedResult.projectAgentsDir,
    };
  }

  const inflightLoad = agentDiscoveryInflightLoads.get(cacheKey);
  if (inflightLoad) {
    const result = await inflightLoad;
    return {
      agents: cloneAgents(result.agents),
      projectAgentsDir: result.projectAgentsDir,
    };
  }

  agentDiscoveryCounters.misses += 1;
  const cacheRevision = agentDiscoveryCacheRevision;

  const loadPromise = (async (): Promise<{ agents: Agent[]; projectAgentsDir: string | null }> => {
    const projectAgentDirs = scope === "user" ? [] : await findNearestProjectAgentDirsAsync(cwd);
    const userAgentDirs = scope === "project"
      ? []
      : (
          await Promise.all(
            getConfiguredUserAgentSourceDirs().map(async (candidate) => ((await isDirectoryAsync(candidate)) ? candidate : null)),
          )
        ).filter((candidate): candidate is string => Boolean(candidate));

    const byName = new Map<string, Agent>();
    const precedenceOrder = [
      ...userAgentDirs.slice().reverse(),
      ...projectAgentDirs.slice().reverse(),
    ];

    for (const sourceDir of precedenceOrder) {
      const agents = await loadAgentsFromDirAsync(sourceDir);
      for (const agent of agents) {
        byName.set(agent.name, agent);
      }
    }

    const result = {
      agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      projectAgentsDir: projectAgentDirs[0] ?? null,
    };

    if (cacheRevision === agentDiscoveryCacheRevision) {
      const setResult = agentDiscoveryCache.set(cacheKey, {
        agents: cloneAgents(result.agents),
        projectAgentsDir: result.projectAgentsDir,
      });
      if (setResult.evicted) {
        agentDiscoveryCounters.evictions += 1;
        logAgentDiscoveryCacheEvent("agent.discovery_cache_evicted", {
          evictedKey: setResult.evicted.key,
        });
      }
    }

    return {
      agents: cloneAgents(result.agents),
      projectAgentsDir: result.projectAgentsDir,
    };
  })();

  agentDiscoveryInflightLoads.set(cacheKey, loadPromise);

  try {
    const result = await loadPromise;
    return {
      agents: cloneAgents(result.agents),
      projectAgentsDir: result.projectAgentsDir,
    };
  } finally {
    if (agentDiscoveryInflightLoads.get(cacheKey) === loadPromise) {
      agentDiscoveryInflightLoads.delete(cacheKey);
    }
  }
}

function isPrimaryAgentWithConfig(agent: Agent, configuredPrimaryAgentSet: ReadonlySet<string>): boolean {
  if (agent.mode) {
    return PRIMARY_MODE_VALUES.has(agent.mode);
  }

  return configuredPrimaryAgentSet.has(agent.name);
}

export function isPrimaryAgent(agent: Agent): boolean {
  return isPrimaryAgentWithConfig(
    agent,
    getConfiguredAgentDiscoverySlices().primaryAgentSet,
  );
}

export function getPrimaryAgents(agents: Agent[]): Agent[] {
  const configuredPrimaryAgentSet = getConfiguredAgentDiscoverySlices().primaryAgentSet;
  return agents.filter((agent) => isPrimaryAgentWithConfig(agent, configuredPrimaryAgentSet));
}

export function getCyclablePrimaryAgents(agents: Agent[]): string[] {
  const configuredSlices = getConfiguredAgentDiscoverySlices();
  const configuredPrimaryAgents = configuredSlices.primaryAgents;
  const configuredPrimaryAgentSet = configuredSlices.primaryAgentSet;
  const primaryNames = new Set(
    agents
      .filter((agent) => isPrimaryAgentWithConfig(agent, configuredPrimaryAgentSet))
      .map((agent) => agent.name),
  );
  const orderedDefaults = configuredPrimaryAgents.filter((name) => primaryNames.has(name));
  const extras = [...primaryNames].filter((name) => !configuredPrimaryAgentSet.has(name));
  return [...orderedDefaults, ...extras.sort((a, b) => a.localeCompare(b))];
}

export function getAgentEmoji(name: string): string {
  return getConfiguredAgentDiscoverySlices().agentEmojis[name] || "🤖";
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
