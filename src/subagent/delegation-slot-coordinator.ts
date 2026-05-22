export const ROUTER_SHUTDOWN_ABORT_MESSAGE =
  "Delegation was aborted because pi-agent-router is shutting down.";
export const ROUTER_DELEGATION_RESET_MESSAGE =
  "Delegation was aborted because pi-agent-router reset its delegation state.";
export const ROUTER_SHUTDOWN_TERMINATION_REASON =
  "Terminated because pi-agent-router is shutting down.";

export type DelegationSlotAcquireResult = {
  queued: boolean;
};

type QueuedDelegationRequest = {
  resume: () => void;
  reject: (error: Error) => void;
};

export class DelegationSlotCoordinator {
  private activeDelegations = 0;
  private readonly queuedDelegations: QueuedDelegationRequest[] = [];
  private shutdownInProgress = false;

  isShutdownInProgress(): boolean {
    return this.shutdownInProgress;
  }

  setShutdownInProgress(shutdownInProgress: boolean): void {
    this.shutdownInProgress = shutdownInProgress;
  }

  resetActiveDelegations(): void {
    this.activeDelegations = 0;
  }

  reset(reason: string): number {
    this.resetActiveDelegations();
    return this.cancelQueuedDelegations(reason);
  }

  cancelQueuedDelegations(reason: string): number {
    if (this.queuedDelegations.length === 0) {
      return 0;
    }

    const queuedRequests = this.queuedDelegations.splice(
      0,
      this.queuedDelegations.length,
    );
    for (const queuedRequest of queuedRequests) {
      queuedRequest.reject(new Error(reason));
    }

    return queuedRequests.length;
  }

  async acquireSlot(
    signal: AbortSignal | undefined,
    maxConcurrency: number,
  ): Promise<DelegationSlotAcquireResult> {
    if (this.shutdownInProgress) {
      throw new Error(ROUTER_SHUTDOWN_ABORT_MESSAGE);
    }

    if (this.activeDelegations < maxConcurrency) {
      this.activeDelegations += 1;
      return { queued: false };
    }

    return new Promise<DelegationSlotAcquireResult>((resolve, reject) => {
      let settled = false;

      const rejectRequest = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      };

      const removeQueuedRequest = (): void => {
        const queueIndex = this.queuedDelegations.indexOf(queuedRequest);
        if (queueIndex >= 0) {
          this.queuedDelegations.splice(queueIndex, 1);
        }
      };

      const onAbort = (): void => {
        removeQueuedRequest();
        rejectRequest(
          new Error(
            "Delegation request was aborted while waiting for an available slot.",
          ),
        );
      };

      const queuedRequest: QueuedDelegationRequest = {
        resume: (): void => {
          if (settled) {
            return;
          }

          signal?.removeEventListener("abort", onAbort);
          if (this.shutdownInProgress) {
            rejectRequest(new Error(ROUTER_SHUTDOWN_ABORT_MESSAGE));
            return;
          }

          settled = true;
          this.activeDelegations += 1;
          resolve({ queued: true });
        },
        reject: (error: Error): void => {
          removeQueuedRequest();
          rejectRequest(error);
        },
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      if (this.shutdownInProgress) {
        queuedRequest.reject(new Error(ROUTER_SHUTDOWN_ABORT_MESSAGE));
        return;
      }

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.queuedDelegations.push(queuedRequest);
    });
  }

  releaseSlot(): void {
    if (this.activeDelegations > 0) {
      this.activeDelegations -= 1;
    }

    if (this.shutdownInProgress) {
      return;
    }

    const next = this.queuedDelegations.shift();
    if (next) {
      next.resume();
    }
  }
}

export function createDelegationSlotCoordinator(): DelegationSlotCoordinator {
  return new DelegationSlotCoordinator();
}
