import assert from "node:assert/strict";

import type { Message } from "@mariozechner/pi-ai";

import { formatModelReferenceForFooter, MODEL_FOOTER_ICON } from "../model-display";
import {
  BRAILLE_SPINNER_INTERVAL_MS,
  CIRCULAR_SPINNER_INTERVAL_MS,
  getBrailleSpinnerFrame,
  getCircularSpinnerFrame,
} from "../progress-spinner";
import {
  getLatestSubagentToolCallLabel,
  getSubagentLiveOutputFromMessages,
} from "../subagent/subagent-output";
import { buildWrappedPrefixedLines } from "../text-formatting";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

runTest("formatModelReferenceForFooter follows powerline style naming", () => {
  const label = formatModelReferenceForFooter("openai-codex/gpt-5.3-codex");
  assert.equal(label, "GPT-5.3 Codex (OpenAI)");
  assert.equal(MODEL_FOOTER_ICON.length > 0, true);
});

runTest("getBrailleSpinnerFrame cycles through braille frames", () => {
  const frameA = getBrailleSpinnerFrame(0);
  const frameB = getBrailleSpinnerFrame(BRAILLE_SPINNER_INTERVAL_MS);
  const frameC = getBrailleSpinnerFrame(BRAILLE_SPINNER_INTERVAL_MS * 2);

  assert.notEqual(frameA, frameB);
  assert.notEqual(frameB, frameC);
});

runTest("getCircularSpinnerFrame cycles through circular frames", () => {
  const frameA = getCircularSpinnerFrame(0);
  const frameB = getCircularSpinnerFrame(CIRCULAR_SPINNER_INTERVAL_MS);
  const frameC = getCircularSpinnerFrame(CIRCULAR_SPINNER_INTERVAL_MS * 2);

  assert.notEqual(frameA, frameB);
  assert.notEqual(frameB, frameC);
});

runTest("tool activity labels keep full grep invocation without hard truncation", () => {
  const pattern = "function CollapsibleRoot\\(|function CollapsibleTrigger\\(|function CollapsibleContent\\(|export const Collapsible = Object.assign";

  const messages: Message[] = [
    {
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "toolCall",
          name: "grep",
          arguments: {
            pattern,
            path: "src/components",
          },
        } as Message["content"][number],
      ],
    } as Message,
  ];

  const latest = getLatestSubagentToolCallLabel(messages);
  assert.equal(latest?.includes("…"), false);
  assert.equal(latest?.includes(pattern), true);

  const live = getSubagentLiveOutputFromMessages(messages);
  assert.equal(live.includes("…"), false);
  assert.equal(live.includes(pattern), true);
});

runTest("wrapped task activity previews clamp to four display lines", () => {
  const lines = buildWrappedPrefixedLines({
    firstPrefix: "└ ",
    continuationPrefix: "   ",
    text: "bash ".repeat(120),
    targetWidth: 32,
    maxLines: 4,
  });

  assert.equal(lines.length, 4);
  assert.equal(lines[0]?.startsWith("└ "), true);
  assert.equal(lines.slice(1).every((line) => line.startsWith("   ")), true);
  assert.equal(lines[3]?.endsWith("…"), true);
});

console.log("All display enhancement tests passed.");
