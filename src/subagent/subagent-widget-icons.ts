import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPiAgentRouterConfig, type SubagentWidgetIconConfigMode } from "../config";

export type SubagentWidgetIconMode = "nerd" | "fallback";

export type SubagentWidgetIcons = {
  running: string;
  queued: string;
};

export type ResolvedSubagentWidgetIcons = {
  mode: SubagentWidgetIconMode;
  icons: SubagentWidgetIcons;
};

export type SubagentWidgetIconDetectionContext = {
  platform: string;
  env: Record<string, string | undefined>;
  pathExists: (path: string) => boolean;
  readTextFile: (path: string) => string | null;
};

type SubagentWidgetIconPreference = SubagentWidgetIconConfigMode;

const NERD_ICONS: SubagentWidgetIcons = {
  running: "",
  queued: "",
};

const FALLBACK_ICONS: SubagentWidgetIcons = {
  running: "⏳",
  queued: "⏸",
};

const WINDOWS_TERMINAL_SETTINGS_CANDIDATES = [
  ["Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"],
  ["Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"],
  ["Packages", "Microsoft.WindowsTerminalDev_8wekyb3d8bbwe", "LocalState", "settings.json"],
  ["Microsoft", "Windows Terminal", "settings.json"],
] as const;

const FONT_HINT_ENV_KEYS = [
  "PI_AGENT_ROUTER_FONT_FAMILY",
  "PI_FONT_FAMILY",
  "TERM_PROGRAM_FONT",
  "KITTY_FONT_FAMILY",
  "WEZTERM_FONT",
  "WT_PROFILE_FONT_FACE",
] as const;

function createDefaultContext(): SubagentWidgetIconDetectionContext {
  return {
    platform: process.platform,
    env: process.env,
    pathExists: (path) => existsSync(path),
    readTextFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function parseEnvBoolean(value: string | undefined): boolean | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function parsePreference(value: string | undefined): SubagentWidgetIconPreference | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "nerd" || normalized === "fallback") {
    return normalized;
  }

  return null;
}

function resolvePreference(
  env: Record<string, string | undefined>,
  configuredPreference: SubagentWidgetIconPreference,
): SubagentWidgetIconPreference {
  const explicitMode = parsePreference(env.PI_AGENT_ROUTER_ICON_MODE);
  if (explicitMode) {
    return explicitMode;
  }

  const explicitBoolean = parseEnvBoolean(
    env.PI_AGENT_ROUTER_NERD_FONT ?? env.PI_NERD_FONT,
  );
  if (explicitBoolean !== null) {
    return explicitBoolean ? "nerd" : "fallback";
  }

  return configuredPreference;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripJsonComments(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}

function stripTrailingCommas(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current !== ",") {
      result += current;
      continue;
    }

    let lookahead = index + 1;
    while (lookahead < value.length && /\s/.test(value[lookahead] ?? "")) {
      lookahead += 1;
    }

    const nextNonSpace = value[lookahead];
    if (nextNonSpace === "}" || nextNonSpace === "]") {
      continue;
    }

    result += current;
  }

  return result;
}

function parseSettingsJson(raw: string): Record<string, unknown> | null {
  const withoutBom = raw.replace(/^\uFEFF/, "");

  try {
    const parsed = JSON.parse(withoutBom);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const withoutComments = stripJsonComments(withoutBom);
    const withoutTrailingCommas = stripTrailingCommas(withoutComments);

    try {
      const parsed = JSON.parse(withoutTrailingCommas);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function getRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function getProfileFontFace(profile: Record<string, unknown> | null): string | null {
  if (!profile) {
    return null;
  }

  const font = getRecord(profile, "font");
  if (font && typeof font.face === "string" && font.face.trim().length > 0) {
    return font.face;
  }

  if (typeof profile.fontFace === "string" && profile.fontFace.trim().length > 0) {
    return profile.fontFace;
  }

  return null;
}

function normalizeProfileId(value: string): string {
  return value.trim().replace(/^\{/, "").replace(/\}$/, "").toLowerCase();
}

function findProfileById(
  settings: Record<string, unknown>,
  wtProfileId: string | undefined,
): Record<string, unknown> | null {
  if (!wtProfileId) {
    return null;
  }

  const profiles = getRecord(settings, "profiles");
  const list = profiles?.list;
  if (!Array.isArray(list)) {
    return null;
  }

  const expectedId = normalizeProfileId(wtProfileId);
  if (expectedId.length === 0) {
    return null;
  }

  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }

    const guid = typeof item.guid === "string" ? normalizeProfileId(item.guid) : "";
    if (guid === expectedId) {
      return item;
    }
  }

  return null;
}

function resolveWindowsTerminalSettingsPath(
  context: SubagentWidgetIconDetectionContext,
): string | null {
  const localAppData = context.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }

  for (const segments of WINDOWS_TERMINAL_SETTINGS_CANDIDATES) {
    const candidatePath = join(localAppData, ...segments);
    if (context.pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function isNerdFontFace(fontFace: string | null): boolean {
  return typeof fontFace === "string" && /nerd/i.test(fontFace);
}

function detectFontHintFromEnv(env: Record<string, string | undefined>): boolean {
  for (const key of FONT_HINT_ENV_KEYS) {
    if (isNerdFontFace(env[key] ?? null)) {
      return true;
    }
  }

  return false;
}

function detectWindowsTerminalNerdFont(
  context: SubagentWidgetIconDetectionContext,
): boolean {
  if (!context.env.WT_SESSION) {
    return false;
  }

  const settingsPath = resolveWindowsTerminalSettingsPath(context);
  if (!settingsPath) {
    return false;
  }

  const rawSettings = context.readTextFile(settingsPath);
  if (!rawSettings) {
    return false;
  }

  const settings = parseSettingsJson(rawSettings);
  if (!settings) {
    return false;
  }

  const activeProfile = findProfileById(settings, context.env.WT_PROFILE_ID);
  const activeProfileFont = getProfileFontFace(activeProfile);
  if (activeProfileFont !== null) {
    return isNerdFontFace(activeProfileFont);
  }

  const profiles = getRecord(settings, "profiles");
  const profileDefaultsFont = getProfileFontFace(getRecord(profiles, "defaults"));
  if (profileDefaultsFont !== null) {
    return isNerdFontFace(profileDefaultsFont);
  }

  const rootDefaultsFont = getProfileFontFace(getRecord(settings, "defaults"));
  if (rootDefaultsFont !== null) {
    return isNerdFontFace(rootDefaultsFont);
  }

  return false;
}

function resolveAutoMode(
  context: SubagentWidgetIconDetectionContext,
): SubagentWidgetIconMode {
  if (context.platform === "win32" && detectWindowsTerminalNerdFont(context)) {
    return "nerd";
  }

  return detectFontHintFromEnv(context.env) ? "nerd" : "fallback";
}

function iconsForMode(mode: SubagentWidgetIconMode): SubagentWidgetIcons {
  return mode === "nerd" ? NERD_ICONS : FALLBACK_ICONS;
}

export function resolveSubagentWidgetIconsForContext(
  context: SubagentWidgetIconDetectionContext,
  configuredPreference: SubagentWidgetIconPreference = "auto",
): ResolvedSubagentWidgetIcons {
  const preference = resolvePreference(context.env, configuredPreference);
  const mode =
    preference === "auto"
      ? resolveAutoMode(context)
      : preference === "nerd"
        ? "nerd"
        : "fallback";

  return {
    mode,
    icons: iconsForMode(mode),
  };
}

export function resolveSubagentWidgetIcons(): ResolvedSubagentWidgetIcons {
  return resolveSubagentWidgetIconsForContext(
    createDefaultContext(),
    loadPiAgentRouterConfig().config.subagentWidgetIconMode,
  );
}
