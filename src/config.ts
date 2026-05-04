import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_EMOJIS,
  DEFAULT_PRIMARY_AGENTS,
  SUBAGENT_DEFAULT_MAX_CONCURRENCY,
  SUBAGENT_MAX_CONFIGURABLE_CONCURRENCY,
  SUBAGENT_MIN_CONCURRENCY,
} from "./constants";
import { getErrorMessage } from "./error-utils";
import { asRecord } from "./record-utils";

export const PI_AGENT_ROUTER_EXTENSION_ID = "pi-agent-router";

export type SubagentWidgetIconConfigMode = "auto" | "nerd" | "fallback";

export interface AgentDiscoveryConfig {
  projectSourceDirs: string[];
  userSourceDirs: string[];
}

export type DelegatedExtensionSkipCondition = "directEnvAuthAvailable";

export interface DelegatedExtensionConfigEntry {
  candidates: string[];
  skipWhen: DelegatedExtensionSkipCondition[];
  optional: boolean;
}

export type DelegatedExtensionsConfig = DelegatedExtensionConfigEntry[];

export type CredentialFallbackPolicy = "parent-env" | "distributed-only";

export interface PiAgentRouterConfig {
  debug: boolean;
  maxParallelDelegationConcurrency: number;
  agentDiscovery: AgentDiscoveryConfig;
  delegatedExtensions: DelegatedExtensionsConfig;
  providerEnvKeys: Record<string, string>;
  directEnvDelegationProviderIds: string[];
  providerCredentialFallbackPolicies: Record<string, CredentialFallbackPolicy>;
  copilotInitiatorTargetApis: string[];
  primaryAgents: string[];
  agentEmojis: Record<string, string>;
  subagentWidgetIconMode: SubagentWidgetIconConfigMode;
}

export interface PiAgentRouterConfigLoadResult {
  config: PiAgentRouterConfig;
  created: boolean;
  warning?: string;
}

const DEFAULT_AGENT_DISCOVERY_CONFIG: AgentDiscoveryConfig = {
  projectSourceDirs: [".omp/agents", ".pi/agents", ".claude/agents"],
  userSourceDirs: ["{home}/.omp/agents", "{agentDir}/agents", "{home}/.claude/agents"],
};

const DEFAULT_DELEGATED_EXTENSION_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {};

const VALID_DELEGATED_EXTENSION_SKIP_CONDITIONS: ReadonlySet<DelegatedExtensionSkipCondition> =
  new Set(["directEnvAuthAvailable"]);

const DEFAULT_DELEGATED_EXTENSIONS_CONFIG: DelegatedExtensionsConfig = [];

const DEFAULT_PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
};

const DEFAULT_DIRECT_ENV_DELEGATION_PROVIDER_IDS = [
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "xai",
  "zai",
];

const DEFAULT_PROVIDER_CREDENTIAL_FALLBACK_POLICIES: Record<string, CredentialFallbackPolicy> = {
  "openai-codex": "distributed-only",
};

const DEFAULT_COPILOT_INITIATOR_TARGET_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

export const DEFAULT_PI_AGENT_ROUTER_CONFIG: PiAgentRouterConfig = {
  debug: false,
  maxParallelDelegationConcurrency: SUBAGENT_DEFAULT_MAX_CONCURRENCY,
  agentDiscovery: DEFAULT_AGENT_DISCOVERY_CONFIG,
  delegatedExtensions: DEFAULT_DELEGATED_EXTENSIONS_CONFIG,
  providerEnvKeys: DEFAULT_PROVIDER_ENV_KEYS,
  directEnvDelegationProviderIds: DEFAULT_DIRECT_ENV_DELEGATION_PROVIDER_IDS,
  providerCredentialFallbackPolicies: DEFAULT_PROVIDER_CREDENTIAL_FALLBACK_POLICIES,
  copilotInitiatorTargetApis: DEFAULT_COPILOT_INITIATOR_TARGET_APIS,
  primaryAgents: [...DEFAULT_PRIMARY_AGENTS],
  agentEmojis: AGENT_EMOJIS,
  subagentWidgetIconMode: "auto",
};

export function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();
export const CONFIG_PATH = join(EXTENSION_ROOT, "config.json");
export const DEBUG_DIR = join(EXTENSION_ROOT, "debug");
export const DEBUG_LOG_PATH = join(DEBUG_DIR, `${PI_AGENT_ROUTER_EXTENSION_ID}-debug.jsonl`);

function cloneStringArray(values: readonly string[]): string[] {
  return [...values];
}

function cloneStringMatrix(values: readonly (readonly string[])[]): string[][] {
  return values.map((entry) => [...entry]);
}

function cloneStringRecord(values: Readonly<Record<string, string>>): Record<string, string> {
  return { ...values };
}

function cloneDelegatedExtensionEntries(
  entries: readonly DelegatedExtensionConfigEntry[],
): DelegatedExtensionConfigEntry[] {
  return entries.map((entry) => ({
    candidates: cloneStringArray(entry.candidates),
    skipWhen: [...entry.skipWhen],
    optional: entry.optional,
  }));
}

function cloneDefaultConfig(): PiAgentRouterConfig {
  return {
    debug: DEFAULT_PI_AGENT_ROUTER_CONFIG.debug,
    maxParallelDelegationConcurrency:
      DEFAULT_PI_AGENT_ROUTER_CONFIG.maxParallelDelegationConcurrency,
    agentDiscovery: {
      projectSourceDirs: cloneStringArray(
        DEFAULT_PI_AGENT_ROUTER_CONFIG.agentDiscovery.projectSourceDirs,
      ),
      userSourceDirs: cloneStringArray(
        DEFAULT_PI_AGENT_ROUTER_CONFIG.agentDiscovery.userSourceDirs,
      ),
    },
    delegatedExtensions: cloneDelegatedExtensionEntries(
      DEFAULT_PI_AGENT_ROUTER_CONFIG.delegatedExtensions,
    ),
    providerEnvKeys: cloneStringRecord(DEFAULT_PI_AGENT_ROUTER_CONFIG.providerEnvKeys),
    directEnvDelegationProviderIds: cloneStringArray(
      DEFAULT_PI_AGENT_ROUTER_CONFIG.directEnvDelegationProviderIds,
    ),
    providerCredentialFallbackPolicies: {
      ...DEFAULT_PI_AGENT_ROUTER_CONFIG.providerCredentialFallbackPolicies,
    },
    copilotInitiatorTargetApis: cloneStringArray(
      DEFAULT_PI_AGENT_ROUTER_CONFIG.copilotInitiatorTargetApis,
    ),
    primaryAgents: cloneStringArray(DEFAULT_PI_AGENT_ROUTER_CONFIG.primaryAgents),
    agentEmojis: cloneStringRecord(DEFAULT_PI_AGENT_ROUTER_CONFIG.agentEmojis),
    subagentWidgetIconMode: DEFAULT_PI_AGENT_ROUTER_CONFIG.subagentWidgetIconMode,
  };
}

function createDefaultConfigContent(): string {
  return `${JSON.stringify(DEFAULT_PI_AGENT_ROUTER_CONFIG, null, 2)}\n`;
}

function formatConfigValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function warnInvalidConfigValue(warnings: string[], field: string, expected: string, value: unknown): void {
  warnings.push(
    `Invalid pi-agent-router config setting '${field}': expected ${expected}, got ${formatConfigValue(value)}.`,
  );
}

function normalizeStringList(
  value: unknown,
  fallback: readonly string[],
  field: string,
  warnings: string[],
): string[] {
  if (value === undefined) {
    return cloneStringArray(fallback);
  }

  if (!Array.isArray(value)) {
    warnInvalidConfigValue(warnings, field, "an array of non-empty strings", value);
    return cloneStringArray(fallback);
  }

  const normalized: string[] = [];
  for (const [index, item] of value.entries()) {
    const normalizedItem = normalizeTrimmedString(item);
    if (!normalizedItem) {
      warnInvalidConfigValue(
        warnings,
        `${field}[${index}]`,
        "a non-empty string",
        item,
      );
      return cloneStringArray(fallback);
    }
    normalized.push(normalizedItem);
  }

  return normalized;
}

function normalizeStringMatrix(
  value: unknown,
  fallback: readonly (readonly string[])[],
  field: string,
  warnings: string[],
): string[][] {
  if (value === undefined) {
    return cloneStringMatrix(fallback);
  }

  if (!Array.isArray(value)) {
    warnInvalidConfigValue(
      warnings,
      field,
      "an array of non-empty string arrays",
      value,
    );
    return cloneStringMatrix(fallback);
  }

  const normalized: string[][] = [];
  for (const [index, item] of value.entries()) {
    if (!Array.isArray(item) || item.length === 0) {
      warnInvalidConfigValue(
        warnings,
        `${field}[${index}]`,
        "a non-empty array of non-empty strings",
        item,
      );
      return cloneStringMatrix(fallback);
    }

    const normalizedItem = normalizeStringList(
      item,
      fallback[index] ?? [],
      `${field}[${index}]`,
      warnings,
    );
    if (normalizedItem.length === 0) {
      warnInvalidConfigValue(
        warnings,
        `${field}[${index}]`,
        "at least one non-empty string",
        item,
      );
      return cloneStringMatrix(fallback);
    }
    normalized.push(normalizedItem);
  }

  return normalized;
}

function expandDelegatedExtensionCandidateAliases(candidates: readonly string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const aliases = DEFAULT_DELEGATED_EXTENSION_NAME_ALIASES[candidate] ?? [candidate];
    for (const alias of aliases) {
      if (!seen.has(alias)) {
        seen.add(alias);
        expanded.push(alias);
      }
    }
  }

  return expanded;
}

function normalizeStringRecord(
  value: unknown,
  fallback: Readonly<Record<string, string>>,
  field: string,
  warnings: string[],
): Record<string, string> {
  if (value === undefined) {
    return cloneStringRecord(fallback);
  }

  const record = asRecord(value);
  if (!record) {
    warnInvalidConfigValue(warnings, field, "an object with non-empty string values", value);
    return cloneStringRecord(fallback);
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim();
    const normalizedValue = normalizeTrimmedString(rawValue);
    if (!key || !normalizedValue) {
      warnInvalidConfigValue(
        warnings,
        `${field}.${rawKey}`,
        "a non-empty string value with a non-empty key",
        rawValue,
      );
      continue;
    }

    normalized[key] = normalizedValue;
  }

  return normalized;
}

function normalizeProviderIdList(
  value: unknown,
  fallback: readonly string[],
  field: string,
  warnings: string[],
): string[] {
  return normalizeStringList(value, fallback, field, warnings).map((providerId) =>
    providerId.toLowerCase(),
  );
}

function normalizeProviderCredentialFallbackPolicies(
  value: unknown,
  fallback: Readonly<Record<string, CredentialFallbackPolicy>>,
  warnings: string[],
): Record<string, CredentialFallbackPolicy> {
  if (value === undefined) {
    return { ...fallback };
  }

  const record = asRecord(value);
  if (!record) {
    warnInvalidConfigValue(
      warnings,
      "providerCredentialFallbackPolicies",
      "an object mapping provider IDs to 'parent-env' or 'distributed-only'",
      value,
    );
    return { ...fallback };
  }

  const normalized: Record<string, CredentialFallbackPolicy> = {};
  for (const [rawProviderId, rawPolicy] of Object.entries(record)) {
    const providerId = normalizeTrimmedString(rawProviderId)?.toLowerCase();
    const policy = normalizeTrimmedString(rawPolicy)?.toLowerCase();
    if (!providerId || (policy !== "parent-env" && policy !== "distributed-only")) {
      warnInvalidConfigValue(
        warnings,
        `providerCredentialFallbackPolicies.${rawProviderId}`,
        "'parent-env' or 'distributed-only'",
        rawPolicy,
      );
      continue;
    }

    normalized[providerId] = policy;
  }

  return { ...fallback, ...normalized };
}

function normalizeAgentDiscoveryConfig(
  value: unknown,
  warnings: string[],
): AgentDiscoveryConfig {
  const record = asRecord(value) ?? {};
  const defaults = DEFAULT_PI_AGENT_ROUTER_CONFIG.agentDiscovery;

  if (value !== undefined && !asRecord(value)) {
    warnInvalidConfigValue(warnings, "agentDiscovery", "an object", value);
  }

  return {
    projectSourceDirs: normalizeStringList(
      record.projectSourceDirs,
      defaults.projectSourceDirs,
      "agentDiscovery.projectSourceDirs",
      warnings,
    ),
    userSourceDirs: normalizeStringList(
      record.userSourceDirs,
      defaults.userSourceDirs,
      "agentDiscovery.userSourceDirs",
      warnings,
    ),
  };
}

function normalizeDelegatedExtensionCandidates(
  value: unknown,
  field: string,
  warnings: string[],
): string[] {
  const singleCandidate = normalizeTrimmedString(value);
  if (singleCandidate) {
    return [singleCandidate];
  }

  if (!Array.isArray(value)) {
    warnInvalidConfigValue(
      warnings,
      field,
      "a non-empty string or non-empty array of strings",
      value,
    );
    return [];
  }

  const candidates = normalizeStringList(value, [], field, warnings);
  if (candidates.length === 0) {
    warnInvalidConfigValue(
      warnings,
      field,
      "at least one non-empty delegated extension candidate",
      value,
    );
  }

  return expandDelegatedExtensionCandidateAliases(candidates);
}

function normalizeDelegatedExtensionSkipWhen(
  value: unknown,
  field: string,
  warnings: string[],
): DelegatedExtensionSkipCondition[] {
  if (value === undefined) {
    return [];
  }

  const rawConditions = normalizeTrimmedString(value)
    ? [normalizeTrimmedString(value) as string]
    : normalizeStringList(value, [], field, warnings);

  const normalized: DelegatedExtensionSkipCondition[] = [];
  const seen = new Set<DelegatedExtensionSkipCondition>();
  for (const rawCondition of rawConditions) {
    if (!VALID_DELEGATED_EXTENSION_SKIP_CONDITIONS.has(rawCondition as DelegatedExtensionSkipCondition)) {
      warnInvalidConfigValue(
        warnings,
        field,
        "one of directEnvAuthAvailable",
        rawCondition,
      );
      continue;
    }

    const condition = rawCondition as DelegatedExtensionSkipCondition;
    if (!seen.has(condition)) {
      seen.add(condition);
      normalized.push(condition);
    }
  }

  return normalized;
}

function normalizeDelegatedExtensionEntry(
  value: unknown,
  field: string,
  warnings: string[],
): DelegatedExtensionConfigEntry | undefined {
  if (typeof value === "string" || Array.isArray(value)) {
    const candidates = normalizeDelegatedExtensionCandidates(value, field, warnings);
    return candidates.length > 0 ? { candidates, skipWhen: [], optional: false } : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    warnInvalidConfigValue(
      warnings,
      field,
      "a string, array of strings, or object with candidates",
      value,
    );
    return undefined;
  }

  const candidates = normalizeDelegatedExtensionCandidates(
    record.candidates,
    `${field}.candidates`,
    warnings,
  );
  if (candidates.length === 0) {
    return undefined;
  }

  return {
    candidates,
    skipWhen: normalizeDelegatedExtensionSkipWhen(
      record.skipWhen,
      `${field}.skipWhen`,
      warnings,
    ),
    optional: record.optional === true,
  };
}

function dedupeDelegatedExtensionEntries(
  entries: readonly DelegatedExtensionConfigEntry[],
): DelegatedExtensionConfigEntry[] {
  const seen = new Set<string>();
  const deduped: DelegatedExtensionConfigEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.candidates.join("\u0000")}\u0001${entry.skipWhen.join("\u0000")}\u0001${entry.optional}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function normalizeUnifiedDelegatedExtensionsConfig(
  value: readonly unknown[],
  warnings: string[],
): DelegatedExtensionsConfig {
  const entries: DelegatedExtensionConfigEntry[] = [];
  for (const [index, item] of value.entries()) {
    const entry = normalizeDelegatedExtensionEntry(
      item,
      `delegatedExtensions[${index}]`,
      warnings,
    );
    if (entry) {
      entries.push(entry);
    }
  }

  return dedupeDelegatedExtensionEntries(entries);
}

function normalizeLegacyDelegatedExtensionsConfig(
  record: Record<string, unknown>,
  warnings: string[],
): DelegatedExtensionsConfig {
  const multiAuthExtensionNames = new Set(
    normalizeStringList(
      record.delegatedMultiAuthExtensionNames,
      [],
      "delegatedExtensions.delegatedMultiAuthExtensionNames",
      warnings,
    ),
  );
  const toSkipWhen = (candidates: readonly string[]): DelegatedExtensionSkipCondition[] =>
    candidates.some((candidate) => multiAuthExtensionNames.has(candidate))
      ? ["directEnvAuthAvailable"]
      : [];

  const requiredEntries = normalizeStringMatrix(
    record.requiredExtensionCandidates,
    [],
    "delegatedExtensions.requiredExtensionCandidates",
    warnings,
  )
    .map(expandDelegatedExtensionCandidateAliases)
    .map((candidates) => ({ candidates, skipWhen: toSkipWhen(candidates), optional: false }));

  const optionalEntries = normalizeStringList(
    record.optionalExtensionNames,
    [],
    "delegatedExtensions.optionalExtensionNames",
    warnings,
  ).map((extensionName) => ({
    candidates: [extensionName],
    skipWhen: toSkipWhen([extensionName]),
    optional: true,
  }));

  return dedupeDelegatedExtensionEntries([...requiredEntries, ...optionalEntries]);
}

function normalizeDelegatedExtensionsConfig(
  value: unknown,
  warnings: string[],
): DelegatedExtensionsConfig {
  if (value === undefined) {
    return cloneDelegatedExtensionEntries(DEFAULT_PI_AGENT_ROUTER_CONFIG.delegatedExtensions);
  }

  if (Array.isArray(value)) {
    return normalizeUnifiedDelegatedExtensionsConfig(value, warnings);
  }

  const record = asRecord(value);
  if (!record) {
    warnInvalidConfigValue(
      warnings,
      "delegatedExtensions",
      "an array of delegated extension entries or a legacy delegated extension object",
      value,
    );
    return cloneDelegatedExtensionEntries(DEFAULT_PI_AGENT_ROUTER_CONFIG.delegatedExtensions);
  }

  if (Array.isArray(record.entries)) {
    return normalizeUnifiedDelegatedExtensionsConfig(record.entries, warnings);
  }

  return normalizeLegacyDelegatedExtensionsConfig(record, warnings);
}

function normalizeMaxParallelDelegationConcurrency(
  value: unknown,
  warnings: string[],
): number {
  if (value === undefined) {
    return DEFAULT_PI_AGENT_ROUTER_CONFIG.maxParallelDelegationConcurrency;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    warnings.push(
      `Invalid pi-agent-router config setting 'maxParallelDelegationConcurrency': expected an integer between ${SUBAGENT_MIN_CONCURRENCY} and ${SUBAGENT_MAX_CONFIGURABLE_CONCURRENCY}, got ${formatConfigValue(value)}.`,
    );
    return DEFAULT_PI_AGENT_ROUTER_CONFIG.maxParallelDelegationConcurrency;
  }

  if (
    value < SUBAGENT_MIN_CONCURRENCY ||
    value > SUBAGENT_MAX_CONFIGURABLE_CONCURRENCY
  ) {
    warnings.push(
      `Invalid pi-agent-router config setting 'maxParallelDelegationConcurrency': expected an integer between ${SUBAGENT_MIN_CONCURRENCY} and ${SUBAGENT_MAX_CONFIGURABLE_CONCURRENCY}, got ${value}.`,
    );
    return DEFAULT_PI_AGENT_ROUTER_CONFIG.maxParallelDelegationConcurrency;
  }

  return value;
}

function normalizeSubagentWidgetIconMode(
  value: unknown,
  warnings: string[],
): SubagentWidgetIconConfigMode {
  if (value === undefined) {
    return DEFAULT_PI_AGENT_ROUTER_CONFIG.subagentWidgetIconMode;
  }

  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (normalized === "auto" || normalized === "nerd" || normalized === "fallback") {
    return normalized;
  }

  warnInvalidConfigValue(
    warnings,
    "subagentWidgetIconMode",
    "'auto', 'nerd', or 'fallback'",
    value,
  );
  return DEFAULT_PI_AGENT_ROUTER_CONFIG.subagentWidgetIconMode;
}

function normalizeConfig(raw: unknown): { config: PiAgentRouterConfig; warnings: string[] } {
  const warnings: string[] = [];
  const record = asRecord(raw);
  if (!record) {
    warnInvalidConfigValue(warnings, "root", "a JSON object", raw);
  }

  const normalizedRecord = record ?? {};

  return {
    config: {
      debug: normalizedRecord.debug === true,
      maxParallelDelegationConcurrency: normalizeMaxParallelDelegationConcurrency(
        normalizedRecord.maxParallelDelegationConcurrency,
        warnings,
      ),
      agentDiscovery: normalizeAgentDiscoveryConfig(normalizedRecord.agentDiscovery, warnings),
      delegatedExtensions: normalizeDelegatedExtensionsConfig(
        normalizedRecord.delegatedExtensions,
        warnings,
      ),
      providerEnvKeys: normalizeStringRecord(
        normalizedRecord.providerEnvKeys,
        DEFAULT_PI_AGENT_ROUTER_CONFIG.providerEnvKeys,
        "providerEnvKeys",
        warnings,
      ),
      directEnvDelegationProviderIds: normalizeProviderIdList(
        normalizedRecord.directEnvDelegationProviderIds,
        DEFAULT_PI_AGENT_ROUTER_CONFIG.directEnvDelegationProviderIds,
        "directEnvDelegationProviderIds",
        warnings,
      ),
      providerCredentialFallbackPolicies: normalizeProviderCredentialFallbackPolicies(
        normalizedRecord.providerCredentialFallbackPolicies,
        DEFAULT_PI_AGENT_ROUTER_CONFIG.providerCredentialFallbackPolicies,
        warnings,
      ),
      copilotInitiatorTargetApis: normalizeStringList(
        normalizedRecord.copilotInitiatorTargetApis,
        DEFAULT_PI_AGENT_ROUTER_CONFIG.copilotInitiatorTargetApis,
        "copilotInitiatorTargetApis",
        warnings,
      ),
      primaryAgents: normalizeStringList(
        normalizedRecord.primaryAgents,
        DEFAULT_PI_AGENT_ROUTER_CONFIG.primaryAgents,
        "primaryAgents",
        warnings,
      ),
      agentEmojis: normalizeStringRecord(
        normalizedRecord.agentEmojis,
        DEFAULT_PI_AGENT_ROUTER_CONFIG.agentEmojis,
        "agentEmojis",
        warnings,
      ),
      subagentWidgetIconMode: normalizeSubagentWidgetIconMode(
        normalizedRecord.subagentWidgetIconMode,
        warnings,
      ),
    },
    warnings,
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

function combineConfigWarnings(warnings: string[]): string | undefined {
  return warnings.length > 0 ? warnings.join(" ") : undefined;
}

export function loadPiAgentRouterConfig(configPath = CONFIG_PATH): PiAgentRouterConfigLoadResult {
  const ensureResult = ensurePiAgentRouterConfig(configPath);

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeConfig(parsed);
    return {
      config: normalized.config,
      created: ensureResult.created,
      warning: combineConfigWarnings([
        ...(ensureResult.warning ? [ensureResult.warning] : []),
        ...normalized.warnings,
      ]),
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
