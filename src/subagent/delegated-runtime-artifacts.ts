/**
 * Runtime artifact helpers for delegated subagent process launches.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { getErrorMessage } from "../error-utils";
import { normalizeInputText } from "../input-normalization";

export interface DelegatedRuntimeArtifact {
  path: string;
  source: string;
  requiredForLaunch: boolean;
}

export type DelegatedRuntimeArtifactRestoreResult =
  | { restoredPaths: string[] }
  | { error: string; restoredPaths: string[] };

function normalizeComparablePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

async function writeDelegatedRuntimeArtifactAsync(
  artifact: DelegatedRuntimeArtifact,
): Promise<void> {
  await mkdir(dirname(artifact.path), { recursive: true });
  await writeFile(artifact.path, artifact.source, "utf-8");
}

export async function writeDelegatedRuntimeArtifactsAsync(
  artifacts: readonly DelegatedRuntimeArtifact[],
): Promise<void> {
  await Promise.all(artifacts.map(writeDelegatedRuntimeArtifactAsync));
}

export async function restoreMissingDelegatedRuntimeArtifactsAsync(
  artifacts: readonly DelegatedRuntimeArtifact[],
  isFileAsync: (path: string) => Promise<boolean>,
): Promise<DelegatedRuntimeArtifactRestoreResult> {
  const missingArtifacts: DelegatedRuntimeArtifact[] = [];

  for (const artifact of artifacts) {
    if (!(await isFileAsync(artifact.path))) {
      missingArtifacts.push(artifact);
    }
  }

  if (missingArtifacts.length === 0) {
    return { restoredPaths: [] };
  }

  const restoredPaths = missingArtifacts.map((artifact) => artifact.path);
  try {
    await writeDelegatedRuntimeArtifactsAsync(missingArtifacts);
    return { restoredPaths };
  } catch (error) {
    return {
      error: `Failed to restore delegated runtime artifact(s) ${restoredPaths.join(", ")}: ${getErrorMessage(error)}`,
      restoredPaths,
    };
  }
}

export function isDelegatedRuntimeArtifactLoadFailure(
  stderr: string,
  artifacts: readonly DelegatedRuntimeArtifact[],
): boolean {
  const normalizedStderr = normalizeInputText(stderr);
  if (!normalizedStderr) {
    return false;
  }

  if (!/Failed to load extension|Extension path does not exist|Cannot find module|ENOENT|no such file/i.test(normalizedStderr)) {
    return false;
  }

  const comparableStderr = normalizeComparablePath(normalizedStderr);
  return artifacts
    .filter((artifact) => artifact.requiredForLaunch)
    .some((artifact) => {
      const comparablePath = normalizeComparablePath(artifact.path);
      const artifactBasename = basename(artifact.path).toLowerCase();
      return comparableStderr.includes(comparablePath) || comparableStderr.includes(artifactBasename);
    });
}
