/**
 * Shared key distribution helpers for delegated subagent processes.
 */

import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  computeExponentialBackoffMs,
  getWeeklyQuotaCooldownMs,
  TRANSIENT_COOLDOWN_BASE_MS,
  TRANSIENT_COOLDOWN_MAX_MS,
} from "./credential-backoff";
import { createBoundedCache } from "../cache/bounded-cache";
import { loadPiAgentRouterConfig } from "../config";
import { piAgentRouterDebugLogger } from "../debug-logger";
import { getErrorMessage } from "../error-utils";

/**
 * Cached provider env keys loaded from models.json.
 * Undefined means not yet loaded, null means load failed, object means loaded.
 */
let cachedProviderEnvKeys: Record<string, string> | null | undefined = undefined;
let providerEnvKeysLoadPromise: Promise<Record<string, string> | null> | undefined;
let providerEnvKeysCacheRevision = 0;

type CredentialFallbackPolicy = "parent-env" | "distributed-only";

type KeyDistributionConfigSlices = {
  providerEnvKeys: Readonly<Record<string, string>>;
  directEnvDelegationProviderIds: ReadonlySet<string>;
  providerCredentialFallbackPolicies: Readonly<Record<string, CredentialFallbackPolicy>>;
};

let cachedKeyDistributionConfigSlices: KeyDistributionConfigSlices | undefined;

function getConfiguredKeyDistributionSlices(): KeyDistributionConfigSlices {
  if (cachedKeyDistributionConfigSlices) {
    return cachedKeyDistributionConfigSlices;
  }

  const config = loadPiAgentRouterConfig().config;
  cachedKeyDistributionConfigSlices = {
    providerEnvKeys: { ...config.providerEnvKeys },
    directEnvDelegationProviderIds: new Set(config.directEnvDelegationProviderIds),
    providerCredentialFallbackPolicies: {
      ...config.providerCredentialFallbackPolicies,
    },
  };
  return cachedKeyDistributionConfigSlices;
}

function resetConfiguredKeyDistributionSlices(): void {
  cachedKeyDistributionConfigSlices = undefined;
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

/**
 * Load provider env keys from models.json dynamically.
 * Each provider entry can have an "apiKey" field that specifies the env var name.
 */
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

function mergeProviderEnvKeys(dynamicKeys: Record<string, string> | null | undefined): Record<string, string> {
  const configuredProviderEnvKeys = getConfiguredKeyDistributionSlices().providerEnvKeys;
  return dynamicKeys
    ? { ...configuredProviderEnvKeys, ...dynamicKeys }
    : { ...configuredProviderEnvKeys };
}

/**
 * Get provider env keys, combining core providers with dynamically loaded ones.
 * Uses cached result to avoid repeated file reads.
 */
function getProviderEnvKeys(): Record<string, string> {
  if (cachedProviderEnvKeys === undefined) {
    const dynamicKeys = loadProviderEnvKeysFromModelsJson();
    cachedProviderEnvKeys = dynamicKeys;
  }

  return mergeProviderEnvKeys(cachedProviderEnvKeys);
}

async function getProviderEnvKeysAsync(): Promise<Record<string, string>> {
  if (cachedProviderEnvKeys !== undefined) {
    return mergeProviderEnvKeys(cachedProviderEnvKeys);
  }

  if (!providerEnvKeysLoadPromise) {
    const cacheRevision = providerEnvKeysCacheRevision;
    providerEnvKeysLoadPromise = (async () => {
      const dynamicKeys = await loadProviderEnvKeysFromModelsJsonAsync();
      if (cacheRevision === providerEnvKeysCacheRevision) {
        cachedProviderEnvKeys = dynamicKeys;
      }
      return dynamicKeys;
    })();
  }

  try {
    return mergeProviderEnvKeys(await providerEnvKeysLoadPromise);
  } finally {
    providerEnvKeysLoadPromise = undefined;
  }
}

export function resetProviderEnvKeyCacheState(): void {
  providerEnvKeysCacheRevision += 1;
  cachedProviderEnvKeys = undefined;
  providerEnvKeysLoadPromise = undefined;
  resetConfiguredKeyDistributionSlices();
}

/**
 * Provider env keys for subagent credential distribution.
 * Dynamically loaded from models.json with core provider fallbacks.
 * Use getProviderEnvKeys() for the actual mapping.
 * @deprecated Use getProviderEnvKeys() instead for dynamic resolution.
 */
export const PROVIDER_ENV_KEYS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_, key: string) {
    return getProviderEnvKeys()[key];
  },
  ownKeys() {
    return Object.keys(getProviderEnvKeys());
  },
  getOwnPropertyDescriptor(_, key: string) {
    const keys = getProviderEnvKeys();
    if (key in keys) {
      return { enumerable: true, configurable: true, value: keys[key] };
    }
    return undefined;
  },
  has(_, key: string) {
    return key in getProviderEnvKeys();
  },
});

const PROVIDER_ID_ALIASES: Record<string, string> = {
  codex: "openai-codex",
  google: "google-gemini-cli",
  gemini: "google-gemini-cli",
};

function getDirectEnvDelegationProviderIds(): ReadonlySet<string> {
  return getConfiguredKeyDistributionSlices().directEnvDelegationProviderIds;
}

function getCredentialFallbackPolicy(providerId: string | undefined): CredentialFallbackPolicy {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return "parent-env";
  }

  return (
    getConfiguredKeyDistributionSlices().providerCredentialFallbackPolicies[normalizedProviderId] ??
    "parent-env"
  );
}

function shouldInheritParentCredentialEnv(providerId: string | undefined): boolean {
  return getCredentialFallbackPolicy(providerId) === "parent-env";
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 1_500;
const DISTRIBUTED_ONLY_ACQUIRE_TIMEOUT_MS = 30_000;
const FALLBACK_ENV_ACQUIRE_TIMEOUT_MS = 250;

type KeyLease = {
  credentialId: string;
  apiKey: string;
};

export type DelegatedCredentialRequest = {
  sessionId: string;
  providerId: string;
  timeoutMs?: number;
  modelId?: string;
  modelRef?: string;
  api?: string;
  signal?: AbortSignal;
  parentSessionId?: string;
};

export type DelegatedRoutingCapabilities = {
  providerId: string;
  modelId?: string;
  modelRef?: string;
  api?: string;
  credentialCounts: {
    total: number;
    structurallyEligible: number;
    modelEligible: number;
  };
  modelConstraintApplied: boolean;
  failureMessage?: string;
};

export type GlobalKeyDistributor = {
  acquireForSubagent: {
    (request: DelegatedCredentialRequest): Promise<KeyLease | string | null | undefined>;
    (
      sessionId: string,
      providerId: string,
      options?: {
        timeoutMs?: number;
        modelId?: string;
        modelRef?: string;
        api?: string;
        signal?: AbortSignal;
        parentSessionId?: string;
      },
    ): Promise<KeyLease | string | null | undefined>;
  };
  releaseFromSubagent: (sessionId: string) => void;
  releaseLightweightSessionLeases?: (parentSessionId: string, providerId?: string) => void;
  getLeaseForSession?: (
    sessionId: string,
  ) => Promise<KeyLease | null | undefined> | KeyLease | null | undefined;
  getKeyForSession?: (sessionId: string) => string | null | undefined;
  getMetrics?: () => unknown;
  shouldBypassDelegatedSubagentAcquisition?: (
    providerId: string,
    options?: {
      modelId?: string;
      modelRef?: string;
      api?: string;
      signal?: AbortSignal;
    },
  ) => Promise<boolean> | boolean;
  getDelegatedCredentialRoutingCapabilities?: (
    request: DelegatedCredentialRequest,
  ) => Promise<DelegatedRoutingCapabilities> | DelegatedRoutingCapabilities;
  applyCooldown?: (
    credentialId: string,
    durationMs: number,
    reason: string,
    providerId?: string,
    isWeekly?: boolean,
    errorMessage?: string,
  ) => Promise<void> | void;
  disableCredential?: (
    credentialId: string,
    reason: string,
    providerId?: string,
  ) => Promise<void> | void;
  clearTransientError?: (
    credentialId: string,
    providerId?: string,
  ) => Promise<void> | void;
};

type GlobalWithKeyDistributor = typeof globalThis & {
  __piMultiAuthKeyDistributor?: GlobalKeyDistributor;
};

export type SubagentKeyLease = {
  providerId: string;
  envKey: string;
  credentialId: string;
  apiKey: string;
};

function normalizeProviderId(providerId: string | undefined): string | undefined {
  if (!providerId) {
    return undefined;
  }

  const normalized = providerId.trim().toLowerCase();
  if (!normalized) {
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

function resolveDelegatedCredentialRequest(options: {
  sessionId: string;
  providerId: string;
  timeoutMs?: number;
  requestedModel?: string;
  modelContext?: {
    providerId?: string;
    modelId?: string;
    modelRef?: string;
    api?: string;
  };
  parentSessionId?: string;
  signal: AbortSignal;
}): DelegatedCredentialRequest {
  const modelId =
    normalizeOptionalRoutingValue(options.modelContext?.modelId) ??
    parseModelIdFromReference(options.requestedModel);
  const modelRef =
    normalizeOptionalRoutingValue(options.modelContext?.modelRef) ??
    normalizeOptionalRoutingValue(options.requestedModel);

  return {
    sessionId: options.sessionId,
    providerId: options.providerId,
    timeoutMs: options.timeoutMs,
    modelId,
    modelRef,
    api: normalizeOptionalRoutingValue(options.modelContext?.api),
    parentSessionId: normalizeOptionalRoutingValue(options.parentSessionId),
    signal: options.signal,
  };
}

function hasUsableEnvValue(env: NodeJS.ProcessEnv, envKey: string | undefined): boolean {
  if (!envKey) {
    return false;
  }

  const value = env[envKey];
  return typeof value === "string" && value.trim().length > 0;
}

function resolveAcquireTimeoutMs(
  requestedTimeoutMs: number | undefined,
  hasParentFallbackCredential: boolean,
  parentFallbackAllowed: boolean,
): number {
  if (Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0) {
    return Math.max(1, Math.trunc(requestedTimeoutMs));
  }

  if (!parentFallbackAllowed) {
    return DISTRIBUTED_ONLY_ACQUIRE_TIMEOUT_MS;
  }

  return hasParentFallbackCredential
    ? FALLBACK_ENV_ACQUIRE_TIMEOUT_MS
    : DEFAULT_ACQUIRE_TIMEOUT_MS;
}

function getGlobalKeyDistributor(): GlobalKeyDistributor | null {
  const globalScope = globalThis as GlobalWithKeyDistributor;
  return globalScope.__piMultiAuthKeyDistributor ?? null;
}

async function getRoutingCapabilitiesSafe(
  distributor: GlobalKeyDistributor,
  request: DelegatedCredentialRequest,
): Promise<DelegatedRoutingCapabilities | undefined> {
  try {
    return await distributor.getDelegatedCredentialRoutingCapabilities?.(request);
  } catch (error) {
    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.routing_capabilities_failed", {
      error: message,
      message: `[pi-agent-router] Failed to resolve redacted routing capabilities for ${request.providerId}: ${message}`,
      providerId: request.providerId,
      sessionId: request.sessionId,
    });
    return undefined;
  }
}

function resolveApiKeyFromLease(
  lease: KeyLease | string | null | undefined,
  distributor: GlobalKeyDistributor,
  sessionId: string,
): KeyLease | null {
  if (!lease) {
    return null;
  }

  if (typeof lease === "object") {
    const credentialId =
      typeof lease.credentialId === "string" ? lease.credentialId.trim() : "";
    const apiKey = typeof lease.apiKey === "string" ? lease.apiKey.trim() : "";
    if (credentialId && apiKey) {
      return { credentialId, apiKey };
    }
    return null;
  }

  const credentialId = lease.trim();
  if (!credentialId) {
    return null;
  }

  const sessionKey = distributor.getKeyForSession?.(sessionId);
  if (typeof sessionKey !== "string") {
    return null;
  }

  const apiKey = sessionKey.trim();
  if (!apiKey || apiKey === credentialId) {
    return null;
  }

  return {
    credentialId,
    apiKey,
  };
}

export function detectSubagentProviderId(options: {
  requestedModel?: string;
  activeProviderId?: string;
  parentEnv?: NodeJS.ProcessEnv;
}): string | undefined {
  const providerEnvKeys = getProviderEnvKeys();

  const modelProvider = parseProviderFromModelReference(options.requestedModel);
  if (modelProvider !== undefined) {
    return providerEnvKeys[modelProvider] ? modelProvider : undefined;
  }

  const activeProvider = normalizeProviderId(options.activeProviderId);
  if (activeProvider && providerEnvKeys[activeProvider]) {
    return activeProvider;
  }

  const parentEnv = options.parentEnv;
  if (!parentEnv) {
    return undefined;
  }

  for (const [providerId, envKey] of Object.entries(providerEnvKeys)) {
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
  const providerEnvKeys = await getProviderEnvKeysAsync();

  const modelProvider = parseProviderFromModelReference(options.requestedModel);
  if (modelProvider !== undefined) {
    return providerEnvKeys[modelProvider] ? modelProvider : undefined;
  }

  const activeProvider = normalizeProviderId(options.activeProviderId);
  if (activeProvider && providerEnvKeys[activeProvider]) {
    return activeProvider;
  }

  const parentEnv = options.parentEnv;
  if (!parentEnv) {
    return undefined;
  }

  for (const [providerId, envKey] of Object.entries(providerEnvKeys)) {
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

  const providerEnvKeys = await getProviderEnvKeysAsync();
  return providerEnvKeys[normalizedProviderId];
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
): Promise<boolean> {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return false;
  }

  const envKey = await resolveProviderEnvKeyAsync(normalizedProviderId);
  if (typeof envKey !== "string" || envKey.trim().length === 0) {
    return false;
  }

  return getDirectEnvDelegationProviderIds().has(normalizedProviderId);
}

export async function shouldSkipDelegatedMultiAuthForProviderAsync(
  providerId: string | undefined,
): Promise<boolean> {
  return isDirectEnvDelegationAuthAvailableForProviderAsync(providerId);
}

export function shouldInheritParentCredentialEnvForProvider(
  providerId: string | undefined,
): boolean {
  return shouldInheritParentCredentialEnv(providerId);
}

export async function tryAcquireKeyForSubagent(
  sessionId: string,
  providerId: string | undefined,
  options: {
    timeoutMs?: number;
    requestedModel?: string;
    modelContext?: {
      providerId?: string;
      modelId?: string;
      modelRef?: string;
      api?: string;
    };
    parentSessionId?: string;
  } = {},
): Promise<SubagentKeyLease | null> {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }

  const providerEnvKeys = await getProviderEnvKeysAsync();
  const envKey = providerEnvKeys[normalizedProviderId];
  if (!envKey) {
    return null;
  }

  const distributor = getGlobalKeyDistributor();
  if (!distributor) {
    return null;
  }

  const fallbackPolicy = getCredentialFallbackPolicy(normalizedProviderId);
  const parentFallbackAllowed = fallbackPolicy === "parent-env";
  const hasParentFallbackCredential =
    parentFallbackAllowed && hasUsableEnvValue(process.env, envKey);
  const effectiveTimeoutMs = resolveAcquireTimeoutMs(
    options.timeoutMs,
    hasParentFallbackCredential,
    parentFallbackAllowed,
  );
  const abortController = new AbortController();
  const delegatedRequest = resolveDelegatedCredentialRequest({
    sessionId,
    providerId: normalizedProviderId,
    timeoutMs: effectiveTimeoutMs,
    requestedModel: options.requestedModel,
    modelContext: options.modelContext,
    parentSessionId: options.parentSessionId,
    signal: abortController.signal,
  });
  const modelId = delegatedRequest.modelId;
  const startedAt = Date.now();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutSentinel = Symbol("subagent-key-acquire-timeout");

  if (normalizedProviderId === "openai-codex" && !delegatedRequest.modelId) {
    void piAgentRouterDebugLogger.warn("subagent.key_acquire_missing_model_context", {
      message:
        `[pi-agent-router] Refused distributed ${normalizedProviderId} credential acquisition for subagent ${sessionId.slice(0, 8)} because model context is required by provider policy.`,
      providerId: normalizedProviderId,
      sessionId,
      fallbackPolicy,
    });
    return null;
  }

  try {
    const existingLease = resolveApiKeyFromLease(
      await distributor.getLeaseForSession?.(sessionId),
      distributor,
      sessionId,
    );
    if (existingLease) {
      void piAgentRouterDebugLogger.info("subagent.key_reused", {
        message:
          `[pi-agent-router] Reused distributed ${normalizedProviderId} key ${existingLease.credentialId} for subagent ${sessionId.slice(0, 8)}.`,
        providerId: normalizedProviderId,
        credentialId: existingLease.credentialId,
        sessionId,
        acquisitionLatencyMs: Date.now() - startedAt,
      });
      return {
        providerId: normalizedProviderId,
        envKey,
        credentialId: existingLease.credentialId,
        apiKey: existingLease.apiKey,
      };
    }

    const shouldBypassDelegatedAcquisition = await distributor.shouldBypassDelegatedSubagentAcquisition?.(
      normalizedProviderId,
      {
        modelId,
        modelRef: delegatedRequest.modelRef,
        api: delegatedRequest.api,
        signal: abortController.signal,
      },
    );
    if (shouldBypassDelegatedAcquisition && parentFallbackAllowed) {
      void piAgentRouterDebugLogger.info("subagent.key_acquire_bypassed", {
        message:
          `[pi-agent-router] Skipped distributed ${normalizedProviderId} key acquisition for subagent ${sessionId.slice(0, 8)} because only one eligible credential remains and parent environment credential fallback is allowed.`,
        providerId: normalizedProviderId,
        sessionId,
        acquisitionLatencyMs: Date.now() - startedAt,
        fallbackPolicy,
      });
      return null;
    }

    if (shouldBypassDelegatedAcquisition) {
      void piAgentRouterDebugLogger.info("subagent.key_acquire_bypass_ignored", {
        message:
          `[pi-agent-router] Keeping distributed ${normalizedProviderId} key acquisition for subagent ${sessionId.slice(0, 8)} because parent environment credential fallback is disabled by provider policy.`,
        providerId: normalizedProviderId,
        sessionId,
        acquisitionLatencyMs: Date.now() - startedAt,
        fallbackPolicy,
      });
    }

    const acquiredLease = await Promise.race<
      KeyLease | string | null | undefined | typeof timeoutSentinel
    >([
      distributor.acquireForSubagent(delegatedRequest),
      new Promise<typeof timeoutSentinel>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve(timeoutSentinel);
        }, effectiveTimeoutMs);
      }),
    ]);

    if (acquiredLease === timeoutSentinel) {
      abortController.abort();
      void piAgentRouterDebugLogger.warn("subagent.key_acquire_timeout", {
        message: parentFallbackAllowed
          ? `[pi-agent-router] Timed out acquiring ${normalizedProviderId} key for subagent ${sessionId.slice(0, 8)} after ${effectiveTimeoutMs}ms; parent environment credential remains allowed by provider policy.`
          : `[pi-agent-router] Timed out acquiring ${normalizedProviderId} key for subagent ${sessionId.slice(0, 8)} after ${effectiveTimeoutMs}ms; parent environment credential fallback is disabled by provider policy.`,
        providerId: normalizedProviderId,
        sessionId,
        timeoutMs: effectiveTimeoutMs,
        acquisitionLatencyMs: Date.now() - startedAt,
        fallbackPolicy,
        fallbackEnvAvailable: hasParentFallbackCredential,
        routingCapabilities: await getRoutingCapabilitiesSafe(distributor, delegatedRequest),
        distributorMetrics: distributor.getMetrics?.(),
      });
      return null;
    }

    const lease = resolveApiKeyFromLease(acquiredLease, distributor, sessionId);
    if (!lease) {
      void piAgentRouterDebugLogger.info("subagent.key_acquire_unavailable", {
        message: parentFallbackAllowed
          ? `[pi-agent-router] No distributed ${normalizedProviderId} key was available for subagent ${sessionId.slice(0, 8)}; parent environment credential remains allowed by provider policy.`
          : `[pi-agent-router] No distributed ${normalizedProviderId} key was available for subagent ${sessionId.slice(0, 8)}; parent environment credential fallback is disabled by provider policy.`,
        providerId: normalizedProviderId,
        sessionId,
        fallbackPolicy,
        routingCapabilities: await getRoutingCapabilitiesSafe(distributor, delegatedRequest),
      });
      return null;
    }

    void piAgentRouterDebugLogger.info("subagent.key_acquired", {
      message:
        `[pi-agent-router] Acquired distributed ${normalizedProviderId} key ${lease.credentialId} for subagent ${sessionId.slice(0, 8)}.`,
      providerId: normalizedProviderId,
      credentialId: lease.credentialId,
      sessionId,
      acquisitionLatencyMs: Date.now() - startedAt,
      distributorMetrics: distributor.getMetrics?.(),
    });

    return {
      providerId: normalizedProviderId,
      envKey,
      credentialId: lease.credentialId,
      apiKey: lease.apiKey,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return null;
    }

    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.key_acquire_failed", {
      error: message,
      message: parentFallbackAllowed
        ? `[pi-agent-router] Failed to acquire ${normalizedProviderId} key for subagent ${sessionId.slice(0, 8)}: ${message}. Parent environment credential remains allowed by provider policy.`
        : `[pi-agent-router] Failed to acquire ${normalizedProviderId} key for subagent ${sessionId.slice(0, 8)}: ${message}. Parent environment credential fallback is disabled by provider policy.`,
      providerId: normalizedProviderId,
      sessionId,
      fallbackPolicy,
      acquisitionLatencyMs: Date.now() - startedAt,
      routingCapabilities: await getRoutingCapabilitiesSafe(distributor, delegatedRequest),
      distributorMetrics: distributor.getMetrics?.(),
    });
    return null;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function releaseKeyForSubagent(sessionId: string): void {
  const distributor = getGlobalKeyDistributor();
  if (!distributor) {
    return;
  }

  try {
    distributor.releaseFromSubagent(sessionId);
    void piAgentRouterDebugLogger.info("subagent.key_released", {
      message: `[pi-agent-router] Released distributed key for subagent ${sessionId.slice(0, 8)}.`,
      sessionId,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.key_release_failed", {
      error: message,
      message: `[pi-agent-router] Failed to release distributed key for subagent ${sessionId.slice(0, 8)}: ${message}.`,
      sessionId,
    });
  }
}

export function releaseKeyLeasesForParentSession(parentSessionId: string): void {
  const normalizedParentSessionId = parentSessionId.trim();
  if (!normalizedParentSessionId) {
    return;
  }

  const distributor = getGlobalKeyDistributor();
  if (!distributor?.releaseLightweightSessionLeases) {
    return;
  }

  try {
    distributor.releaseLightweightSessionLeases(normalizedParentSessionId);
    void piAgentRouterDebugLogger.info("subagent.parent_session_key_leases_released", {
      message: `[pi-agent-router] Released lightweight distributed key leases for parent session ${normalizedParentSessionId.slice(0, 8)}.`,
      parentSessionId: normalizedParentSessionId,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.parent_session_key_lease_release_failed", {
      error: message,
      message: `[pi-agent-router] Failed to release lightweight distributed key leases for parent session ${normalizedParentSessionId.slice(0, 8)}: ${message}.`,
      parentSessionId: normalizedParentSessionId,
    });
  }
}

const QUOTA_RATE_LIMIT_PATTERNS: RegExp[] = [
  /quota/i,
  /rate[_\s-]?limit/i,
  /rate_limit/i,
  /\b429\b/,
  /\b503\b/,
  /insufficient[_\s-]?quota/i,
  /exceeded/i,
  /exhausted/i,
  /resource[_\s-]?exhausted/i,
  /overloaded/i,
  /capacity/i,
  /too many requests/i,
  /model is currently loaded/i,
  /server busy/i,
  // Weekly quota patterns (Ollama)
  /weekly\s+(?:usage|limit)/i,
  /usage limit/i,
  /upgrade for higher limits/i,
];

/**
 * Patterns indicating balance exhaustion that requires manual intervention.
 * These credentials should be DISABLED (not just cooled down) because
 * the account has no credits and requires manual action to add funds.
 */
const BALANCE_EXHAUSTED_PATTERNS: RegExp[] = [
  /outstanding[_\s-]?balance/i,
  /balance[_\s-]?too[_\s-]?low/i,
  /insufficient[_\s-]?balance/i,
  /no[_\s-]?credits?[_\s-]?(?:remaining|left)/i,
  /account[_\s-]?has[_\s-]?no[_\s-]?credits/i,
  /credits?[_\s-]?depleted/i,
  /balance[_\s-]?depleted/i,
  /please[_\s-]?add[_\s-]?credits/i,
  /please[_\s-]?add[_\s-]?funds/i,
];

/**
 * Patterns indicating a weekly/quota reset cycle that requires longer cooldown.
 */
const WEEKLY_QUOTA_PATTERNS: RegExp[] = [
  /weekly\s+(?:usage|credit|limit)/i,
  /your\s+weekly/i,
  /reached your weekly/i,
  /\bweekly\b[^\n.]*\blimit\b/i,
  /\bweekly\b[^\n.]*\bquota\b/i,
  /7-?day\s+(?:limit|window)/i,
  /upgrade for higher limits/i,
];

const TRANSIENT_PROVIDER_PATTERNS: RegExp[] = [
  /\b5\d\d\b/i,
  /internal[_\s-]?server[_\s-]?error/i,
  /internal_server_error/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /upstream[^\n]*(?:timeout|error|failed|unavailable)/i,
  /temporar(?:y|ily) unavailable/i,
  /please try again later/i,
  /timeout/i,
  /timed out/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /network error/i,
  /fetch failed/i,
  /request was aborted/i,
  /operation was aborted/i,
  /\bAbortError\b/i,
  /without any assistant output/i,
  /without a final assistant output/i,
  /without completion event/i,
  /stream ended unexpectedly/i,
];

const MODEL_NOT_SUPPORTED_PATTERNS: RegExp[] = [
  /unsupported model/i,
  /model[^\n]*(?:not found|not supported)/i,
  /unknown model/i,
];

const DEFAULT_QUOTA_COOLDOWN_MS = 60_000; // 1 minute for regular quota errors
export const KEY_DISTRIBUTION_ATTEMPT_CACHE_MAX_ENTRIES = 1_024;

/**
 * Checks whether an error message indicates a quota or rate-limit condition
 * that may be resolved by rotating to a different API credential.
 */
export function isQuotaOrRateLimitError(errorText: string): boolean {
  if (!errorText) {
    return false;
  }

  return (
    QUOTA_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorText)) ||
    BALANCE_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(errorText)) ||
    WEEKLY_QUOTA_PATTERNS.some((pattern) => pattern.test(errorText))
  );
}

/**
 * Checks whether an error message indicates a retryable transient transport/provider failure.
 */
export function isTransientCredentialError(errorText: string): boolean {
  if (!errorText) {
    return false;
  }

  return TRANSIENT_PROVIDER_PATTERNS.some((pattern) => pattern.test(errorText));
}

/**
 * Vivgrid sometimes reports model availability mismatches as 400 errors even though
 * rotating to another credential resolves the request. Treat those as retryable
 * delegated credential failures instead of terminal invalid requests.
 */
export function isRetryableModelAvailabilityError(
  providerId: string | undefined,
  errorText: string,
): boolean {
  if (!errorText || !providerId) {
    return false;
  }

  if (providerId.trim().toLowerCase() !== "vivgrid") {
    return false;
  }

  return MODEL_NOT_SUPPORTED_PATTERNS.some((pattern) => pattern.test(errorText));
}

/**
 * Checks whether an error message indicates balance exhaustion.
 * Balance exhaustion requires manual intervention (add credits/funds).
 * Credentials with this error should be DISABLED until manually re-enabled.
 */
export function isBalanceExhaustedError(errorText: string): boolean {
  if (!errorText) {
    return false;
  }
  return BALANCE_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(errorText));
}

/**
 * Checks whether an error message indicates a weekly quota limit.
 * Weekly quotas require longer cooldown periods.
 */
function isWeeklyQuotaError(errorText: string): boolean {
  if (!errorText) {
    return false;
  }
  return WEEKLY_QUOTA_PATTERNS.some((pattern) => pattern.test(errorText));
}

/**
 * Weekly quota and transient provider attempt tracking for exponential backoff.
 * Bounded by credentialId to prevent unbounded long-lived process growth.
 */
const weeklyQuotaAttempts = createBoundedCache<string, number>(KEY_DISTRIBUTION_ATTEMPT_CACHE_MAX_ENTRIES);
const transientProviderAttempts = createBoundedCache<string, number>(KEY_DISTRIBUTION_ATTEMPT_CACHE_MAX_ENTRIES);

/**
 * Reports a quota/rate-limit error on a credential to the global KeyDistributor
 * so the failed credential receives a cooldown period and subsequent acquisitions
 * rotate to a healthy credential.
 *
 * For balance exhaustion errors: Permanently disables the credential until manually re-enabled.
 * For weekly quota errors: Applies exponential backoff:
 * - 1st error: 12 hours
 * - 2nd consecutive: 24 hours
 * - 3rd consecutive: 48 hours
 * - 4th+: 72 hours (max)
 */
export function reportSubagentKeyError(
  sessionId: string,
  credentialId: string,
  errorMessage: string,
): void {
  if (!credentialId) {
    return;
  }

  const distributor = getGlobalKeyDistributor();
  if (!distributor?.applyCooldown && !distributor?.disableCredential) {
    return;
  }

  const isBalanceExhausted = isBalanceExhaustedError(errorMessage);
  const isWeekly = isWeeklyQuotaError(errorMessage);

  // Balance exhaustion: disable credential permanently (requires manual re-enable)
  if (isBalanceExhausted) {
    weeklyQuotaAttempts.delete(credentialId);
    const reason = `Subagent ${sessionId.slice(0, 8)} balance exhausted: ${errorMessage.slice(0, 200)}`;

    if (distributor.disableCredential) {
      try {
        distributor.disableCredential(credentialId, reason, undefined);
        void piAgentRouterDebugLogger.info("subagent.credential_disabled", {
          credentialId,
          message:
            `[pi-agent-router] Disabled credential ${credentialId} for subagent ${sessionId.slice(0, 8)} due to balance exhaustion.`,
          sessionId,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        void piAgentRouterDebugLogger.warn("subagent.credential_disable_failed", {
          credentialId,
          error: message,
          message: `[pi-agent-router] Failed to disable credential ${credentialId}: ${message}.`,
          sessionId,
        });
      }
    } else if (distributor.applyCooldown) {
      // Fallback: apply a very long cooldown if disableCredential is not available
      const fallbackCooldownMs = 72 * 60 * 60 * 1000; // 72 hours
      try {
        distributor.applyCooldown(
          credentialId,
          fallbackCooldownMs,
          reason,
          undefined,
          false,
          errorMessage.slice(0, 500),
        );
        void piAgentRouterDebugLogger.info("subagent.credential_balance_cooldown_applied", {
          cooldownMs: fallbackCooldownMs,
          credentialId,
          message:
            `[pi-agent-router] Applied 72h cooldown on credential ${credentialId} for subagent ${sessionId.slice(0, 8)} (balance exhausted).`,
          sessionId,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        void piAgentRouterDebugLogger.warn("subagent.credential_cooldown_failed", {
          credentialId,
          error: message,
          message: `[pi-agent-router] Failed to apply cooldown for credential ${credentialId}: ${message}.`,
          sessionId,
        });
      }
    }
    return;
  }

  if (!distributor.applyCooldown) {
    return;
  }

  let cooldownMs: number;
  let reasonPrefix: string;

  if (isWeekly) {
    // Exponential backoff for weekly quota
    const attempts = (weeklyQuotaAttempts.get(credentialId) ?? 0) + 1;
    weeklyQuotaAttempts.set(credentialId, attempts);
    cooldownMs = getWeeklyQuotaCooldownMs(attempts);
    reasonPrefix = `Subagent ${sessionId.slice(0, 8)} weekly quota error (attempt ${attempts})`;
  } else {
    // Reset weekly attempts for non-weekly errors
    weeklyQuotaAttempts.delete(credentialId);
    cooldownMs = DEFAULT_QUOTA_COOLDOWN_MS;
    reasonPrefix = `Subagent ${sessionId.slice(0, 8)} quota/rate-limit error`;
  }

  try {
    const reason = `${reasonPrefix}: ${errorMessage.slice(0, 200)}`;
    distributor.applyCooldown(
      credentialId,
      cooldownMs,
      reason,
      undefined,
      isWeekly,
      errorMessage.slice(0, 500),
    );
    void piAgentRouterDebugLogger.info("subagent.credential_cooldown_reported", {
      cooldownHours: cooldownMs / (60 * 60 * 1000),
      cooldownMs,
      credentialId,
      isWeekly,
      message:
        `[pi-agent-router] Reported ${isWeekly ? 'weekly ' : ''}cooldown on credential ${credentialId} for subagent ${sessionId.slice(0, 8)} (${cooldownMs / (60 * 60 * 1000)}h).`,
      sessionId,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.credential_error_report_failed", {
      credentialId,
      error: message,
      message: `[pi-agent-router] Failed to report key error for subagent ${sessionId.slice(0, 8)}: ${message}.`,
      sessionId,
    });
  }
}

/**
 * Reports a retryable transient provider/transport error and applies a short cooldown
 * so the next delegated retry prefers a different credential when available.
 */
export function reportSubagentTransientKeyError(
  sessionId: string,
  credentialId: string,
  errorMessage: string,
): void {
  if (!credentialId) {
    return;
  }

  const distributor = getGlobalKeyDistributor();
  if (!distributor?.applyCooldown) {
    return;
  }

  weeklyQuotaAttempts.delete(credentialId);
  const attempts = (transientProviderAttempts.get(credentialId) ?? 0) + 1;
  transientProviderAttempts.set(credentialId, attempts);
  const cooldownMs = computeExponentialBackoffMs(
    TRANSIENT_COOLDOWN_BASE_MS,
    attempts,
    TRANSIENT_COOLDOWN_MAX_MS,
  );

  const reason = `Subagent ${sessionId.slice(0, 8)} transient provider error: ${errorMessage.slice(0, 200)}`;

  try {
    distributor.applyCooldown(
      credentialId,
      cooldownMs,
      reason,
      undefined,
      false,
      errorMessage.slice(0, 500),
    );
    void piAgentRouterDebugLogger.info("subagent.credential_transient_cooldown_applied", {
      attempt: attempts,
      cooldownMs,
      credentialId,
      message:
        `[pi-agent-router] Applied transient cooldown on credential ${credentialId} for subagent ${sessionId.slice(0, 8)} (${cooldownMs}ms, attempt ${attempts}).`,
      sessionId,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    void piAgentRouterDebugLogger.warn("subagent.transient_key_error_report_failed", {
      credentialId,
      error: message,
      message: `[pi-agent-router] Failed to report transient key error for subagent ${sessionId.slice(0, 8)}: ${message}.`,
      sessionId,
    });
  }
}

export function clearSubagentTransientKeyError(credentialId: string): void {
  if (!credentialId) {
    return;
  }

  transientProviderAttempts.delete(credentialId);

  const distributor = getGlobalKeyDistributor();
  if (!distributor?.clearTransientError) {
    return;
  }

  try {
    void distributor.clearTransientError(credentialId);
  } catch {
    // ignore cleanup failures
  }
}

/**
 * Clears the weekly quota attempt counter for a credential.
 * Should be called when a credential successfully completes a request.
 */
export function clearWeeklyQuotaAttempts(credentialId: string): void {
  weeklyQuotaAttempts.delete(credentialId);
}
