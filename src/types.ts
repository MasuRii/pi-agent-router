/**
 * Core type definitions for pi-agent-router extension.
 *
 * This module contains all TypeScript types used across the extension's modules.
 * It has no internal dependencies to avoid circular imports.
 */

// External type imports for type-only references
import type { Message, Model, Api, AssistantMessageEventStream, Context as LlmContext, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ChildProcess } from "node:child_process";

export type AgentMode = "primary" | "subagent" | "all";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentScope = "user" | "project" | "both";

export type Agent = {
  name: string;
  description: string;
  color?: string;
  model?: string;
  mode?: AgentMode;
  thinkingLevel?: AgentThinkingLevel;
  temperature?: number;
  systemPrompt: string;
};

export type CacheDebugCounters = {
  hits: number;
  misses: number;
  invalidations: number;
  evictions: number;
  size: number;
  maxEntries: number;
};

export type AgentDiscoveryCacheSnapshot = {
  directory: CacheDebugCounters;
  discovery: CacheDebugCounters;
};

export type TaskControlsCacheSnapshot = CacheDebugCounters;

export type SubagentSessionRetentionSnapshot = {
  evictions: number;
  retainedCompletedCount: number;
  maxCompletedSessions: number;
};

export type SubagentTaskItemInput = {
  agent: string;
  task: string;
  cwd?: string;
};

type TaskReferenceInput = string | string[];

type TaskBatchItemInput = {
  id: string;
  description: string;
  assignment: string;
  skills?: string[];
  cwd?: string;
  agent: string;
  contextFrom?: TaskReferenceInput;
  retry?: boolean;
  retryFrom?: string;
};

export type TaskStyleDelegationItem = TaskBatchItemInput;

export type ActiveAgentEntryData = {
  name: string | null;
};

export type SubagentExecutionStatus =
  | "blocked"
  | "queued"
  | "running"
  | "finished"
  | "failed"
  | "timed_out"
  | "killed"
  | "aborted";

export type SubagentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sessionPath?: string;
  messages?: Message[];
  usage?: SubagentUsage;
  malformedEventCount?: number;
  outputText?: string;
  finalResponseText?: string;
  toolInvocations?: SubagentToolInvocation[];
  toolInvocationCount?: number;
  latestToolCall?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  outputNotice?: string;
};

export type SubagentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

export type SubagentExecutionDetails = {
  mode?: "single" | "parallel" | "chain" | "task";
  delegatedBy: string;
  delegatedAgent: string;
  delegatedTask: string;
  agentColor?: string;
  model?: string;
  thinkingLevel?: string;
  duration?: number;
  status: SubagentExecutionStatus;
  attached?: boolean;
  liveOutput?: string;
  sessionId?: string;
  taskId?: string;
  parentSessionId?: string;
  exitCode?: number;
  timedOut?: boolean;
  usage?: SubagentUsage;
  summary?: {
    total: number;
    succeeded: number;
    failed: number;
    running: number;
    queued: number;
    aborted: number;
  };
  contractWarnings?: string[];
  aborted?: boolean;
  results?: Array<{
    index: number;
    delegatedAgent: string;
    delegatedTask: string;
    agentColor?: string;
    taskLabel?: string;
    taskDescription?: string;
    model?: string;
    thinkingLevel?: string;
    duration?: number;
    status: SubagentExecutionStatus;
    sessionId?: string;
    exitCode?: number;
    timedOut?: boolean;
    usage?: SubagentUsage;
    toolCalls?: number;
    latestToolCall?: string;
    output?: string;
    error?: string;
    resultSummary?: string;
    abortReason?: string;
    contractWarnings?: string[];
  }>;
};

export type SubagentToolInvocation = {
  name: string;
  argumentsPreview?: string;
  count: number;
};

export type SubagentJsonEventState = {
  messages: Message[];
  messageWeights: number[];
  retainedMessageChars: number;
  messageRetentionLimit: number;
  messageRetentionMaxChars: number;
  droppedMessageCount: number;
  outputText: string;
  committedOutputText: string;
  liveOutputText: string;
  finalResponseText: string;
  outputTextMaxChars: number;
  usage: SubagentUsage;
  malformedEventCount: number;
  latestToolCall?: string;
  committedLatestToolCall?: string;
  liveLatestToolCall?: string;
  sessionPath?: string;
  sessionDir?: string;
  toolInvocationMap: Map<string, SubagentToolInvocation>;
  toolInvocationRetentionLimit: number;
  toolInvocationTotalCount: number;
};

export type SubagentSession = {
  id: string;
  taskId: string;
  logicalTaskId?: string;
  sessionPath?: string;
  sessionDir?: string;
  parentSessionId: string;
  delegatedBy: string;
  agent: string;
  agentColor?: string;
  task: string;
  cwd: string;
  status: SubagentExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  requestedAgent?: string;
  fallback?: boolean;
  fullOutput?: string;
  lastOutput?: string;
  lastFinalResponseText?: string;
  toolInvocations?: SubagentToolInvocation[];
  stderr: string;
  exitCode?: number;
  timedOut?: boolean;
  timeoutMs?: number;
  timeoutTimer?: NodeJS.Timeout;
  proc?: ChildProcess;
  tmpDir?: string;
  isolatedAgentDir?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  outputNotice?: string;
  dismissed?: boolean;
  notifyCompletion?: boolean;
  completionPromise?: Promise<SubagentRunResult>;
  resolveCompletion?: (result: SubagentRunResult) => void;
};

export type SubagentTaskRegistryEntry = {
  taskId: string;
  logicalTaskId?: string;
  sessionPath?: string;
  parentSessionId: string;
  delegatedBy: string;
  agent: string;
  cwd: string;
  status: SubagentExecutionStatus;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  childSessionIds: string[];
  lastTask: string;
  lastOutput?: string;
  lastFinalResponseText?: string;
  lastStructuredResult?: unknown;
  lastOutputFormat?: "structured" | "human_text" | "empty";
  lastOutputSource?: "submit_result" | "streamed_output" | "assistant_output" | "empty";
  lastError?: string;
  lastExitCode?: number;
  lastTimedOut?: boolean;
  lastDismissedAt?: number;
  usage?: SubagentUsage;
};

export type ContextWithOptionalAppendEntry = ExtensionContext & {
  appendEntry?: <T = unknown>(customType: string, data?: T) => void;
};

export type ApiStreamSimpleDelegate = (
  model: Model<Api>,
  context: LlmContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type GlobalWithAgentRouterBaseApiStreams = typeof globalThis & {
  __piAgentRouterBaseApiStreams?: Map<string, ApiStreamSimpleDelegate>;
};

export type BoundedTextCapture = {
  value: string;
  droppedChars: number;
};

export type TailTextBuffer = {
  append: (piece: string) => void;
  text: () => string;
  bytes: () => number;
  clear: () => void;
};

export type OutputCaptureSummary = {
  tailText: string;
  totalChars: number;
  totalBytes: number;
  droppedChars: number;
};

export type SubagentOutputDigest = {
  summary: string;
  commands: string[];
};
