import {
  getMarkdownTheme,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import { ZellijModal, type ZellijModalContentRenderer } from "../../../zellij-modal";
import { getCircularSpinnerFrame } from "../progress-spinner";

type StatusColor = "success" | "warning" | "error";

type SubagentStatusDisplay = {
  label: string;
  color: StatusColor;
};

export type SubagentOverlaySession = {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  agent: string;
  fullOutput?: string;
  lastOutput?: string;
  failureSummary?: string;
  stderr: string;
  outputNotice?: string;
};

const CONTENT_LEFT_PADDING = "   ";
const CONTENT_RIGHT_PADDING = " ";
const SCROLLBAR_GAP = " ";

function fitLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "");
}

function getPaddedContentWidth(width: number): number {
  return Math.max(
    1,
    width -
      visibleWidth(CONTENT_LEFT_PADDING) -
      visibleWidth(CONTENT_RIGHT_PADDING) -
      visibleWidth(SCROLLBAR_GAP) -
      1,
  );
}

function fitPaddedLine(text: string, width: number, scrollbarChar: string): string {
  if (width <= 8) {
    return fitLine(text, width);
  }

  const contentWidth = getPaddedContentWidth(width);
  const fitted = truncateToWidth(text, contentWidth, "");
  const fillWidth = Math.max(0, contentWidth - visibleWidth(fitted));
  return `${CONTENT_LEFT_PADDING}${fitted}${" ".repeat(fillWidth)}${CONTENT_RIGHT_PADDING}${SCROLLBAR_GAP}${scrollbarChar}`;
}

function resolveScrollbarChar(options: {
  row: number;
  rowCount: number;
  totalLines: number;
  visibleLines: number;
  offset: number;
}): string {
  const { row, rowCount, totalLines, visibleLines, offset } = options;
  if (totalLines <= visibleLines || rowCount <= 0) {
    return " ";
  }

  const trackRows = Math.max(1, rowCount);
  const thumbSize = Math.max(1, Math.floor((visibleLines / totalLines) * trackRows));
  const maxThumbStart = Math.max(0, trackRows - thumbSize);
  const maxOffset = Math.max(1, totalLines - visibleLines);
  const thumbStart = Math.min(
    maxThumbStart,
    Math.floor((Math.max(0, offset) / maxOffset) * maxThumbStart),
  );

  return row >= thumbStart && row < thumbStart + thumbSize ? "█" : "░";
}

type OutputOverlayDependencies = {
  getStatusDisplay: (status: string) => SubagentStatusDisplay;
  formatDuration: (milliseconds: number) => string;
  sanitizeOutput: (output: string) => string;
};

type OverlayOutputView = {
  output: string;
  noticeLines: string[];
};

export class SubagentOutputOverlay {
  private scrollOffset = 0;
  private lastRenderedOutputLineCount = 1;
  private readonly modal: ZellijModal;

  constructor(
    private readonly theme: ExtensionContext["ui"]["theme"],
    private readonly getSession: () => SubagentOverlaySession | undefined,
    private readonly onClose: () => void,
    private readonly requestRender: () => void,
    private readonly getTerminalRows: () => number,
    private readonly deps: OutputOverlayDependencies,
  ) {
    const contentRenderer: ZellijModalContentRenderer = {
      render: (width) => this.renderContent(width),
      invalidate: () => {},
      handleInput: (data) => this.handleOutputInput(data),
    };

    this.modal = new ZellijModal(
      contentRenderer,
      {
        borderStyle: "rounded",
        padding: 0,
        titleBar: {
          left: "Task Delegation Output",
          right: "pi-agent-router",
        },
        helpUndertitle: {
          text: "↑↓: scroll | PgUp/PgDn: page | Home/End: jump | Esc: close",
          color: "dim",
        },
        overlay: {
          width: "90%",
          maxHeight: "85%",
          anchor: "center",
          margin: 1,
        },
      },
      this.theme,
    );
  }

  private getMaxVisibleOutputLines(hasTaskId: boolean): number {
    const terminalRows = this.getTerminalRows();
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) {
      return 16;
    }

    const estimatedOverlayRows = Math.max(
      10,
      Math.floor(terminalRows * 0.85) - 2,
    );
    const chromeRows = hasTaskId ? 8 : 7;
    return Math.max(4, estimatedOverlayRows - chromeRows);
  }

  private clampScroll(totalLines: number, maxVisible: number): void {
    const maxOffset = Math.max(0, totalLines - maxVisible);
    if (this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }
    if (this.scrollOffset < 0) {
      this.scrollOffset = 0;
    }
  }

  private renderOutputLines(output: string, width: number): string[] {
    const contentWidth = Math.max(1, width - 1);

    try {
      const markdown = new Markdown(output, 0, 0, getMarkdownTheme());
      const markdownLines = markdown.render(contentWidth);
      if (markdownLines.length > 0) {
        return markdownLines;
      }
    } catch {
      // Fall back to plain wrapping when markdown rendering fails.
    }

    const wrappedOutputLines: string[] = [];
    for (const rawLine of output.split(/\r?\n/)) {
      const wrapped = wrapTextWithAnsi(rawLine, contentWidth);
      if (wrapped.length === 0) {
        wrappedOutputLines.push("");
      } else {
        wrappedOutputLines.push(...wrapped);
      }
    }

    if (wrappedOutputLines.length === 0) {
      wrappedOutputLines.push("");
    }

    return wrappedOutputLines;
  }

  private buildOutputView(session: SubagentOverlaySession | undefined): OverlayOutputView {
    const noticeLines = session?.outputNotice?.trim()
      ? [session.outputNotice.trim()]
      : [];

    const terminalFailure =
      session?.status === "failed" ||
      session?.status === "timed_out" ||
      session?.status === "aborted" ||
      session?.status === "killed";
    if (terminalFailure && session?.failureSummary?.trim()) {
      return {
        output: this.deps.sanitizeOutput(session.failureSummary),
        noticeLines,
      };
    }

    const retainedOutput = session?.fullOutput || session?.lastOutput;
    if (retainedOutput?.trim()) {
      return {
        output: this.deps.sanitizeOutput(retainedOutput),
        noticeLines,
      };
    }

    return {
      output: this.deps.sanitizeOutput(session?.stderr || "(no output yet)"),
      noticeLines,
    };
  }

  private handleOutputInput(data: string): void {
    const session = this.getSession();
    const outputView = this.buildOutputView(session);
    const totalRawLines = Math.max(1, outputView.output.split(/\r?\n/).length);
    const totalLines = Math.max(
      this.lastRenderedOutputLineCount,
      totalRawLines,
    );
    const maxVisible = this.getMaxVisibleOutputLines(Boolean(session?.taskId));
    const pageSize = Math.max(3, Math.floor(maxVisible * 0.8));

    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "q")
    ) {
      this.onClose();
      return;
    }

    if (matchesKey(data, "up")) {
      this.scrollOffset -= 1;
      this.clampScroll(totalLines, maxVisible);
      this.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.scrollOffset += 1;
      this.clampScroll(totalLines, maxVisible);
      this.requestRender();
      return;
    }

    if (matchesKey(data, "pageUp")) {
      this.scrollOffset -= pageSize;
      this.clampScroll(totalLines, maxVisible);
      this.requestRender();
      return;
    }

    if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
      this.scrollOffset += pageSize;
      this.clampScroll(totalLines, maxVisible);
      this.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.clampScroll(totalLines, maxVisible);
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    this.modal.handleInput(data);
  }

  render(width: number): string[] {
    return this.modal.renderModal(width).lines;
  }

  private renderContent(width: number): string[] {
    const session = this.getSession();
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];

    const outputView = this.buildOutputView(session);
    const statusDisplay = this.deps.getStatusDisplay(
      session?.status || "failed",
    );
    const runtime = session
      ? this.deps.formatDuration(
          (session.finishedAt ?? Date.now()) - session.startedAt,
        )
      : "0ms";

    const outputContentWidth = getPaddedContentWidth(safeWidth);
    const renderedOutputLines = this.renderOutputLines(outputView.output, outputContentWidth);
    this.lastRenderedOutputLineCount = renderedOutputLines.length;

    const maxVisible = this.getMaxVisibleOutputLines(Boolean(session?.taskId));
    const noticeLineCount = outputView.noticeLines.length > 0
      ? outputView.noticeLines.flatMap((line) => wrapTextWithAnsi(line, outputContentWidth)).length + 1
      : 0;
    const maxVisibleOutputLines = Math.max(1, maxVisible - noticeLineCount);
    this.clampScroll(renderedOutputLines.length, maxVisibleOutputLines);

    const visible = renderedOutputLines.slice(
      this.scrollOffset,
      this.scrollOffset + maxVisibleOutputLines,
    );
    const visibleEnd = this.scrollOffset + visible.length;

    const statusText =
      session?.status === "running"
        ? `${getCircularSpinnerFrame()} Executing...`
        : statusDisplay.label;

    lines.push(
      `${this.theme.fg(statusDisplay.color, statusText)} ${this.theme.fg("dim", runtime)} ${session ? this.theme.fg("dim", `#${session.id.slice(0, 8)} • ${session.agent}`) : ""}`,
    );

    lines.push("");

    for (const noticeLine of outputView.noticeLines) {
      const wrappedNotice = wrapTextWithAnsi(noticeLine, outputContentWidth);
      for (const wrappedLine of wrappedNotice) {
        lines.push(this.theme.fg("warning", wrappedLine));
      }
      lines.push("");
    }

    if (visible.length === 0) {
      lines.push(this.theme.fg("dim", "(no output)"));
    } else {
      for (const outputLine of visible) {
        lines.push(outputLine);
      }
    }

    lines.push("");

    const startLine =
      renderedOutputLines.length === 0 ? 0 : this.scrollOffset + 1;
    const endLine = renderedOutputLines.length === 0 ? 0 : visibleEnd;
    lines.push(
      this.theme.fg("dim", `Lines ${startLine}-${endLine} / ${renderedOutputLines.length}`),
    );

    const rowCount = lines.length;
    return lines.map((line, row) =>
      fitPaddedLine(
        line,
        safeWidth,
        resolveScrollbarChar({
          row,
          rowCount,
          totalLines: renderedOutputLines.length,
          visibleLines: maxVisibleOutputLines,
          offset: this.scrollOffset,
        }),
      ),
    );
  }

  invalidate(): void {
    this.modal.invalidate();
  }
}
