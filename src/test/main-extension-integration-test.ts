import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import agentRouterExtension from "../index";

type RegisteredHandler = (event?: unknown, ctx?: unknown) => Promise<unknown> | unknown;

type RegisteredCommand = {
  description?: string;
  handler?: (args: string, ctx: MockExtensionContext) => Promise<void> | void;
};

type RegisteredTool = {
  name?: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  renderShell?: string;
  execute?: (...args: unknown[]) => unknown;
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
};

type MockExtensionContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, level?: string) => void;
  };
};

function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> | void {
  const result = testFn();
  if (result && typeof (result as Promise<void>).then === "function") {
    return (result as Promise<void>).then(() => {
      console.log(`[PASS] ${name}`);
    });
  }

  console.log(`[PASS] ${name}`);
}

function createMockPi(): {
  pi: ExtensionAPI;
  events: Map<string, RegisteredHandler[]>;
  commands: Map<string, RegisteredCommand>;
  tools: RegisteredTool[];
} {
  const events = new Map<string, RegisteredHandler[]>();
  const commands = new Map<string, RegisteredCommand>();
  const tools: RegisteredTool[] = [];

  const pi = {
    on(name: string, handler: RegisteredHandler): void {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, command: RegisteredCommand): void {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool): void {
      tools.push(tool);
    },
    getFlag(): boolean {
      return false;
    },
  } as unknown as ExtensionAPI;

  return { pi, events, commands, tools };
}

function getSingleHandler(
  events: Map<string, RegisteredHandler[]>,
  name: string,
): RegisteredHandler {
  const handlers = events.get(name) ?? [];
  assert.equal(handlers.length, 1, `expected one ${name} handler`);
  return handlers[0];
}

await runTest("agentRouterExtension registers commands, lifecycle handlers, and task tool", () => {
  const { pi, events, commands, tools } = createMockPi();

  agentRouterExtension(pi);

  assert.equal(events.size, 9);
  assert.deepEqual(new Set(events.keys()), new Set([
    "resources_discover",
    "session_start",
    "model_select",
    "input",
    "session_shutdown",
    "before_agent_start",
    "turn_start",
    "tool_result",
    "agent_end",
  ]));
  assert.equal(commands.size, 3);
  assert.deepEqual(new Set(commands.keys()), new Set(["agent", "attach", "dismiss"]));
  assert.equal(typeof commands.get("agent")?.handler, "function");
  assert.equal(typeof commands.get("attach")?.handler, "function");
  assert.equal(typeof commands.get("dismiss")?.handler, "function");

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "task");
  assert.equal(tools[0].label, "Task");
  assert.equal(tools[0].renderShell, "self");
  assert.equal(typeof tools[0].description, "string");
  assert.equal(typeof tools[0].execute, "function");
  assert.equal(typeof tools[0].renderCall, "function");
  assert.equal(typeof tools[0].renderResult, "function");
  assert.equal(tools[0].promptGuidelines?.length, 1);
});

await runTest("registered safe handlers and /agent list command execute without side effects", async () => {
  const { pi, events, commands } = createMockPi();
  const cwd = mkdtempSync(join(tmpdir(), "pi-agent-router-extension-smoke-"));
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx: MockExtensionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  try {
    agentRouterExtension(pi);

    await getSingleHandler(events, "resources_discover")({ reason: "reload" });
    await getSingleHandler(events, "turn_start")();
    await getSingleHandler(events, "model_select")({
      source: "manual",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    assert.deepEqual(
      await getSingleHandler(events, "tool_result")({ toolName: "not-task" }),
      {},
    );

    await commands.get("agent")?.handler?.("list", ctx);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "info");
    assert.match(notifications[0].message, /^Active: /);
    assert.match(notifications[0].message, /\nAgents:\n/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

console.log("All main extension integration smoke tests passed.");
