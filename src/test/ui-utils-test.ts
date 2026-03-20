import assert from "node:assert/strict";

import { getCircularSpinnerFrame } from "../progress-spinner";
import { renderSubagentWidgetLines } from "../subagent/subagent-widget-renderer";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("renderSubagentWidgetLines shows aggregate progress with live running details", () => {
  const now = 24_000;
  const spinnerFrame = getCircularSpinnerFrame(now);
  const line = renderSubagentWidgetLines({
    sessions: [
      {
        id: "63db3446-1111-2222-3333-444444444444",
        agent: "code",
        status: "running",
        startedAt: 0,
      },
      {
        id: "a7a720ec-1111-2222-3333-444444444444",
        agent: "ask",
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
        return { label: "⏳ Executing...", color: "warning" as const };
      }

      return { label: "✓ COMPLETED", color: "success" as const };
    },
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes(`${spinnerFrame} 1 running`), true);
  assert.equal(line[0].includes("✓ 1 completed"), true);
  assert.equal(line[0].includes(`${spinnerFrame} code 24s`), true);
  assert.equal(line[0].includes("63db3446"), false);
  assert.equal(line[0].includes("a7a720ec"), false);
  assert.equal(line[0].includes("COMPLETED"), false);
  assert.equal(line[0].includes(" | "), false);
  assert.equal(line[0].includes(" · "), true);
});

runTest("renderSubagentWidgetLines uses available width before collapsing running details", () => {
  const now = 24_000;
  const spinnerFrame = getCircularSpinnerFrame(now);
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
    getStatusDisplay: () => ({ label: "⏳ Executing...", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes(`${spinnerFrame} alpha 24s`), true);
  assert.equal(line[0].includes(`${spinnerFrame} beta 24s`), true);
  assert.equal(line[0].includes(`${spinnerFrame} gamma 24s`), true);
  assert.equal(line[0].includes("+1 more"), false);
});

runTest("renderSubagentWidgetLines collapses all-success sessions into a single summary", () => {
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
    getStatusDisplay: () => ({ label: "✓ COMPLETED", color: "success" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 5_000,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("All 3 agents completed successfully"), true);
  assert.equal(line[0].includes("3s"), true);
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
        return { label: "✗ ABORTED", color: "warning" as const };
      }

      if (status === "failed") {
        return { label: "✗ FAILED", color: "error" as const };
      }

      return { label: "✓ COMPLETED", color: "success" as const };
    },
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 5_000,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("✓ 1 completed"), true);
  assert.equal(line[0].includes("✗ 1 failed (ui)"), true);
  assert.equal(line[0].includes("! 1 aborted (security)"), true);
  assert.equal(line[0].includes("in progress"), false);
  assert.equal(line[0].includes("more sessions"), false);
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
    getStatusDisplay: () => ({ label: "✓ COMPLETED", color: "success" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 8_000,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("✓"), true);
  assert.equal(line[0].includes("more sessions"), false);
  assert.equal(line[0].includes("11111111"), false);
  assert.equal(line[0].includes("COMPLETED"), false);
});

runTest("renderSubagentWidgetLines retains bright custom agent colors without background blocks", () => {
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
      fg: (_color, text) => text,
    },
    formatDuration: (milliseconds) => `${Math.round(milliseconds / 1000)}s`,
    getStatusDisplay: () => ({ label: "⏳ Executing...", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 42_000,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("\u001b[1;38;5;"), true);
  assert.equal(line[0].includes("\u001b[48;"), false);
  assert.equal(line[0].includes("63db3446"), false);
});

runTest("renderSubagentWidgetLines falls back to status styling for invalid agent colors", () => {
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
    getStatusDisplay: () => ({ label: "⏳ Executing...", color: "warning" as const }),
    truncate: (text, width, marker) =>
      text.length > width ? `${text.slice(0, Math.max(0, width - marker.length))}${marker}` : text,
    now: 42_000,
  });

  assert.equal(line.length, 1);
  assert.equal(line[0].includes("<warning>code</warning>"), true);
  assert.equal(line[0].includes("\u001b[38;5;"), false);
});

console.log("All UI utility tests passed.");
