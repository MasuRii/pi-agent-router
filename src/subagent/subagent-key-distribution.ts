/**
 * Generic delegated auth broker helpers for delegated subagent processes.
 *
 * The router owns process orchestration only. Credential selection, rotation,
 * cooldowns, and provider-specific auth handling belong to whichever extension
 * registers a delegated auth broker.
 */

import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { piAgentRouterDebugLogger } from "../debug-logger";
import { getErrorMessage } from "../error-utils";

/**
 * Cached provider env keys loaded from models.json.
 * Undefined means not yet loaded, null means load failed, object means loaded.
 */
let cachedProviderCredentialEnvKeys: Record<string, string> | null | undefined = undefined;
let providerCredentialEnvKeysLoadPromise: Promise<Record<string, string> | null> | undefined;
let providerCredentialEnvKeysCacheRevision = 0;

const DEFAULT_PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
};

function isRemovedLegacyGoogleProviderId(providerId: string | undefined): boolean {
  const normalizedProviderId = providerId?.trim().toLowerCase();
  return (
    normalizedProviderId === ["google", "gemini", "cli"].join("-") ||
    normalizedProviderId === ["google", "antigravity"].join("-")
  );
}

function filterRemovedLegacyProviderCredentialEnvKeys(
  providerCredentialEnvKeys: Readonly<Record<string, string>>,
): Record<string, string> {
  const filteredProviderEnvKeys: Record<string, string> = {};
  for (const [providerId, envKey] of Object.entries(providerCredentialEnvKeys)) {
    if (!isRemovedLegacyGoogleProviderId(providerId)) {
      filteredProviderEnvKeys[providerId] = envKey;
    }
  }
  return filteredProviderEnvKeys;
}

/**
 * Get the path to models.json file.
 * Resolves the active Pi agent runtime models.json path (default: ~/.pi/agent/models.json; respects PI_CODING_AGENT_DIR).
 */
function getModelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}

function extractProviderEnvKeys(parsed: unknown): Record<string, string> | null {
  if (!parsed || typeof parsed !== "object" || !("providers" in parsed)) {
    return null;
  }

  const providers = (parsed as { providers: Record<string, unknown> }).providers;
  if (!providers || typeof providers !== "object") {
    return null;
  }

  const envKeys: Record<string, string> = {};

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (isRemovedLegacyGoogleProviderId(providerId)) {
      continue;
    }

    if (
      providerConfig &&
      typeof providerConfig === "object" &&
      "apiKey" in providerConfig &&
      typeof (providerConfig as { apiKey: unknown }).apiKey === "string"
    ) {
      const apiKeyEnv = (providerConfig as { apiKey: string }).apiKey.trim();
      if (apiKeyEnv) {
        envKeys[providerId] = apiKeyEnv;
      }
    }
  }

  return Object.keys(envKeys).length > 0 ? envKeys : null;
}

function loadProviderEnvKeysFromModelsJson(): Record<string, string> | null {
  try {
    const modelsPath = getModelsJsonPath();
    if (!existsSync(modelsPath)) {
      return null;
    }

    const content = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return extractProviderEnvKeys(parsed);
  } catch {
    return null;
  }
}

async function loadProviderEnvKeysFromModelsJsonAsync(): Promise<Record<string, string> | null> {
  try {
    const content = await readFile(getModelsJsonPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return extractProviderEnvKeys(parsed);
  } catch {
    return null;
  }
}

function mergeProviderCredentialEnvKeys(dynamicKeys: Record<string, string> | null | undefined): Record<string, string> {
  const defaults = filterRemovedLegacyProviderCredentialEnvKeys(DEFAULT_PROVIDER_ENV_KEYS);
  return dynamicKeys
    ? { ...defaults, ...filterRemovedLegacyProviderCredentialEnvKeys(dynamicKeys) }
    : { ...defaults };
}

function getProviderCredentialEnvKeys(): Record<string, string> {
  if (cachedProviderCredentialEnvKeys === undefined) {
    const dynamicKeys = loadProviderEnvKeysFromModelsJson();
    cachedProviderCredentialEnvKeys = dynamicKeys;
  }

  return mergeProviderCredentialEnvKeys(cachedProviderCredentialEnvKeys);
}

async function getProviderCredentialEnvKeysAsync(): Promise<Record<string, string>> {
  if (cachedProviderCredentialEnvKeys !== undefined) {
    return mergeProviderCredentialEnvKeys(cachedProviderCredentialEnvKeys);
  }

  if (!providerCredentialEnvKeysLoadPromise) {
    const cacheRevision = providerCredentialEnvKeysCacheRevision;
    providerCredentialEnvKeysLoadPromise = (async () => {
      const dynamicKeys = await loadProviderEnvKeysFromModelsJsonAsync();
      if (cacheRevision === providerCredentialEnvKeysCacheRevision) {
        cachedProviderCredentialEnvKeys = dynamicKeys;
      }
      return dynamicKeys;
    })();
  }

  try {
    return mergeProviderCredentialEnvKeys(await providerCredentialEnvKeysLoadPromise);
  } finally {
    providerCredentialEnvKeysLoadPromise = undefined;
  }
}

export function resetProviderEnvKeyCacheState(): void {
  providerCredentialEnvKeysCacheRevision += 1;
  cachedProviderCredentialEnvKeys = undefined;
  providerCredentialEnvKeysLoadPromise = undefined;
}

const PROVIDER_ID_ALIASES: Record<string, string> = {
  codex: "openai-codex",
};

function normalizeProviderId(providerId: string | undefined): string | undefined {
  if (!providerId) {
    return undefined;
  }

  const normalized = providerId.trim().toLowerCase();
  if (!normalized || isRemovedLegacyGoogleProviderId(normalized)) {
    return undefined;
  }

  return PROVIDER_ID_ALIASES[normalized] ?? normalized;
}

function parseProviderFromModelReference(modelReference: string | undefined): string | undefined {
  if (!modelReference) {
    return undefined;
  }

  const normalized = modelReference.trim();
  if (!normalized) {
    return undefined;
  }

  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex <= 0) {
    return normalizeProviderId(normalized);
  }

  return normalizeProviderId(normalized.slice(0, separatorIndex));
}

function parseModelIdFromReference(modelReference: string | undefined): string | undefined {
  if (!modelReference) {
    return undefined;
  }

  const normalized = modelReference.trim();
  if (!normalized) {
    return undefined;
  }

  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex < 0) {
    return undefined;
  }

  const modelId = normalized.slice(separatorIndex + 1).trim();
  return modelId || undefined;
}

function normalizeOptionalRoutingValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function hasUsableEnvValue(env: NodeJS.ProcessEnv, envKey: string | undefined): boolean {
  if (!envKey) {
    return false;
  }

  const value = env[envKey];
  return typeof value === "string" && value.trim().length > 0;
}

export type DelegatedAuthPrepareRequest = {
  providerId?: string;
  modelId?: string;
  modelRef?: string;
  api?: string;
  parentSessionId?: string;
  subagentSessionId: string;
};

export type DelegatedAuthAttemptResult = {
  providerId?: string;
  modelId?: string;
  modelRef?: string;
  api?: string;
  parentSessionId?: string;
  subagentSessionId: string;
  mode: DelegatedAuthPrepareResult["mode"];
  leaseId?: string;
  exitCode: number;
  timedOut: boolean;
  stderr?: string;
};

export type DelegatedAuthPrepareResult =
  | {
      mode: "self-managed";
      extensionDirs: string[];
      env?: Record<string, string>;
    }
  | {
      mode: "lease";
      env: Record<string, string>;
      leaseId: string;
    }
  | {
      mode: "none";
      env?: Record<string, string>;
      extensionDirs?: string[];
    };

export type DelegatedAuthBroker = {
  id: string;
  capabilities: readonly string[];
  prepareSubagentAuth: (
    request: DelegatedAuthPrepareRequest,
  ) => Promise<DelegatedAuthPrepareResult> | DelegatedAuthPrepareResult;
  release?: (request: {
    leaseId?: string;
    parentSessionId?: string;
    subagentSessionId: string;
    providerId?: string;
  }) => Promise<void> | void;
  reportAttemptResult?: (
    result: DelegatedAuthAttemptResult,
  ) => Promise<void> | void;
};

export type DelegatedAuthBrokerRegistry = {
  register: (broker: DelegatedAuthBroker) => void;
  unregister: (brokerId: string) => void;
  list: () => DelegatedAuthBroker[];
  get: (brokerId: string) => DelegatedAuthBroker | undefined;
};

type GlobalWithDelegatedAuthBrokerRegistry = typeof globalThis & {
  __piDelegatedAuthBrokerRegistry?: DelegatedAuthBrokerRegistry;
};

function isDelegatedAuthBroker(value: unknown): value is DelegatedAuthBroker {
  if (!value || typeof value !== "object") {
    return false;
  }

  const broker = value as DelegatedAuthBroker;
  return (
    typeof broker.id === "string" &&
    broker.id.trim().length > 0 &&
    Array.isArray(broker.capabilities) &&
    broker.capabilities.includes("delegated-auth") &&
    typeof broker.prepareSubagentAuth === "function"
  );
}

export function getOrCreateDelegatedAuthBrokerRegistry(): DelegatedAuthBrokerRegistry {
  const globalScope = globalThis as GlobalWithDelegatedAuthBrokerRegistry;
  if (globalScope.__piDelegatedAuthBrokerRegistry) {
    return globalScope.__piDelegatedAuthBrokerRegistry;
  }

  const brokers = new Map<string, DelegatedAuthBroker>();
  const registry: DelegatedAuthBrokerRegistry = {
    register: (broker) => {
      if (!isDelegatedAuthBroker(broker)) {
        return;
      }
      brokers.set(broker.id.trim(), broker);
    },
    unregister: (brokerId) => {
      brokers.delete(brokerId.trim());
    },
    list: () => [...brokers.values()],
    get: (brokerId) => brokers.get(brokerId.trim()),
  };

  globalScope.__piDelegatedAuthBrokerRegistry = registry;
  return registry;
}

function getDelegatedAuthBrokers(): DelegatedAuthBroker[] {
  const globalScope = globalThis as GlobalWithDelegatedAuthBrokerRegistry;
  return globalScope.__piDelegatedAuthBrokerRegistry?.list() ?? [];
}

function normalizeEnvRecord(env: Record<string, string> | undefined): Record<string, string> {
  const normalizedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (normalizedKey && normalizedValue) {
      normalizedEnv[normalizedKey] = normalizedValue;
    }
  }
  return normalizedEnv;
}

function normalizeExtensionDirs(extensionDirs: readonly string[] | undefined): string[] {
  const normalizedDirs: string[] = [];
  const seen = new Set<string>();
  for (const extensionDir of extensionDirs ?? []) {
    const normalizedDir = extensionDir.trim();
    if (!normalizedDir || seen.has(normalizedDir)) {
      continue;
    }
    seen.add(normalizedDir);
    normalizedDirs.push(normalizedDir);
  }
  return normalizedDirs;
}

function normalizeBrokerResult(
  result: DelegatedAuthPrepareResult,
): DelegatedAuthPrepareResult {
  if (result.mode === "self-managed") {
    return {
      mode: "self-managed",
      extensionDirs: normalizeExtensionDirs(result.extensionDirs),
      env: normalizeEnvRecord(result.env),
    };
  }

  if (result.mode === "lease") {
    return {
      mode: "lease",
      leaseId: result.leaseId.trim(),
      env: normalizeEnvRecord(result.env),
    };
  }

  return {
    mode: "none",
    extensionDirs: normalizeExtensionDirs(result.extensionDirs),
    env: normalizeEnvRecord(result.env),
  };
}

export type PreparedSubagentAuth = {
  mode: DelegatedAuthPrepareResult["mode"] | "direct-env";
  brokerId?: string;
  extensionDirs: string[];
  env: Record<string, string>;
  inheritedEnvKeys: string[];
  leaseId?: string;
  failureMessage?: string;
};

function createStandaloneAuthFailureMessage(options: {
  providerId: string;
  envKey?: string;
  modelRef?: string;
}): string {
  const modelText = options.modelRef ? ` for ${options.modelRef}` : "";
  const envText = options.envKey
    ? ` Set ${options.envKey} in the parent environment`
    : " Configure a provider apiKey mapping in models.json or pi-agent-router config and set that environment variable";
  return (
    `[pi-agent-router] No delegated auth broker is registered and no direct parent environment credential is available for ${options.providerId}${modelText}. ` +
    `${envText}, or install/enable an extension that registers globalThis.__piDelegatedAuthBrokerRegistry with the delegated-auth capability.`
  );
}

export async function prepareSubagentAuthForLaunch(options: {
  providerId: string | undefined;
  requestedModel?: string;
  modelContext?: {
    providerId?: string;
    modelId?: string;
    modelRef?: string;
    api?: string;
  };
  parentSessionId?: string;
  subagentSessionId: string;
  parentEnv?: NodeJS.ProcessEnv;
}): Promise<PreparedSubagentAuth> {
  const normalizedProviderId = normalizeProviderId(options.providerId);
  const modelId =
    normalizeOptionalRoutingValue(options.modelContext?.modelId) ??
    parseModelIdFromReference(options.requestedModel);
  const modelRef =
    normalizeOptionalRoutingValue(options.modelContext?.modelRef) ??
    normalizeOptionalRoutingValue(options.requestedModel);
  const request: DelegatedAuthPrepareRequest = {
    providerId: normalizedProviderId,
    modelId,
    modelRef,
    api: normalizeOptionalRoutingValue(options.modelContext?.api),
    parentSessionId: normalizeOptionalRoutingValue(options.parentSessionId),
    subagentSessionId: options.subagentSessionId,
  };

  for (const broker of getDelegatedAuthBrokers()) {
    try {
      const prepared = normalizeBrokerResult(await broker.prepareSubagentAuth(request));
      if (prepared.mode === "none") {
        continue;
      }

      void piAgentRouterDebugLogger.info("subagent.delegated_auth_prepared", {
        brokerId: broker.id,
        mode: prepared.mode,
        providerId: normalizedProviderId,
        sessionId: options.subagentSessionId,
        extensionDirCount: "extensionDirs" in prepared ? prepared.extensionDirs?.length ?? 0 : 0,
      });

      return {
        mode: prepared.mode,
        brokerId: broker.id,
        extensionDirs: "extensionDirs" in prepared ? prepared.extensionDirs ?? [] : [],
        env: prepared.env ?? {},
        inheritedEnvKeys: [],
        leaseId: prepared.mode === "lease" ? prepared.leaseId : undefined,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      void piAgentRouterDebugLogger.warn("subagent.delegated_auth_prepare_failed", {
        brokerId: broker.id,
        error: message,
        message: `[pi-agent-router] Delegated auth broker '${broker.id}' failed to prepare subagent auth: ${message}`,
        providerId: normalizedProviderId,
        sessionId: options.subagentSessionId,
      });
    }
  }

  if (!normalizedProviderId) {
    return {
      mode: "none",
      extensionDirs: [],
      env: {},
      inheritedEnvKeys: [],
    };
  }

  const envKey = await resolveProviderEnvKeyAsync(normalizedProviderId);
  if (hasUsableEnvValue(options.parentEnv ?? process.env, envKey)) {
    return {
      mode: "direct-env",
      extensionDirs: [],
      env: {},
      inheritedEnvKeys: envKey ? [envKey] : [],
    };
  }

  return {
    mode: "none",
    extensionDirs: [],
    env: {},
    inheritedEnvKeys: [],
    failureMessage: createStandaloneAuthFailureMessage({
      providerId: normalizedProviderId,
      envKey,
      modelRef,
    }),
  };
}

export async function reportSubagentAuthAttemptResult(
  preparedAuth: PreparedSubagentAuth,
  result: Omit<DelegatedAuthAttemptResult, "mode" | "leaseId">,
): Promise<void> {
  if (!preparedAuth.brokerId) {
    return;
  }

  const broker = getOrCreateDelegatedAuthBrokerRegistry().get(preparedAuth.brokerId);
  if (!broker?.reportAttemptResult) {
    return;
  }

  try {
    await broker.reportAttemptResult({
      ...result,
      mode: preparedAuth.mode === "direct-env" ? "none" : preparedAuth.mode,
      leaseId: preparedAuth.leaseId,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.delegated_auth_report_failed", {
      brokerId: preparedAuth.brokerId,
      error: message,
      message: `[pi-agent-router] Delegated auth broker '${preparedAuth.brokerId}' failed to record subagent auth result: ${message}`,
      providerId: result.providerId,
      sessionId: result.subagentSessionId,
    });
  }
}

export function releaseSubagentAuthForLaunch(
  preparedAuth: PreparedSubagentAuth | undefined,
  options: {
    parentSessionId?: string;
    subagentSessionId: string;
    providerId?: string;
  },
): void {
  if (!preparedAuth?.brokerId) {
    return;
  }

  const broker = getOrCreateDelegatedAuthBrokerRegistry().get(preparedAuth.brokerId);
  if (!broker?.release) {
    return;
  }

  try {
    void broker.release({
      leaseId: preparedAuth.leaseId,
      parentSessionId: options.parentSessionId,
      subagentSessionId: options.subagentSessionId,
      providerId: options.providerId,
    });
    void piAgentRouterDebugLogger.info("subagent.delegated_auth_released", {
      brokerId: preparedAuth.brokerId,
      mode: preparedAuth.mode,
      providerId: options.providerId,
      sessionId: options.subagentSessionId,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.delegated_auth_release_failed", {
      brokerId: preparedAuth.brokerId,
      error: message,
      message: `[pi-agent-router] Delegated auth broker '${preparedAuth.brokerId}' failed to release subagent auth: ${message}`,
      providerId: options.providerId,
      sessionId: options.subagentSessionId,
    });
  }
}

export function releaseSubagentAuthForParentSession(parentSessionId: string): void {
  const normalizedParentSessionId = parentSessionId.trim();
  if (!normalizedParentSessionId) {
    return;
  }

  for (const broker of getDelegatedAuthBrokers()) {
    if (!broker.release) {
      continue;
    }

    try {
      void broker.release({
        parentSessionId: normalizedParentSessionId,
        subagentSessionId: "",
      });
    } catch (error) {
      const message = getErrorMessage(error);
      void piAgentRouterDebugLogger.warn("subagent.parent_session_auth_release_failed", {
        brokerId: broker.id,
        error: message,
        message: `[pi-agent-router] Delegated auth broker '${broker.id}' failed to release parent-session auth: ${message}`,
        parentSessionId: normalizedParentSessionId,
      });
    }
  }
}

export function detectSubagentProviderId(options: {
  requestedModel?: string;
  activeProviderId?: string;
  parentEnv?: NodeJS.ProcessEnv;
}): string | undefined {
  const providerCredentialEnvKeys = getProviderCredentialEnvKeys();

  const modelProvider = parseProviderFromModelReference(options.requestedModel);
  if (modelProvider !== undefined) {
    return providerCredentialEnvKeys[modelProvider] ? modelProvider : modelProvider;
  }

  const activeProvider = normalizeProviderId(options.activeProviderId);
  if (activeProvider) {
    return activeProvider;
  }

  const parentEnv = options.parentEnv;
  if (!parentEnv) {
    return undefined;
  }

  for (const [providerId, envKey] of Object.entries(providerCredentialEnvKeys)) {
    const candidate = parentEnv[envKey];
    if (typeof candidate === "string" && candidate.trim()) {
      return providerId;
    }
  }

  return undefined;
}

export async function detectSubagentProviderIdAsync(options: {
  requestedModel?: string;
  activeProviderId?: string;
  parentEnv?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const providerCredentialEnvKeys = await getProviderCredentialEnvKeysAsync();

  const modelProvider = parseProviderFromModelReference(options.requestedModel);
  if (modelProvider !== undefined) {
    return providerCredentialEnvKeys[modelProvider] ? modelProvider : modelProvider;
  }

  const activeProvider = normalizeProviderId(options.activeProviderId);
  if (activeProvider) {
    return activeProvider;
  }

  const parentEnv = options.parentEnv;
  if (!parentEnv) {
    return undefined;
  }

  for (const [providerId, envKey] of Object.entries(providerCredentialEnvKeys)) {
    const candidate = parentEnv[envKey];
    if (typeof candidate === "string" && candidate.trim()) {
      return providerId;
    }
  }

  return undefined;
}

export async function resolveProviderEnvKeyAsync(
  providerId: string | undefined,
): Promise<string | undefined> {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }

  const providerCredentialEnvKeys = await getProviderCredentialEnvKeysAsync();
  return providerCredentialEnvKeys[normalizedProviderId];
}

export async function hasParentProviderCredentialEnvAsync(
  providerId: string | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const envKey = await resolveProviderEnvKeyAsync(providerId);
  return hasUsableEnvValue(parentEnv, envKey);
}

export async function isDirectEnvDelegationAuthAvailableForProviderAsync(
  providerId: string | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return false;
  }

  const envKey = await resolveProviderEnvKeyAsync(normalizedProviderId);
  return typeof envKey === "string" && hasUsableEnvValue(parentEnv, envKey);
}
