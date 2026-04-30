import { Container, Spacer, Text } from "@mariozechner/pi-tui";

import { INLINE_OPEN_BOX_TARGET_WIDTH } from "../constants";
import { getBrailleSpinnerFrame } from "../progress-spinner";

import {
  colorizeWithHex,
  getTaskStatusTone,
  normalizeHexColor,
} from "./task-display-formatting";
import { buildWrappedPrefixedLines } from "../text-formatting";

export type TaskDisplayTheme = {
  fg(color: string, text: string): string;
  bold?: (text: string) => string;
};

type TaskBlockOptions = {
  title: string;
  description: string;
  activity: string;
  status: string;
  detailLines?: readonly string[];
  footerLine?: string;
  hint?: string;
  spinner?: boolean;
  includeSpacer?: boolean;
  borderColorHex?: string;
  titleColorHex?: string;
};

const TASK_BLOCK_BORDER = "▌";
const TASK_BLOCK_TARGET_WIDTH = Math.max(56, INLINE_OPEN_BOX_TARGET_WIDTH);
const TASK_ACTIVITY_MAX_LINES = 4;
const TASK_DETAIL_MAX_LINES = 4;

function normalizeDisplayText(value: string): string {
  const normalized = value.trim();
  return normalized || "(none)";
}

function styleWithOptionalHex(
  theme: TaskDisplayTheme,
  text: string,
  semanticColor: string,
  hexColor: string | undefined,
  options: { strong?: boolean } = {},
): string {
  const normalizedHex = normalizeHexColor(hexColor);
  if (normalizedHex) {
    return colorizeWithHex(text, normalizedHex, { bold: Boolean(options.strong) });
  }

  const strongText = options.strong && typeof theme.bold === "function"
    ? theme.bold(text)
    : text;
  return theme.fg(semanticColor, strongText);
}

function buildBorderLineText(
  theme: TaskDisplayTheme,
  text: string,
  color: string,
  options: {
    borderColorHex?: string;
    textColorHex?: string;
    strongBorder?: boolean;
    strongText?: boolean;
    firstPrefix?: string;
    continuationPrefix?: string;
    maxLines?: number;
  } = {},
): string {
  const border = styleWithOptionalHex(
    theme,
    TASK_BLOCK_BORDER,
    "accent",
    options.borderColorHex,
    { strong: options.strongBorder ?? true },
  );

  const firstPrefix = options.firstPrefix || "";
  const continuationPrefix =
    options.continuationPrefix ?? (firstPrefix ? " ".repeat(firstPrefix.length) : "");

  const wrappedContentLines = buildWrappedPrefixedLines({
    firstPrefix,
    continuationPrefix,
    text,
    targetWidth: Math.max(24, TASK_BLOCK_TARGET_WIDTH - 2),
    maxLines: options.maxLines,
  });

  return wrappedContentLines.map((wrappedLine) => {
    const content = styleWithOptionalHex(
      theme,
      wrappedLine,
      color,
      options.textColorHex,
      { strong: options.strongText },
    );

    return `${border} ${content}`;
  }).join("\n");
}

class AnimatedTaskTitleLine {
  private readonly text = new Text("", 0, 0);

  constructor(
    private readonly theme: TaskDisplayTheme,
    private readonly title: string,
    private readonly color: string,
    private readonly options: {
      borderColorHex?: string;
      textColorHex?: string;
      strongText?: boolean;
    } = {},
  ) {}

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    this.text.setText(
      buildBorderLineText(this.theme, this.title, this.color, {
        borderColorHex: this.options.borderColorHex,
        textColorHex: this.options.textColorHex,
        strongText: this.options.strongText,
        firstPrefix: `${getBrailleSpinnerFrame()} `,
      }),
    );
    return this.text.render(width);
  }
}

function addBorderLine(
  container: Container,
  theme: TaskDisplayTheme,
  text: string,
  color: string,
  options: {
    borderColorHex?: string;
    textColorHex?: string;
    strongBorder?: boolean;
    strongText?: boolean;
    firstPrefix?: string;
    continuationPrefix?: string;
    maxLines?: number;
  } = {},
): void {
  container.addChild(
    new Text(
      buildBorderLineText(theme, text, color, options),
      0,
      0,
    ),
  );
}

function addVerticalSpace(container: Container, lines = 1): void {
  if (lines <= 0) {
    return;
  }

  container.addChild(new Spacer(lines));
}

export function appendTaskBlock(
  container: Container,
  theme: TaskDisplayTheme,
  options: TaskBlockOptions,
): void {
  if (options.includeSpacer) {
    addVerticalSpace(container, 1);
  }

  const title = normalizeDisplayText(options.title);
  const titleColor = options.spinner ? "warning" : "accent";

  if (options.spinner) {
    container.addChild(
      new AnimatedTaskTitleLine(theme, title, titleColor, {
        borderColorHex: options.borderColorHex,
        textColorHex: options.titleColorHex || options.borderColorHex,
        strongText: true,
      }),
    );
  } else {
    addBorderLine(container, theme, title, titleColor, {
      borderColorHex: options.borderColorHex,
      textColorHex: options.titleColorHex || options.borderColorHex,
      strongText: true,
      firstPrefix: "# ",
    });
  }

  addBorderLine(container, theme, normalizeDisplayText(options.description), "toolOutput", {
    borderColorHex: options.borderColorHex,
  });

  const activity = normalizeDisplayText(options.activity);
  addBorderLine(container, theme, activity, getTaskStatusTone(options.status), {
    borderColorHex: options.borderColorHex,
    firstPrefix: "└─ ",
    continuationPrefix: "   ",
    maxLines: TASK_ACTIVITY_MAX_LINES,
  });

  for (const line of options.detailLines || []) {
    const normalized = line.trimEnd();
    if (!normalized.trim()) {
      continue;
    }

    addBorderLine(container, theme, normalized, "dim", {
      borderColorHex: options.borderColorHex,
      maxLines: TASK_DETAIL_MAX_LINES,
    });
  }

  if (options.footerLine?.trim()) {
    addBorderLine(container, theme, options.footerLine.trim(), "dim", {
      borderColorHex: options.borderColorHex,
    });
  }

  if (options.hint?.trim()) {
    addBorderLine(container, theme, options.hint.trim(), "dim", {
      borderColorHex: options.borderColorHex,
    });
  }
}
