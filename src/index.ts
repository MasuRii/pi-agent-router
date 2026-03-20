/**
 * pi-agent-router extension.
 *
 * Main extension entry point for agent routing and subagent delegation.
 */

// External imports
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import {
  getApiProvider,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Existing internal imports
import { sanitizeSubagentResultForDisplay } from "./output-sanitizer";
import { renderSubagentWidgetLines } from "./subagent/subagent-widget-renderer";
import { SubagentOutputOverlay } from "./subagent/subagent-overlays";
import {
  isTaskBatchItem,
  renderTaskBatchPrompt,
  renderTaskBatchSummary,
  validateTaskBatchItems,
} from "./task/task-tool-adapter";
import {
  applyPreviousOutputSubstitution,
  resolveTaskExecutionMode,
  type TaskExecutionMode,
} from "./task/task-chain-mode";

// Modularized internal imports
import type {
  ActiveAgentEntryData,
  Agent,
  AgentThinkingLevel,
  ApiStreamSimpleDelegate,
  ContextWithOptionalAppendEntry,
  OutputCaptureSummary,
  SubagentExecutionDetails,
  SubagentExecutionStatus,
  SubagentRunResult,
  SubagentSession,
  SubagentTaskItemInput,
  SubagentTaskRegistryEntry,
  SubagentToolInvocation,
  SubagentUsage,
  TaskStyleDelegationItem,
} from "./types";
import {
  AGENT_DIR,
  DEFAULT_AGENT,
  DEFAULT_PRIMARY_AGENTS,
  FINISHED_SUBAGENT_TTL_MS,
  LINUX_TAB_CYCLE_DEBOUNCE_MS,
  SUBAGENT_DERIVED_OUTPUT_MAX_CHARS,
  SUBAGENT_HARD_KILL_DELAY_MS,
  SUBAGENT_STDOUT_CAPTURE_MAX_CHARS,
  SUBAGENT_STDERR_CAPTURE_MAX_CHARS,
  SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS,
  SUBAGENT_TASK_REGISTRY_TTL_MS,
  SUBAGENT_WIDGET_KEY,
} from "./constants";
import {
  discoverAgents,
  getAgentEmoji,
  getCyclablePrimaryAgents,
  getPersistedActiveAgentName,
  loadAgents,
  normalizeThinkingLevel,
} from "./agent/agent-discovery";
import {
  buildAgentListSummary,
  buildAgentSelectionMenu,
} from "./agent/agent-command-ui";
import {
  isDirectory,
  isFile,
  prepareIsolatedAgentDirectory,
  resolveExistingWorkingDirectory,
  resolveSubagentSessionDirectory,
  resolveSubagentWorkingDirectory,
} from "./subagent/session-paths";
import { resolveAgentModel, toModelReference } from "./model-resolution";
import {
  cloneSubagentUsage,
  createSubagentJsonEventState,
} from "./subagent/subagent-usage";
import {
  appendBoundedOutputSection,
  countSubagentToolInvocations,
  getLatestSubagentToolCallLabel,
  getSubagentOutputFromMessages,
  getSubagentToolInvocationsFromState,
  normalizeInputText,
  processSubagentJsonEventLine,
  sameToolInvocations,
  summarizeSubagentToolInvocations,
} from "./subagent/subagent-output";
import { createOutputSink } from "./subagent/subagent-output-sink";
import {
  clearStaleSubagentSessionsForNewSession,
  clearSubagentSessionsForParentShutdown,
  listVisibleSubagentSessions,
} from "./subagent/subagent-session-state";
import {
  buildRetainedHistoryText,
  getDelegatingAgentName,
  isOrchestratorAgent,
  normalizeAgentScope,
  truncatePreview,
} from "./text-formatting";
import { renderTaskDelegationCall } from "./task/task-call-renderer";
import { renderSingleDelegationResult } from "./task/task-result-renderer";
import {
  buildDelegatedActiveAgentIdentityExtensionSource,
  buildDelegatedCopilotInitiatorExtensionSource,
  buildDelegatedTemperatureExtensionSource,
  getAgentRouterBaseApiStreams,
} from "./agent/extension-sources";
import {
  aggregateUsageFromResults,
  createSubagentExecutionDetails,
  formatDuration,
  generateUniqueTaskId,
  getSubagentStatusDisplay,
  parseSubagentExecutionDetails,
  parseSubagentExecutionStatus,
  resolveSessionByReference,
  resolveSubagentTimeoutMs,
  summarizeParallelResults,
} from "./subagent/subagent-execution";
import { renderParallelDelegationResult } from "./task/parallel-delegation-renderer";
import { mapWithAbortAwareConcurrency } from "./task/parallel-control";
import { SPINNER_RENDER_INTERVAL_MS } from "./progress-spinner";
import { createAnimatedRenderSurface } from "./ui/animated-render-surface";
import { createUiRenderScheduler } from "./ui/render-scheduler";
import { resolveTaskControls } from "./task/task-controls";
import {
  buildTaskToolPartialUpdateFingerprint,
  createTaskToolPartialUpdateGate,
  resolveTaskToolUpdateCadence,
} from "./task/task-update-dedupe";
import { validateSubagentOutputContract } from "./output-contract";
import { piAgentRouterDebugLogger } from "./debug-logger";
import {
  clearSubagentTransientKeyError,
  detectSubagentProviderId,
  isQuotaOrRateLimitError,
  isRetryableModelAvailabilityError,
  isTransientCredentialError,
  releaseKeyForSubagent,
  reportSubagentKeyError,
  reportSubagentTransientKeyError,
  tryAcquireKeyForSubagent,
} from "./subagent/subagent-key-distribution";
import { buildSystemPromptForActiveAgent } from "./agent/active-agent-prompt";

// Re-export shared types for external consumers
export type {
  ActiveAgentEntryData,
  Agent,
  AgentMode,
  AgentScope,
  AgentThinkingLevel,
  BoundedTextCapture,
  ContextWithOptionalAppendEntry,
  GlobalWithAgentRouterBaseApiStreams,
  OutputCaptureSummary,
  SubagentExecutionDetails,
  SubagentExecutionStatus,
  SubagentJsonEventState,
  SubagentOutputDigest,
  SubagentRunResult,
  SubagentSession,
  SubagentTaskItemInput,
  SubagentTaskRegistryEntry,
  SubagentToolInvocation,
  SubagentUsage,
  TailTextBuffer,
  TaskStyleDelegationItem,
} from "./types";

const TaskBatchItem = Type.Object({
  id: Type.String({
    description: "CamelCase identifier, max 32 chars",
    maxLength: 32,
  }),
  description: Type.String({ description: "Short task label for UI display." }),
  assignment: Type.String({
    description: "Detailed assignment executed by the delegated agent.",
  }),
  skills: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional skill names for this delegated task.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory override for this task item (optional).",
    }),
  ),
  agent: Type.String({ description: "Agent name for this task (required)." }),
});

const SUBAGENT_REQUIRED_EXTENSION_CANDIDATES = [
  ["pi-permission-system"],
  ["pi-sensitive-guard", "env-protection"],
  ["context-injector"],
  ["pi-mcp-adapter"],
  ["pi-rtk-optimizer", "rtk-integration"],
  ["pi-system-prompt-sanitizer"],
] as const;

const SUBAGENT_OPTIONAL_EXTENSION_NAMES = [
  "pi-factory-auth",
  "pi-multi-auth",
  "multi-auth",
  "pi-find-robustness",
  "pi-tool-display",
] as const;

const resolveExtensionDirectory = (
  extensionCandidates: readonly string[],
): string | undefined => {
  for (const extensionName of extensionCandidates) {
    const extensionDir = join(AGENT_DIR, "extensions", extensionName);
    if (isDirectory(extensionDir)) {
      return extensionDir;
    }
  }

  return undefined;
};

const formatExtensionCandidatePaths = (
  extensionCandidates: readonly string[],
): string => {
  const extensionPaths = extensionCandidates.map((extensionName) =>
    join(AGENT_DIR, "extensions", extensionName),
  );

  if (extensionPaths.length === 1) {
    return extensionPaths[0];
  }

  return `${extensionPaths[0]} (or ${extensionPaths.slice(1).join(", ")})`;
};

export default function agentRouterExtension(pi: ExtensionAPI) {
  let activeAgent: string | null = DEFAULT_AGENT;
  const subagentSessions = new Map<string, SubagentSession>();
  const subagentTaskRegistry = new Map<string, SubagentTaskRegistryEntry>();
  const isolatedAgentDirs = new Set<string>();
  let subagentOverlayRenderRequest: (() => void) | null = null;
  let subagentWidgetRenderRequest: (() => void) | null = null;
  let cleanupTimer: NodeJS.Timeout | undefined;
  const warnedMissingAgentModels = new Set<string>();
  const warnedTemperatureRuntime = new Set<string>();
  const wrappedTemperatureApis = new Set<string>();
  let activeRuntimeTemperature: number | undefined;
  let manualModelOverrideForActiveAgent:
    | { agentName: string; modelRef: string }
    | undefined;
  const manualThinkingOverrideByAgent = new Map<string, AgentThinkingLevel>();
  let suppressManualModelOverrideCapture = false;
  let activeSubagentDelegations = 0;
  const queuedSubagentDelegations: Array<() => void> = [];
  const pendingDelegationJobs = new Set<Promise<void>>();
  let dispatchReminderQueued = false;
  let autoCompletionWaitJob: Promise<void> | null = null;
  let tabCycleInputUnsubscribe: (() => void) | undefined;
  let tabCycleInputContext: ExtensionContext | undefined;
  let lastTabCycleAtMs = 0;
  let activeParentSessionId = "";

  const tabCycleDebounceMs = process.platform === "linux" ? LINUX_TAB_CYCLE_DEBOUNCE_MS : 0;

  const listSubagentSessions = (): SubagentSession[] =>
    listVisibleSubagentSessions(subagentSessions.values(), activeParentSessionId);

  const hasRunningVisibleSubagentSession = (): boolean => {
    for (const session of subagentSessions.values()) {
      if (session.dismissed) {
        continue;
      }

      if (activeParentSessionId && session.parentSessionId !== activeParentSessionId) {
        continue;
      }

      if (session.status === "running") {
        return true;
      }
    }

    return false;
  };

  const subagentUiRenderScheduler = createUiRenderScheduler({
    // Align router-driven redraws with the visible spinner cadence so stream
    // bursts do not schedule extra frames between spinner ticks.
    minIntervalMs: SPINNER_RENDER_INTERVAL_MS,
    render: () => {
      subagentOverlayRenderRequest?.();
      subagentWidgetRenderRequest?.();
    },
  });

  const requestSubagentUiRender = (immediate = true): void => {
    subagentUiRenderScheduler.request({ immediate });
  };

  const syncActiveParentSessionId = (ctx: ExtensionContext): string => {
    activeParentSessionId = normalizeInputText(ctx.sessionManager.getSessionId());
    return activeParentSessionId;
  };

  const clearStaleSubagentUiSessions = (nextParentSessionId: string): void => {
    const { removedCount } =
      clearStaleSubagentSessionsForNewSession(
        subagentSessions,
        nextParentSessionId,
        {
          cleanupSessionArtifacts,
        },
      );

    if (removedCount > 0) {
      requestSubagentUiRender();
    }
  };

  const shutdownParentScopedSubagentSessions = (
    parentSessionId: string,
  ): boolean => {
    const { removedCount, terminatedSessionIds } =
      clearSubagentSessionsForParentShutdown(
        subagentSessions,
        parentSessionId,
        {
          cleanupSessionArtifacts,
        },
      );

    for (const sessionId of terminatedSessionIds) {
      killSubagentSession(sessionId, "Terminated on session shutdown.");
    }

    return removedCount > 0 || terminatedSessionIds.length > 0;
  };

  const queueDispatchReminderTurn = (): void => {
    if (dispatchReminderQueued) {
      return;
    }

    dispatchReminderQueued = true;
    pi.sendMessage(
      {
        customType: "subagent-dispatch-reminder",
        content:
          "Subagent delegations are still in progress. Continue dispatching remaining independent subtasks now, and do not finalize yet.",
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const scheduleAutoCompletionWaitTurn = (delegatedBy: string): void => {
    if (autoCompletionWaitJob) {
      return;
    }

    const trackedSessionIds = new Set(
      listSubagentSessions()
        .filter(
          (session) =>
            session.delegatedBy === delegatedBy &&
            (session.status === "running" || session.status === "queued"),
        )
        .map((session) => session.id),
    );

    autoCompletionWaitJob = (async () => {
      while (pendingDelegationJobs.size > 0) {
        const jobs = [...pendingDelegationJobs];
        if (jobs.length === 0) {
          break;
        }
        await Promise.allSettled(jobs);
      }

      const completedSessions = listSubagentSessions()
        .filter(
          (session) =>
            session.delegatedBy === delegatedBy &&
            trackedSessionIds.has(session.id),
        )
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

      if (completedSessions.length === 0) {
        return;
      }

      const failedCount = completedSessions.filter(
        (session) => session.status !== "finished",
      ).length;
      const summaryLines = [
        `All delegated subagents finished (${completedSessions.length} total, ${failedCount} failed).`,
      ];

      for (const session of completedSessions) {
        const label = getSubagentStatusDisplay(session.status).label;
        summaryLines.push(
          `- [${session.id.slice(0, 8)}] ${session.agent}: ${label}`,
        );
      }

      pi.sendMessage(
        {
          customType: "subagent-auto-complete",
          content: `${summaryLines.join("\n")}\n\nYou may now synthesize the final response using these completed results.`,

          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    })().finally(() => {
      autoCompletionWaitJob = null;
    });
  };

  const acquireDelegationSlot = async (
    signal: AbortSignal | undefined,
    maxConcurrency: number,
  ): Promise<{ queued: boolean }> => {
    if (activeSubagentDelegations < maxConcurrency) {
      activeSubagentDelegations += 1;
      return { queued: false };
    }

    return new Promise<{ queued: boolean }>((resolve, reject) => {
      const resume = (): void => {
        signal?.removeEventListener("abort", onAbort);
        activeSubagentDelegations += 1;
        resolve({ queued: true });
      };

      const onAbort = (): void => {
        const queueIndex = queuedSubagentDelegations.indexOf(resume);
        if (queueIndex >= 0) {
          queuedSubagentDelegations.splice(queueIndex, 1);
        }
        signal?.removeEventListener("abort", onAbort);
        reject(
          new Error(
            "Delegation request was aborted while waiting for an available slot.",
          ),
        );
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      queuedSubagentDelegations.push(resume);
    });
  };

  const releaseDelegationSlot = (): void => {
    if (activeSubagentDelegations > 0) {
      activeSubagentDelegations -= 1;
    }

    const next = queuedSubagentDelegations.shift();
    if (next) {
      next();
    }
  };

  const cleanupSessionRuntimeArtifacts = (session: SubagentSession): void => {
    if (session.isolatedAgentDir) {
      try {
        rmSync(session.isolatedAgentDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
      isolatedAgentDirs.delete(session.isolatedAgentDir);
      session.isolatedAgentDir = undefined;
    }

    if (session.tmpDir) {
      try {
        rmSync(session.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
      session.tmpDir = undefined;
    }
  };

  const cleanupSessionArtifacts = (session: SubagentSession): void => {
    cleanupSessionRuntimeArtifacts(session);
  };

  const pruneFinishedSessions = (): number => {
    const now = Date.now();
    let removed = 0;

    for (const [sessionId, session] of subagentSessions.entries()) {
      if (session.status === "running") {
        continue;
      }

      if (!session.finishedAt) {
        continue;
      }

      if (now - session.finishedAt > FINISHED_SUBAGENT_TTL_MS) {
        cleanupSessionArtifacts(session);
        subagentSessions.delete(sessionId);
        removed += 1;
      }
    }

    if (removed > 0) {
      requestSubagentUiRender();
    }

    for (const [taskId, tracked] of subagentTaskRegistry.entries()) {
      tracked.childSessionIds = tracked.childSessionIds.filter((childId) =>
        subagentSessions.has(childId),
      );

      const hasActiveChild = tracked.childSessionIds.some((childId) => {
        const child = subagentSessions.get(childId);
        return child?.status === "running" || child?.status === "queued";
      });

      if (hasActiveChild) {
        continue;
      }

      if (now - tracked.updatedAt > SUBAGENT_TASK_REGISTRY_TTL_MS) {
        subagentTaskRegistry.delete(taskId);
      }
    }

    return removed;
  };

  const ensureCleanupTimer = (): void => {
    if (cleanupTimer) {
      return;
    }

    cleanupTimer = setInterval(() => {
      pruneFinishedSessions();
    }, 60_000);
  };

  const clearCleanupTimer = (): void => {
    if (!cleanupTimer) {
      return;
    }

    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  };

  const ensureTemperatureApiWrapper = (
    api: Api,
    notify: (message: string, type?: "info" | "warning" | "error") => void,
  ): boolean => {
    if (wrappedTemperatureApis.has(api)) {
      return true;
    }

    const baseApiStreams = getAgentRouterBaseApiStreams();
    let baseStream = baseApiStreams.get(api);
    if (!baseStream) {
      const currentProvider = getApiProvider(api);
      if (!currentProvider) {
        return false;
      }
      baseStream = currentProvider.streamSimple as ApiStreamSimpleDelegate;
      baseApiStreams.set(api, baseStream);
    }

    const providerName = `pi-agent-router-temperature-${api.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

    try {
      pi.registerProvider(providerName, {
        api,
        streamSimple: (model, context, options) => {
          const delegate = baseApiStreams.get(model.api);
          if (!delegate) {
            throw new Error(
              `No base stream provider available for api '${model.api}'.`,
            );
          }

          if (typeof activeRuntimeTemperature !== "number") {
            return delegate(model as Model<Api>, context, options);
          }

          const nextOptions: SimpleStreamOptions = options
            ? { ...options, temperature: activeRuntimeTemperature }
            : { temperature: activeRuntimeTemperature };

          return delegate(model as Model<Api>, context, nextOptions);
        },
      });

      wrappedTemperatureApis.add(api);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      notify(
        `Failed to enable runtime temperature override for api '${api}': ${message}`,
        "warning",
      );
      return false;
    }
  };

  const applyAgentRuntimeProfile = async (
    ctx: ExtensionContext,
    agent: Agent,
    options: {
      respectManualModelOverride?: boolean;
      respectManualThinkingOverride?: boolean;
    } = {},
  ): Promise<void> => {
    const notify = (
      message: string,
      type: "info" | "warning" | "error" = "info",
    ): void => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, type);
      }
    };

    activeRuntimeTemperature = undefined;
    let effectiveModel = ctx.model;

    const shouldRespectManualModelOverride = Boolean(
      options.respectManualModelOverride &&
      ctx.model &&
      manualModelOverrideForActiveAgent &&
      manualModelOverrideForActiveAgent.agentName === agent.name &&
      manualModelOverrideForActiveAgent.modelRef ===
        toModelReference(ctx.model),
    );

    try {
      if (agent.model && !shouldRespectManualModelOverride) {
        const resolution = resolveAgentModel(ctx, agent);

        if (!resolution.model) {
          const warningKey = `${agent.name}:missing:${resolution.requested || agent.model}`;
          if (!warnedMissingAgentModels.has(warningKey)) {
            warnedMissingAgentModels.add(warningKey);
            notify(
              `Agent '${agent.name}' references model '${resolution.requested || agent.model}', but no matching model is registered.`,
              "warning",
            );
          }
        } else {
          effectiveModel = resolution.model;
          const requestedRef = resolution.requested || agent.model;
          const resolvedRef = toModelReference(resolution.model);

          if (resolution.fallbackFrom) {
            const fallbackKey = `${agent.name}:fallback:${resolution.fallbackFrom}->${resolvedRef}`;
            if (!warnedMissingAgentModels.has(fallbackKey)) {
              warnedMissingAgentModels.add(fallbackKey);
              notify(
                `Agent '${agent.name}' model '${requestedRef}' mapped to available model '${resolvedRef}'.`,
                "info",
              );
            }
          }

          const current = ctx.model;
          const sameModel = Boolean(
            current &&
            current.provider === resolution.model.provider &&
            current.id === resolution.model.id,
          );

          if (!sameModel) {
            let switched = false;
            suppressManualModelOverrideCapture = true;
            try {
              switched = await pi.setModel(resolution.model);
            } finally {
              suppressManualModelOverrideCapture = false;
            }

            if (!switched) {
              const authKey = `${agent.name}:auth:${resolvedRef}`;
              if (!warnedMissingAgentModels.has(authKey)) {
                warnedMissingAgentModels.add(authKey);
                notify(
                  `Agent '${agent.name}' could not switch to model '${resolvedRef}' (requested '${requestedRef}') due to missing credentials.`,
                  "warning",
                );
              }

              if (current) {
                effectiveModel = current;
              }
            }
          } else if (current) {
            effectiveModel = current;
          }
        }
      } else if (shouldRespectManualModelOverride && ctx.model) {
        effectiveModel = ctx.model;
      }

      const manualThinkingOverride =
        options.respectManualThinkingOverride && agent.thinkingLevel
          ? manualThinkingOverrideByAgent.get(agent.name)
          : undefined;
      const effectiveThinkingLevel =
        manualThinkingOverride ?? agent.thinkingLevel;

      if (effectiveThinkingLevel) {
        pi.setThinkingLevel(effectiveThinkingLevel);
      }

      if (typeof agent.temperature === "number") {
        if (!effectiveModel) {
          const warningKey = `${agent.name}:temperature:no-model`;
          if (!warnedTemperatureRuntime.has(warningKey)) {
            warnedTemperatureRuntime.add(warningKey);
            notify(
              `Agent '${agent.name}' temperature ${agent.temperature} could not be applied because no model is active.`,
              "warning",
            );
          }
          return;
        }

        const api = effectiveModel.api as Api;
        const wrapperReady = ensureTemperatureApiWrapper(api, notify);
        if (!wrapperReady) {
          const warningKey = `${agent.name}:temperature:unsupported:${api}`;
          if (!warnedTemperatureRuntime.has(warningKey)) {
            warnedTemperatureRuntime.add(warningKey);
            notify(
              `Agent '${agent.name}' temperature ${agent.temperature} could not be applied because api '${api}' has no registered runtime stream.`,
              "warning",
            );
          }
          return;
        }

        activeRuntimeTemperature = agent.temperature;
        const infoKey = `${agent.name}:temperature:runtime:${api}:${agent.temperature}`;
        if (!warnedTemperatureRuntime.has(infoKey)) {
          warnedTemperatureRuntime.add(infoKey);
          notify(
            `Agent '${agent.name}' temperature ${agent.temperature} is now applied as a runtime model option.`,
            "info",
          );
        }
      }
    } catch (error) {
      activeRuntimeTemperature = undefined;
      suppressManualModelOverrideCapture = false;
      const message = error instanceof Error ? error.message : "Unknown error";
      notify(
        `Failed to apply runtime profile for agent '${agent.name}': ${message}`,
        "warning",
      );
    }
  };

  const appendSessionOutput = (
    session: SubagentSession,
    text: string,
  ): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const currentOutput = session.lastOutput?.trimEnd() || "";
    if (currentOutput === trimmed || currentOutput.endsWith(trimmed)) {
      return;
    }

    session.lastOutput = appendBoundedOutputSection(
      session.lastOutput || "",
      trimmed,
      SUBAGENT_DERIVED_OUTPUT_MAX_CHARS,
    );
  };

  const formatSessionCompletionMessage = (session: SubagentSession): string => {
    const statusDisplay = getSubagentStatusDisplay(session.status);
    const output = sanitizeSubagentResultForDisplay(
      session.fullOutput ||
        session.lastOutput ||
        session.stderr ||
        "(no output)",
    );
    const truncatedOutput = truncatePreview(output, 9_000);

    let header = `Subagent ${session.agent} (#${session.id.slice(0, 8)}) ${statusDisplay.label.toLowerCase()}. task_id=${session.taskId}.`;
    if (session.fallback && session.requestedAgent) {
      header += ` Requested '${session.requestedAgent}', used '${session.agent}'.`;
    }

    let content = `${header}\nTask: ${session.task || "(none)"}`;

    if (session.outputNotice?.trim()) {
      content += `\n\n${session.outputNotice.trim()}`;
    }

    if (truncatedOutput.trim()) {
      content += `\n\n${truncatedOutput}`;
      if (truncatedOutput.length < output.length) {
        content +=
          "\n\n[Output truncated in notification. Use /attach to inspect full details.]";
      }
    }

    return content;
  };

  const finalizeSession = (
    session: SubagentSession,
    run: SubagentRunResult,
    options: { emitFollowUp?: boolean } = {},
  ): void => {
    if (session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = undefined;
    }

    session.stdoutTruncated = Boolean(run.stdoutTruncated);
    session.stderrTruncated = Boolean(run.stderrTruncated);
    session.outputNotice = run.outputNotice?.trim() || undefined;

    if (run.stderr.trim()) {
      session.stderr = session.stderr
        ? `${session.stderr}\n${run.stderr}`
        : run.stderr;
    }

    const parsedOutput =
      run.outputText?.trim() ||
      getSubagentOutputFromMessages(run.messages || []);
    if (parsedOutput) {
      appendSessionOutput(session, parsedOutput);
    } else {
      const fallbackOutput = run.stdout.trim();
      if (fallbackOutput) {
        appendSessionOutput(session, fallbackOutput);
      }
    }

    const finalToolInvocations =
      run.toolInvocations ||
      (run.messages && run.messages.length > 0
        ? summarizeSubagentToolInvocations(run.messages)
        : undefined);
    if (finalToolInvocations) {
      session.toolInvocations = finalToolInvocations.map((item) => ({ ...item }));
    }

    if (run.malformedEventCount && run.malformedEventCount > 0) {
      const malformedMessage = `Ignored ${run.malformedEventCount} malformed JSON output event${run.malformedEventCount === 1 ? "" : "s"}.`;
      session.stderr = session.stderr
        ? `${session.stderr}\n${malformedMessage}`
        : malformedMessage;
    }

    if (run.sessionPath) {
      session.sessionPath = run.sessionPath;
    }

    session.exitCode = run.code;
    session.finishedAt = Date.now();

    if (session.status !== "killed") {
      if (session.timedOut || run.timedOut) {
        session.status = "timed_out";
      } else if (run.code === 0) {
        session.status = "finished";
      } else {
        session.status = "failed";
      }
    }

    const retainedCompletedOutput = buildRetainedHistoryText(
      session.fullOutput || session.lastOutput || run.outputText || run.stdout,
    );
    if (retainedCompletedOutput.excerpt) {
      session.fullOutput = retainedCompletedOutput.excerpt;
      session.lastOutput = retainedCompletedOutput.excerpt;
    } else {
      session.fullOutput = undefined;
      session.lastOutput = undefined;
    }

    const retainedCompletedError = buildRetainedHistoryText(
      session.stderr || run.stderr,
    );
    session.stderr = retainedCompletedError.excerpt || "";

    const trackedTask = subagentTaskRegistry.get(session.taskId);
    if (trackedTask) {
      trackedTask.updatedAt = Date.now();
      trackedTask.status = session.status;
      trackedTask.delegatedBy = session.delegatedBy;
      trackedTask.parentSessionId = session.parentSessionId;
      trackedTask.agent = session.agent;
      trackedTask.cwd = session.cwd;
      trackedTask.sessionPath =
        session.sessionPath || run.sessionPath || trackedTask.sessionPath;
      trackedTask.lastTask = session.task;
      trackedTask.lastOutput =
        retainedCompletedOutput.excerpt || trackedTask.lastOutput;
      trackedTask.lastError = retainedCompletedError.excerpt || undefined;
      trackedTask.lastExitCode = session.exitCode;
      trackedTask.lastTimedOut = session.status === "timed_out";
      trackedTask.usage = run.usage;
    }

    cleanupSessionRuntimeArtifacts(session);

    const emitFollowUp =
      options.emitFollowUp ?? session.notifyCompletion ?? true;

    if (session.dismissed) {
      cleanupSessionArtifacts(session);
      subagentSessions.delete(session.id);
      session.resolveCompletion?.(run);
      session.resolveCompletion = undefined;
      session.completionPromise = undefined;
      requestSubagentUiRender();
      return;
    }

    if (emitFollowUp) {
      const details = createSubagentExecutionDetails(
        session.delegatedBy,
        session.agent,
        session.task,
        session.status,
        {
          sessionId: session.id,
          taskId: session.taskId,
          parentSessionId: session.parentSessionId,
          exitCode: session.exitCode,
          timedOut: session.status === "timed_out",
          usage: run.usage,
          agentColor: session.agentColor,
        },
      );

      pi.sendMessage(
        {
          customType: "subagent-result",
          content: formatSessionCompletionMessage(session),
          display: true,
          details,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }

    session.resolveCompletion?.(run);
    session.resolveCompletion = undefined;
    session.completionPromise = undefined;

    pruneFinishedSessions();
    requestSubagentUiRender();
  };

  const killSubagentSession = (sessionId: string, reason?: string): boolean => {
    const session = subagentSessions.get(sessionId);
    if (!session || session.status !== "running") {
      return false;
    }

    session.status = "killed";
    if (reason?.trim()) {
      session.stderr = session.stderr ? `${session.stderr}\n${reason}` : reason;
    }

    if (session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = undefined;
    }

    if (session.proc && !session.proc.killed) {
      try {
        session.proc.kill("SIGTERM");
      } catch {
        // ignore kill errors
      }

      setTimeout(() => {
        if (!session.proc || session.proc.killed) {
          return;
        }

        try {
          session.proc.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }, SUBAGENT_HARD_KILL_DELAY_MS);
    }

    requestSubagentUiRender();
    return true;
  };

  const dismissSubagentSession = (sessionId: string): boolean => {
    const session = subagentSessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.dismissed = true;

    if (session.status === "running") {
      killSubagentSession(sessionId, "Dismissed by user.");
      return true;
    }

    cleanupSessionArtifacts(session);
    subagentSessions.delete(sessionId);
    requestSubagentUiRender();
    return true;
  };

  const startBackgroundSubagent = (
    ctx: ExtensionContext,
    delegatedBy: string,
    agent: Agent,
    task: string,
    cwd: string,
    timeoutMs?: number,
    options: {
      notifyCompletion?: boolean;
      taskId?: string;
      parentSessionId?: string;
      displayTask?: string;
      sessionPath?: string;
      onStreamUpdate?: (update: {
        outputText: string;
        usage: SubagentUsage;
        toolInvocations: SubagentToolInvocation[];
        toolInvocationCount: number;
        latestToolCall?: string;
        malformedEventCount: number;
        sessionPath?: string;
        sessionId: string;
        taskId: string;
        parentSessionId: string;
      }) => void;
    } = {},
  ): SubagentSession => {
    const sessionId = randomUUID();
    const taskId =
      normalizeInputText(options.taskId) ||
      generateUniqueTaskId(subagentTaskRegistry);
    const parentSessionId =
      normalizeInputText(options.parentSessionId) ||
      ctx.sessionManager.getSessionId();
    let resolveCompletion: ((result: SubagentRunResult) => void) | undefined;
    const completionPromise = new Promise<SubagentRunResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const now = Date.now();
    const existingTaskRegistryEntry = subagentTaskRegistry.get(taskId);
    const taskRegistryEntry: SubagentTaskRegistryEntry =
      existingTaskRegistryEntry || {
        taskId,
        sessionPath: options.sessionPath,
        parentSessionId,
        delegatedBy,
        agent: agent.name,
        cwd,
        status: "running",
        createdAt: now,
        updatedAt: now,
        runCount: 0,
        childSessionIds: [],
        lastTask: options.displayTask || task,
      };

    taskRegistryEntry.updatedAt = now;
    taskRegistryEntry.status = "running";
    taskRegistryEntry.delegatedBy = delegatedBy;
    taskRegistryEntry.parentSessionId = parentSessionId;
    taskRegistryEntry.agent = agent.name;
    taskRegistryEntry.cwd = cwd;
    taskRegistryEntry.sessionPath =
      options.sessionPath || taskRegistryEntry.sessionPath;
    taskRegistryEntry.lastTask = options.displayTask || task;
    taskRegistryEntry.runCount += 1;
    taskRegistryEntry.childSessionIds.push(sessionId);
    subagentTaskRegistry.set(taskId, taskRegistryEntry);

    const session: SubagentSession = {
      id: sessionId,
      taskId,
      sessionPath: options.sessionPath,
      parentSessionId,
      delegatedBy,
      agent: agent.name,
      agentColor: agent.color,
      task: options.displayTask || task,
      cwd,
      status: "running",
      startedAt: Date.now(),
      stderr: "",
      timeoutMs,
      notifyCompletion: options.notifyCompletion ?? true,
      completionPromise,
      resolveCompletion,
    };

    if (!isDirectory(cwd)) {
      session.status = "failed";
      session.finishedAt = Date.now();
      session.stderr = `Invalid working directory: ${cwd}`;
      taskRegistryEntry.updatedAt = session.finishedAt;
      taskRegistryEntry.status = "failed";
      taskRegistryEntry.lastError = session.stderr;
      taskRegistryEntry.lastExitCode = 1;
      taskRegistryEntry.lastTimedOut = false;
      session.resolveCompletion?.({
        code: 1,
        stdout: "",
        stderr: session.stderr,
        timedOut: false,
      });
      session.resolveCompletion = undefined;
      session.completionPromise = undefined;
      subagentSessions.set(session.id, session);
      requestSubagentUiRender();
      return session;
    }

    const resolvedSessionDir = resolveSubagentSessionDirectory(
      cwd,
      options.sessionPath,
    );
    if ("error" in resolvedSessionDir) {
      session.status = "failed";
      session.finishedAt = Date.now();
      session.stderr = resolvedSessionDir.error;
      taskRegistryEntry.updatedAt = session.finishedAt;
      taskRegistryEntry.status = "failed";
      taskRegistryEntry.lastError = session.stderr;
      taskRegistryEntry.lastExitCode = 1;
      taskRegistryEntry.lastTimedOut = false;
      session.resolveCompletion?.({
        code: 1,
        stdout: "",
        stderr: session.stderr,
        timedOut: false,
      });
      session.resolveCompletion = undefined;
      session.completionPromise = undefined;
      subagentSessions.set(session.id, session);
      requestSubagentUiRender();
      return session;
    }

    const subagentSessionDir = resolvedSessionDir.sessionDir;
    session.sessionDir = subagentSessionDir;

    subagentSessions.set(session.id, session);
    requestSubagentUiRender();

    const args: string[] = [
      "--mode",
      "json",
      "-p",
      "--no-extensions",
      "--session-dir",
      subagentSessionDir,
    ];
    if (options.sessionPath) {
      args.push("--session", options.sessionPath);
    }
    if (agent.model) {
      args.push("--model", agent.model);
    }
    if (agent.thinkingLevel) {
      args.push("--thinking", agent.thinkingLevel);
    }

    const subagentProviderId = detectSubagentProviderId({
      requestedModel: agent.model,
      activeProviderId: ctx.model?.provider,
      parentEnv: process.env,
    });

    try {
      const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-router-"));
      session.tmpDir = tempDir;

      const isolatedAgentDirResult = prepareIsolatedAgentDirectory(tempDir);
      if ("error" in isolatedAgentDirResult) {
        throw new Error(isolatedAgentDirResult.error);
      }

      session.isolatedAgentDir = isolatedAgentDirResult.agentDir;
      isolatedAgentDirs.add(isolatedAgentDirResult.agentDir);

      const requiredExtensionDirs: string[] = [];
      const missingRequiredExtensions: string[] = [];

      for (const extensionCandidates of SUBAGENT_REQUIRED_EXTENSION_CANDIDATES) {
        const resolvedExtensionDir = resolveExtensionDirectory(extensionCandidates);
        if (resolvedExtensionDir) {
          requiredExtensionDirs.push(resolvedExtensionDir);
          continue;
        }

        missingRequiredExtensions.push(
          formatExtensionCandidatePaths(extensionCandidates),
        );
      }

      if (missingRequiredExtensions.length > 0) {
        throw new Error(
          `Missing required delegated extensions: ${missingRequiredExtensions.join(", ")}. Ensure critical/important extensions are installed before delegating.`,
        );
      }

      const optionalExtensionDirs = SUBAGENT_OPTIONAL_EXTENSION_NAMES.map(
        (extensionName) => join(AGENT_DIR, "extensions", extensionName),
      ).filter((extensionDir) => isDirectory(extensionDir));

      const delegatedExtensionDirs = [
        ...requiredExtensionDirs,
        ...optionalExtensionDirs,
      ];

      for (const extensionDir of delegatedExtensionDirs) {
        args.push("-e", extensionDir);
      }

      const tempPrompt = join(tempDir, "system.md");
      const delegatedSystemPrompt = [
        `<active_agent name="${agent.name}">`,
        agent.systemPrompt,
        "</active_agent>",
        "You MUST follow the active_agent instructions for this turn.",
      ].join("\n");
      writeFileSync(tempPrompt, delegatedSystemPrompt, "utf-8");

      const delegatedCopilotInitiatorExtension = join(
        tempDir,
        "delegated-runtime-copilot-initiator.ts",
      );
      const copilotInitiatorExtensionSource =
        buildDelegatedCopilotInitiatorExtensionSource();
      writeFileSync(
        delegatedCopilotInitiatorExtension,
        copilotInitiatorExtensionSource,
        "utf-8",
      );
      args.push("-e", delegatedCopilotInitiatorExtension);

      if (typeof agent.temperature === "number") {
        const delegatedRuntimeExtension = join(
          tempDir,
          "delegated-runtime-temperature.ts",
        );
        const extensionSource = buildDelegatedTemperatureExtensionSource(
          agent.temperature,
        );
        writeFileSync(delegatedRuntimeExtension, extensionSource, "utf-8");
        args.push("-e", delegatedRuntimeExtension);
      }

      const delegatedIdentityExtension = join(
        tempDir,
        "delegated-runtime-active-agent-identity.ts",
      );
      const delegatedIdentityExtensionSource =
        buildDelegatedActiveAgentIdentityExtensionSource(agent);
      writeFileSync(
        delegatedIdentityExtension,
        delegatedIdentityExtensionSource,
        "utf-8",
      );
      args.push("-e", delegatedIdentityExtension);

      args.push("--append-system-prompt", tempPrompt, `Task: ${task}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      session.status = "failed";
      session.finishedAt = Date.now();
      session.stderr = `Failed to prepare delegated runtime files: ${message}`;
      cleanupSessionArtifacts(session);
      session.resolveCompletion?.({
        code: 1,
        stdout: "",
        stderr: session.stderr,
        timedOut: false,
      });
      session.resolveCompletion = undefined;
      session.completionPromise = undefined;
      requestSubagentUiRender();
      return session;
    }

    const LOCK_RETRY_MAX_RETRIES = 3;
    const LOCK_RETRY_DELAYS_MS = [200, 600, 1500] as const;
    const LOCK_RETRY_JITTER_MAX_MS = 100;
    const LOCK_ERROR_PATTERN = /(Lock file is already being held|ELOCKED)/i;

    const mergeCapturedText = (current: string, next: string): string => {
      if (!current) {
        return next;
      }

      if (!next) {
        return current;
      }

      return `${current}\n${next}`;
    };

    const sleep = (delayMs: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });

    const getStructuredAssistantErrorMessage = (
      run: SubagentRunResult,
    ): string | undefined => {
      const messages = run.messages;
      if (!messages || messages.length === 0) {
        return undefined;
      }

      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index] as Record<string, unknown> | undefined;
        if (!candidate || candidate.role !== "assistant") {
          continue;
        }

        const errorMessage = normalizeInputText(candidate.errorMessage);
        if (errorMessage) {
          return errorMessage;
        }
      }

      return undefined;
    };

    const getSilentSuccessfulRunMessage = (
      run: SubagentRunResult,
    ): string | undefined => {
      if (run.code !== 0 || run.timedOut) {
        return undefined;
      }

      const messages = run.messages;
      if (!messages || messages.length === 0) {
        return undefined;
      }

      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index] as Record<string, unknown> | undefined;
        if (!candidate || candidate.role !== "assistant") {
          continue;
        }

        const stopReason = normalizeInputText(candidate.stopReason);
        if (stopReason && stopReason !== "stop" && stopReason !== "done") {
          return undefined;
        }

        const errorMessage = normalizeInputText(candidate.errorMessage);
        if (errorMessage) {
          return undefined;
        }

        const usage = candidate.usage as Record<string, unknown> | undefined;
        const totalTokens = usage?.totalTokens;
        const hasUsage =
          typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0;
        if (hasUsage) {
          return undefined;
        }

        const content = candidate.content;
        if (typeof content === "string") {
          if (content.trim()) {
            return undefined;
          }
        } else if (Array.isArray(content)) {
          const hasContent = content.some((part) => {
            if (!part || typeof part !== "object") {
              return false;
            }

            const record = part as Record<string, unknown>;
            const partType = normalizeInputText(record.type);
            if (partType === "text") {
              return Boolean(normalizeInputText(record.text));
            }

            return Boolean(partType);
          });
          if (hasContent) {
            return undefined;
          }
        }

        const sawEarlierActivity = messages
          .slice(0, index)
          .some((message) => {
            const prior = message as Record<string, unknown> | undefined;
            if (!prior || typeof prior.role !== "string") {
              return false;
            }

            if (prior.role === "tool") {
              return true;
            }

            if (prior.role !== "assistant") {
              return false;
            }

            const priorContent = prior.content;
            if (typeof priorContent === "string") {
              return Boolean(priorContent.trim());
            }

            if (!Array.isArray(priorContent)) {
              return false;
            }

            return priorContent.some((part) => {
              if (!part || typeof part !== "object") {
                return false;
              }

              const record = part as Record<string, unknown>;
              const partType = normalizeInputText(record.type);
              if (partType === "text") {
                return Boolean(normalizeInputText(record.text));
              }

              return Boolean(partType);
            });
          });

        return sawEarlierActivity
          ? "Delegated stream finished without a final assistant output after tool activity."
          : "Delegated stream finished without any assistant output or completion payload.";
      }

      return undefined;
    };

    const getRunFailureText = (run: SubagentRunResult): string => {
      let failureText = run.stderr.trim();
      const structuredError = getStructuredAssistantErrorMessage(run);
      if (
        structuredError &&
        (!failureText || !failureText.includes(structuredError))
      ) {
        failureText = mergeCapturedText(failureText, structuredError);
      }

      const silentSuccessMessage = getSilentSuccessfulRunMessage(run);
      if (
        silentSuccessMessage &&
        (!failureText || !failureText.includes(silentSuccessMessage))
      ) {
        failureText = mergeCapturedText(failureText, silentSuccessMessage);
      }

      return failureText;
    };

    const hasAssistantResponse = (run: SubagentRunResult): boolean => {
      const outputText =
        run.outputText?.trim() ||
        getSubagentOutputFromMessages(run.messages || []).trim();
      return Boolean(outputText);
    };

    const hasMeaningfulOutput = (run: SubagentRunResult): boolean => {
      if (hasAssistantResponse(run)) {
        return true;
      }

      if (run.messages && run.messages.length > 0) {
        return true;
      }

      return Boolean(run.stdout.trim());
    };

    const getRunToolInvocationCount = (run: SubagentRunResult): number => {
      if (typeof run.toolInvocationCount === "number" && Number.isFinite(run.toolInvocationCount)) {
        return Math.max(0, Math.trunc(run.toolInvocationCount));
      }

      if (run.toolInvocations && run.toolInvocations.length > 0) {
        return countSubagentToolInvocations(run.toolInvocations);
      }

      if (run.messages && run.messages.length > 0) {
        return countSubagentToolInvocations(
          summarizeSubagentToolInvocations(run.messages),
        );
      }

      return 0;
    };

    const hasExtensiveDelegatedProgress = (run: SubagentRunResult): boolean => {
      const usage = run.usage;
      const outputText =
        run.outputText?.trim() ||
        getSubagentOutputFromMessages(run.messages || []).trim();
      const toolInvocationCount = getRunToolInvocationCount(run);

      return (
        toolInvocationCount >= 12 ||
        (usage?.turns ?? 0) >= 6 ||
        (usage?.input ?? 0) >= 50_000 ||
        outputText.length >= 24_000
      );
    };

    const getRunQualityScore = (run: SubagentRunResult): number => {
      const usage = run.usage;
      const outputText =
        run.outputText?.trim() ||
        getSubagentOutputFromMessages(run.messages || []).trim();
      const toolInvocationCount = getRunToolInvocationCount(run);
      const messageCount = run.messages?.length ?? 0;

      return (
        outputText.length +
        toolInvocationCount * 4_000 +
        (usage?.turns ?? 0) * 8_000 +
        Math.min(200_000, usage?.input ?? 0) +
        messageCount * 128
      );
    };

    const mergeOutputNotices = (
      current: string | undefined,
      next: string | undefined,
    ): string | undefined => {
      const merged = [current?.trim(), next?.trim()].filter(
        (value): value is string => Boolean(value),
      );
      if (merged.length === 0) {
        return undefined;
      }

      return [...new Set(merged)].join("\n");
    };

    const preferRicherRunResult = (
      base: SubagentRunResult,
      candidate: SubagentRunResult | undefined,
    ): SubagentRunResult => {
      if (!candidate || getRunQualityScore(candidate) <= getRunQualityScore(base)) {
        return base;
      }

      const candidateMessages = candidate.messages || [];
      const baseMessages = base.messages || [];
      const candidateInvocations =
        candidate.toolInvocations ||
        (candidateMessages.length > 0
          ? summarizeSubagentToolInvocations(candidateMessages)
          : undefined);
      const baseInvocations =
        base.toolInvocations ||
        (baseMessages.length > 0
          ? summarizeSubagentToolInvocations(baseMessages)
          : undefined);

      return {
        ...base,
        stdout:
          candidate.stdout.trim().length > base.stdout.trim().length
            ? candidate.stdout
            : base.stdout,
        sessionPath: candidate.sessionPath || base.sessionPath,
        messages: candidateMessages.length > 0 ? candidateMessages : base.messages,
        usage:
          (candidate.usage?.input ?? 0) >= (base.usage?.input ?? 0)
            ? candidate.usage
            : base.usage,
        malformedEventCount: Math.max(
          base.malformedEventCount ?? 0,
          candidate.malformedEventCount ?? 0,
        ),
        outputText:
          (candidate.outputText?.trim().length ?? 0) >=
          (base.outputText?.trim().length ?? 0)
            ? candidate.outputText
            : base.outputText,
        toolInvocations:
          (candidateInvocations?.length ?? 0) >= (baseInvocations?.length ?? 0)
            ? candidateInvocations
            : baseInvocations,
        toolInvocationCount: Math.max(
          getRunToolInvocationCount(base),
          getRunToolInvocationCount(candidate),
        ),
        latestToolCall: candidate.latestToolCall || base.latestToolCall,
        stdoutTruncated: Boolean(base.stdoutTruncated || candidate.stdoutTruncated),
        stderrTruncated: Boolean(base.stderrTruncated || candidate.stderrTruncated),
        outputNotice: mergeOutputNotices(base.outputNotice, candidate.outputNotice),
      };
    };

    const isLockRetryableFailure = (run: SubagentRunResult): boolean => {
      if (run.code === 0 || run.timedOut) {
        return false;
      }

      if (!LOCK_ERROR_PATTERN.test(run.stderr)) {
        return false;
      }

      return !hasMeaningfulOutput(run);
    };

    const getRetryableCredentialFailure = (
      run: SubagentRunResult,
    ): { kind: "quota" | "transient"; message: string } | undefined => {
      if (run.timedOut) {
        return undefined;
      }

      const structuredError = getStructuredAssistantErrorMessage(run);
      const stderrText = run.stderr.trim();
      const silentSuccessMessage = getSilentSuccessfulRunMessage(run);
      const candidates = [structuredError, stderrText, silentSuccessMessage].filter(
        (value): value is string => Boolean(value),
      );
      const allowFullTaskRetry = !hasExtensiveDelegatedProgress(run);

      for (const candidate of candidates) {
        if (isQuotaOrRateLimitError(candidate)) {
          return allowFullTaskRetry
            ? { kind: "quota", message: candidate }
            : undefined;
        }

        if (
          isTransientCredentialError(candidate) ||
          isRetryableModelAvailabilityError(subagentProviderId, candidate)
        ) {
          return allowFullTaskRetry
            ? { kind: "transient", message: candidate }
            : undefined;
        }
      }

      return undefined;
    };

    let finalized = false;
    let accumulatedStderr = "";

    const finalizeRun = (run: SubagentRunResult): void => {
      if (finalized) {
        return;
      }

      finalized = true;
      session.proc = undefined;
      if (run.sessionPath) {
        session.sessionPath = run.sessionPath;
      }
      finalizeSession(session, run, { emitFollowUp: session.notifyCompletion });
    };

    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined;

    const triggerSubagentTimeout = (): void => {
      if (!effectiveTimeoutMs || session.status !== "running" || session.timedOut) {
        return;
      }

      session.timedOut = true;

      if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
        session.timeoutTimer = undefined;
      }

      const timeoutMessage = `Timed out after ${Math.round(effectiveTimeoutMs / 1000)}s`;
      session.stderr = session.stderr
        ? `${session.stderr}\n${timeoutMessage}`
        : timeoutMessage;

      if (session.proc && !session.proc.killed) {
        try {
          session.proc.kill("SIGTERM");
        } catch {
        }

        setTimeout(() => {
          if (!session.proc || session.proc.killed) {
            return;
          }

          try {
            session.proc.kill("SIGKILL");
          } catch {
          }
        }, SUBAGENT_HARD_KILL_DELAY_MS);
      }

      requestSubagentUiRender();
    };

    const armSubagentTimeout = (): void => {
      if (!effectiveTimeoutMs) {
        return;
      }

      if (session.timeoutTimer) {
        clearTimeout(session.timeoutTimer);
      }

      session.timeoutTimer = setTimeout(() => {
        triggerSubagentTimeout();
      }, effectiveTimeoutMs);
    };

    const recordSubagentActivity = (): void => {
      if (!effectiveTimeoutMs) {
        return;
      }

      if (session.status !== "running" || session.timedOut) {
        return;
      }

      armSubagentTimeout();
    };

    const cliEntrypoint = normalizeInputText(process.argv[1]);
    const canSpawnCurrentCli = Boolean(cliEntrypoint && isFile(cliEntrypoint));
    const command = canSpawnCurrentCli
      ? process.execPath
      : process.platform === "win32"
        ? process.env.ComSpec || "cmd.exe"
        : "pi";
    const commandArgs = canSpawnCurrentCli
      ? [cliEntrypoint, ...args]
      : process.platform === "win32"
        ? ["/d", "/s", "/c", "pi", ...args]
        : args;

    let lastAcquiredCredentialId: string | undefined;

    const runSubagentAttempt = async (): Promise<SubagentRunResult> => {
      const acquiredKeyLease = await tryAcquireKeyForSubagent(
        session.id,
        subagentProviderId,
        {
          requestedModel: agent.model,
        },
      );
      lastAcquiredCredentialId = acquiredKeyLease?.credentialId;
      const stdoutSink = createOutputSink({
        inMemoryMaxChars: SUBAGENT_STDOUT_CAPTURE_MAX_CHARS,
      });
      const stderrSink = createOutputSink({
        inMemoryMaxChars: SUBAGENT_STDERR_CAPTURE_MAX_CHARS,
      });
      const stdoutDecoder = new TextDecoder("utf-8");
      const stderrDecoder = new TextDecoder("utf-8");
      let stdoutBuffer = "";
      let stdoutPartialLineOverflowed = false;
      let droppedPartialStdoutChars = 0;
      const eventState = createSubagentJsonEventState({
        sessionDir: subagentSessionDir,
      });
      let lastStreamOutput = "";
      let lastStreamToolInvocationCount = 0;
      let lastStreamLatestToolCall: string | undefined;

      const emitStreamUpdate = (): void => {
        const outputText = eventState.outputText;
        const toolInvocations = getSubagentToolInvocationsFromState(eventState);
        const toolInvocationCount = eventState.toolInvocationTotalCount;
        const latestToolCall = eventState.latestToolCall;
        const trackedInvocationsChanged = !sameToolInvocations(
          session.toolInvocations,
          toolInvocations,
        );
        const toolInvocationCountChanged =
          toolInvocationCount !== lastStreamToolInvocationCount;
        const latestToolCallChanged = latestToolCall !== lastStreamLatestToolCall;

        if (trackedInvocationsChanged) {
          session.toolInvocations = toolInvocations;
        }

        const outputChanged =
          Boolean(outputText) && outputText !== lastStreamOutput;
        if (!outputChanged && !trackedInvocationsChanged && !toolInvocationCountChanged && !latestToolCallChanged) {
          return;
        }

        if (outputChanged) {
          lastStreamOutput = outputText;
          session.lastOutput = outputText;
        }

        lastStreamToolInvocationCount = toolInvocationCount;
        lastStreamLatestToolCall = latestToolCall;

        if (typeof options.onStreamUpdate === "function") {
          try {
            options.onStreamUpdate({
              outputText: outputText || lastStreamOutput,
              usage: cloneSubagentUsage(eventState.usage),
              toolInvocations: toolInvocations.map((item) => ({ ...item })),
              toolInvocationCount,
              latestToolCall,
              malformedEventCount: eventState.malformedEventCount,
              sessionPath: eventState.sessionPath,
              sessionId: session.id,
              taskId: session.taskId,
              parentSessionId: session.parentSessionId,
            });
          } catch {
            // ignore attach stream callback failures
          }
        }

        recordSubagentActivity();
        requestSubagentUiRender(false);
      };

      const appendStdoutPiece = (piece: string): void => {
        if (!piece) {
          return;
        }

        stdoutSink.push(piece);
        recordSubagentActivity();
        stdoutBuffer += piece;

        let processedJsonEvent = false;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          if (stdoutPartialLineOverflowed) {
            eventState.malformedEventCount += 1;
            stdoutPartialLineOverflowed = false;
            continue;
          }

          processSubagentJsonEventLine(line, eventState);
          processedJsonEvent = true;
        }

        if (processedJsonEvent) {
          emitStreamUpdate();
        }

        if (stdoutBuffer.length > SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS) {
          const overflow =
            stdoutBuffer.length - SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS;
          droppedPartialStdoutChars += overflow;
          stdoutBuffer = stdoutBuffer.slice(
            -SUBAGENT_STDOUT_PARTIAL_LINE_MAX_CHARS,
          );
          stdoutPartialLineOverflowed = true;
        }
      };

      const appendStderrPiece = (piece: string): void => {
        if (!piece) {
          return;
        }

        stderrSink.push(piece);
        session.stderr = mergeCapturedText(
          accumulatedStderr,
          stderrSink.summarize().tailText,
        );
        recordSubagentActivity();
        requestSubagentUiRender(false);
      };

      const appendStderrMessage = (message: string): void => {
        if (!message) {
          return;
        }

        const currentTail = stderrSink.summarize().tailText;
        appendStderrPiece(currentTail ? `\n${message}` : message);
      };

      const flushStdoutRemainder = (): void => {
        if (!stdoutBuffer.trim()) {
          if (stdoutPartialLineOverflowed) {
            eventState.malformedEventCount += 1;
          }
          stdoutBuffer = "";
          stdoutPartialLineOverflowed = false;
          return;
        }

        if (stdoutPartialLineOverflowed) {
          eventState.malformedEventCount += 1;
        } else {
          processSubagentJsonEventLine(stdoutBuffer, eventState);
          emitStreamUpdate();
        }

        stdoutBuffer = "";
        stdoutPartialLineOverflowed = false;
      };

      const flushDecoderRemainders = (): void => {
        appendStdoutPiece(stdoutDecoder.decode());
        appendStderrPiece(stderrDecoder.decode());
      };

      const buildCaptureNotice = (
        streamName: "stdout" | "stderr",
        maxChars: number,
        summary: OutputCaptureSummary,
        options: { suppress?: boolean } = {},
      ): string[] => {
        if (summary.droppedChars <= 0 || options.suppress) {
          return [];
        }

        return [
          `Delegated ${streamName} was truncated to the most recent ${maxChars} chars (dropped ${summary.droppedChars} chars).`,
        ];
      };

      const finalizeCapturedOutput = async (): Promise<{
        stdout: ReturnType<typeof stdoutSink.summarize>;
        stderr: ReturnType<typeof stderrSink.summarize>;
        outputNotice?: string;
      }> => {
        flushDecoderRemainders();
        flushStdoutRemainder();

        const stdoutSummary = await stdoutSink.close();
        const stderrSummary = await stderrSink.close();
        const hasStructuredDelegatedOutput =
          eventState.messages.length > 0 ||
          Boolean(eventState.outputText.trim()) ||
          eventState.toolInvocationTotalCount > 0;
        const suppressStdoutTruncationNotice =
          hasStructuredDelegatedOutput &&
          eventState.malformedEventCount === 0 &&
          droppedPartialStdoutChars === 0;
        const notices = [
          ...buildCaptureNotice(
            "stdout",
            SUBAGENT_STDOUT_CAPTURE_MAX_CHARS,
            stdoutSummary,
            { suppress: suppressStdoutTruncationNotice },
          ),
          ...buildCaptureNotice(
            "stderr",
            SUBAGENT_STDERR_CAPTURE_MAX_CHARS,
            stderrSummary,
          ),
        ];

        if (droppedPartialStdoutChars > 0) {
          notices.push(
            `Dropped ${droppedPartialStdoutChars} chars from oversized partial stdout JSON event lines while parsing delegated output.`,
          );
        }

        return {
          stdout: stdoutSummary,
          stderr: stderrSummary,
          outputNotice: notices.length > 0 ? notices.join("\n") : undefined,
        };
      };

      return new Promise<SubagentRunResult>((resolve) => {
        let settled = false;

        const completeAttempt = (code: number): void => {
          if (settled) {
            return;
          }

          settled = true;
          void (async () => {
            try {
              const captured = await finalizeCapturedOutput();
              const run: SubagentRunResult = {
                code,
                stdout: captured.stdout.tailText,
                stderr: captured.stderr.tailText,
                timedOut: Boolean(session.timedOut),
                sessionPath: eventState.sessionPath || options.sessionPath,
                messages: [...eventState.messages],
                usage: cloneSubagentUsage(eventState.usage),
                malformedEventCount: eventState.malformedEventCount,
                outputText: eventState.outputText,
                toolInvocations: getSubagentToolInvocationsFromState(eventState),
                toolInvocationCount: eventState.toolInvocationTotalCount,
                latestToolCall: eventState.latestToolCall,
                stdoutTruncated: captured.stdout.droppedChars > 0,
                stderrTruncated: captured.stderr.droppedChars > 0,
                outputNotice: captured.outputNotice,
              };

              if (run.sessionPath) {
                session.sessionPath = run.sessionPath;
              }
              resolve(run);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown error";
              resolve({
                code,
                stdout: "",
                stderr: mergeCapturedText(accumulatedStderr, message),
                timedOut: Boolean(session.timedOut),
                sessionPath: eventState.sessionPath || options.sessionPath,
                messages: [...eventState.messages],
                usage: cloneSubagentUsage(eventState.usage),
                malformedEventCount: eventState.malformedEventCount,
                outputText: eventState.outputText,
                toolInvocations: getSubagentToolInvocationsFromState(eventState),
                toolInvocationCount: eventState.toolInvocationTotalCount,
                latestToolCall: eventState.latestToolCall,
                outputNotice: `Failed to finalize delegated output capture: ${message}`,
              });
            } finally {
              if (acquiredKeyLease) {
                releaseKeyForSubagent(session.id);
              }
              session.proc = undefined;
            }
          })();
        };

        try {
          const subagentEnv: NodeJS.ProcessEnv = {
            ...process.env,
          };

          if (session.isolatedAgentDir) {
            subagentEnv.PI_CODING_AGENT_DIR = session.isolatedAgentDir;
          }

          if (acquiredKeyLease) {
            subagentEnv[acquiredKeyLease.envKey] = acquiredKeyLease.apiKey;
          }

          const proc = spawn(command, commandArgs, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            env: subagentEnv,
          });

          session.proc = proc as SubagentSession["proc"];

          proc.stdout.on("data", (chunk) => {
            appendStdoutPiece(stdoutDecoder.decode(chunk, { stream: true }));
          });

          proc.stderr.on("data", (chunk) => {
            appendStderrPiece(stderrDecoder.decode(chunk, { stream: true }));
          });

          proc.on("close", (code) => {
            completeAttempt(code ?? 1);
          });

          proc.on("error", (error) => {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to spawn delegated process";
            appendStderrMessage(message);
            completeAttempt(1);
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          appendStderrMessage(message);
          completeAttempt(1);
        }
      });
    };

    if (effectiveTimeoutMs) {
      armSubagentTimeout();
    }

    const QUOTA_RETRY_MAX_RETRIES = 3;
    const QUOTA_RETRY_BASE_DELAY_MS = 1_500;
    const QUOTA_RETRY_JITTER_MAX_MS = 500;
    const TRANSIENT_RETRY_MAX_RETRIES = 2;
    const TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;
    const TRANSIENT_RETRY_JITTER_MAX_MS = 250;

    const runWithLockRetry = async (): Promise<void> => {
      let lockRetryCount = 0;
      let quotaRetryCount = 0;
      let transientRetryCount = 0;
      let richestAttemptRun: SubagentRunResult | undefined;

      while (true) {
        if (session.status !== "running") {
          finalizeRun({
            code: 1,
            stdout: "",
            stderr: accumulatedStderr || session.stderr,
            timedOut: Boolean(session.timedOut),
            sessionPath: session.sessionPath || options.sessionPath,
          });
          return;
        }

        const attemptRun = await runSubagentAttempt();
        const retryableFailure = getRetryableCredentialFailure(attemptRun);
        const runFailureText = getRunFailureText(attemptRun);
        const runWithAccumulatedStderr: SubagentRunResult = {
          ...attemptRun,
          stderr: mergeCapturedText(accumulatedStderr, runFailureText),
        };
        richestAttemptRun = preferRicherRunResult(
          richestAttemptRun || runWithAccumulatedStderr,
          runWithAccumulatedStderr,
        );

        if (
          attemptRun.code === 0 &&
          !attemptRun.timedOut &&
          !retryableFailure &&
          lastAcquiredCredentialId
        ) {
          clearSubagentTransientKeyError(lastAcquiredCredentialId);
        }

        // Check lock retry
        if (
          lockRetryCount < LOCK_RETRY_MAX_RETRIES &&
          session.status === "running" &&
          !session.timedOut &&
          isLockRetryableFailure(attemptRun)
        ) {
          accumulatedStderr = runWithAccumulatedStderr.stderr;
          const delay =
            LOCK_RETRY_DELAYS_MS[lockRetryCount] +
            Math.floor(Math.random() * LOCK_RETRY_JITTER_MAX_MS);
          const retryMessage =
            `[pi-agent-router] Lock contention detected for delegated task ${session.id.slice(0, 8)} ` +
            `(attempt ${lockRetryCount + 1}/${LOCK_RETRY_MAX_RETRIES + 1}). Retrying in ${delay}ms.`;

          accumulatedStderr = mergeCapturedText(accumulatedStderr, retryMessage);
          session.stderr = accumulatedStderr;
          void piAgentRouterDebugLogger.warn("subagent.lock_contention_retry", {
            attempt: lockRetryCount + 1,
            delayMs: delay,
            maxAttempts: LOCK_RETRY_MAX_RETRIES + 1,
            message: retryMessage,
            sessionId: session.id,
          });
          requestSubagentUiRender();
          lockRetryCount += 1;

          await sleep(delay);
          continue;
        }

        // Check quota/rate-limit retry with credential rotation
        if (
          retryableFailure?.kind === "quota" &&
          quotaRetryCount < QUOTA_RETRY_MAX_RETRIES &&
          session.status === "running" &&
          !session.timedOut
        ) {
          if (lastAcquiredCredentialId) {
            reportSubagentKeyError(
              session.id,
              lastAcquiredCredentialId,
              retryableFailure.message.slice(0, 500),
            );
          }
          accumulatedStderr = runWithAccumulatedStderr.stderr;
          quotaRetryCount += 1;
          const delay =
            QUOTA_RETRY_BASE_DELAY_MS * quotaRetryCount +
            Math.floor(Math.random() * QUOTA_RETRY_JITTER_MAX_MS);
          const retryMessage =
            `[pi-agent-router] Quota/rate-limit error for delegated task ${session.id.slice(0, 8)} ` +
            `(quota retry ${quotaRetryCount}/${QUOTA_RETRY_MAX_RETRIES}). Rotating credential and retrying in ${delay}ms.`;

          accumulatedStderr = mergeCapturedText(accumulatedStderr, retryMessage);
          session.stderr = accumulatedStderr;
          void piAgentRouterDebugLogger.warn("subagent.quota_retry", {
            attempt: quotaRetryCount,
            delayMs: delay,
            maxAttempts: QUOTA_RETRY_MAX_RETRIES,
            message: retryMessage,
            sessionId: session.id,
          });
          requestSubagentUiRender();

          await sleep(delay);
          continue;
        }

        if (
          retryableFailure?.kind === "transient" &&
          transientRetryCount < TRANSIENT_RETRY_MAX_RETRIES &&
          session.status === "running" &&
          !session.timedOut
        ) {
          if (lastAcquiredCredentialId) {
            reportSubagentTransientKeyError(
              session.id,
              lastAcquiredCredentialId,
              retryableFailure.message.slice(0, 500),
            );
          }
          accumulatedStderr = runWithAccumulatedStderr.stderr;
          transientRetryCount += 1;
          const delay =
            TRANSIENT_RETRY_BASE_DELAY_MS * transientRetryCount +
            Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MAX_MS);
          const retryMessage =
            `[pi-agent-router] Transient provider error for delegated task ${session.id.slice(0, 8)} ` +
            `(retry ${transientRetryCount}/${TRANSIENT_RETRY_MAX_RETRIES}). Retrying with credential rotation in ${delay}ms.`;

          accumulatedStderr = mergeCapturedText(accumulatedStderr, retryMessage);
          session.stderr = accumulatedStderr;
          void piAgentRouterDebugLogger.warn("subagent.transient_retry", {
            attempt: transientRetryCount,
            delayMs: delay,
            maxAttempts: TRANSIENT_RETRY_MAX_RETRIES,
            message: retryMessage,
            sessionId: session.id,
          });
          requestSubagentUiRender();

          await sleep(delay);
          continue;
        }

        // Not retryable, finalize
        const finalRun =
          retryableFailure && runWithAccumulatedStderr.code === 0
            ? { ...runWithAccumulatedStderr, code: 1 }
            : runWithAccumulatedStderr;
        finalizeRun(preferRicherRunResult(finalRun, richestAttemptRun));
        return;
      }
    };

    void runWithLockRetry().catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      const fallbackRun: SubagentRunResult = {
        code: 1,
        stdout: "",
        stderr: mergeCapturedText(accumulatedStderr || session.stderr, message),
        timedOut: Boolean(session.timedOut),
        sessionPath: session.sessionPath || options.sessionPath,
      };
      finalizeRun(fallbackRun);
    });

    pruneFinishedSessions();
    return session;
  };

  const setupSubagentWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setWidget(
      SUBAGENT_WIDGET_KEY,
      (tui, theme) => {
        const animatedSurface = createAnimatedRenderSurface(tui, {
          intervalMs: SPINNER_RENDER_INTERVAL_MS,
          shouldRender: hasRunningVisibleSubagentSession,
        });
        subagentWidgetRenderRequest = animatedSurface.requestRender;

        return {
          dispose() {
            animatedSurface.dispose();
            if (subagentWidgetRenderRequest === animatedSurface.requestRender) {
              subagentWidgetRenderRequest = null;
            }
          },
          invalidate() {},
          render(width: number): string[] {
            return renderSubagentWidgetLines({
              sessions: listSubagentSessions(),
              width,
              theme,
              formatDuration,
              getStatusDisplay: (status) =>
                getSubagentStatusDisplay(parseSubagentExecutionStatus(status)),
              truncate: truncateToWidth,
            });
          },
        };
      },
      { placement: "belowEditor" },
    );
  };

  const openSubagentOutputModal = async (
    ctx: ExtensionContext,
    sessionId: string,
  ): Promise<void> => {
    if (!ctx.hasUI) {
      return;
    }

    const initialSession = subagentSessions.get(sessionId);
    if (!initialSession) {
      ctx.ui.notify(`Session not found: ${sessionId}`, "error");
      return;
    }

    let overlayRenderRequest: (() => void) | null = null;

    try {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const animatedSurface = createAnimatedRenderSurface(tui, {
            intervalMs: SPINNER_RENDER_INTERVAL_MS,
            shouldRender: () => subagentSessions.get(sessionId)?.status === "running",
          });
          overlayRenderRequest = animatedSurface.requestRender;
          subagentOverlayRenderRequest = animatedSurface.requestRender;

          const overlay = new SubagentOutputOverlay(
            theme,
            () => subagentSessions.get(sessionId),
            () => done(),
            animatedSurface.requestRender,
            () => {
              const terminalRows = (tui as { terminal?: { rows?: number } })
                .terminal?.rows;
              return typeof terminalRows === "number" && terminalRows > 0
                ? terminalRows
                : 40;
            },
            {
              getStatusDisplay: (status) =>
                getSubagentStatusDisplay(parseSubagentExecutionStatus(status)),
              formatDuration,
              sanitizeOutput: sanitizeSubagentResultForDisplay,
            },
          );

          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => overlay.handleInput(data),
            dispose: () => {
              animatedSurface.dispose();
              if (
                subagentOverlayRenderRequest === animatedSurface.requestRender
              ) {
                subagentOverlayRenderRequest = null;
              }
              if (overlayRenderRequest === animatedSurface.requestRender) {
                overlayRenderRequest = null;
              }
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            maxHeight: "85%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } finally {
      if (
        overlayRenderRequest &&
        subagentOverlayRenderRequest === overlayRenderRequest
      ) {
        subagentOverlayRenderRequest = null;
      }
    }
  };

  const clearAgentStatus = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-agent-router", undefined);
    }
  };

  const persistActiveAgent = (
    ctx: ExtensionContext,
    agentName: string | null,
  ): void => {
    try {
      const withAppend = ctx as ContextWithOptionalAppendEntry;
      if (typeof withAppend.appendEntry === "function") {
        withAppend.appendEntry<ActiveAgentEntryData>("active_agent", {
          name: agentName,
        });
        return;
      }
      pi.appendEntry<ActiveAgentEntryData>("active_agent", { name: agentName });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      ctx.ui.notify(
        `Failed to persist active agent '${agentName ?? "none"}': ${message}`,
        "warning",
      );
    }
  };

  const syncManualThinkingOverrideForAgent = (
    ctx: ExtensionContext,
    agentName: string | null,
  ): void => {
    if (!agentName) {
      return;
    }

    const configuredAgent = loadAgents().find(
      (agent) => agent.name === agentName,
    );
    if (!configuredAgent?.thinkingLevel) {
      manualThinkingOverrideByAgent.delete(agentName);
      return;
    }

    try {
      const currentThinkingLevel = normalizeThinkingLevel(
        pi.getThinkingLevel(),
      );
      if (!currentThinkingLevel) {
        return;
      }

      if (currentThinkingLevel === configuredAgent.thinkingLevel) {
        manualThinkingOverrideByAgent.delete(agentName);
        return;
      }

      manualThinkingOverrideByAgent.set(agentName, currentThinkingLevel);
    } catch (error) {
      if (!ctx.hasUI) {
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      ctx.ui.notify(
        `Failed to capture manual thinking override for agent '${agentName}': ${message}`,
        "warning",
      );
    }
  };

  const setActiveAgent = (
    ctx: ExtensionContext,
    agentName: string | null,
    options: {
      persist?: boolean;
      notify?: boolean;
      applyRuntime?: boolean;
    } = {},
  ): void => {
    const previousActiveAgent = activeAgent;
    activeAgent = agentName;

    if (previousActiveAgent !== activeAgent) {
      manualModelOverrideForActiveAgent = undefined;
    }

    clearAgentStatus(ctx);

    if (options.persist) {
      persistActiveAgent(ctx, activeAgent);
    }

    if (options.notify) {
      if (activeAgent) {
        ctx.ui.notify(
          `${getAgentEmoji(activeAgent)} Active agent: ${activeAgent}`,
          "info",
        );
      } else {
        ctx.ui.notify("Agent mode disabled", "info");
      }
    }

    if (options.applyRuntime === false || !activeAgent || !ctx.hasUI) {
      return;
    }

    const selectedAgent = loadAgents().find(
      (agent) => agent.name === activeAgent,
    );
    if (!selectedAgent) {
      return;
    }

    void applyAgentRuntimeProfile(ctx, selectedAgent, {
      respectManualThinkingOverride: true,
    });
  };

  const cycleAgent = (ctx: ExtensionContext, direction: 1 | -1): void => {
    const agents = loadAgents();
    const cyclable = getCyclablePrimaryAgents(agents);

    if (cyclable.length === 0) {
      const available = agents.map((agent) => agent.name).join(", ") || "none";
      ctx.ui.notify(
        `No primary agents found for Tab cycling. Expected primary defaults: ${DEFAULT_PRIMARY_AGENTS.join(", ")}\nAvailable: ${available}`,
        "warning",
      );
      return;
    }

    const currentIndex = activeAgent ? cyclable.indexOf(activeAgent) : -1;
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : cyclable.length - 1
        : (currentIndex + direction + cyclable.length) % cyclable.length;

    setActiveAgent(ctx, cyclable[nextIndex], { persist: true, notify: false });
  };

  const ensureTabCycleInputHook = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) {
      return;
    }

    tabCycleInputContext = ctx;

    if (tabCycleInputUnsubscribe) {
      return;
    }

    tabCycleInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (data !== "\t") {
        return undefined;
      }

      const currentCtx = tabCycleInputContext;
      if (!currentCtx) {
        return undefined;
      }

      const now = Date.now();
      if (tabCycleDebounceMs > 0 && now - lastTabCycleAtMs < tabCycleDebounceMs) {
        return { consume: true, data: "" };
      }

      lastTabCycleAtMs = now;
      cycleAgent(currentCtx, 1);
      return { consume: true, data: "" };
    });
  };

  const clearTabCycleInputHook = (): void => {
    if (tabCycleInputUnsubscribe) {
      tabCycleInputUnsubscribe();
      tabCycleInputUnsubscribe = undefined;
    }

    tabCycleInputContext = undefined;
    lastTabCycleAtMs = 0;
  };

  const restoreActiveAgentFromSession = (ctx: ExtensionContext): void => {
    const persisted = getPersistedActiveAgentName(ctx);
    if (persisted === undefined) {
      setActiveAgent(ctx, DEFAULT_AGENT, { persist: false, notify: false });
      return;
    }
    if (persisted === null) {
      setActiveAgent(ctx, null, { persist: false, notify: false });
      return;
    }

    const agents = loadAgents();
    const persistedAgent = agents.find((agent) => agent.name === persisted);
    if (!persistedAgent) {
      activeAgent = null;
      clearAgentStatus(ctx);
      ctx.ui.notify(
        `Saved agent '${persisted}' was not found. Agent mode is disabled.`,
        "warning",
      );
      return;
    }

    setActiveAgent(ctx, persistedAgent.name, { persist: false, notify: false });
  };

  pi.on("session_start", (_event, ctx) => {
    subagentUiRenderScheduler.cancel();
    activeSubagentDelegations = 0;
    queuedSubagentDelegations.length = 0;
    pendingDelegationJobs.clear();
    dispatchReminderQueued = false;
    autoCompletionWaitJob = null;
    manualModelOverrideForActiveAgent = undefined;
    manualThinkingOverrideByAgent.clear();

    const nextParentSessionId = syncActiveParentSessionId(ctx);
    clearStaleSubagentUiSessions(nextParentSessionId);

    setActiveAgent(ctx, DEFAULT_AGENT, {
      persist: false,
      notify: false,
      applyRuntime: false,
    });
    restoreActiveAgentFromSession(ctx);
    persistActiveAgent(ctx, activeAgent);

    if (!ctx.hasUI) {
      return;
    }

    pruneFinishedSessions();
    ensureCleanupTimer();
    setupSubagentWidget(ctx);

    ensureTabCycleInputHook(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    subagentUiRenderScheduler.cancel();
    const persistedActiveAgent = getPersistedActiveAgentName(ctx);
    manualModelOverrideForActiveAgent = undefined;
    manualThinkingOverrideByAgent.clear();

    syncActiveParentSessionId(ctx);
    restoreActiveAgentFromSession(ctx);

    if (persistedActiveAgent === undefined) {
      persistActiveAgent(ctx, activeAgent);
    }

    if (!ctx.hasUI) {
      return;
    }

    pruneFinishedSessions();
    ensureCleanupTimer();
    setupSubagentWidget(ctx);
    ensureTabCycleInputHook(ctx);
  });

  pi.on("model_select", async (event) => {
    if (suppressManualModelOverrideCapture) {
      return;
    }

    if (!activeAgent) {
      manualModelOverrideForActiveAgent = undefined;
      return;
    }

    if (event.source === "restore") {
      return;
    }

    manualModelOverrideForActiveAgent = {
      agentName: activeAgent,
      modelRef: toModelReference(event.model),
    };
  });

  pi.on("input", async (_event, ctx) => {
    syncManualThinkingOverrideForAgent(ctx, activeAgent);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    subagentUiRenderScheduler.cancel();
    const shuttingDownParentSessionId = normalizeInputText(
      ctx.sessionManager.getSessionId(),
    );
    const isActiveParentSession =
      Boolean(shuttingDownParentSessionId) &&
      shuttingDownParentSessionId === activeParentSessionId;

    shutdownParentScopedSubagentSessions(shuttingDownParentSessionId);

    if (!isActiveParentSession) {
      return;
    }

    activeParentSessionId = "";
    clearCleanupTimer();
    clearAgentStatus(ctx);
    manualModelOverrideForActiveAgent = undefined;
    manualThinkingOverrideByAgent.clear();
    activeSubagentDelegations = 0;
    queuedSubagentDelegations.length = 0;
    pendingDelegationJobs.clear();
    dispatchReminderQueued = false;
    autoCompletionWaitJob = null;

    if (!ctx.hasUI) {
      subagentOverlayRenderRequest = null;
      subagentWidgetRenderRequest = null;
      clearTabCycleInputHook();
      return;
    }

    ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);

    subagentOverlayRenderRequest = null;
    subagentWidgetRenderRequest = null;
    clearTabCycleInputHook();
  });

  pi.registerCommand("agent", {
    description: "Open the active-agent picker or switch agents in non-interactive mode",
    handler: async (args, ctx) => {
      const agents = loadAgents();
      const names = agents.map((agent) => agent.name);
      const input = args.trim();

      if (ctx.hasUI) {
        const menu = buildAgentSelectionMenu(agents, activeAgent);
        const current = activeAgent || "none";
        const selected = await ctx.ui.select(
          `Select active agent (current: ${current}; ↑/↓ to navigate, Enter to confirm)`,
          menu.labels,
        );

        if (!selected) {
          return;
        }

        const selectedAgentName = menu.valueByLabel.get(selected);
        if (selectedAgentName === undefined) {
          ctx.ui.notify("Unknown agent selection. Please try again.", "warning");
          return;
        }

        setActiveAgent(ctx, selectedAgentName, { persist: true, notify: true });
        return;
      }

      if (!input || input === "list") {
        ctx.ui.notify(buildAgentListSummary(agents, activeAgent), "info");
        return;
      }

      if (input === "off" || input === "none") {
        setActiveAgent(ctx, null, { persist: true, notify: true });
        return;
      }

      if (!names.includes(input)) {
        ctx.ui.notify(
          `Unknown agent: ${input}\n${buildAgentListSummary(agents, activeAgent)}`,
          "error",
        );
        return;
      }

      setActiveAgent(ctx, input, { persist: true, notify: true });
    },
  });

  pi.registerCommand("attach", {
    description:
      "Open a tracked task delegation output modal (usage: /attach <sessionId>)",
    handler: async (args, ctx) => {
      pruneFinishedSessions();
      const sessions = listSubagentSessions();
      if (sessions.length === 0) {
        ctx.ui.notify("No tracked delegated-task sessions.", "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          "Attach requires interactive TUI mode to open the output modal.",
          "warning",
        );
        return;
      }

      let target = args.trim();

      if (!target) {
        const options = sessions.map((session) => {
          const status = getSubagentStatusDisplay(session.status).label.replace(
            /^✗\s*/,
            "",
          );
          const duration = formatDuration(
            (session.finishedAt ?? Date.now()) - session.startedAt,
          );
          return `${session.id.slice(0, 8)} ${session.agent} (${status}, ${duration})`;
        });

        const selected = await ctx.ui.select(
          "Attach to delegated-task session",
          options,
        );
        if (!selected) {
          return;
        }

        target = selected.split(" ")[0] ?? "";
      }

      const resolved = resolveSessionByReference(target, sessions);
      if (!resolved) {
        ctx.ui.notify(`Session not found: ${target}`, "error");
        return;
      }

      await openSubagentOutputModal(ctx, resolved.id);
    },
  });

  pi.registerCommand("dismiss", {
    description:
      "Dismiss tracked delegated-task sessions (usage: /dismiss <sessionId|all>)",
    handler: async (args, ctx) => {
      pruneFinishedSessions();
      const sessions = listSubagentSessions();
      if (sessions.length === 0) {
        ctx.ui.notify("No tracked delegated-task sessions.", "info");
        return;
      }

      const input = args.trim();
      let targetIds: string[] = [];

      if (input) {
        if (input.toLowerCase() === "all") {
          targetIds = sessions.map((session) => session.id);
        } else {
          const resolved = resolveSessionByReference(input, sessions);
          if (!resolved) {
            ctx.ui.notify(`Session not found: ${input}`, "error");
            return;
          }
          targetIds = [resolved.id];
        }
      } else if (sessions.length === 1) {
        targetIds = [sessions[0].id];
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "Please provide a session ID or 'all' in non-interactive mode.",
            "warning",
          );
          return;
        }

        const options = [
          "all",
          ...sessions.map((session) => {
            const status = getSubagentStatusDisplay(
              session.status,
            ).label.replace(/^✗\s*/, "");
            return `${session.id.slice(0, 8)} ${session.agent} (${status})`;
          }),
        ];

        const selected = await ctx.ui.select("Dismiss session", options);
        if (!selected) {
          return;
        }

        if (selected === "all") {
          targetIds = sessions.map((session) => session.id);
        } else {
          targetIds = [selected.split(" ")[0] ?? ""];
        }
      }

      targetIds = targetIds.filter(Boolean).map((target) => {
        const resolved = resolveSessionByReference(target, sessions);
        return resolved?.id ?? target;
      });

      let dismissed = 0;
      for (const sessionId of targetIds) {
        if (dismissSubagentSession(sessionId)) {
          dismissed += 1;
        }
      }

      if (dismissed === 0) {
        ctx.ui.notify("No sessions were dismissed.", "warning");
        return;
      }

      pruneFinishedSessions();
      ctx.ui.notify(
        `Dismissed ${dismissed} delegated-task session${dismissed === 1 ? "" : "s"}.`,
        "info",
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!activeAgent) {
      activeRuntimeTemperature = undefined;
      return {};
    }

    const agent = loadAgents().find((item) => item.name === activeAgent);
    if (!agent) {
      activeRuntimeTemperature = undefined;
      return {};
    }

    await applyAgentRuntimeProfile(ctx, agent, {
      respectManualModelOverride: true,
      respectManualThinkingOverride: true,
    });

    return {
      systemPrompt: buildSystemPromptForActiveAgent(event.systemPrompt, agent, {
        interactionMode: "direct",
      }),
    };
  });

  pi.on("turn_start", async () => {
    dispatchReminderQueued = false;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "task") {
      return {};
    }

    const delegatedBy = getDelegatingAgentName(ctx, activeAgent);
    if (!isOrchestratorAgent(delegatedBy)) {
      return {};
    }

    const details = parseSubagentExecutionDetails(event.details);
    if (
      !details ||
      (details.status !== "running" && details.status !== "queued")
    ) {
      return {};
    }

    if (pendingDelegationJobs.size > 0) {
      queueDispatchReminderTurn();
    }

    return {};
  });

  pi.on("agent_end", async (_event, ctx) => {
    const delegatedBy = getDelegatingAgentName(ctx, activeAgent);
    if (!isOrchestratorAgent(delegatedBy)) {
      return;
    }

    if (pendingDelegationJobs.size > 0) {
      scheduleAutoCompletionWaitTurn(delegatedBy);
    }
  });

  const taskToolDefinition = {
    name: "task",
    label: "Task",
    description:
      'Delegate task batches to local agents using task-style items: tasks[{id,description,assignment,skills?,cwd?,agent}] with optional shared context/schema. Set mode="parallel" (default) or mode="chain" for sequential execution. In chain mode, use {previous} in later assignments to inject the prior step output (safely truncated). Each task must explicitly provide its agent. agentScope: "user" => ~/.pi/agent/agents, "project" => nearest .pi/agents, "both" => merge both. Supports live attach updates and bounded concurrency.',

    parameters: Type.Object({
      tasks: Type.Array(TaskBatchItem, {
        description:
          "Task items: [{id, description, assignment, skills?, cwd?, agent}]",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("parallel"), Type.Literal("chain")], {
          description:
            "Execution strategy. parallel: run tasks concurrently (default). chain: run tasks sequentially and stop on first failure; supports {previous} replacement.",
          default: "parallel",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Shared background prepended to each assignment. Use for global constraints, contracts, and acceptance criteria.",
        }),
      ),
      schema: Type.Optional(
        Type.Unknown({
          description:
            "Optional expected output schema (forwarded in each delegated prompt).",
        }),
      ),
      agentScope: Type.Optional(
        Type.Union(
          [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
          {
            description:
              'Which agent directories to search. "user": ~/.pi/agent/agents, "project": nearest .pi/agents from cwd, "both": merge both (default).',
            default: "both",
          },
        ),
      ),
      attach: Type.Optional(
        Type.Boolean({
          description:
            "Stream live delegated output back to this tool result while it runs.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory (optional, defaults to current directory)",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "Inactivity timeout in milliseconds. Enforced minimum/default: 1800000 (30 minutes).",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        tasks: TaskStyleDelegationItem[];
        mode?: "parallel" | "chain";
        context?: string;
        schema?: unknown;
        agentScope?: "user" | "project" | "both";
        attach?: boolean;
        cwd?: string;
        timeoutMs?: number;
      },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<SubagentExecutionDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const delegatedBy = getDelegatingAgentName(ctx, activeAgent);
      const delegatedContext = normalizeInputText(params.context);
      const rawTasks = Array.isArray(params.tasks)
        ? (params.tasks as Array<TaskStyleDelegationItem>)
        : [];
      const taskStyleMetadata = rawTasks
        .filter((item): item is TaskStyleDelegationItem =>
          isTaskBatchItem(item),
        )
        .map((item) => ({
          id: normalizeInputText(item.id),
          description: normalizeInputText(item.description),
          assignment: normalizeInputText(item.assignment),
          skills: Array.isArray(item.skills)
            ? item.skills
                .map((skill) => normalizeInputText(skill))
                .filter(Boolean)
            : undefined,
          cwd: normalizeInputText(item.cwd) || undefined,
          agent: normalizeInputText(item.agent),
        }));
      const taskStyleValidationError =
        validateTaskBatchItems(taskStyleMetadata);
      const distinctTaskAgents = [
        ...new Set(taskStyleMetadata.map((task) => task.agent).filter(Boolean)),
      ];

      const providedTasks: SubagentTaskItemInput[] = taskStyleMetadata.map(
        (task) => ({
          agent: task.agent,
          task: renderTaskBatchPrompt({
            context: delegatedContext || undefined,
            assignment: task.assignment,
            schema: params.schema,
            taskId: task.id,
            description: task.description || task.id,
            skills: task.skills,
          }),
          cwd: task.cwd,
        }),
      );

      const resolvedMode = resolveTaskExecutionMode(params.mode);
      const requestedMode: TaskExecutionMode = resolvedMode.mode;
      const hasTaskStyleMode = true;
      const agentScope = normalizeAgentScope(params.agentScope);
      const attachToParent = params.attach !== false;
      const defaultExecutionCwd = resolveExistingWorkingDirectory(ctx.cwd);
      const { controls: taskControls, warnings: controlWarnings } =
        resolveTaskControls(defaultExecutionCwd);
      const modeAgentLabel =
        distinctTaskAgents.length === 1
          ? distinctTaskAgents[0]
          : distinctTaskAgents.length > 1
            ? "multiple-agents"
            : "(missing task agent)";
      const modeTaskLabel = `${taskStyleMetadata.length} task tool item(s)`;
      const hasExecutableTasks = providedTasks.length > 0;

      // Single validation gate for task delegation.
      // Internal execution paths trust the validated values from this entry point.

      if (!isOrchestratorAgent(delegatedBy)) {
        const details = createSubagentExecutionDetails(
          delegatedBy,
          modeAgentLabel,
          modeTaskLabel,
          "blocked",
          {
            mode: requestedMode,
          },
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Delegation denied: active agent '${delegatedBy}' is not allowed to call task. Only '${DEFAULT_AGENT}' can delegate.`,
            },
          ],
          details,
        };
      }

      if (resolvedMode.error) {
        return {
          isError: true,
          content: [{ type: "text", text: resolvedMode.error }],
          details: createSubagentExecutionDetails(
            delegatedBy,
            modeAgentLabel,
            modeTaskLabel,
            "failed",
            {
              mode: requestedMode,
              parentSessionId: ctx.sessionManager.getSessionId(),
            },
          ),
        };
      }

      if (taskStyleValidationError) {
        const details = createSubagentExecutionDetails(
          delegatedBy,
          modeAgentLabel,
          modeTaskLabel,
          "failed",
          {
            mode: requestedMode,
            parentSessionId: ctx.sessionManager.getSessionId(),
          },
        );
        return {
          isError: true,
          content: [{ type: "text", text: taskStyleValidationError }],
          details,
        };
      }

      if (!hasExecutableTasks) {
        const details = createSubagentExecutionDetails(
          delegatedBy,
          modeAgentLabel,
          modeTaskLabel,
          "failed",
          {
            mode: requestedMode,
            parentSessionId: ctx.sessionManager.getSessionId(),
          },
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Task delegation failed: provide at least one task item.",
            },
          ],
          details,
        };
      }

      const resolvedGlobalCwd = resolveSubagentWorkingDirectory(
        params.cwd,
        defaultExecutionCwd,
      );
      if ("error" in resolvedGlobalCwd) {
        const details = createSubagentExecutionDetails(
          delegatedBy,
          modeAgentLabel,
          modeTaskLabel,
          "failed",
          {
            mode: requestedMode,
            parentSessionId: ctx.sessionManager.getSessionId(),
          },
        );
        return {
          isError: true,
          content: [{ type: "text", text: resolvedGlobalCwd.error }],
          details,
        };
      }

      const executionBaseCwd = resolvedGlobalCwd.cwd;
      const agentDiscovery = discoverAgents(executionBaseCwd, agentScope);
      const availableAgents = agentDiscovery.agents;

      const timeout = resolveSubagentTimeoutMs(
        params.timeoutMs ?? taskControls.defaultTimeoutMs,
      );

      if (hasExecutableTasks) {
        const delegationStartedAt = Date.now();
        const normalizedTasks = providedTasks.map((task, index) => ({
          agent: normalizeInputText(task.agent),
          task: normalizeInputText(task.task),
          cwd: normalizeInputText(task.cwd) || undefined,
          taskLabel: hasTaskStyleMode
            ? taskStyleMetadata[index]?.id
            : undefined,
          taskDescription: hasTaskStyleMode
            ? taskStyleMetadata[index]?.description ||
              taskStyleMetadata[index]?.id
            : undefined,
        }));

        const invalidTaskIndex = normalizedTasks.findIndex(
          (task) => !task.agent || !task.task,
        );
        const queuedDelegationLabel =
          requestedMode === "chain"
            ? "Chain delegation"
            : normalizedTasks.length === 1
              ? "Task delegation"
              : "Parallel delegation";
        if (invalidTaskIndex >= 0) {
          const details = createSubagentExecutionDetails(
            delegatedBy,
            modeAgentLabel,
            modeTaskLabel,
            "failed",
            {
              mode: requestedMode,
            },
          );
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `${queuedDelegationLabel} failed: tasks[${invalidTaskIndex}] requires non-empty 'agent' and task payload.`,
              },
            ],
            details,
          };
        }

        const agentsByName = new Map(
          availableAgents.map((item) => [item.name, item] as const),
        );
          const builtInAgentColorFallback = new Map<string, string>([
            ["architect", "#50E3C2"],
            ["ask", "#9013FE"],
            ["code", "#4A90E2"],
            ["debug", "#F5A623"],
            ["devops", "#6C5CE7"],
            ["docs", "#417505"],
            ["git", "#D0021B"],
            ["orchestrator", "#7ED321"],
            ["product", "#8B572A"],
            ["refactor", "#4A4A4A"],
            ["researcher", "#F8E71C"],
            ["security", "#B00020"],
            ["test", "#2D9CDB"],
            ["ui", "#FF6F61"],
          ]);
          const fallbackUserAgentColors = new Map(
          loadAgents()
            .filter((agent) => typeof agent.color === "string" && agent.color.trim().length > 0)
            .map((agent) => [normalizeInputText(agent.name).toLowerCase(), agent.color!] as const),
        );
        const resolveDelegatedAgentColor = (
          agentName: string,
          agent: Agent | undefined,
        ): string | undefined => {
          const normalizedAgentName = normalizeInputText(agentName).toLowerCase();
          const configuredColor = normalizeInputText(agent?.color);
          if (configuredColor) {
            return configuredColor;
          }

          const fallbackColor = fallbackUserAgentColors.get(normalizedAgentName);
          if (normalizeInputText(fallbackColor)) {
            return normalizeInputText(fallbackColor);
          }

          return builtInAgentColorFallback.get(normalizedAgentName);
        };
        const resolveDelegatedModelLabel = (
          agent: Agent | undefined,
        ): string | undefined => {
          if (!agent) {
            return undefined;
          }

          const configuredModel = normalizeInputText(agent.model);
          if (!configuredModel) {
            return undefined;
          }

          const resolution = resolveAgentModel(ctx, agent);
          if (resolution.model) {
            return toModelReference(resolution.model);
          }

          return configuredModel;
        };

        const taskResults: NonNullable<SubagentExecutionDetails["results"]> =
          normalizedTasks.map((task, index) => {
            const configuredAgent = agentsByName.get(task.agent);
            const thinkingLevel = normalizeInputText(
              configuredAgent?.thinkingLevel,
            );

            return {
              index: index + 1,
              delegatedAgent: task.agent,
              delegatedTask: task.task,
              agentColor: resolveDelegatedAgentColor(task.agent, configuredAgent),
              taskLabel: task.taskLabel,
              taskDescription: task.taskDescription,
              model: resolveDelegatedModelLabel(configuredAgent),
              thinkingLevel: thinkingLevel || undefined,
              status: "queued",
            };
          });

        const buildParallelDetails = (
          liveOutput?: string,
        ): SubagentExecutionDetails => {
          const summary = summarizeParallelResults(taskResults);
          const status: SubagentExecutionStatus =
            summary.running > 0 || summary.queued > 0
              ? "running"
              : summary.aborted > 0 && summary.aborted === summary.total
                ? "aborted"
                : summary.failed > 0
                  ? "failed"
                  : "finished";
          const summaryDelegationLabel =
            requestedMode === "chain"
              ? "Chain delegation"
              : summary.total === 1
                ? "Task delegation"
                : "Parallel delegation";
          const contractWarnings = [
            ...controlWarnings,
            ...taskResults.flatMap((result) => result.contractWarnings || []),
          ];
          return createSubagentExecutionDetails(
            delegatedBy,
            hasTaskStyleMode
              ? modeAgentLabel
              : requestedMode === "chain"
                ? "chain"
                : summary.total === 1
                  ? "delegation"
                  : "parallel",
            `${summaryDelegationLabel}: ${summary.total} task${summary.total === 1 ? "" : "s"}`,
            status,
            {
              mode: requestedMode,
              attached: attachToParent,
              agentColor:
                summary.total === 1 ? taskResults[0]?.agentColor : undefined,
              model: summary.total === 1 ? taskResults[0]?.model : undefined,
              thinkingLevel:
                summary.total === 1 ? taskResults[0]?.thinkingLevel : undefined,
              duration:
                summary.total === 1 ? taskResults[0]?.duration : undefined,
              usage: aggregateUsageFromResults(taskResults),
              summary,
              results: taskResults,
              contractWarnings:
                contractWarnings.length > 0 ? contractWarnings : undefined,
              aborted: summary.aborted > 0,
              liveOutput,
            },
          );
        };

        const partialUpdateCadence = resolveTaskToolUpdateCadence({
          hasUI: Boolean(ctx.hasUI),
          argv: process.argv,
          env: process.env,
        });
        const partialUpdateGate = createTaskToolPartialUpdateGate({
          minIntervalMs: partialUpdateCadence.minIntervalMs,
          unchangedFrameIntervalMs:
            partialUpdateCadence.unchangedFrameIntervalMs,
        });
        let lastDurationRefreshAt = 0;

        const compactPartialTaskText = (value: string | undefined): string | undefined => {
          if (typeof value !== "string") {
            return undefined;
          }

          const normalized = value.replace(/\s+/g, " ").trim();
          if (!normalized) {
            return undefined;
          }

          return truncatePreview(normalized, 220);
        };

        const buildCompactPartialResults = (
          results: NonNullable<SubagentExecutionDetails["results"]>,
        ): NonNullable<SubagentExecutionDetails["results"]> => results.map((result) => ({
          ...result,
          output:
            result.status === "running" || result.status === "queued"
              ? compactPartialTaskText(result.output)
              : result.output,
          error: compactPartialTaskText(result.error),
          latestToolCall: compactPartialTaskText(result.latestToolCall),
          resultSummary: compactPartialTaskText(result.resultSummary),
        }));

        const emitParallelUpdate = (
          message: string,
          options: { force?: boolean } = {},
        ): void => {
          if (typeof onUpdate !== "function") {
            return;
          }

          try {
            const partialDetails = buildParallelDetails(message);
            const compactResults = buildCompactPartialResults(
              partialDetails.results || taskResults,
            );
            const compactDetails: SubagentExecutionDetails = {
              ...partialDetails,
              liveOutput: compactPartialTaskText(partialDetails.liveOutput),
              results: compactResults,
            };
            const fingerprint = buildTaskToolPartialUpdateFingerprint({
              message,
              status: compactDetails.status,
              summary:
                compactDetails.summary || summarizeParallelResults(taskResults),
              results: compactDetails.results || taskResults,
            });
            if (
              !partialUpdateGate.shouldEmit({
                fingerprint,
                force: options.force,
              })
            ) {
              return;
            }

            const compatibilityUpdate = {
              ...compactDetails,
              content: [{ type: "text", text: message }],
              details: compactDetails,
            };

            (onUpdate as unknown as (partial: unknown) => void)(
              compatibilityUpdate,
            );
          } catch {
            // ignore partial update rendering errors
          }
        };

        const refreshRunningTaskDurations = (): boolean => {
          const now = Date.now();
          const shouldRefreshDurations =
            now - lastDurationRefreshAt >=
            partialUpdateCadence.durationUpdateIntervalMs;
          if (shouldRefreshDurations) {
            lastDurationRefreshAt = now;
          }

          let hasRunningTasks = false;

          for (const taskResult of taskResults) {
            if (taskResult.status !== "running") {
              continue;
            }

            hasRunningTasks = true;
            const sessionId = taskResult.sessionId;
            if (!sessionId) {
              continue;
            }

            const session = subagentSessions.get(sessionId);
            if (!session) {
              continue;
            }

            if (shouldRefreshDurations) {
              taskResult.duration = Math.max(
                0,
                (session.finishedAt ?? now) - session.startedAt,
              );
            }

            if (attachToParent && !taskResult.output && session.lastOutput) {
              taskResult.output = session.lastOutput;
            }
          }

          return hasRunningTasks;
        };

        const emitProgressHeartbeat = (): void => {
          if (!refreshRunningTaskDurations()) {
            return;
          }

          const summary = summarizeParallelResults(taskResults);
          const done = summary.succeeded + summary.failed;
          emitParallelUpdate(
            `${queuedDelegationLabel} progress: ${done}/${summary.total} done (${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.aborted} aborted, ${summary.running} running, ${summary.queued} queued).`,
          );
          requestSubagentUiRender(false);
        };

        let parallelProgressTicker: NodeJS.Timeout | undefined;
        const stopParallelProgressTicker = (): void => {
          if (!parallelProgressTicker) {
            return;
          }

          clearInterval(parallelProgressTicker);
          parallelProgressTicker = undefined;
        };

        emitParallelUpdate(
          `${queuedDelegationLabel} queued: 0/${normalizedTasks.length} done.`,
          { force: true },
        );

        parallelProgressTicker = setInterval(() => {
          emitProgressHeartbeat();
        }, partialUpdateCadence.heartbeatIntervalMs);

        let resolvePendingDelegationJob: (() => void) | undefined;
        const trackedDelegationJob = new Promise<void>((resolve) => {
          resolvePendingDelegationJob = resolve;
        });
        pendingDelegationJobs.add(trackedDelegationJob);

        let previousChainOutput = "";

        let parallelControl: {
          aborted: boolean;
          reason?: "signal" | "worker_error";
          firstError?: Error;
          started: number;
          completed: number;
          skipped: number;
        } | undefined;

        try {
          ({ control: parallelControl } =
            await mapWithAbortAwareConcurrency({
            items: normalizedTasks,
            concurrency:
              requestedMode === "chain" ? 1 : taskControls.maxConcurrency,
            signal,
            abortOnWorkerError: requestedMode === "chain",
            worker: async (task, index, workerSignal) => {
              const taskResult = taskResults[index];
              let slotAcquired = false;

              try {
                const resolvedTaskCwd = resolveSubagentWorkingDirectory(
                  task.cwd,
                  executionBaseCwd,
                );
                if ("error" in resolvedTaskCwd) {
                  taskResult.status = "failed";
                  taskResult.exitCode = 1;
                  taskResult.error = resolvedTaskCwd.error;
                  throw new Error(taskResult.error);
                }

                await acquireDelegationSlot(
                  workerSignal,
                  taskControls.maxConcurrency,
                );
                slotAcquired = true;

                if (workerSignal.aborted) {
                  taskResult.status = "aborted";
                  taskResult.abortReason =
                    "Delegation was aborted before task execution started.";
                  throw new Error(taskResult.abortReason);
                }

                taskResult.status = "running";
                const progressLabel = taskResult.taskLabel
                  ? `${taskResult.taskLabel} (${task.agent})`
                  : task.agent;
                emitParallelUpdate(
                  `Starting task ${taskResult.index}/${normalizedTasks.length}: ${progressLabel}`,
                  { force: true },
                );

                const agent = agentsByName.get(task.agent);
                if (!agent) {
                  taskResult.status = "failed";
                  taskResult.exitCode = 1;
                  taskResult.error = `Unknown agent: ${task.agent}`;
                  throw new Error(taskResult.error);
                }

                taskResult.model =
                  taskResult.model || resolveDelegatedModelLabel(agent);
                taskResult.agentColor =
                  taskResult.agentColor ||
                  resolveDelegatedAgentColor(task.agent, agent);
                taskResult.thinkingLevel =
                  taskResult.thinkingLevel ||
                  normalizeInputText(agent.thinkingLevel) ||
                  undefined;

                let delegatedTaskPayload = task.task;
                if (requestedMode === "chain") {
                  const substitution = applyPreviousOutputSubstitution({
                    task: task.task,
                    previousOutput: previousChainOutput,
                  });
                  delegatedTaskPayload = substitution.task;
                  taskResult.delegatedTask = delegatedTaskPayload;

                  if (substitution.truncated) {
                    taskResult.contractWarnings = [
                      ...(taskResult.contractWarnings || []),
                      `Step ${taskResult.index}: {previous} output was truncated before substitution to keep prompts bounded.`,
                    ];
                  }
                }

                const session = startBackgroundSubagent(
                  ctx,
                  delegatedBy,
                  agent,
                  delegatedTaskPayload,
                  resolvedTaskCwd.cwd,
                  timeout,
                  {
                    notifyCompletion: false,
                    onStreamUpdate: (update) => {
                      if (attachToParent || !taskResult.output) {
                        taskResult.output = update.outputText;
                      }
                      taskResult.usage = update.usage;
                      taskResult.toolCalls = update.toolInvocationCount;
                      taskResult.latestToolCall = update.latestToolCall;
                      const streamLabel = taskResult.taskLabel
                        ? `${taskResult.taskLabel} (${task.agent})`
                        : task.agent;
                      emitParallelUpdate(
                        `Task ${taskResult.index}/${normalizedTasks.length} ${streamLabel} is running.`,
                      );
                    },
                  },
                );
                taskResult.sessionId = session.id;

                if (session.status !== "running" || !session.completionPromise) {
                  taskResult.status = "failed";
                  taskResult.exitCode = 1;
                  const retainedStartupError = buildRetainedHistoryText(
                    session.stderr || "Unknown startup error.",
                  );
                  taskResult.error =
                    retainedStartupError.excerpt || "Unknown startup error.";
                  taskResult.resultSummary = retainedStartupError.summary;
                  const retainedStartupOutput = buildRetainedHistoryText(
                    session.fullOutput || session.lastOutput || session.stderr,
                  );
                  taskResult.output = retainedStartupOutput.excerpt;
                  if (!taskResult.resultSummary) {
                    taskResult.resultSummary = retainedStartupOutput.summary;
                  }
                  taskResult.duration = Math.max(
                    0,
                    (session.finishedAt ?? Date.now()) - session.startedAt,
                  );
                  throw new Error(taskResult.error);
                }

                const abortSession = (): void => {
                  killSubagentSession(
                    session.id,
                    "Delegation aborted by parent signal.",
                  );
                };

                if (workerSignal.aborted) {
                  abortSession();
                } else {
                  workerSignal.addEventListener("abort", abortSession, {
                    once: true,
                  });
                }

                const run = await session.completionPromise;
                workerSignal.removeEventListener("abort", abortSession);

                const latestSessionStatus: SubagentExecutionStatus =
                  subagentSessions.get(session.id)?.status ?? session.status;
                const finalStatus: SubagentExecutionStatus =
                  workerSignal.aborted || latestSessionStatus === "killed"
                    ? "aborted"
                    : run.timedOut || Boolean(session.timedOut)
                      ? "timed_out"
                      : run.code === 0
                        ? "finished"
                        : "failed";
                taskResult.status = finalStatus;
                taskResult.exitCode = run.code;
                taskResult.timedOut = finalStatus === "timed_out";
                taskResult.duration = Math.max(
                  0,
                  (session.finishedAt ?? Date.now()) - session.startedAt,
                );
                taskResult.usage = run.usage;

                let finalOutputText =
                  session.fullOutput ||
                  session.lastOutput ||
                  run.outputText ||
                  getSubagentOutputFromMessages(run.messages || []) ||
                  run.stderr;

                const contractValidation = validateSubagentOutputContract({
                  messages: run.messages || [],
                  schema: params.schema,
                  strictness: taskControls.outputStrictness,
                });
                if (contractValidation.outputText.trim()) {
                  finalOutputText = contractValidation.outputText;
                }
                if (contractValidation.warnings.length > 0) {
                  taskResult.contractWarnings = [
                    ...(taskResult.contractWarnings || []),
                    ...contractValidation.warnings,
                  ];
                }
                if (run.outputNotice?.trim()) {
                  taskResult.contractWarnings = [
                    ...(taskResult.contractWarnings || []),
                    ...run.outputNotice
                      .split("\n")
                      .map((warning) => warning.trim())
                      .filter((warning) => Boolean(warning)),
                  ];
                }

                const retainedTaskOutput = buildRetainedHistoryText(finalOutputText);
                taskResult.output = retainedTaskOutput.excerpt;
                taskResult.resultSummary = retainedTaskOutput.summary;

                if (contractValidation.error) {
                  taskResult.status = "failed";
                  const retainedContractError = buildRetainedHistoryText(
                    contractValidation.error,
                  );
                  taskResult.error =
                    retainedContractError.excerpt || contractValidation.error;
                  taskResult.resultSummary =
                    retainedContractError.summary || taskResult.resultSummary;
                  throw new Error(taskResult.error);
                }

                const finalToolInvocations =
                  run.toolInvocations ||
                  (run.messages && run.messages.length > 0
                    ? summarizeSubagentToolInvocations(run.messages)
                    : session.toolInvocations || []);
                taskResult.toolCalls =
                  run.toolInvocationCount ??
                  countSubagentToolInvocations(finalToolInvocations);
                taskResult.latestToolCall =
                  run.latestToolCall ||
                  ((run.messages && run.messages.length > 0
                    ? getLatestSubagentToolCallLabel(run.messages)
                    : undefined) || taskResult.latestToolCall);

                if (finalStatus === "finished" && requestedMode === "chain") {
                  previousChainOutput = finalOutputText || "";
                }

                if (finalStatus === "aborted") {
                  taskResult.abortReason =
                    "Delegation aborted by signal while task was running.";
                  throw new Error(taskResult.abortReason);
                }

                if (finalStatus !== "finished") {
                  const retainedFailureError = buildRetainedHistoryText(
                    session.stderr ||
                      run.stderr ||
                      `Task failed with status '${taskResult.status}'.`,
                  );
                  taskResult.error =
                    retainedFailureError.excerpt ||
                    `Task failed with status '${taskResult.status}'.`;
                  taskResult.resultSummary =
                    retainedFailureError.summary || taskResult.resultSummary;
                  throw new Error(taskResult.error);
                }
              } catch (error) {
                if (taskResult.status === "aborted") {
                  throw error;
                }

                if (workerSignal.aborted) {
                  taskResult.status = "aborted";
                  taskResult.abortReason =
                    taskResult.abortReason ||
                    "Delegation aborted by parent signal.";
                  taskResult.error = taskResult.abortReason;
                } else {
                  taskResult.status = "failed";
                  taskResult.exitCode = taskResult.exitCode ?? 1;
                  taskResult.error =
                    taskResult.error ||
                    (error instanceof Error ? error.message : "Unknown error");
                }

                const retainedTaskError = buildRetainedHistoryText(
                  taskResult.error,
                );
                taskResult.error =
                  retainedTaskError.excerpt || taskResult.error;
                taskResult.resultSummary =
                  retainedTaskError.summary || taskResult.resultSummary;

                throw error;
              } finally {
                if (slotAcquired) {
                  releaseDelegationSlot();
                }

                const summary = summarizeParallelResults(taskResults);
                const done = summary.succeeded + summary.failed;
                const progressDelegationLabel =
                  requestedMode === "chain"
                    ? "Chain delegation"
                    : summary.total === 1
                      ? "Task delegation"
                      : "Parallel delegation";
                emitParallelUpdate(
                  `${progressDelegationLabel} progress: ${done}/${summary.total} done (${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.aborted} aborted, ${summary.running} running, ${summary.queued} queued).`,
                  { force: true },
                );
              }
            },
            onSkipped: (_task, index, reason) => {
              const taskResult = taskResults[index];
              if (taskResult.status !== "queued") {
                return;
              }

              taskResult.status = "aborted";
              taskResult.abortReason =
                reason === "signal"
                  ? "Delegation was aborted before this task started."
                  : requestedMode === "chain"
                    ? "Skipped because a prior chain step failed."
                    : "Skipped because another delegated task failed.";
              taskResult.error = taskResult.abortReason;
            },
          }));

          if (parallelControl?.reason === "signal") {
            controlWarnings.push(
              requestedMode === "chain"
                ? "Chain delegation was aborted by signal before all queued steps started."
                : "Parallel delegation was aborted by signal before all queued tasks started.",
            );
          } else if (
            parallelControl?.reason === "worker_error" &&
            parallelControl.firstError
          ) {
            controlWarnings.push(
              requestedMode === "chain"
                ? `Chain delegation stopped after failed step: ${parallelControl.firstError.message}`
                : `Parallel delegation stopped after first worker error: ${parallelControl.firstError.message}`,
            );
          }
        } finally {
          stopParallelProgressTicker();
          resolvePendingDelegationJob?.();
          pendingDelegationJobs.delete(trackedDelegationJob);
        }

        const finalDetails = buildParallelDetails();
        const finalSummary =
          finalDetails.summary || summarizeParallelResults(taskResults);
        const taskLines = taskResults.map((taskResult) => {
          const statusDisplay = getSubagentStatusDisplay(
            taskResult.status,
          ).label.replace(/^✗\s*/, "");
          const messageSource =
            taskResult.error || taskResult.output || "(no output)";
          const preview = truncatePreview(
            messageSource.replace(/\s+/g, " ").trim(),
            180,
          );
          const prefix = taskResult.taskLabel
            ? `${taskResult.taskLabel} (${taskResult.delegatedAgent})`
            : `${taskResult.index}. ${taskResult.delegatedAgent}`;
          return `${prefix} - ${statusDisplay}: ${preview || "(no output)"}`;
        });
        const singleTaskResult = taskResults.length === 1 ? taskResults[0] : undefined;

        if (hasTaskStyleMode) {
          const taskSummary = renderTaskBatchSummary({
            total: finalSummary.total,
            succeeded: finalSummary.succeeded,
            failed: finalSummary.failed,
            durationMs: Date.now() - delegationStartedAt,
            items: taskResults.map((taskResult) => ({
              id: taskResult.taskLabel || `task-${taskResult.index}`,
              description:
                taskResult.taskDescription ||
                taskResult.taskLabel ||
                `Task ${taskResult.index}`,
              agent: taskResult.delegatedAgent,
              status:
                taskResult.status === "finished"
                  ? "completed"
                  : taskResult.status === "timed_out"
                    ? "timed_out"
                    : taskResult.status,
              output: taskResult.output,
              error: taskResult.error,
            })),
          });

          return {
            isError: finalSummary.failed > 0 || finalSummary.aborted > 0,
            content: [{ type: "text", text: taskSummary }],
            details: finalDetails,
          };
        }

        return {
          isError: finalSummary.failed > 0 || finalSummary.aborted > 0,
          content: [
            {
              type: "text",
              text:
                `${requestedMode === "chain" ? "Chain delegation" : finalSummary.total === 1 ? "Task delegation" : "Parallel delegation"} complete: ${finalSummary.succeeded}/${finalSummary.total} succeeded, ${finalSummary.failed} failed.` +
                `\n\n${taskLines.join("\n")}`,
            },
          ],
          details: finalDetails,
        };
      }

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Task delegation failed: no executable tasks were produced.",
          },
        ],
        details: createSubagentExecutionDetails(
          delegatedBy,
          modeAgentLabel,
          modeTaskLabel,
          "failed",
          {
            mode: requestedMode,
            parentSessionId: ctx.sessionManager.getSessionId(),
          },
        ),
      };
    },

    renderCall(args, theme) {
      const normalizedArgs =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      return renderTaskDelegationCall(normalizedArgs, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = parseSubagentExecutionDetails(result.details);

      if (details?.results && details.results.length > 0) {
        return renderParallelDelegationResult(details, expanded, theme, isPartial);
      }

      const status: SubagentExecutionStatus = isPartial
        ? details?.status || "running"
        : details?.status || (result.isError ? "failed" : "finished");

      return renderSingleDelegationResult({
        result,
        details,
        status,
        isPartial,
        expanded,
        theme,
      });
    },
  };

  pi.registerTool(taskToolDefinition as any);
}
