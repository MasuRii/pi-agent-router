import {
  getBrailleSpinnerFrame,
  getCircularSpinnerFrame,
} from "../progress-spinner";
import {
  colorizeWithHex,
  normalizeHexColor,
} from "../task/task-display-formatting";
import type { SubagentWidgetIcons } from "./subagent-widget-icons";

type WidgetTheme = {
  fg(color: string, text: string): string;
};

type StatusColor = "success" | "warning" | "error";

type WidgetTone = StatusColor | "dim" | "accent" | "toolOutput" | "toolTitle";

type SessionBucketKey =
  | "completed"
  | "running"
  | "queued"
  | "failed";

type SessionBuckets = Record<SessionBucketKey, SubagentWidgetSession[]>;

type DetailMode = "full" | "noTimers" | "iconsOnly";

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

function normalizeAgentName(agentName: string): string {
  const normalized = typeof agentName === "string" ? agentName.trim() : "";
  return normalized || "agent";
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

  return "failed";
}

function buildSessionBuckets(
  sessions: readonly SubagentWidgetSession[],
): SessionBuckets {
  const buckets: SessionBuckets = {
    completed: [],
    running: [],
    queued: [],
    failed: [],
  };

  for (const session of sessions) {
    buckets[bucketSessionStatus(session.status)].push(session);
  }

  return buckets;
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
  tone: WidgetTone,
  truncate: (text: string, width: number, overflowMarker: string) => string,
  maxWidth?: number,
): string {
  const normalizedAgentName = truncateAgentName(agentName, maxWidth, truncate);
  const normalizedColor = normalizeHexColor(agentColor);
  if (normalizedColor) {
    return colorizeWithHex(normalizedAgentName, normalizedColor, { bold: true });
  }

  return theme.fg(tone, normalizedAgentName);
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

function resolveGeometricTrackWidth(totalSessions: number): number {
  return Math.max(1, Math.trunc(totalSessions));
}

function resolveTotalSessionCount(
  visibleSessionCount: number,
  totalCount: number | undefined,
): number {
  if (typeof totalCount !== "number" || !Number.isFinite(totalCount)) {
    return visibleSessionCount;
  }

  return Math.max(visibleSessionCount, Math.trunc(totalCount));
}

function resolveCompletedTrackSegments(
  completedSessionCount: number,
  totalSessions: number,
  trackWidth: number,
): number {
  if (completedSessionCount <= 0) {
    return 0;
  }

  const proportionalSegments = Math.floor(
    (completedSessionCount / Math.max(1, totalSessions)) * trackWidth,
  );
  return Math.max(1, Math.min(trackWidth, proportionalSegments));
}

function renderGeometricTrack(
  buckets: SessionBuckets,
  totalSessions: number,
  theme: WidgetTheme,
  segmentSeparator: string,
): string {
  const trackWidth = resolveGeometricTrackWidth(totalSessions);
  const completedSegments = resolveCompletedTrackSegments(
    buckets.completed.length,
    totalSessions,
    trackWidth,
  );
  const segments: string[] = [];

  for (let index = 0; index < trackWidth; index += 1) {
    segments.push(
      index < completedSegments
        ? theme.fg("success", "▰")
        : theme.fg("dim", "▱"),
    );
  }

  return segments.join(segmentSeparator);
}

function buildTrackSegmentSeparators(width: number): readonly string[] {
  if (width >= 64) {
    return [" ", ""];
  }

  return [""];
}

function formatProgressLead(
  buckets: SessionBuckets,
  totalSessions: number,
  theme: WidgetTheme,
  now: number,
  trackSegmentSeparator: string,
  icon?: string,
): string {
  const progressIcon = icon ?? getBrailleSpinnerFrame(now);
  return [
    theme.fg(progressIcon === "✓" ? "success" : "toolTitle", progressIcon),
    theme.fg("muted", `${buckets.completed.length}/${totalSessions}`),
    renderGeometricTrack(buckets, totalSessions, theme, trackSegmentSeparator),
  ].join(" ");
}

function formatErrorSegment(errorCount: number, theme: WidgetTheme): string | undefined {
  if (errorCount <= 0) {
    return undefined;
  }

  return theme.fg("error", ` ${errorCount} failed`);
}

function formatRunningDetail(
  session: SubagentWidgetSession,
  mode: DetailMode,
  theme: WidgetTheme,
  formatDuration: (milliseconds: number) => string,
  now: number,
  truncate: (text: string, width: number, overflowMarker: string) => string,
  icons: SubagentWidgetIcons,
): string {
  const icon = theme.fg("toolTitle", getCircularSpinnerFrame(now) || icons.running);
  if (mode === "iconsOnly") {
    return icon;
  }

  const label = formatAgentLabel(
    session.agent,
    session.agentColor,
    theme,
    "toolOutput",
    truncate,
    mode === "full" ? 18 : 12,
  );
  if (mode === "noTimers") {
    return `${icon} ${label}`;
  }

  const runtime = resolveRuntimeLabel(session, now, formatDuration);
  return runtime ? `${icon} ${label} ${theme.fg("dim", runtime)}` : `${icon} ${label}`;
}

function buildRunningDetailSegment(options: {
  sessions: readonly SubagentWidgetSession[];
  mode: DetailMode;
  maxShown: number;
  theme: WidgetTheme;
  formatDuration: (milliseconds: number) => string;
  now: number;
  truncate: (text: string, width: number, overflowMarker: string) => string;
  icons: SubagentWidgetIcons;
}): string | undefined {
  const visibleSessions = options.sessions.slice(0, options.maxShown);
  if (visibleSessions.length === 0) {
    return undefined;
  }

  const segments = visibleSessions.map((session) =>
    formatRunningDetail(
      session,
      options.mode,
      options.theme,
      options.formatDuration,
      options.now,
      options.truncate,
      options.icons,
    ),
  );

  if (visibleSessions.length < options.sessions.length && options.mode !== "iconsOnly") {
    segments.push(options.theme.fg("dim", `+${options.sessions.length - visibleSessions.length} more`));
  }

  return segments.join(options.theme.fg("dim", SEGMENT_SEPARATOR));
}

function buildCompletedSummaryCandidates(
  buckets: SessionBuckets,
  theme: WidgetTheme,
  totalSessions: number,
  durationLabel: string | undefined,
  now: number,
  width: number,
): string[] {
  const candidates: string[] = [];
  for (const trackSegmentSeparator of buildTrackSegmentSeparators(width)) {
    const lead = formatProgressLead(
      buckets,
      totalSessions,
      theme,
      now,
      trackSegmentSeparator,
      "✓",
    );
    const status = durationLabel
      ? `${theme.fg("success", "completed successfully")} ${theme.fg("dim", `(${durationLabel})`)}`
      : theme.fg("success", "completed successfully");
    candidates.push(` ${lead}${theme.fg("dim", DETAIL_SEPARATOR)}${status}`);
    candidates.push(` ${lead}`);
  }

  return candidates;
}

function buildDetailModeOrder(width: number): DetailMode[] {
  if (width < 80) {
    return ["noTimers", "iconsOnly"];
  }

  return ["full", "noTimers", "iconsOnly"];
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
  totalCount?: number;
  icons: SubagentWidgetIcons;
}): string[] {
  const { sessions, width, theme, formatDuration, truncate } = options;
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
  const buckets = buildSessionBuckets(sessions);
  const totalSessions = resolveTotalSessionCount(sessions.length, options.totalCount);
  const runningSessions = buckets.running;
  const errorCount = buckets.failed.length;
  const allCompletedSuccessfully =
    buckets.completed.length === totalSessions &&
    buckets.running.length === 0 &&
    buckets.queued.length === 0 &&
    buckets.failed.length === 0;

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
      buckets,
      theme,
      totalSessions,
      durationLabel,
      now,
      safeWidth,
    )) {
      pushCandidate(candidate);
    }
  } else {
    const errorSegment = formatErrorSegment(errorCount, theme);
    const maxVisibleRunningSessions = Math.min(runningSessions.length, maxShown);

    for (const trackSegmentSeparator of buildTrackSegmentSeparators(safeWidth)) {
      const lead = formatProgressLead(
        buckets,
        totalSessions,
        theme,
        now,
        trackSegmentSeparator,
      );

      if (maxVisibleRunningSessions > 0) {
        for (let visibleCount = maxVisibleRunningSessions; visibleCount >= 1; visibleCount -= 1) {
          for (const mode of buildDetailModeOrder(safeWidth)) {
            const runningDetails = buildRunningDetailSegment({
              sessions: runningSessions,
              mode,
              maxShown: visibleCount,
              theme,
              formatDuration,
              now,
              truncate,
              icons: options.icons,
            });
            if (!runningDetails) {
              continue;
            }

            const trailingSegments = [errorSegment, runningDetails].filter(
              (segment): segment is string => Boolean(segment),
            );
            pushCandidate(
              ` ${lead}${trailingSegments.length > 0 ? theme.fg("dim", DETAIL_SEPARATOR) : ""}${trailingSegments.join(theme.fg("dim", DETAIL_SEPARATOR))}`,
            );
          }
        }
      }

      if (errorSegment) {
        pushCandidate(` ${lead}${theme.fg("dim", DETAIL_SEPARATOR)}${errorSegment}`);
      }

      pushCandidate(` ${lead}`);
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
