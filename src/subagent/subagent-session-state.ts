import type { SubagentSession } from "../types";

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
    cleanupSessionArtifacts: (session: SubagentSession) => void;
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

    handlers.cleanupSessionArtifacts(session);
    sessionsById.delete(sessionId);
    removedCount += 1;
  }

  return { removedCount, retainedActiveCount };
}

export function clearSubagentSessionsForParentShutdown(
  sessionsById: Map<string, SubagentSession>,
  parentSessionId: string | undefined,
  handlers: {
    cleanupSessionArtifacts: (session: SubagentSession) => void;
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

    handlers.cleanupSessionArtifacts(session);
    sessionsById.delete(sessionId);
    removedCount += 1;
  }

  return { removedCount, terminatedSessionIds };
}
