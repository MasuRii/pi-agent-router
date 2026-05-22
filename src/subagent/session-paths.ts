/**
 * Session directory and path management utilities.
 */

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { AGENT_DIR, SESSIONS_DIR, SUBAGENT_SESSIONS_DIR } from "../constants";
import { getErrorMessage } from "../error-utils";
import { normalizeInputText } from "../input-normalization";

const ISOLATED_AGENT_RUNTIME_FILES = ["auth.json", "settings.json", "models.json"] as const;
const ISOLATED_AGENT_DIR_MODE = 0o700;
const ISOLATED_AGENT_RUNTIME_FILE_MODE = 0o600;
const SAFE_SESSION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SESSION_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/;

function isPathInsideDirectory(parentDir: string, candidatePath: string): boolean {
  const relativePath = relative(parentDir, candidatePath);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function normalizeSafeSessionIdentifier(value: unknown): string | undefined {
  const normalized = normalizeInputText(value);
  if (!normalized || !SAFE_SESSION_IDENTIFIER_PATTERN.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function normalizeSafeSessionTimestamp(value: unknown): string | undefined {
  const normalized = normalizeInputText(value).replace(/[:.]/g, "-");
  if (!normalized || !SAFE_SESSION_IDENTIFIER_PATTERN.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function validateRetainedSessionPath(resolvedSessionPath: string): string | undefined {
  const resolvedSubagentSessionsDir = resolve(SUBAGENT_SESSIONS_DIR);
  if (!isPathInsideDirectory(resolvedSubagentSessionsDir, resolvedSessionPath)) {
    return `Invalid retained session path '${resolvedSessionPath}': path must stay within '${resolvedSubagentSessionsDir}'.`;
  }

  const filename = basename(resolvedSessionPath);
  if (!SAFE_SESSION_FILENAME_PATTERN.test(filename)) {
    return `Invalid retained session path '${resolvedSessionPath}': filename must be a safe .jsonl session filename.`;
  }

  return undefined;
}

function hardenIsolatedAgentDirectory(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, ISOLATED_AGENT_DIR_MODE);
  }
}

async function hardenIsolatedAgentDirectoryAsync(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, ISOLATED_AGENT_DIR_MODE);
  }
}

function hardenIsolatedRuntimeFile(path: string): void {
  if (process.platform !== "win32") {
    chmodSync(path, ISOLATED_AGENT_RUNTIME_FILE_MODE);
  }
}

async function hardenIsolatedRuntimeFileAsync(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, ISOLATED_AGENT_RUNTIME_FILE_MODE);
  }
}

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
    hardenIsolatedAgentDirectory(isolatedDir);
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

      const destinationPath = join(isolatedDir, runtimeFile);
      copyFileSync(sourcePath, destinationPath);
      hardenIsolatedRuntimeFile(destinationPath);
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
    await hardenIsolatedAgentDirectoryAsync(isolatedDir);
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

        const destinationPath = join(isolatedDir, runtimeFile);
        await copyFile(sourcePath, destinationPath);
        await hardenIsolatedRuntimeFileAsync(destinationPath);
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

export function tryBuildSessionPathFromHeader(
  id: string,
  timestamp: string,
  cwd: string,
  sessionDir?: string,
  options: { requireSubagentSessionRoot?: boolean } = {},
): { sessionPath: string } | { error: string } {
  const safeSessionId = normalizeSafeSessionIdentifier(id);
  if (!safeSessionId) {
    return { error: "Invalid session event id: expected a safe filename identifier." };
  }

  const fileTimestamp = normalizeSafeSessionTimestamp(timestamp);
  if (!fileTimestamp) {
    return { error: "Invalid session event timestamp: expected a safe filename timestamp." };
  }

  const baseSessionDir = sessionDir ? resolve(sessionDir) : join(SESSIONS_DIR, encodeSessionDirectoryForCwd(cwd));
  const sessionPath = resolve(baseSessionDir, `${fileTimestamp}_${safeSessionId}.jsonl`);
  if (!isPathInsideDirectory(baseSessionDir, sessionPath)) {
    return { error: `Invalid session event path '${sessionPath}': path must stay within '${baseSessionDir}'.` };
  }

  if (options.requireSubagentSessionRoot) {
    const retainedPathError = validateRetainedSessionPath(sessionPath);
    if (retainedPathError) {
      return { error: retainedPathError };
    }
  }

  return { sessionPath };
}

export function buildSessionPathFromHeader(id: string, timestamp: string, cwd: string, sessionDir?: string): string {
  const result = tryBuildSessionPathFromHeader(id, timestamp, cwd, sessionDir);
  if ("error" in result) {
    throw new Error(result.error);
  }

  return result.sessionPath;
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
  let sessionDir: string;
  if (normalizedSessionPath) {
    if (normalizedSessionPath.includes("\0")) {
      return { error: "Invalid retained session path: value contains a null byte." };
    }

    const resolvedSessionPath = resolve(normalizedSessionPath);
    const retainedPathError = validateRetainedSessionPath(resolvedSessionPath);
    if (retainedPathError) {
      return { error: retainedPathError };
    }

    sessionDir = dirname(resolvedSessionPath);
  } else {
    sessionDir = join(SUBAGENT_SESSIONS_DIR, encodeSessionDirectoryForCwd(resolve(cwd)));
  }

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
  let sessionDir: string;
  if (normalizedSessionPath) {
    if (normalizedSessionPath.includes("\0")) {
      return { error: "Invalid retained session path: value contains a null byte." };
    }

    const resolvedSessionPath = resolve(normalizedSessionPath);
    const retainedPathError = validateRetainedSessionPath(resolvedSessionPath);
    if (retainedPathError) {
      return { error: retainedPathError };
    }

    sessionDir = dirname(resolvedSessionPath);
  } else {
    sessionDir = join(SUBAGENT_SESSIONS_DIR, encodeSessionDirectoryForCwd(resolve(cwd)));
  }

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
