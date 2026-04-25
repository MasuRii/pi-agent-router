import { SUBAGENT_SESSION_RETENTION_MAX_COMPLETED } from "../constants";
import { piAgentRouterDebugLogger } from "../debug-logger";
import type { SubagentSession, SubagentSessionRetentionSnapshot } from "../types";

const subagentSessionRetentionCounters = {
  evictions: 0,
};

function normalizeParentSessionId(parentSessionId: string | undefined): string {
  return typeof parentSessionId === "string" ? parentSessionId.trim() : "";
}

function isOwnedByParentSession(
  session: SubagentSession,
  parentSessionId: string,
): boolean {
  return session.parentSessionId === parentSessionId;
}

function isActiveSubagentSession(session: SubagentSession): boolean {
  return session.status === "running" || session.status === "queued";
}

function getSessionSortRank(status: SubagentSession["status"]): number {
  if (status === "running") {
    return 0;
  }

  if (status === "queued") {
    return 1;
  }

  return 2;
}

function getSessionRetentionTimestamp(session: SubagentSession): number {
  return session.finishedAt ?? session.startedAt;
}

function listCompletedSessionEntries(
  sessionsById: Map<string, SubagentSession>,
): Array<[string, SubagentSession]> {
  return [...sessionsById.entries()].filter(([, session]) => !isActiveSubagentSession(session));
}

function countCompletedSessions(sessions: Iterable<SubagentSession>): number {
  let count = 0;

  for (const session of sessions) {
    if (!isActiveSubagentSession(session)) {
      count += 1;
    }
  }

  return count;
}

export function getSubagentSessionRetentionSnapshot(
  sessions: Iterable<SubagentSession>,
): SubagentSessionRetentionSnapshot {
  return {
    evictions: subagentSessionRetentionCounters.evictions,
    retainedCompletedCount: Math.min(
      countCompletedSessions(sessions),
      SUBAGENT_SESSION_RETENTION_MAX_COMPLETED,
    ),
    maxCompletedSessions: SUBAGENT_SESSION_RETENTION_MAX_COMPLETED,
  };
}

export function resetSubagentSessionRetentionState(): void {
  subagentSessionRetentionCounters.evictions = 0;
}

export function listVisibleSubagentSessions(
  sessions: Iterable<SubagentSession>,
  activeParentSessionId: string | undefined,
): SubagentSession[] {
  const normalizedParentSessionId = normalizeParentSessionId(activeParentSessionId);

  return [...sessions]
    .filter((session) => {
      if (session.dismissed) {
        return false;
      }

      if (!normalizedParentSessionId) {
        return true;
      }

      return isOwnedByParentSession(session, normalizedParentSessionId);
    })
    .sort((left, right) => {
      const rankDelta = getSessionSortRank(left.status) - getSessionSortRank(right.status);
      if (rankDelta !== 0) {
        return rankDelta;
      }

      return right.startedAt - left.startedAt;
    });
}

export function clearStaleSubagentSessionsForNewSession(
  sessionsById: Map<string, SubagentSession>,
  activeParentSessionId: string | undefined,
  handlers: {
    cleanupSessionArtifacts: (session: SubagentSession) => boolean | void;
  },
): { removedCount: number; retainedActiveCount: number } {
  const normalizedParentSessionId = normalizeParentSessionId(activeParentSessionId);
  if (!normalizedParentSessionId) {
    return { removedCount: 0, retainedActiveCount: 0 };
  }

  let removedCount = 0;
  let retainedActiveCount = 0;

  for (const [sessionId, session] of sessionsById.entries()) {
    if (isOwnedByParentSession(session, normalizedParentSessionId)) {
      continue;
    }

    if (isActiveSubagentSession(session)) {
      retainedActiveCount += 1;
      continue;
    }

    if (handlers.cleanupSessionArtifacts(session) === false) {
      continue;
    }

    sessionsById.delete(sessionId);
    removedCount += 1;
  }

  return { removedCount, retainedActiveCount };
}

export function clearSubagentSessionsForParentShutdown(
  sessionsById: Map<string, SubagentSession>,
  parentSessionId: string | undefined,
  handlers: {
    cleanupSessionArtifacts: (session: SubagentSession) => boolean | void;
  },
): { removedCount: number; terminatedSessionIds: string[] } {
  const normalizedParentSessionId = normalizeParentSessionId(parentSessionId);
  if (!normalizedParentSessionId) {
    return { removedCount: 0, terminatedSessionIds: [] };
  }

  let removedCount = 0;
  const terminatedSessionIds: string[] = [];

  for (const [sessionId, session] of sessionsById.entries()) {
    if (!isOwnedByParentSession(session, normalizedParentSessionId)) {
      continue;
    }

    if (isActiveSubagentSession(session)) {
      terminatedSessionIds.push(sessionId);
      continue;
    }

    if (handlers.cleanupSessionArtifacts(session) === false) {
      continue;
    }

    sessionsById.delete(sessionId);
    removedCount += 1;
  }

  return { removedCount, terminatedSessionIds };
}

export function enforceBoundedSubagentSessionRetention(
  sessionsById: Map<string, SubagentSession>,
  handlers: {
    cleanupSessionArtifacts: (session: SubagentSession) => boolean | void;
  },
): { evictedCount: number; retainedCompletedCount: number; evictedSessionIds: string[] } {
  const completedSessions = listCompletedSessionEntries(sessionsById)
    .sort((left, right) => {
      const timestampDelta = getSessionRetentionTimestamp(right[1]) - getSessionRetentionTimestamp(left[1]);
      if (timestampDelta !== 0) {
        return timestampDelta;
      }

      return right[1].startedAt - left[1].startedAt;
    });

  if (completedSessions.length <= SUBAGENT_SESSION_RETENTION_MAX_COMPLETED) {
    return {
      evictedCount: 0,
      retainedCompletedCount: completedSessions.length,
      evictedSessionIds: [],
    };
  }

  const sessionsToEvict = completedSessions.slice(SUBAGENT_SESSION_RETENTION_MAX_COMPLETED);
  const evictedSessionIds: string[] = [];

  for (const [sessionId, session] of sessionsToEvict) {
    if (handlers.cleanupSessionArtifacts(session) === false) {
      continue;
    }

    sessionsById.delete(sessionId);
    evictedSessionIds.push(sessionId);
  }

  subagentSessionRetentionCounters.evictions += evictedSessionIds.length;
  void piAgentRouterDebugLogger.info("subagent.session_retention_evicted", {
    evictedCount: evictedSessionIds.length,
    evictedSessionIds,
    retention: getSubagentSessionRetentionSnapshot(sessionsById.values()),
  });

  return {
    evictedCount: evictedSessionIds.length,
    retainedCompletedCount: SUBAGENT_SESSION_RETENTION_MAX_COMPLETED,
    evictedSessionIds,
  };
}
