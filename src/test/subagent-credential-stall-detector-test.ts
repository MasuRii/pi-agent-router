import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSubagentCredentialStallMonitor,
  detectSubagentCredentialStallSignal,
  type SubagentCredentialStallEvent,
} from "../subagent/credential-stall-detector";
import { processSubagentJsonEventLine } from "../subagent/subagent-output";
import { createSubagentJsonEventState } from "../subagent/subagent-usage";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function isProcessStillRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

type FakeChildResult = {
  closeCode: number | null;
  closeSignal: NodeJS.Signals | null;
  forcedFinalize: boolean;
  stalledEvent?: SubagentCredentialStallEvent;
  stdout: string;
  stderr: string;
  outputText: string;
  sessionPath?: string;
  durationMs: number;
};

function buildAssistantEvent(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    },
  });
}

function buildFakeChildScript(body: string): string {
  return `
const emitStdout = (value) => process.stdout.write(value + "\\n");
const emitStderr = (value) => process.stderr.write(value + "\\n");
const assistantEvent = (text) => JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  },
});
emitStdout(JSON.stringify({
  type: "session",
  id: "credential-stall-child",
  timestamp: "2026-05-23T00:00:00.000Z",
  cwd: process.cwd(),
}));
${body}
`;
}

async function runFakeChildWithCredentialStallMonitor(
  script: string,
  options: { thresholdMs: number; hardKillDelayMs: number; forcedFinalizeGraceMs: number },
): Promise<FakeChildResult> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agent-router-credential-stall-"));
  const startedAt = Date.now();
  const eventState = createSubagentJsonEventState({});
  let stdout = "";
  let stderr = "";
  let stdoutBuffer = "";
  let lastOutputText = "";
  let lastSessionPath: string | undefined;
  let stalledEvent: SubagentCredentialStallEvent | undefined;
  let forcedFinalize = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  let forcedFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  let proc: ChildProcess | undefined;

  try {
    return await new Promise<FakeChildResult>((resolve, reject) => {
      let completed = false;
      const monitor = createSubagentCredentialStallMonitor({
        enabled: true,
        thresholdMs: options.thresholdMs,
        onStall: (event) => {
          stalledEvent = event;
          stderr += `[pi-agent-router] Credential retry/cooldown stall detected: ${event.signal.matchedText}\n`;
          if (proc && isProcessStillRunning(proc)) {
            proc.kill("SIGTERM");
            hardKillTimer = setTimeout(() => {
              if (proc && isProcessStillRunning(proc)) {
                proc.kill("SIGKILL");
              }
            }, options.hardKillDelayMs);
          }
          forcedFinalizeTimer = setTimeout(() => {
            forcedFinalize = true;
            complete(proc?.exitCode ?? 1, proc?.signalCode ?? null);
          }, options.hardKillDelayMs + options.forcedFinalizeGraceMs);
        },
      });

      const clearTimers = (): void => {
        monitor.stop();
        if (hardKillTimer) clearTimeout(hardKillTimer);
        if (forcedFinalizeTimer) clearTimeout(forcedFinalizeTimer);
        if (guardTimer) clearTimeout(guardTimer);
      };

      const processStdoutLine = (line: string): void => {
        const beforeOutputText = eventState.outputText;
        const beforeSessionPath = eventState.sessionPath;
        processSubagentJsonEventLine(line, eventState);
        if (eventState.outputText !== beforeOutputText || eventState.sessionPath !== beforeSessionPath) {
          monitor.recordMeaningfulProgress();
          lastOutputText = eventState.outputText;
          lastSessionPath = eventState.sessionPath;
        }
      };

      const appendStdout = (piece: string): void => {
        stdout += piece;
        monitor.recordCredentialSignalText(piece);
        stdoutBuffer += piece;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          processStdoutLine(line);
        }
      };

      const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (completed) return;
        completed = true;
        clearTimers();
        if (stdoutBuffer.trim()) {
          processStdoutLine(stdoutBuffer);
          stdoutBuffer = "";
        }
        if (proc && isProcessStillRunning(proc)) {
          proc.kill("SIGKILL");
        }
        resolve({
          closeCode: code,
          closeSignal: signal,
          forcedFinalize,
          stalledEvent,
          stdout,
          stderr,
          outputText: lastOutputText,
          sessionPath: lastSessionPath,
          durationMs: Date.now() - startedAt,
        });
      };

      guardTimer = setTimeout(() => {
        clearTimers();
        if (proc && isProcessStillRunning(proc)) {
          proc.kill("SIGKILL");
        }
        reject(new Error("fake child credential stall test exceeded guard timeout"));
      }, 2_000);

      proc = spawn(process.execPath, ["-e", script], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      proc.stdout?.on("data", (chunk) => appendStdout(String(chunk)));
      proc.stderr?.on("data", (chunk) => {
        const piece = String(chunk);
        stderr += piece;
        monitor.recordCredentialSignalText(piece);
      });
      proc.on("error", reject);
      proc.on("close", (code, signal) => complete(code, signal));
    });
  } finally {
    if (proc && isProcessStillRunning(proc)) {
      proc.kill("SIGKILL");
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

await runTest("credential stall signal detector recognizes runtime credential stall vocabulary", () => {
  assert.equal(
    detectSubagentCredentialStallSignal("pi-multi-auth: credential cooldown active after quota exceeded; retry-after-ms: 600000")?.kind,
    "cooldown",
  );
  assert.equal(
    detectSubagentCredentialStallSignal("No eligible credentials available for openai-codex/gpt-5." )?.kind,
    "transient",
  );
  assert.equal(
    detectSubagentCredentialStallSignal("openai provider quota exceeded; retry-after-ms: 600000")?.kind,
    "cooldown",
  );
  assert.equal(detectSubagentCredentialStallSignal("ordinary delegated progress without provider errors"), undefined);
  assert.equal(detectSubagentCredentialStallSignal("negative cooldown edge case coverage report"), undefined);
  assert.equal(detectSubagentCredentialStallSignal("Quota/rate-limit branch is tested by this suite"), undefined);
  assert.equal(detectSubagentCredentialStallSignal("retry after 5 seconds in prose, not a runtime stall"), undefined);
});

await runTest("credential stall monitor uses meaningful progress to avoid false positives", () => {
  let nowMs = 0;
  const scheduled: Array<{ callback: () => void; delayMs: number; active: boolean }> = [];
  const stalledEvents: SubagentCredentialStallEvent[] = [];
  const monitor = createSubagentCredentialStallMonitor({
    enabled: true,
    thresholdMs: 100,
    now: () => nowMs,
    timers: {
      setTimeout: (callback, delayMs) => {
        const entry = { callback, delayMs, active: true };
        scheduled.push(entry);
        return entry as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle) => {
        (handle as unknown as { active: boolean }).active = false;
      },
    },
    onStall: (event) => stalledEvents.push(event),
  });

  monitor.recordMeaningfulProgress();
  nowMs = 10;
  monitor.recordCredentialSignalText("quota exceeded; retry-after-ms: 5000");
  nowMs = 90;
  monitor.recordMeaningfulProgress();
  for (const entry of [...scheduled]) {
    if (entry.active) entry.callback();
  }
  assert.equal(stalledEvents.length, 0);

  nowMs = 191;
  const lastScheduled = scheduled.at(-1);
  assert.ok(lastScheduled);
  if (lastScheduled.active) lastScheduled.callback();
  assert.equal(stalledEvents.length, 1);
  assert.equal(stalledEvents[0].stalledForMs, 101);
  monitor.stop();
});

await runTest("fake delegated child is terminated quickly after progress then credential cooldown stall", async () => {
  const result = await runFakeChildWithCredentialStallMonitor(
    buildFakeChildScript(`
emitStdout(assistantEvent("partial output before cooldown"));
setTimeout(() => emitStderr("pi-multi-auth credential cooldown: quota exceeded; retry-after-ms: 600000"), 5);
setInterval(() => {}, 1000);
`),
    { thresholdMs: 40, hardKillDelayMs: 10, forcedFinalizeGraceMs: 20 },
  );

  assert.ok(result.stalledEvent);
  assert.equal(result.stalledEvent?.signal.kind, "cooldown");
  assert.match(result.stderr, /Credential retry\/cooldown stall detected/);
  assert.match(result.outputText, /partial output before cooldown/);
  assert.ok(result.sessionPath?.includes("credential-stall-child"));
  assert.equal(result.durationMs < 1_000, true);
});

await runTest("fake delegated child is not terminated when normal progress continues after credential signal", async () => {
  const result = await runFakeChildWithCredentialStallMonitor(
    buildFakeChildScript(`
emitStdout(assistantEvent("initial progress"));
setTimeout(() => emitStderr("temporary provider rate limit; retry-after-ms: 25"), 5);
setTimeout(() => emitStdout(assistantEvent("continued progress after retry signal")), 25);
setTimeout(() => process.exit(0), 55);
`),
    { thresholdMs: 50, hardKillDelayMs: 10, forcedFinalizeGraceMs: 20 },
  );

  assert.equal(result.stalledEvent, undefined);
  assert.equal(result.closeCode, 0);
  assert.match(result.outputText, /continued progress after retry signal/);
});

console.log("All subagent credential stall detector tests passed.");
