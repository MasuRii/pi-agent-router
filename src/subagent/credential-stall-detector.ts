/**
 * Parent-side credential/cooldown stall detection for delegated subagent processes.
 */

export type SubagentCredentialStallSignalKind =
  | "quota"
  | "credential_auth"
  | "cooldown"
  | "transient";

export type SubagentCredentialStallSignal = {
  kind: SubagentCredentialStallSignalKind;
  matchedText: string;
};

export type SubagentCredentialStallEvent = {
  signal: SubagentCredentialStallSignal;
  firstCredentialSignalAt: number;
  lastCredentialSignalAt: number;
  lastMeaningfulActivityAt: number;
  stalledForMs: number;
  signalCount: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type TimerApi = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type SubagentCredentialStallMonitorOptions = {
  enabled: boolean;
  thresholdMs: number;
  now?: () => number;
  timers?: TimerApi;
  onStall: (event: SubagentCredentialStallEvent) => void;
};

const SIGNAL_SNIPPET_MAX_CHARS = 500;

const CREDENTIAL_RUNTIME_CONTEXT_PATTERN = String.raw`(?:credential|credentials|api[-_\s]?key|oauth|auth(?:entication)?|token|provider|model|multi[-_\s]?auth|openai|anthropic|codex|copilot|google|gemini|xai|groq|mistral|kimi|opencode)`;
const CREDENTIAL_OR_QUOTA_CONTEXT_PATTERN = String.raw`(?:${CREDENTIAL_RUNTIME_CONTEXT_PATTERN}|quota|rate[-\s]?limit(?:ed)?|429|too\s+many\s+requests|request\s+limit|usage\s+limit|credit(?:s)?)`;
const COOLDOWN_SIGNAL_PATTERN = String.raw`(?:cool[-\s]?down|cooling\s+down|retry[-_\s]?after|retry\s+after|retrying\s+in|back(?:ing)?\s+off|temporarily\s+paused)`;
const QUOTA_SIGNAL_PATTERN = String.raw`(?:quota|rate[-\s]?limit(?:ed)?|429|too\s+many\s+requests|request\s+limit|usage\s+limit|credit(?:s)?\s+(?:exhausted|depleted|limit))`;

function createContextualSignalPattern(signalPattern: string, contextPattern: string): RegExp {
  return new RegExp(
    `\\b(?:(?:${contextPattern})\\b.{0,160}\\b(?:${signalPattern})|(?:${signalPattern})\\b.{0,160}\\b(?:${contextPattern}))\\b`,
    "i",
  );
}

const CREDENTIAL_STALL_PATTERNS: ReadonlyArray<{
  kind: SubagentCredentialStallSignalKind;
  pattern: RegExp;
}> = [
  {
    kind: "cooldown",
    pattern: createContextualSignalPattern(
      COOLDOWN_SIGNAL_PATTERN,
      CREDENTIAL_OR_QUOTA_CONTEXT_PATTERN,
    ),
  },
  {
    kind: "quota",
    pattern: createContextualSignalPattern(
      QUOTA_SIGNAL_PATTERN,
      CREDENTIAL_RUNTIME_CONTEXT_PATTERN,
    ),
  },
  {
    kind: "credential_auth",
    pattern: /\b(?:(?:credential|api[-_\s]?key|oauth|auth(?:entication)?|token)\b.{0,120}\b(?:expired|invalid|revoked|unauthorized|forbidden|failed|requires?\s+relogin|refresh\s+failed)|(?:invalid|expired|revoked|unauthorized|forbidden)\b.{0,120}\b(?:credential|api[-_\s]?key|oauth|token))\b/i,
  },
  {
    kind: "transient",
    pattern: new RegExp(
      String.raw`\b(?:no\s+(?:eligible\s+)?credentials?\s+available|all\s+credentials?\s+(?:are\s+)?(?:unavailable|exhausted|cooling\s+down)|(?:${CREDENTIAL_RUNTIME_CONTEXT_PATTERN})\b.{0,160}\b(?:service\s+unavailable|temporarily\s+unavailable|unavailable|overloaded)|(?:service\s+unavailable|temporarily\s+unavailable|unavailable|overloaded)\b.{0,160}\b(?:${CREDENTIAL_RUNTIME_CONTEXT_PATTERN}))\b`,
      "i",
    ),
  },
];

function normalizeThresholdMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function truncateSignalText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= SIGNAL_SNIPPET_MAX_CHARS
    ? normalized
    : normalized.slice(0, SIGNAL_SNIPPET_MAX_CHARS);
}

export function detectSubagentCredentialStallSignal(
  text: string,
): SubagentCredentialStallSignal | undefined {
  if (!text.trim()) {
    return undefined;
  }

  for (const entry of CREDENTIAL_STALL_PATTERNS) {
    if (entry.pattern.test(text)) {
      return {
        kind: entry.kind,
        matchedText: truncateSignalText(text),
      };
    }
  }

  return undefined;
}

export function createSubagentCredentialStallMonitor(
  options: SubagentCredentialStallMonitorOptions,
): {
  recordMeaningfulProgress: () => void;
  recordCredentialSignalText: (text: string) => SubagentCredentialStallSignal | undefined;
  stop: () => void;
} {
  const thresholdMs = normalizeThresholdMs(options.thresholdMs);
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: TimerHandle) => clearTimeout(handle),
  };
  const enabled = options.enabled && thresholdMs > 0;

  let stopped = false;
  let stalled = false;
  let stallTimer: TimerHandle | undefined;
  let lastMeaningfulActivityAt: number | undefined;
  let firstCredentialSignalAt: number | undefined;
  let lastCredentialSignalAt: number | undefined;
  let lastCredentialSignal: SubagentCredentialStallSignal | undefined;
  let signalCount = 0;

  const clearStallTimer = (): void => {
    if (stallTimer) {
      timers.clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };

  const buildEvent = (currentTime: number): SubagentCredentialStallEvent | undefined => {
    if (
      !lastCredentialSignal ||
      firstCredentialSignalAt === undefined ||
      lastCredentialSignalAt === undefined ||
      lastMeaningfulActivityAt === undefined
    ) {
      return undefined;
    }

    return {
      signal: lastCredentialSignal,
      firstCredentialSignalAt,
      lastCredentialSignalAt,
      lastMeaningfulActivityAt,
      stalledForMs: Math.max(0, currentTime - lastMeaningfulActivityAt),
      signalCount,
    };
  };

  const evaluate = (): void => {
    stallTimer = undefined;
    if (stopped || stalled || !enabled) {
      return;
    }

    if (!lastCredentialSignal || lastMeaningfulActivityAt === undefined) {
      return;
    }

    const currentTime = now();
    const stalledForMs = currentTime - lastMeaningfulActivityAt;
    if (stalledForMs < thresholdMs) {
      schedule();
      return;
    }

    const event = buildEvent(currentTime);
    if (!event) {
      return;
    }

    stalled = true;
    clearStallTimer();
    options.onStall(event);
  };

  function schedule(): void {
    clearStallTimer();
    if (
      stopped ||
      stalled ||
      !enabled ||
      !lastCredentialSignal ||
      lastMeaningfulActivityAt === undefined
    ) {
      return;
    }

    const delayMs = Math.max(0, thresholdMs - (now() - lastMeaningfulActivityAt));
    stallTimer = timers.setTimeout(evaluate, delayMs);
  }

  return {
    recordMeaningfulProgress: (): void => {
      if (!enabled || stopped || stalled) {
        return;
      }

      lastMeaningfulActivityAt = now();
      schedule();
    },
    recordCredentialSignalText: (text: string): SubagentCredentialStallSignal | undefined => {
      if (!enabled || stopped || stalled) {
        return undefined;
      }

      const signal = detectSubagentCredentialStallSignal(text);
      if (!signal) {
        return undefined;
      }

      const currentTime = now();
      firstCredentialSignalAt ??= currentTime;
      lastCredentialSignalAt = currentTime;
      lastCredentialSignal = signal;
      signalCount += 1;
      schedule();
      return signal;
    },
    stop: (): void => {
      stopped = true;
      clearStallTimer();
    },
  };
}
