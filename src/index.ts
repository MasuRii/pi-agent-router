import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type {
  ActiveAgentEntryData,
  Agent,
  AgentDiscoveryCacheSnapshot,
  AgentMode,
  AgentScope,
  AgentThinkingLevel,
  BoundedTextCapture,
  CacheDebugCounters,
  ContextWithOptionalAppendEntry,
  GlobalWithAgentRouterBaseApiStreams,
  OutputCaptureSummary,
  SubagentExecutionDetails,
  SubagentExecutionStatus,
  SubagentJsonEventState,
  SubagentOutputDigest,
  SubagentRunResult,
  SubagentSession,
  SubagentSessionRetentionSnapshot,
  SubagentTaskItemInput,
  SubagentTaskRegistryEntry,
  SubagentToolInvocation,
  SubagentUsage,
  TailTextBuffer,
  TaskControlsCacheSnapshot,
  TaskStyleDelegationItem,
} from "./types";

export { resolveDelegatedThinkingLevel, shouldForceDelegatedThinkingOff } from "./agent/thinking-policy";

type RuntimeModule = typeof import("./runtime.js");
type RuntimeCommand = {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => unknown[] | null | Promise<unknown[] | null>;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};
type RuntimeEventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type RuntimeBridge = {
  commands: Map<string, RuntimeCommand>;
  eventHandlers: Map<string, RuntimeEventHandler[]>;
  tools: Map<string, unknown>;
  runtimeLoaded: boolean;
};

const TASK_TOOL_BASE_DESCRIPTION =
  'Delegate compact task batches to local agents. Required task fields: id, description, assignment, agent. mode defaults to "parallel"; same-batch contextFrom is valid only in mode="chain" and only from earlier task ids. Parallel and top-level contextFrom must reference retained delegated sessions only. Handoffs inject bounded final responses or validated structured results, never transcripts. Agent catalog discovery is resolved lazily when the task tool runs.';

function createTaskBatchItemSchema() {
  return Type.Object({
    id: Type.String({
      description: "Stable task id, max 32 chars.",
      maxLength: 32,
    }),
    description: Type.String({ description: "Short UI label." }),
    assignment: Type.String({
      description: "Concise, self-contained delegated instructions.",
    }),
    skills: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional skill names.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Task working directory override.",
      }),
    ),
    agent: Type.String({
      description: "Target agent name.",
    }),
    contextFrom: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Retained task/session refs; in chain mode only, earlier same-batch task ids. Injects bounded final results only.",
      }),
    ),
    retry: Type.Optional(
      Type.Boolean({
        description: "Resume this logical task from its retained session.",
      }),
    ),
    retryFrom: Type.Optional(
      Type.String({
        description: "Retained task/session reference to resume.",
      }),
    ),
  });
}

function createRuntimeBridge(pi: ExtensionAPI): RuntimeBridge & { api: ExtensionAPI } {
  const bridge: RuntimeBridge = {
    commands: new Map(),
    eventHandlers: new Map(),
    tools: new Map(),
    runtimeLoaded: false,
  };

  const api = new Proxy(pi as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      if (property === "on") {
        return (eventName: string, handler: RuntimeEventHandler): void => {
          const handlers = bridge.eventHandlers.get(eventName) ?? [];
          handlers.push(handler);
          bridge.eventHandlers.set(eventName, handlers);
        };
      }

      if (property === "registerCommand") {
        return (name: string, options: RuntimeCommand): void => {
          bridge.commands.set(name, options);
        };
      }

      if (property === "registerTool") {
        return (tool: { name?: string }): void => {
          if (tool?.name) {
            bridge.tools.set(tool.name, tool);
          }
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;

  return { ...bridge, api };
}

export default function agentRouterExtension(pi: ExtensionAPI): void {
  const bridge = createRuntimeBridge(pi);
  let runtimeImportPromise: Promise<RuntimeModule> | undefined;
  let runtimeReadyPromise: Promise<RuntimeBridge> | undefined;

  const ensureRuntime = async (): Promise<RuntimeBridge> => {
    if (bridge.runtimeLoaded) {
      return bridge;
    }

    runtimeReadyPromise ??= (async () => {
      runtimeImportPromise ??= import("./runtime.js");
      const runtime = await runtimeImportPromise;
      await runtime.default(bridge.api);
      bridge.runtimeLoaded = true;
      return bridge;
    })();

    return runtimeReadyPromise;
  };

  const dispatchRuntimeEvent = async (
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<unknown> => {
    const runtime = await ensureRuntime();
    const handlers = runtime.eventHandlers.get(eventName) ?? [];
    let result: unknown;
    for (const handler of handlers) {
      const nextResult = await handler(event, ctx);
      if (nextResult !== undefined) {
        result = nextResult;
      }
    }
    return result;
  };

  const runRuntimeCommand = async (
    commandName: string,
    args: string,
    ctx: unknown,
  ): Promise<void> => {
    const runtime = await ensureRuntime();
    const command = runtime.commands.get(commandName);
    if (!command) {
      throw new Error(`pi-agent-router runtime did not register /${commandName}.`);
    }
    await command.handler(args, ctx);
  };

  pi.on("resources_discover", async (event, ctx) => {
    if (event.reason !== "reload") {
      return {};
    }
    return dispatchRuntimeEvent("resources_discover", event, ctx) as Promise<Record<string, unknown>>;
  });

  pi.on("session_start", async (event, ctx) => {
    await dispatchRuntimeEvent("session_start", event, ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    await dispatchRuntimeEvent("model_select", event, ctx);
  });

  pi.on("input", async (event, ctx) => {
    return dispatchRuntimeEvent("input", event, ctx) as Promise<Record<string, unknown> | void>;
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await dispatchRuntimeEvent("session_shutdown", event, ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    return dispatchRuntimeEvent("before_agent_start", event, ctx) as Promise<Record<string, unknown> | void>;
  });

  pi.on("turn_start", async (event, ctx) => {
    await dispatchRuntimeEvent("turn_start", event, ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    return dispatchRuntimeEvent("tool_result", event, ctx) as Promise<Record<string, unknown> | void>;
  });

  pi.on("agent_end", async (event, ctx) => {
    await dispatchRuntimeEvent("agent_end", event, ctx);
  });

  pi.registerCommand("agent", {
    description: "Open the active-agent picker or switch agents in non-interactive mode",
    handler: async (args, ctx) => runRuntimeCommand("agent", args, ctx),
  });

  pi.registerCommand("attach", {
    description:
      "Open a tracked task delegation output modal (usage: /attach <sessionId>)",
    handler: async (args, ctx) => runRuntimeCommand("attach", args, ctx),
  });

  pi.registerCommand("dismiss", {
    description:
      "Dismiss delegated task sessions (usage: /dismiss <sessionId|taskId|agent|all>)",
    handler: async (args, ctx) => runRuntimeCommand("dismiss", args, ctx),
  });

  const taskToolDefinition = defineTool({
    name: "task",
    label: "Task",
    description: TASK_TOOL_BASE_DESCRIPTION,
    promptSnippet: "Delegate work to local agents in parallel or chain mode",
    promptGuidelines: [
      "Use task when work should be delegated to one or more specialized agents instead of handled entirely in the current session.",
    ],
    renderShell: "self",
    parameters: Type.Object({
      tasks: Type.Array(createTaskBatchItemSchema(), {
        description: "Task items with required id, description, assignment, and agent.",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("parallel"), Type.Literal("chain")], {
          description:
            "parallel runs concurrently. chain runs sequentially and allows {previous} plus earlier task ids in per-task contextFrom.",
          default: "parallel",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description: "Concise shared background prepended to each task.",
        }),
      ),
      contextFrom: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "Retained delegated task/session refs injected into every task as bounded final results; cannot reference current batch ids.",
        }),
      ),
      schema: Type.Optional(
        Type.Unknown({
          description: "Optional JSON schema for submit_result payloads.",
        }),
      ),
      agentScope: Type.Optional(
        Type.Union(
          [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
          {
            description: 'Agent directories to search: "user", "project", or "both".',
            default: "both",
          },
        ),
      ),
      attach: Type.Optional(
        Type.Boolean({
          description: "Stream live delegated output into this result.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Default working directory for delegated tasks.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Inactivity timeout in milliseconds; minimum/default is 30 minutes.",
        }),
      ),
    }),
    execute: async (...args: unknown[]) => {
      const runtime = await ensureRuntime();
      const taskTool = runtime.tools.get("task") as { execute?: (...innerArgs: unknown[]) => unknown } | undefined;
      if (!taskTool?.execute) {
        throw new Error("pi-agent-router runtime did not register the task tool.");
      }
      return taskTool.execute(...args);
    },
    renderCall: (...args: unknown[]) => {
      const taskTool = bridge.tools.get("task") as { renderCall?: (...innerArgs: unknown[]) => unknown } | undefined;
      if (taskTool?.renderCall) {
        return taskTool.renderCall(...args);
      }
      return {
        invalidate() {},
        render() {
          return ["Task delegation renderer is loading…"];
        },
      };
    },
    renderResult: (...args: unknown[]) => {
      const taskTool = bridge.tools.get("task") as { renderResult?: (...innerArgs: unknown[]) => unknown } | undefined;
      if (taskTool?.renderResult) {
        return taskTool.renderResult(...args);
      }
      return {
        invalidate() {},
        render() {
          return ["Task result renderer is loading…"];
        },
      };
    },
  } as never);

  pi.registerTool(taskToolDefinition);
}
