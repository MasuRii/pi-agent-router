import {
  colorizeWithHex,
  normalizeHexColor,
} from "../task/task-display-formatting";
import { getCircularSpinnerFrame } from "../progress-spinner";

type WidgetTheme = {
  fg(color: string, text: string): string;
};

type StatusColor = "success" | "warning" | "error";

type WidgetTone = StatusColor | "dim";

type SessionBucketKey =
  | "completed"
  | "running"
  | "queued"
  | "aborted"
  | "failed";

type SessionBuckets = Record<SessionBucketKey, SubagentWidgetSession[]>;

type ActiveDetailStyle = {
  includeRuntime: boolean;
  maxAgentWidth?: number;
};

export type SubagentWidgetStatusDisplay = {
  label: string;
  color: StatusColor;
};

export type SubagentWidgetSession = {
  id: string;
  agent: string;
  agentColor?: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
};

const SEGMENT_SEPARATOR = " · ";
const DETAIL_SEPARATOR = " │ ";
const ACTIVE_DETAIL_STYLES: readonly ActiveDetailStyle[] = [
  { includeRuntime: true },
  { includeRuntime: false },
  { includeRuntime: false, maxAgentWidth: 18 },
  { includeRuntime: false, maxAgentWidth: 12 },
  { includeRuntime: false, maxAgentWidth: 8 },
];

function normalizeAgentName(agentName: string): string {
  const normalized = typeof agentName === "string" ? agentName.trim() : "";
  return normalized || "agent";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function getStatusIcon(status: string, runningIcon: string): string {
  if (status === "running") {
    return runningIcon;
  }

  if (status === "queued") {
    return "⏸";
  }

  if (status === "finished") {
    return "✓";
  }

  if (status === "aborted") {
    return "!";
  }

  return "✗";
}

function bucketSessionStatus(status: string): SessionBucketKey {
  if (status === "finished") {
    return "completed";
  }

  if (status === "running") {
    return "running";
  }

  if (status === "queued") {
    return "queued";
  }

  if (status === "aborted") {
    return "aborted";
  }

  return "failed";
}

function buildSessionBuckets(
  sessions: readonly SubagentWidgetSession[],
): SessionBuckets {
  const buckets: SessionBuckets = {
    completed: [],
    running: [],
    queued: [],
    aborted: [],
    failed: [],
  };

  for (const session of sessions) {
    buckets[bucketSessionStatus(session.status)].push(session);
  }

  return buckets;
}

function summarizeAgentNames(
  sessions: readonly SubagentWidgetSession[],
  maxNames = 2,
): string {
  if (sessions.length === 0) {
    return "";
  }

  const normalizedMaxNames = Math.max(1, Math.trunc(maxNames));
  const uniqueNames = [...new Set(sessions.map((session) => normalizeAgentName(session.agent)))];
  const visibleNames = uniqueNames.slice(0, normalizedMaxNames);
  const hiddenCount = Math.max(0, uniqueNames.length - visibleNames.length);

  if (visibleNames.length === 0) {
    return "";
  }

  if (hiddenCount === 0) {
    return ` (${visibleNames.join(", ")})`;
  }

  return ` (${visibleNames.join(", ")} +${hiddenCount})`;
}

function truncateAgentName(
  agentName: string,
  maxWidth: number | undefined,
  truncate: (text: string, width: number, overflowMarker: string) => string,
): string {
  const normalizedAgentName = normalizeAgentName(agentName);
  if (!Number.isFinite(maxWidth)) {
    return normalizedAgentName;
  }

  const safeMaxWidth = Math.max(1, Math.trunc(maxWidth ?? normalizedAgentName.length));
  if (normalizedAgentName.length <= safeMaxWidth) {
    return normalizedAgentName;
  }

  const truncatedAgentName = truncate(normalizedAgentName, safeMaxWidth, "…").trim();
  if (truncatedAgentName) {
    return truncatedAgentName;
  }

  return normalizedAgentName.slice(0, safeMaxWidth);
}

function formatAgentLabel(
  agentName: string,
  agentColor: string | undefined,
  theme: WidgetTheme,
  fallbackTone: WidgetTone,
  truncate: (text: string, width: number, overflowMarker: string) => string,
  maxWidth?: number,
): string {
  const normalizedAgentName = truncateAgentName(agentName, maxWidth, truncate);
  const normalizedColor = normalizeHexColor(agentColor);
  if (normalizedColor) {
    return colorizeWithHex(normalizedAgentName, normalizedColor, { bold: true });
  }

  return theme.fg(fallbackTone, normalizedAgentName);
}

function resolveRuntimeLabel(
  session: SubagentWidgetSession,
  now: number,
  formatDuration: (milliseconds: number) => string,
): string | undefined {
  const startedAt = Number.isFinite(session.startedAt) ? session.startedAt : now;
  const finishedAt = Number.isFinite(session.finishedAt) ? session.finishedAt : now;
  const runtimeMs = Math.max(0, finishedAt - startedAt);
  const runtime = formatDuration(runtimeMs);
  return runtime.trim() || undefined;
}

function resolveSessionSpanMs(
  sessions: readonly SubagentWidgetSession[],
  now: number,
): number | undefined {
  if (sessions.length === 0) {
    return undefined;
  }

  const starts = sessions
    .map((session) => (Number.isFinite(session.startedAt) ? session.startedAt : now))
    .filter((value) => Number.isFinite(value));
  const ends = sessions
    .map((session) => (Number.isFinite(session.finishedAt) ? session.finishedAt : now))
    .filter((value) => Number.isFinite(value));

  if (starts.length === 0 || ends.length === 0) {
    return undefined;
  }

  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

function joinSegments(theme: WidgetTheme, segments: readonly string[]): string {
  return segments.join(theme.fg("dim", SEGMENT_SEPARATOR));
}

function formatStatusSegment(
  theme: WidgetTheme,
  tone: WidgetTone,
  icon: string,
  text: string,
): string {
  return `${theme.fg(tone, icon)} ${theme.fg(tone, text)}`;
}

function formatSummarySegments(
  theme: WidgetTheme,
  buckets: SessionBuckets,
  options: {
    includeFailedNames: boolean;
    includeAbortedNames: boolean;
    runningIcon: string;
  },
): string[] {
  const segments: string[] = [];

  if (buckets.running.length > 0) {
    segments.push(
      formatStatusSegment(
        theme,
        "warning",
        options.runningIcon,
        `${buckets.running.length} running`,
      ),
    );
  }

  if (buckets.completed.length > 0) {
    segments.push(
      formatStatusSegment(
        theme,
        "success",
        "✓",
        `${buckets.completed.length} completed`,
      ),
    );
  }

  if (buckets.failed.length > 0) {
    const failedNames = options.includeFailedNames
      ? summarizeAgentNames(buckets.failed)
      : "";
    segments.push(
      formatStatusSegment(
        theme,
        "error",
        "✗",
        `${buckets.failed.length} failed${failedNames}`,
      ),
    );
  }

  if (buckets.aborted.length > 0) {
    const abortedNames = options.includeAbortedNames
      ? summarizeAgentNames(buckets.aborted)
      : "";
    segments.push(
      formatStatusSegment(
        theme,
        "warning",
        "!",
        `${buckets.aborted.length} aborted${abortedNames}`,
      ),
    );
  }

  if (buckets.queued.length > 0) {
    segments.push(
      formatStatusSegment(
        theme,
        "warning",
        "⏸",
        `${buckets.queued.length} queued`,
      ),
    );
  }

  return segments;
}

function formatLiveSessionDetail(
  session: SubagentWidgetSession,
  theme: WidgetTheme,
  formatDuration: (milliseconds: number) => string,
  now: number,
  getStatusDisplay: (status: string) => SubagentWidgetStatusDisplay,
  truncate: (text: string, width: number, overflowMarker: string) => string,
  options: ActiveDetailStyle & { runningIcon: string },
): string {
  const statusDisplay = getStatusDisplay(session.status);
  const icon = getStatusIcon(session.status, options.runningIcon);
  const label = formatAgentLabel(
    session.agent,
    session.agentColor,
    theme,
    statusDisplay.color,
    truncate,
    options.maxAgentWidth,
  );
  const runtime =
    options.includeRuntime && session.status === "running"
      ? resolveRuntimeLabel(session, now, formatDuration)
      : undefined;

  if (!runtime) {
    return `${theme.fg(statusDisplay.color, icon)} ${label}`;
  }

  return `${theme.fg(statusDisplay.color, icon)} ${label} ${theme.fg("dim", runtime)}`;
}

function buildActiveDetailSegments(
  sessions: readonly SubagentWidgetSession[],
  theme: WidgetTheme,
  formatDuration: (milliseconds: number) => string,
  now: number,
  getStatusDisplay: (status: string) => SubagentWidgetStatusDisplay,
  truncate: (text: string, width: number, overflowMarker: string) => string,
  maxShown: number,
  options: ActiveDetailStyle & { runningIcon: string },
): string[] {
  if (sessions.length === 0) {
    return [];
  }

  const normalizedMaxShown = Math.max(1, Math.min(Math.trunc(maxShown), sessions.length));
  const visibleSessions = sessions.slice(0, normalizedMaxShown);
  const segments = visibleSessions.map((session) =>
    formatLiveSessionDetail(
      session,
      theme,
      formatDuration,
      now,
      getStatusDisplay,
      truncate,
      options,
    ),
  );

  if (visibleSessions.length < sessions.length) {
    segments.push(theme.fg("dim", `+${sessions.length - visibleSessions.length} more`));
  }

  return segments;
}

function buildCompletedSummaryCandidates(
  theme: WidgetTheme,
  totalSessions: number,
  durationLabel: string | undefined,
): string[] {
  const agentLabel = `${totalSessions} ${pluralize(totalSessions, "agent")}`;
  const baseMessage = `✓ All ${agentLabel} completed successfully`;
  const candidates = [theme.fg("success", baseMessage)];

  if (durationLabel) {
    candidates.unshift(
      `${theme.fg("success", baseMessage)} ${theme.fg("dim", durationLabel)}`,
    );
  }

  candidates.push(theme.fg("success", `✓ ${totalSessions}/${totalSessions} completed`));
  return candidates;
}

function buildSummaryVariants(
  theme: WidgetTheme,
  buckets: SessionBuckets,
  runningIcon: string,
): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();

  for (const variant of [
    joinSegments(
      theme,
      formatSummarySegments(theme, buckets, {
        includeFailedNames: true,
        includeAbortedNames: true,
        runningIcon,
      }),
    ),
    joinSegments(
      theme,
      formatSummarySegments(theme, buckets, {
        includeFailedNames: false,
        includeAbortedNames: false,
        runningIcon,
      }),
    ),
  ]) {
    if (!variant || seen.has(variant)) {
      continue;
    }

    seen.add(variant);
    variants.push(variant);
  }

  return variants;
}

export function renderSubagentWidgetLines(options: {
  sessions: readonly SubagentWidgetSession[];
  width: number;
  theme: WidgetTheme;
  formatDuration: (milliseconds: number) => string;
  getStatusDisplay: (status: string) => SubagentWidgetStatusDisplay;
  truncate: (text: string, width: number, overflowMarker: string) => string;
  maxShown?: number;
  now?: number;
}): string[] {
  const { sessions, width, theme, formatDuration, getStatusDisplay, truncate } = options;
  if (sessions.length === 0) {
    return [];
  }

  if (!Number.isFinite(width) || width <= 0) {
    return [];
  }

  const safeWidth = Math.max(1, Math.floor(width));
  const now = options.now ?? Date.now();
  const maxShown =
    options.maxShown === undefined
      ? sessions.length
      : Math.max(1, Math.trunc(options.maxShown));
  const runningIcon = getCircularSpinnerFrame(now);
  const buckets = buildSessionBuckets(sessions);
  const activeSessions = [...buckets.running, ...buckets.queued];
  const maxVisibleActiveSessions = Math.min(activeSessions.length, maxShown);
  const hasActiveSessions = activeSessions.length > 0;
  const allCompletedSuccessfully =
    buckets.completed.length === sessions.length &&
    buckets.running.length === 0 &&
    buckets.queued.length === 0 &&
    buckets.failed.length === 0 &&
    buckets.aborted.length === 0;

  const fitsWidth = (line: string): boolean => truncate(line, safeWidth, "") === line;
  const candidates: string[] = [];
  const seenCandidates = new Set<string>();
  const pushCandidate = (candidate: string): void => {
    if (!candidate || seenCandidates.has(candidate)) {
      return;
    }

    seenCandidates.add(candidate);
    candidates.push(candidate);
  };

  if (allCompletedSuccessfully) {
    const totalDurationMs = resolveSessionSpanMs(sessions, now);
    const durationLabel =
      totalDurationMs !== undefined ? formatDuration(totalDurationMs) : undefined;

    for (const candidate of buildCompletedSummaryCandidates(
      theme,
      sessions.length,
      durationLabel,
    )) {
      pushCandidate(` ${candidate}`);
    }
  } else {
    const summaryVariants = buildSummaryVariants(theme, buckets, runningIcon);

    if (summaryVariants.length > 0 && hasActiveSessions && maxVisibleActiveSessions > 0) {
      for (let visibleCount = maxVisibleActiveSessions; visibleCount >= 1; visibleCount -= 1) {
        for (const detailStyle of ACTIVE_DETAIL_STYLES) {
          const activeDetails = buildActiveDetailSegments(
            activeSessions,
            theme,
            formatDuration,
            now,
            getStatusDisplay,
            truncate,
            visibleCount,
            {
              ...detailStyle,
              runningIcon,
            },
          );

          if (activeDetails.length === 0) {
            continue;
          }

          for (const summaryVariant of summaryVariants) {
            pushCandidate(
              ` ${summaryVariant}${theme.fg("dim", DETAIL_SEPARATOR)}${joinSegments(theme, activeDetails)}`,
            );
          }
        }
      }
    }

    for (const summaryVariant of summaryVariants) {
      pushCandidate(` ${summaryVariant}`);
    }

    if (hasActiveSessions) {
      const activeIcon = buckets.running.length > 0 ? runningIcon : "⏸";
      const activeCount = activeSessions.length;
      pushCandidate(
        ` ${formatStatusSegment(
          theme,
          "warning",
          activeIcon,
          `${activeCount} ${pluralize(activeCount, "active session")}`,
        )}`,
      );
    }
  }

  for (const candidate of candidates) {
    if (fitsWidth(candidate)) {
      return [candidate];
    }
  }

  const fallback = candidates[candidates.length - 1] || "";
  if (!fallback) {
    return [];
  }

  return [truncate(fallback, safeWidth, "…")];
}
