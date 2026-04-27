import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DelegatedExtensionConfigEntry,
  DelegatedExtensionSkipCondition,
} from "../config";
import { asRecord } from "../record-utils";

const VALID_DELEGATED_EXTENSION_SKIP_CONDITIONS: ReadonlySet<DelegatedExtensionSkipCondition> =
  new Set(["directEnvAuthAvailable"]);

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

export async function readDelegatedExtensionRuntimeMetadataAsync(
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
