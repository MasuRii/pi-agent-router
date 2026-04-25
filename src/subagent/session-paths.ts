/**
 * Session directory and path management utilities.
 */

import { copyFileSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { AGENT_DIR, SESSIONS_DIR, SUBAGENT_SESSIONS_DIR } from "../constants";
import { getErrorMessage } from "../error-utils";
import { normalizeInputText } from "../input-normalization";

const ISOLATED_AGENT_RUNTIME_FILES = ["auth.json", "settings.json", "models.json", "multi-auth.json"] as const;

export function prepareIsolatedAgentDirectory(parentTempDir: string): { agentDir: string } | { error: string } {
  const normalizedParentDir = normalizeInputText(parentTempDir);
  if (!normalizedParentDir) {
    return { error: "Failed to prepare isolated agent directory: parent temp directory is empty." };
  }

  const resolvedParentDir = resolve(normalizedParentDir);

  try {
    mkdirSync(resolvedParentDir, { recursive: true });
  } catch (error) {
    const message = getErrorMessage(error);
    return { error: `Failed to create parent temp directory '${resolvedParentDir}': ${message}` };
  }

  let isolatedDir: string;
  try {
    isolatedDir = mkdtempSync(join(resolvedParentDir, "agent-home-"));
  } catch (error) {
    const message = getErrorMessage(error);
    return { error: `Failed to create isolated agent directory in '${resolvedParentDir}': ${message}` };
  }

  try {
    for (const runtimeFile of ISOLATED_AGENT_RUNTIME_FILES) {
      const sourcePath = join(AGENT_DIR, runtimeFile);
      if (!isFile(sourcePath)) {
        continue;
      }

      copyFileSync(sourcePath, join(isolatedDir, runtimeFile));
    }
  } catch (error) {
    const message = getErrorMessage(error);
    return { error: `Failed to copy runtime files into '${isolatedDir}': ${message}` };
  }

  return { agentDir: isolatedDir };
}

export async function prepareIsolatedAgentDirectoryAsync(
  parentTempDir: string,
): Promise<{ agentDir: string } | { error: string }> {
  const normalizedParentDir = normalizeInputText(parentTempDir);
  if (!normalizedParentDir) {
    return { error: "Failed to prepare isolated agent directory: parent temp directory is empty." };
  }

  const resolvedParentDir = resolve(normalizedParentDir);

  try {
    await mkdir(resolvedParentDir, { recursive: true });
  } catch (error) {
    const message = getErrorMessage(error);
    return { error: `Failed to create parent temp directory '${resolvedParentDir}': ${message}` };
  }

  let isolatedDir: string;
  try {
    isolatedDir = await mkdtemp(join(resolvedParentDir, "agent-home-"));
  } catch (error) {
    const message = getErrorMessage(error);
    return { error: `Failed to create isolated agent directory in '${resolvedParentDir}': ${message}` };
  }

  try {
    await Promise.all(
      ISOLATED_AGENT_RUNTIME_FILES.map(async (runtimeFile) => {
        const sourcePath = join(AGENT_DIR, runtimeFile);
        if (!(await isFileAsync(sourcePath))) {
          return;
        }

        await copyFile(sourcePath, join(isolatedDir, runtimeFile));
      }),
    );
  } catch (error) {
    const message = getErrorMessage(error);
    return { error: `Failed to copy runtime files into '${isolatedDir}': ${message}` };
  }

  return { agentDir: isolatedDir };
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function isDirectoryAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function isFileAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function encodeSessionDirectoryForCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function buildSessionPathFromHeader(id: string, timestamp: string, cwd: string, sessionDir?: string): string {
  const baseSessionDir = sessionDir ? resolve(sessionDir) : join(SESSIONS_DIR, encodeSessionDirectoryForCwd(cwd));
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  return join(baseSessionDir, `${fileTimestamp}_${id}.jsonl`);
}

export function resolveExistingWorkingDirectory(preferredCwd: string): string {
  const normalized = normalizeInputText(preferredCwd);
  if (normalized) {
    const resolvedPreferred = resolve(normalized);
    if (isDirectory(resolvedPreferred)) {
      return resolvedPreferred;
    }
  }

  return resolve(process.cwd());
}

export async function resolveExistingWorkingDirectoryAsync(preferredCwd: string): Promise<string> {
  const normalized = normalizeInputText(preferredCwd);
  if (normalized) {
    const resolvedPreferred = resolve(normalized);
    if (await isDirectoryAsync(resolvedPreferred)) {
      return resolvedPreferred;
    }
  }

  return resolve(process.cwd());
}

export function resolveSubagentSessionDirectory(cwd: string, existingSessionPath?: string): { sessionDir: string } | { error: string } {
  const normalizedSessionPath = normalizeInputText(existingSessionPath);
  const sessionDir = normalizedSessionPath
    ? dirname(resolve(normalizedSessionPath))
    : join(SUBAGENT_SESSIONS_DIR, encodeSessionDirectoryForCwd(resolve(cwd)));

  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      error: `Failed to prepare subagent session directory '${sessionDir}': ${message}`,
    };
  }

  if (!isDirectory(sessionDir)) {
    return {
      error: `Failed to prepare subagent session directory '${sessionDir}': path is not a directory.`,
    };
  }

  return { sessionDir };
}

export async function resolveSubagentSessionDirectoryAsync(
  cwd: string,
  existingSessionPath?: string,
): Promise<{ sessionDir: string } | { error: string }> {
  const normalizedSessionPath = normalizeInputText(existingSessionPath);
  const sessionDir = normalizedSessionPath
    ? dirname(resolve(normalizedSessionPath))
    : join(SUBAGENT_SESSIONS_DIR, encodeSessionDirectoryForCwd(resolve(cwd)));

  try {
    await mkdir(sessionDir, { recursive: true });
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      error: `Failed to prepare subagent session directory '${sessionDir}': ${message}`,
    };
  }

  if (!(await isDirectoryAsync(sessionDir))) {
    return {
      error: `Failed to prepare subagent session directory '${sessionDir}': path is not a directory.`,
    };
  }

  return { sessionDir };
}

export function resolveSubagentWorkingDirectory(requestedCwd: unknown, fallbackCwd: string): { cwd: string } | { error: string } {
  const baseCwd = resolveExistingWorkingDirectory(fallbackCwd);
  const normalized = normalizeInputText(requestedCwd);

  if (!normalized) {
    return { cwd: baseCwd };
  }

  if (normalized.includes("\0")) {
    return {
      error: "Invalid cwd: value contains a null byte.",
    };
  }

  const resolvedCwd = isAbsolute(normalized) ? resolve(normalized) : resolve(baseCwd, normalized);
  if (!isAbsolute(normalized)) {
    const relativeToBase = relative(baseCwd, resolvedCwd);
    if (relativeToBase === ".." || relativeToBase.startsWith("../") || relativeToBase.startsWith("..\\")) {
      return {
        error: `Invalid cwd '${normalized}': relative paths must stay within '${baseCwd}'.`,
      };
    }
  }

  if (!isDirectory(resolvedCwd)) {
    return {
      error: `Invalid cwd '${normalized}': directory does not exist (${resolvedCwd}).`,
    };
  }

  return { cwd: resolvedCwd };
}

export async function resolveSubagentWorkingDirectoryAsync(
  requestedCwd: unknown,
  fallbackCwd: string,
): Promise<{ cwd: string } | { error: string }> {
  const baseCwd = await resolveExistingWorkingDirectoryAsync(fallbackCwd);
  const normalized = normalizeInputText(requestedCwd);

  if (!normalized) {
    return { cwd: baseCwd };
  }

  if (normalized.includes("\0")) {
    return {
      error: "Invalid cwd: value contains a null byte.",
    };
  }

  const resolvedCwd = isAbsolute(normalized) ? resolve(normalized) : resolve(baseCwd, normalized);
  if (!isAbsolute(normalized)) {
    const relativeToBase = relative(baseCwd, resolvedCwd);
    if (relativeToBase === ".." || relativeToBase.startsWith("../") || relativeToBase.startsWith("..\\")) {
      return {
        error: `Invalid cwd '${normalized}': relative paths must stay within '${baseCwd}'.`,
      };
    }
  }

  if (!(await isDirectoryAsync(resolvedCwd))) {
    return {
      error: `Invalid cwd '${normalized}': directory does not exist (${resolvedCwd}).`,
    };
  }

  return { cwd: resolvedCwd };
}
