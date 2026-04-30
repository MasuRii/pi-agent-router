import assert from "node:assert/strict";

import { renderSubagentWidgetLines } from "../subagent/subagent-widget-renderer";

const widgetIcons = {
  running: "",
  queued: "",
} as const;

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("renderSubagentWidgetLines shows aggregate progress with live running and queued details", () => {
  const now = 24_000;
  const line = renderSubagentWidgetLines({
    sessions: [
      {
        id: "63db3446-1111-2222-3333-444444444444",
        agent: "code",
        status: "running",
        startedAt: 0,
      },
      {
        id: "b8c831fd-1111-2222-3333-444444444444",
        agent: "ask",
        status: "queued",
        startedAt: 0,
      },
      {
        id: "a7a720ec-1111-2222-3333-444444444444",
        agent: "ui",
        status: "finished",
        startedAt: 0,
        finishedAt: 82_000,
      },
    ],
    width: 500,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: (status) => {
      if (status === "running") {
        return { label: "Running", color: "warning" as const };
      }

      if (status === "queued") {
        return { label: "Queued", color: "warning" as const };
      }

      return { label: "Completed", color: "success" as const };
    },
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes(" 1/3"), true);
  assert.equal(line[0].includes("▰ ▱ ▱"), true);
  assert.equal(line[0].includes("◜ code 24s"), true);
  assert.equal(line[0].includes("ask"), false);
  assert.equal(line[0].includes("63db3446"), false);
  assert.equal(line[0].includes("b8c831fd"), false);
  assert.equal(line[0].includes("a7a720ec"), false);
  assert.equal(line[0].includes(" | "), false);
  assert.equal(line[0].includes(" │ "), true);
  assert.equal(line[0].includes(" · "), false);
});

runTest("renderSubagentWidgetLines uses available width before collapsing running details", () => {
  const now = 24_000;
  const line = renderSubagentWidgetLines({
    sessions: [
      { id: "11111111-aaaa", agent: "alpha", status: "running", startedAt: 0 },
      { id: "22222222-bbbb", agent: "beta", status: "running", startedAt: 0 },
      { id: "33333333-cccc", agent: "gamma", status: "running", startedAt: 0 },
    ],
    width: 120,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Running", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("◜ alpha 24s"), true);
  assert.equal(line[0].includes("◜ beta 24s"), true);
  assert.equal(line[0].includes("◜ gamma 24s"), true);
  assert.equal(line[0].includes("+1 more"), false);
});

runTest("renderSubagentWidgetLines keeps all-success sessions on the geometric track", () => {
  const line = renderSubagentWidgetLines({
    sessions: [
      { id: "11111111-aaaa", agent: "a", status: "finished", startedAt: 0, finishedAt: 1_000 },
      { id: "22222222-bbbb", agent: "b", status: "finished", startedAt: 0, finishedAt: 2_000 },
      { id: "33333333-cccc", agent: "c", status: "finished", startedAt: 0, finishedAt: 3_000 },
    ],
    width: 500,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Completed", color: "success" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 5_000,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("✓ 3/3"), true);
  assert.equal(line[0].includes("▰ ▰ ▰"), true);
  assert.equal(line[0].includes("completed successfully"), true);
  assert.equal(line[0].includes("(3s)"), true);
  assert.equal(line[0].includes("11111111"), false);
  assert.equal(line[0].includes("more sessions"), false);
});

runTest("renderSubagentWidgetLines summarizes mixed terminal outcomes without pill clutter", () => {
  const line = renderSubagentWidgetLines({
    sessions: [
      { id: "11111111-aaaa", agent: "ask", status: "finished", startedAt: 0, finishedAt: 1_000 },
      { id: "22222222-bbbb", agent: "ui", status: "failed", startedAt: 0, finishedAt: 2_000 },
      { id: "33333333-cccc", agent: "security", status: "aborted", startedAt: 0, finishedAt: 3_000 },
    ],
    width: 500,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: (status) => {
      if (status === "aborted") {
        return { label: "Aborted", color: "warning" as const };
      }

      if (status === "failed") {
        return { label: "Failed", color: "error" as const };
      }

      return { label: "Completed", color: "success" as const };
    },
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 5_000,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes(" 1/3"), true);
  assert.equal(line[0].includes("▰ ▱ ▱"), true);
  assert.equal(line[0].includes("✕"), false);
  assert.equal(line[0].includes(" 2 failed"), true);
  assert.equal(line[0].includes("in progress"), false);
  assert.equal(line[0].includes("more sessions"), false);
});

runTest("renderSubagentWidgetLines uses compact track spacing on narrow widths", () => {
  const line = renderSubagentWidgetLines({
    sessions: [
      { id: "11111111-aaaa", agent: "done", status: "finished", startedAt: 0, finishedAt: 1_000 },
      { id: "22222222-bbbb", agent: "code", status: "running", startedAt: 0 },
      { id: "33333333-cccc", agent: "test", status: "queued", startedAt: 0 },
    ],
    width: 50,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Running", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 0,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("▰▱▱"), true);
  assert.equal(line[0].includes("▰ ▰"), false);
});

runTest("renderSubagentWidgetLines keeps aggregate status on narrow widths", () => {
  const line = renderSubagentWidgetLines({
    sessions: [
      { id: "11111111-aaaa", agent: "a", status: "finished", startedAt: 0, finishedAt: 1_000 },
      { id: "22222222-bbbb", agent: "b", status: "finished", startedAt: 0, finishedAt: 2_000 },
      { id: "33333333-cccc", agent: "c", status: "finished", startedAt: 0, finishedAt: 3_000 },
      { id: "44444444-dddd", agent: "d", status: "finished", startedAt: 0, finishedAt: 4_000 },
    ],
    width: 20,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Completed", color: "success" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 8_000,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("✓"), true);
  assert.equal(line[0].includes("more sessions"), false);
  assert.equal(line[0].includes("11111111"), false);
  assert.equal(line[0].includes("COMPLETED"), false);
});

runTest("renderSubagentWidgetLines pulses the first active track segment", () => {
  const createLine = (now: number): string => renderSubagentWidgetLines({
    sessions: [
      { id: "11111111-aaaa", agent: "done", status: "finished", startedAt: 0, finishedAt: 1_000 },
      { id: "22222222-bbbb", agent: "code", status: "running", startedAt: 0 },
    ],
    width: 500,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Running", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now,
    icons: widgetIcons,
  })[0] || "";

  assert.equal(createLine(0).includes("▰ ▱"), true);
  assert.equal(createLine(500).includes("▰ _"), true);
});

runTest("renderSubagentWidgetLines animates running spinner frames", () => {
  const createLine = (now: number): string => renderSubagentWidgetLines({
    sessions: [
      {
        id: "63db3446-1111-2222-3333-444444444444",
        agent: "code",
        status: "running",
        startedAt: 0,
      },
    ],
    width: 500,
    theme: {
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Running", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now,
    icons: widgetIcons,
  })[0] || "";

  assert.equal(createLine(0).includes("◜ code"), true);
  assert.equal(createLine(80).includes("◠ code"), true);
});

runTest("renderSubagentWidgetLines applies configured frontmatter agent colors", () => {
  const line = renderSubagentWidgetLines({
    sessions: [
      {
        id: "63db3446-1111-2222-3333-444444444444",
        agent: "code",
        agentColor: "#4A90E2",
        status: "running",
        startedAt: 0,
      },
    ],
    width: 500,
    theme: {
      fg: (color, text) => `<${color}>${text}</${color}>`,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Running", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 42_000,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("<dim>▱</dim>"), true);
  assert.equal(line[0].includes("code"), true);
  assert.equal(line[0].includes("\u001b[1;38;5;"), true);
  assert.equal(line[0].includes("<toolOutput>code</toolOutput>"), false);
  assert.equal(line[0].includes("63db3446"), false);
});

runTest("renderSubagentWidgetLines keeps theme styling when agent colors are invalid", () => {
  const line = renderSubagentWidgetLines({
    sessions: [
      {
        id: "63db3446-1111-2222-3333-444444444444",
        agent: "code",
        agentColor: "not-a-color",
        status: "running",
        startedAt: 0,
      },
    ],
    width: 500,
    theme: {
      fg: (color, text) => `<${color}>${text}</${color}>`,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "Running", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 42_000,
    icons: widgetIcons,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("<toolTitle>◞</toolTitle>"), true);
  assert.equal(line[0].includes("<toolOutput>code</toolOutput>"), true);
  assert.equal(line[0].includes("\u001b[38;5;"), false);
});

console.log("All UI utility tests passed.");
