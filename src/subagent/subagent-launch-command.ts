export interface DelegatedSubagentBaseArgsOptions {
  sessionDir: string;
  sessionPath?: string;
  modelRef?: string;
  thinkingLevel?: string;
}

export interface DelegatedCliSpawnCommandOptions {
  cliEntrypoint: string | undefined;
  nodeExecPath: string;
  invocationArgs: readonly string[];
  hasExplicitSessionPath: boolean;
  isFile: (path: string) => Promise<boolean>;
}

export type DelegatedCliSpawnCommandResolution =
  | {
      ok: true;
      command: string;
      buildArgs: (continuationSessionPath?: string) => string[];
    }
  | {
      ok: false;
      error: string;
    };

export function createDelegatedSubagentBaseArgs(
  options: DelegatedSubagentBaseArgsOptions,
): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-extensions",
    "--offline",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session-dir",
    options.sessionDir,
  ];

  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
  }
  if (options.modelRef) {
    args.push("--model", options.modelRef);
  }
  if (options.thinkingLevel) {
    args.push("--thinking", options.thinkingLevel);
  }

  return args;
}

export async function resolveDelegatedCliSpawnCommand(
  options: DelegatedCliSpawnCommandOptions,
): Promise<DelegatedCliSpawnCommandResolution> {
  const cliEntrypoint = normalizeNonEmptyString(options.cliEntrypoint);
  const nodeExecPath = normalizeNonEmptyString(options.nodeExecPath);
  const canSpawnCurrentCli = Boolean(
    cliEntrypoint && nodeExecPath && (await options.isFile(cliEntrypoint)) && (await options.isFile(nodeExecPath)),
  );

  if (!canSpawnCurrentCli || !cliEntrypoint || !nodeExecPath) {
    return {
      ok: false,
      error:
        "[pi-agent-router] Delegated subprocess was not started because the current Pi CLI entrypoint could not be resolved to a trusted file. " +
        "Refusing to fall back to PATH lookup for bare \"pi\"; restart Pi from a file-backed CLI entrypoint or reinstall the Pi CLI so process.argv[1] points to the trusted launcher.",
    };
  }

  return {
    ok: true,
    command: nodeExecPath,
    buildArgs: (continuationSessionPath?: string) => {
      const invocationArgs = [...options.invocationArgs];
      const normalizedContinuationSessionPath = normalizeNonEmptyString(continuationSessionPath);
      if (normalizedContinuationSessionPath && !options.hasExplicitSessionPath) {
        invocationArgs.push("--session", normalizedContinuationSessionPath);
      }

      return [cliEntrypoint, ...invocationArgs];
    },
  };
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}
