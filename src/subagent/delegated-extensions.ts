import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DelegatedExtensionConfigEntry,
  DelegatedExtensionSkipCondition,
} from "../config";
import { asRecord } from "../record-utils";

const VALID_DELEGATED_EXTENSION_SKIP_CONDITIONS: ReadonlySet<DelegatedExtensionSkipCondition> =
  new Set(["directEnvAuthAvailable"]);

const REQUIRED_SECURITY_DELEGATED_EXTENSION_NAMES: ReadonlySet<string> = new Set([
  "pi-permission-system",
  "pi-sensitive-guard",
  "env-protection",
]);

const directoryResolutionCache = new Map<string, Promise<string | undefined>>();
const runtimeMetadataCache = new Map<string, Promise<DelegatedExtensionMetadataParseResult>>();

export interface DelegatedExtensionRuntimeMetadata {
  skipWhen: DelegatedExtensionSkipCondition[];
}

export interface DelegatedExtensionMetadataParseResult {
  metadata: DelegatedExtensionRuntimeMetadata;
  warnings: string[];
}

export interface DelegatedExtensionSkipContext {
  directEnvAuthAvailable: boolean;
}

function normalizeSkipWhenValue(value: unknown, warnings: string[]): DelegatedExtensionSkipCondition[] {
  if (value === undefined) {
    return [];
  }

  const rawValues = typeof value === "string" ? [value] : value;
  if (!Array.isArray(rawValues)) {
    warnings.push("Invalid delegated extension metadata skipWhen: expected a string or array of strings.");
    return [];
  }

  const skipWhen: DelegatedExtensionSkipCondition[] = [];
  const seen = new Set<DelegatedExtensionSkipCondition>();
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      warnings.push("Invalid delegated extension metadata skipWhen entry: expected a string.");
      continue;
    }

    const normalized = rawValue.trim();
    if (!VALID_DELEGATED_EXTENSION_SKIP_CONDITIONS.has(normalized as DelegatedExtensionSkipCondition)) {
      warnings.push(
        `Invalid delegated extension metadata skipWhen entry '${normalized}': expected directEnvAuthAvailable.`,
      );
      continue;
    }

    const condition = normalized as DelegatedExtensionSkipCondition;
    if (!seen.has(condition)) {
      seen.add(condition);
      skipWhen.push(condition);
    }
  }

  return skipWhen;
}

function createDirectoryResolutionCacheKey(
  extensionsRootDir: string,
  extensionCandidates: readonly string[],
): string {
  return `${extensionsRootDir}\u0000${extensionCandidates.join("\u0000")}`;
}

function cloneDelegatedExtensionMetadataParseResult(
  result: DelegatedExtensionMetadataParseResult,
): DelegatedExtensionMetadataParseResult {
  return {
    metadata: {
      skipWhen: [...result.metadata.skipWhen],
    },
    warnings: [...result.warnings],
  };
}

async function readDelegatedExtensionRuntimeMetadataUncachedAsync(
  extensionDir: string,
): Promise<DelegatedExtensionMetadataParseResult> {
  const packageJsonPath = join(extensionDir, "package.json");

  try {
    const rawPackageJson = await readFile(packageJsonPath, "utf-8");
    return parseDelegatedExtensionRuntimeMetadata(JSON.parse(rawPackageJson) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { metadata: { skipWhen: [] }, warnings: [] };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      metadata: { skipWhen: [] },
      warnings: [`Failed to read delegated extension metadata '${packageJsonPath}': ${message}`],
    };
  }
}

export function invalidateDelegatedExtensionRuntimeCaches(): void {
  directoryResolutionCache.clear();
  runtimeMetadataCache.clear();
}

export function parseDelegatedExtensionRuntimeMetadata(
  packageMetadata: unknown,
): DelegatedExtensionMetadataParseResult {
  const warnings: string[] = [];
  const packageRecord = asRecord(packageMetadata);
  const routerRecord = asRecord(packageRecord?.piAgentRouter);
  const delegatedRuntimeRecord = asRecord(routerRecord?.delegatedRuntime);

  return {
    metadata: {
      skipWhen: normalizeSkipWhenValue(delegatedRuntimeRecord?.skipWhen, warnings),
    },
    warnings,
  };
}

export async function resolveDelegatedExtensionDirectoryAsync(
  extensionsRootDir: string,
  extensionCandidates: readonly string[],
  isDirectoryAsync: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  const cacheKey = createDirectoryResolutionCacheKey(extensionsRootDir, extensionCandidates);
  const cachedResolution = directoryResolutionCache.get(cacheKey);
  if (cachedResolution) {
    return cachedResolution;
  }

  const resolutionPromise = (async () => {
    for (const extensionName of extensionCandidates) {
      const extensionDir = join(extensionsRootDir, extensionName);
      if (await isDirectoryAsync(extensionDir)) {
        return extensionDir;
      }
    }

    return undefined;
  })().catch((error: unknown) => {
    directoryResolutionCache.delete(cacheKey);
    throw error;
  });

  directoryResolutionCache.set(cacheKey, resolutionPromise);
  return resolutionPromise;
}

export async function readDelegatedExtensionRuntimeMetadataAsync(
  extensionDir: string,
): Promise<DelegatedExtensionMetadataParseResult> {
  const cachedMetadata = runtimeMetadataCache.get(extensionDir);
  if (cachedMetadata) {
    return cloneDelegatedExtensionMetadataParseResult(await cachedMetadata);
  }

  const metadataPromise = readDelegatedExtensionRuntimeMetadataUncachedAsync(extensionDir);
  runtimeMetadataCache.set(extensionDir, metadataPromise);
  return cloneDelegatedExtensionMetadataParseResult(await metadataPromise);
}

export function isSecurityCriticalDelegatedExtensionEntry(
  configEntry: DelegatedExtensionConfigEntry,
): boolean {
  return configEntry.candidates.some((candidate) =>
    REQUIRED_SECURITY_DELEGATED_EXTENSION_NAMES.has(candidate),
  );
}

export function getMissingRequiredDelegatedSecurityExtensionError(
  configEntry: DelegatedExtensionConfigEntry,
  missingExtensionCandidates: string,
): string | undefined {
  if (configEntry.optional || !isSecurityCriticalDelegatedExtensionEntry(configEntry)) {
    return undefined;
  }

  return [
    `Required delegated security extension is missing: ${missingExtensionCandidates}.`,
    "Delegated subagents run with --no-extensions, so permission and sensitive-data controls must be explicitly loaded.",
    `Install one of ${configEntry.candidates.join(", ")} or mark this delegated extension entry optional only when that security control is intentionally not required.`,
  ].join(" ");
}

export function mergeDelegatedExtensionSkipWhen(
  configEntry: DelegatedExtensionConfigEntry,
  metadata: DelegatedExtensionRuntimeMetadata,
): DelegatedExtensionSkipCondition[] {
  const merged: DelegatedExtensionSkipCondition[] = [];
  const seen = new Set<DelegatedExtensionSkipCondition>();

  for (const condition of [...configEntry.skipWhen, ...metadata.skipWhen]) {
    if (!seen.has(condition)) {
      seen.add(condition);
      merged.push(condition);
    }
  }

  return merged;
}

export function shouldSkipDelegatedExtension(
  skipWhen: readonly DelegatedExtensionSkipCondition[],
  context: DelegatedExtensionSkipContext,
): boolean {
  return skipWhen.includes("directEnvAuthAvailable") && context.directEnvAuthAvailable;
}
