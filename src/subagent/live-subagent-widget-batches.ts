export type LiveSubagentWidgetBatchRenderRequest = (immediate?: boolean) => void;

export type LiveSubagentWidgetSession = {
  id: string;
};

type LiveSubagentWidgetBatch = {
  parentSessionId: string;
  total: number;
  sessionIds: Set<string>;
};

export type LiveSubagentWidgetBatchTracker = {
  registerBatch: (batchId: string, parentSessionId: string, total: number) => void;
  trackSession: (batchId: string, sessionId: string) => void;
  clearBatch: (batchId: string) => void;
  resolveTotalCount: (sessions: readonly LiveSubagentWidgetSession[]) => number | undefined;
};

export function createLiveSubagentWidgetBatchTracker(options: {
  requestRender: LiveSubagentWidgetBatchRenderRequest;
  getActiveParentSessionId: () => string;
}): LiveSubagentWidgetBatchTracker {
  const batches = new Map<string, LiveSubagentWidgetBatch>();

  return {
    registerBatch(batchId, parentSessionId, total) {
      batches.set(batchId, {
        parentSessionId,
        total: Math.max(0, Math.trunc(total)),
        sessionIds: new Set<string>(),
      });
      options.requestRender();
    },

    trackSession(batchId, sessionId) {
      const batch = batches.get(batchId);
      if (!batch) {
        return;
      }

      batch.sessionIds.add(sessionId);
      options.requestRender(false);
    },

    clearBatch(batchId) {
      if (batches.delete(batchId)) {
        options.requestRender();
      }
    },

    resolveTotalCount(sessions) {
      const visibleSessionIds = new Set(sessions.map((session) => session.id));
      const activeParentSessionId = options.getActiveParentSessionId();
      let queuedWithoutSessions = 0;

      for (const batch of batches.values()) {
        if (activeParentSessionId && batch.parentSessionId !== activeParentSessionId) {
          continue;
        }

        let visibleStartedSessions = 0;
        for (const sessionId of batch.sessionIds) {
          if (visibleSessionIds.has(sessionId)) {
            visibleStartedSessions += 1;
          }
        }

        queuedWithoutSessions += Math.max(0, batch.total - visibleStartedSessions);
      }

      if (queuedWithoutSessions <= 0) {
        return undefined;
      }

      return sessions.length + queuedWithoutSessions;
    },
  };
}
