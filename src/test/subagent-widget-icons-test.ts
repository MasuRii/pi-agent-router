import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveSubagentWidgetIconsForContext } from "../subagent/subagent-widget-icons";
import type { SubagentWidgetIconDetectionContext } from "../subagent/subagent-widget-icons";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function createContext(overrides: Partial<SubagentWidgetIconDetectionContext> = {}): SubagentWidgetIconDetectionContext {
  return {
    platform: "linux",
    env: {},
    pathExists: () => false,
    readTextFile: () => null,
    ...overrides,
  };
}

runTest("subagent widget icon env mode overrides config preference", () => {
  assert.equal(
    resolveSubagentWidgetIconsForContext(
      createContext({ env: { PI_AGENT_ROUTER_ICON_MODE: "fallback" } }),
      "nerd",
    ).mode,
    "fallback",
  );

  assert.equal(
    resolveSubagentWidgetIconsForContext(
      createContext({ env: { PI_AGENT_ROUTER_NERD_FONT: "true" } }),
      "fallback",
    ).mode,
    "nerd",
  );
});

runTest("subagent widget icon config preference is used when env is not explicit", () => {
  assert.equal(resolveSubagentWidgetIconsForContext(createContext(), "nerd").mode, "nerd");
  assert.equal(resolveSubagentWidgetIconsForContext(createContext(), "fallback").mode, "fallback");
  assert.equal(resolveSubagentWidgetIconsForContext(createContext(), "auto").mode, "fallback");
});

runTest("subagent widget icon auto mode detects nerd font hints from environment", () => {
  assert.equal(
    resolveSubagentWidgetIconsForContext(
      createContext({ env: { PI_AGENT_ROUTER_FONT_FAMILY: "JetBrainsMono Nerd Font" } }),
      "auto",
    ).mode,
    "nerd",
  );
});

runTest("subagent widget icon auto mode detects Windows Terminal active profile nerd font", () => {
  const localAppData = "C:/Users/Test/AppData/Local";
  const settingsPath = join(
    localAppData,
    "Packages",
    "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
    "LocalState",
    "settings.json",
  );

  const result = resolveSubagentWidgetIconsForContext(
    createContext({
      platform: "win32",
      env: {
        LOCALAPPDATA: localAppData,
        WT_SESSION: "session",
        WT_PROFILE_ID: "{PROFILE-GUID}",
      },
      pathExists: (path) => path === settingsPath,
      readTextFile: (path) => path === settingsPath
        ? `{
            // Windows Terminal allows comments and trailing commas.
            "profiles": {
              "list": [
                {
                  "guid": "{profile-guid}",
                  "font": { "face": "CaskaydiaCove Nerd Font" },
                },
              ],
            },
          }`
        : null,
    }),
    "auto",
  );

  assert.equal(result.mode, "nerd");
});

runTest("subagent widget icon auto mode falls back on non-Windows without nerd hints", () => {
  const result = resolveSubagentWidgetIconsForContext(createContext({ platform: "darwin" }), "auto");
  assert.equal(result.mode, "fallback");
  assert.equal(result.icons.running, "⏳");
});

console.log("All subagent widget icon tests passed.");
