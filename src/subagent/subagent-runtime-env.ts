export const PI_AGENT_ROUTER_SUBAGENT_ENV = "PI_AGENT_ROUTER_SUBAGENT";
export const PI_AGENT_ROUTER_PARENT_SESSION_ID_ENV = "PI_AGENT_ROUTER_PARENT_SESSION_ID";
export const PI_MULTI_AUTH_RUNTIME_DIR_ENV = "PI_MULTI_AUTH_RUNTIME_DIR";
export const PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV = "PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID";
export const PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV = "PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID";
export const PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV = "PI_AGENT_ROUTER_DELEGATED_API_KEY";

const SUBAGENT_PARENT_ENV_ALLOWLIST = [
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PI_AGENT_ROUTER_FONT_FAMILY",
  "PI_AGENT_ROUTER_ICON_MODE",
  "PI_AGENT_ROUTER_NERD_FONT",
  "PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS",
  "PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY",
  "PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS",
  "PI_FONT_FAMILY",
  "PI_MODE",
  "PI_NERD_FONT",
  "PI_OUTPUT_MODE",
  "PWD",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TERM_PROGRAM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function setNormalizedEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
): void {
  const normalizedValue = normalizeEnvValue(value);
  if (!normalizedValue) {
    return;
  }

  env[key] = normalizedValue;
}

export function createSubagentRuntimeEnv(parentSessionId?: string): NodeJS.ProcessEnv {
  const runtimeEnv: NodeJS.ProcessEnv = {
    [PI_AGENT_ROUTER_SUBAGENT_ENV]: "1",
  };

  const normalizedParentSessionId = normalizeEnvValue(parentSessionId);
  if (normalizedParentSessionId) {
    runtimeEnv[PI_AGENT_ROUTER_PARENT_SESSION_ID_ENV] = normalizedParentSessionId;
  }

  return runtimeEnv;
}

export function createSubagentBaseEnv(
  parentEnv: NodeJS.ProcessEnv,
  options: {
    inheritedEnvKeys?: readonly string[];
  } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of SUBAGENT_PARENT_ENV_ALLOWLIST) {
    setNormalizedEnvValue(env, key, parentEnv[key]);
  }

  for (const key of options.inheritedEnvKeys || []) {
    setNormalizedEnvValue(env, key, parentEnv[key]);
  }

  return env;
}

export function injectSubagentRuntimeEnv(
  env: NodeJS.ProcessEnv,
  parentSessionId?: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...createSubagentRuntimeEnv(parentSessionId),
  };
}

export function buildSubagentSpawnEnv(options: {
  parentEnv: NodeJS.ProcessEnv;
  parentSessionId?: string;
  isolatedAgentDir?: string;
  multiAuthRuntimeDir?: string;
  inheritedEnvKeys?: readonly string[];
  delegatedCredential?: {
    providerId: string;
    credentialId: string;
    envKey: string;
    apiKey: string;
  };
}): NodeJS.ProcessEnv {
  const env = createSubagentBaseEnv(options.parentEnv, {
    inheritedEnvKeys: options.inheritedEnvKeys,
  });

  setNormalizedEnvValue(env, "PI_CODING_AGENT_DIR", options.isolatedAgentDir);
  setNormalizedEnvValue(env, PI_MULTI_AUTH_RUNTIME_DIR_ENV, options.multiAuthRuntimeDir);

  if (options.delegatedCredential) {
    setNormalizedEnvValue(
      env,
      options.delegatedCredential.envKey,
      options.delegatedCredential.apiKey,
    );
    setNormalizedEnvValue(
      env,
      PI_AGENT_ROUTER_DELEGATED_PROVIDER_ID_ENV,
      options.delegatedCredential.providerId,
    );
    setNormalizedEnvValue(
      env,
      PI_AGENT_ROUTER_DELEGATED_CREDENTIAL_ID_ENV,
      options.delegatedCredential.credentialId,
    );
    setNormalizedEnvValue(
      env,
      PI_AGENT_ROUTER_DELEGATED_API_KEY_ENV,
      options.delegatedCredential.apiKey,
    );
  }

  return injectSubagentRuntimeEnv(env, options.parentSessionId);
}
