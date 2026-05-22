import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { normalizeInputText } from "../input-normalization";
import type {
  SubagentExecutionStatus,
  SubagentSession,
  SubagentTaskRegistryEntry,
} from "../types";
import { recoverTaskSummaryReferencesFromSessionEntries } from "./task-session-history";
import {
  renderTaskContextFromText,
  type TaskContextFromSource,
} from "./task-tool-adapter";

export type ResolvedTaskReference = {
  source: "registry" | "session" | "history";
  reference: string;
  taskId: string;
  logicalTaskId?: string;
  sessionId?: string;
  sessionPath?: string;
  status: SubagentExecutionStatus;
  outputText?: string;
  structuredResult?: unknown;
  lastDismissedAt?: number;
  updatedAt?: number;
};

export type TaskReferenceResolverState = {
  subagentSessions: ReadonlyMap<string, SubagentSession>;
  subagentTaskRegistry: ReadonlyMap<string, SubagentTaskRegistryEntry>;
};

export type TaskReferenceResolutionResult = {
  candidate?: ResolvedTaskReference;
  error?: string;
};

export type ResolvedContextFromSourceResult = {
  source?: TaskContextFromSource;
  error?: string;
};

export type ResolvedContextFromSourcesResult = {
  sources?: TaskContextFromSource[];
  error?: string;
};

export type ResolvedContextFromTextResult = {
  text?: string;
  error?: string;
};

export type RetryReferenceResolutionResult = {
  taskId?: string;
  sessionPath?: string;
  error?: string;
  autoResumed?: boolean;
};

const RECOVERED_REFERENCE_ACTIVE_CACHE_KEY = "__active__";

const RESOLVED_TASK_REFERENCE_SOURCE_PRIORITY: Record<ResolvedTaskReference["source"], number> = {
  registry: 0,
  session: 1,
  history: 2,
};

function getRecoveredReferenceCacheKey(parentSessionId: string): string {
  return normalizeInputText(parentSessionId) || RECOVERED_REFERENCE_ACTIVE_CACHE_KEY;
}

function getResolvedTaskReferenceIdentityKey(candidate: ResolvedTaskReference): string {
  const sessionIdentity = normalizeInputText(candidate.sessionId);
  if (sessionIdentity) {
    return `session:${sessionIdentity}`;
  }

  const sessionPathIdentity = normalizeInputText(candidate.sessionPath);
  if (sessionPathIdentity) {
    return `path:${sessionPathIdentity}`;
  }

  return `task:${candidate.taskId}`;
}

function isActiveReferenceStatus(status: SubagentExecutionStatus): boolean {
  return status === "running" || status === "queued";
}

function describeResolvedTaskReference(candidate: ResolvedTaskReference): string {
  const identifiers = [
    candidate.logicalTaskId ? `logical=${candidate.logicalTaskId}` : undefined,
    `task=${candidate.taskId}`,
    candidate.sessionId ? `session=${candidate.sessionId}` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return identifiers.join("/");
}

function matchesExactTaskReference(
  candidate: ResolvedTaskReference,
  normalizedReference: string,
): boolean {
  return [candidate.taskId, candidate.logicalTaskId]
    .map((value) => normalizeInputText(value).toLowerCase())
    .some((value) => value === normalizedReference);
}

function preferMostRecentTaskReferenceMatch(
  candidates: readonly ResolvedTaskReference[],
  normalizedReference: string,
): ResolvedTaskReference | undefined {
  if (candidates.length <= 1) {
    return candidates[0];
  }

  if (!candidates.every((candidate) => matchesExactTaskReference(candidate, normalizedReference))) {
    return undefined;
  }

  return [...candidates].sort((left, right) => {
    const leftUpdatedAt = Number.isFinite(left.updatedAt) ? left.updatedAt ?? 0 : 0;
    const rightUpdatedAt = Number.isFinite(right.updatedAt) ? right.updatedAt ?? 0 : 0;
    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    const sourcePriority =
      RESOLVED_TASK_REFERENCE_SOURCE_PRIORITY[left.source] -
      RESOLVED_TASK_REFERENCE_SOURCE_PRIORITY[right.source];
    if (sourcePriority !== 0) {
      return sourcePriority;
    }

    return describeResolvedTaskReference(left).localeCompare(
      describeResolvedTaskReference(right),
    );
  })[0];
}

function isRetainedOutputSafeForHandoff(
  source: SubagentTaskRegistryEntry["lastOutputSource"],
): boolean {
  return source === "assistant_output" || source === "streamed_output";
}

export class TaskReferenceResolver {
  private readonly recoveredTaskReferencesByParentSession = new Map<string, Map<string, ResolvedTaskReference>>();
  private readonly recoveredTaskReferenceEntryCountsByParentSession = new Map<string, number>();

  constructor(private readonly state: TaskReferenceResolverState) {}

  hydrateRecoveredTaskReferencesFromSessionHistory(
    ctx: ExtensionContext,
    parentSessionId: string,
  ): void {
    const cacheKey = getRecoveredReferenceCacheKey(parentSessionId);
    const entries = ctx.sessionManager.getEntries();
    if (this.recoveredTaskReferenceEntryCountsByParentSession.get(cacheKey) === entries.length) {
      return;
    }

    const recoveredReferences = recoverTaskSummaryReferencesFromSessionEntries(entries);
    const candidates = new Map<string, ResolvedTaskReference>();
    for (const reference of recoveredReferences) {
      const candidate: ResolvedTaskReference = {
        source: "history",
        reference: reference.id,
        taskId: reference.id,
        logicalTaskId: reference.id,
        sessionId: reference.sessionId,
        status: reference.status,
        outputText: reference.outputText,
      };
      candidates.set(getResolvedTaskReferenceIdentityKey(candidate), candidate);
    }

    this.recoveredTaskReferencesByParentSession.set(cacheKey, candidates);
    this.recoveredTaskReferenceEntryCountsByParentSession.set(cacheKey, entries.length);
  }

  buildResolvedTaskReferenceCandidates(parentSessionId: string): ResolvedTaskReference[] {
    const candidates = new Map<string, ResolvedTaskReference>();

    const upsertCandidate = (candidate: ResolvedTaskReference): void => {
      const key = getResolvedTaskReferenceIdentityKey(candidate);
      const existing = candidates.get(key);
      candidates.set(key, {
        ...existing,
        ...candidate,
        reference: candidate.reference || existing?.reference || candidate.taskId,
        taskId: candidate.taskId || existing?.taskId,
        logicalTaskId: candidate.logicalTaskId || existing?.logicalTaskId,
        outputText: candidate.outputText || existing?.outputText,
        structuredResult:
          candidate.structuredResult !== undefined
            ? candidate.structuredResult
            : existing?.structuredResult,
        sessionPath: candidate.sessionPath || existing?.sessionPath,
        sessionId: candidate.sessionId || existing?.sessionId,
        lastDismissedAt: candidate.lastDismissedAt ?? existing?.lastDismissedAt,
        updatedAt: candidate.updatedAt ?? existing?.updatedAt,
      });
    };

    const recoveredCandidates = this.recoveredTaskReferencesByParentSession.get(
      getRecoveredReferenceCacheKey(parentSessionId),
    );
    for (const candidate of recoveredCandidates?.values() || []) {
      upsertCandidate(candidate);
    }

    for (const entry of this.state.subagentTaskRegistry.values()) {
      if (parentSessionId && entry.parentSessionId !== parentSessionId) {
        continue;
      }

      const latestSessionId = [...entry.childSessionIds]
        .reverse()
        .find((sessionId) => this.state.subagentSessions.has(sessionId));
      const latestSession = latestSessionId
        ? this.state.subagentSessions.get(latestSessionId)
        : undefined;
      upsertCandidate({
        source: "registry",
        reference: entry.logicalTaskId || entry.taskId,
        taskId: entry.taskId,
        logicalTaskId: entry.logicalTaskId,
        sessionId: latestSession?.id || latestSessionId,
        sessionPath: entry.sessionPath || latestSession?.sessionPath,
        status: entry.status,
        lastDismissedAt: entry.lastDismissedAt,
        updatedAt: entry.updatedAt || entry.createdAt,
        outputText:
          entry.lastFinalResponseText ||
          latestSession?.lastFinalResponseText ||
          (isRetainedOutputSafeForHandoff(entry.lastOutputSource)
            ? entry.lastOutput
            : undefined),
        structuredResult: entry.lastStructuredResult,
      });
    }

    for (const session of this.state.subagentSessions.values()) {
      if (parentSessionId && session.parentSessionId !== parentSessionId) {
        continue;
      }

      upsertCandidate({
        source: "session",
        reference: session.logicalTaskId || session.taskId,
        taskId: session.taskId,
        logicalTaskId: session.logicalTaskId,
        sessionId: session.id,
        sessionPath: session.sessionPath,
        status: session.status,
        outputText: session.lastFinalResponseText,
        lastDismissedAt: session.dismissed ? session.finishedAt ?? session.startedAt : undefined,
        updatedAt: session.finishedAt ?? session.startedAt,
      });
    }

    return [...candidates.values()];
  }

  resolveTaskReference(
    reference: string,
    parentSessionId: string,
    fieldName: string,
  ): TaskReferenceResolutionResult {
    const normalizedReference = normalizeInputText(reference);
    const normalized = normalizedReference.toLowerCase();
    if (!normalized) {
      return {
        error: `Task delegation failed: '${fieldName}' requires a non-empty task or session reference.`,
      };
    }

    const candidates = this.buildResolvedTaskReferenceCandidates(parentSessionId);
    const matchesReference = (
      candidate: ResolvedTaskReference,
      exact: boolean,
    ): boolean => {
      const values = [
        candidate.taskId,
        candidate.logicalTaskId,
        candidate.sessionId,
        candidate.sessionPath,
      ]
        .map((value) => normalizeInputText(value).toLowerCase())
        .filter(Boolean);

      return values.some((value) => exact ? value === normalized : value.startsWith(normalized));
    };

    const exactSessionIdMatches = candidates.filter(
      (candidate) => normalizeInputText(candidate.sessionId).toLowerCase() === normalized,
    );
    const exactMatches = exactSessionIdMatches.length > 0
      ? exactSessionIdMatches
      : candidates.filter((candidate) => matchesReference(candidate, true));
    const registryExactMatches = exactMatches.filter(
      (candidate) => candidate.source === "registry",
    );
    const matches = registryExactMatches.length > 0
      ? registryExactMatches
      : exactMatches.length > 0
        ? exactMatches
        : candidates.filter((candidate) => matchesReference(candidate, false));

    if (matches.length === 0) {
      return {
        error: `Task delegation failed: ${fieldName} reference '${normalizedReference}' was not found in retained delegated sessions.`,
      };
    }

    const uniqueMatches = new Map(
      matches.map((candidate) => [
        getResolvedTaskReferenceIdentityKey(candidate),
        candidate,
      ]),
    );
    if (uniqueMatches.size > 1) {
      const uniqueMatchValues = [...uniqueMatches.values()];
      const preferredMatch = preferMostRecentTaskReferenceMatch(
        uniqueMatchValues,
        normalized,
      );
      if (preferredMatch) {
        return { candidate: preferredMatch };
      }

      const labels = uniqueMatchValues
        .slice(0, 6)
        .map((candidate) => describeResolvedTaskReference(candidate))
        .join(", ");
      return {
        error: `Task delegation failed: ${fieldName} reference '${normalizedReference}' is ambiguous; matched ${labels}. Use a full taskId or sessionId.`,
      };
    }

    return { candidate: [...uniqueMatches.values()][0] };
  }

  resolveRetainedContextFromSource(
    reference: string,
    parentSessionId: string,
    fieldName: string,
  ): ResolvedContextFromSourceResult {
    const resolved = this.resolveTaskReference(reference, parentSessionId, fieldName);
    if (resolved.error || !resolved.candidate) {
      return { error: resolved.error };
    }

    const candidate = resolved.candidate;
    if (isActiveReferenceStatus(candidate.status)) {
      return {
        error: `Task delegation failed: ${fieldName} reference '${reference}' is not available because the delegated session is ${candidate.status}.`,
      };
    }

    if (candidate.structuredResult === undefined && !normalizeInputText(candidate.outputText)) {
      return {
        error: `Task delegation failed: ${fieldName} reference '${reference}' has no retained final response/result.`,
      };
    }

    return {
      source: {
        reference,
        taskId: candidate.taskId,
        sessionId: candidate.sessionId,
        status: candidate.status,
        outputText: candidate.outputText,
        structuredResult: candidate.structuredResult,
      },
    };
  }

  resolveContextFromSources(
    references: readonly string[],
    parentSessionId: string,
    fieldName: string,
  ): ResolvedContextFromSourcesResult {
    const sources: TaskContextFromSource[] = [];

    for (const reference of references) {
      const resolved = this.resolveRetainedContextFromSource(
        reference,
        parentSessionId,
        fieldName,
      );
      if (resolved.error || !resolved.source) {
        return { error: resolved.error };
      }
      sources.push(resolved.source);
    }

    return { sources };
  }

  resolveContextFromText(
    references: readonly string[],
    parentSessionId: string,
    fieldName: string,
  ): ResolvedContextFromTextResult {
    const resolved = this.resolveContextFromSources(
      references,
      parentSessionId,
      fieldName,
    );
    if (resolved.error || !resolved.sources) {
      return { error: resolved.error };
    }

    return { text: renderTaskContextFromText(resolved.sources) };
  }

  resolveRetryReference(
    reference: string,
    parentSessionId: string,
    fieldName: string,
  ): RetryReferenceResolutionResult {
    const resolved = this.resolveTaskReference(reference, parentSessionId, fieldName);
    if (resolved.error || !resolved.candidate) {
      return { error: resolved.error };
    }

    const candidate = resolved.candidate;
    if (isActiveReferenceStatus(candidate.status)) {
      return {
        error: `Task delegation failed: ${fieldName} reference '${reference}' cannot be retried while it is ${candidate.status}.`,
      };
    }

    if (!candidate.sessionPath) {
      return {
        error: `Task delegation failed: ${fieldName} reference '${reference}' cannot be retried because no retained session path is available.`,
      };
    }

    return { taskId: candidate.taskId, sessionPath: candidate.sessionPath };
  }

  resolveImplicitDismissedRetryReference(
    logicalTaskId: string | undefined,
    parentSessionId: string,
  ): RetryReferenceResolutionResult {
    const normalizedLogicalTaskId = normalizeInputText(logicalTaskId).toLowerCase();
    if (!normalizedLogicalTaskId) {
      return {};
    }

    const candidates = this.buildResolvedTaskReferenceCandidates(parentSessionId)
      .filter((candidate) => {
        if (!candidate.lastDismissedAt || !candidate.sessionPath) {
          return false;
        }

        if (isActiveReferenceStatus(candidate.status)) {
          return false;
        }

        const candidateLogicalTaskId = normalizeInputText(
          candidate.logicalTaskId || candidate.taskId,
        ).toLowerCase();
        return candidateLogicalTaskId === normalizedLogicalTaskId;
      })
      .sort((left, right) => {
        const dismissedAtDelta = (right.lastDismissedAt ?? 0) - (left.lastDismissedAt ?? 0);
        if (dismissedAtDelta !== 0) {
          return dismissedAtDelta;
        }

        return (right.sessionId || "").localeCompare(left.sessionId || "");
      });

    const candidate = candidates[0];
    if (!candidate) {
      return {};
    }

    return {
      taskId: candidate.taskId,
      sessionPath: candidate.sessionPath,
      autoResumed: true,
    };
  }
}

export function createTaskReferenceResolver(
  state: TaskReferenceResolverState,
): TaskReferenceResolver {
  return new TaskReferenceResolver(state);
}
