import assert from "node:assert/strict";

import { recoverTaskSummaryReferencesFromSessionEntries } from "../task/task-session-history";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function toolResultTextEntry(text: string): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      content: [{ type: "text", text }],
    },
  };
}

runTest("recoverTaskSummaryReferencesFromSessionEntries decodes XML text and attributes", () => {
  const references = recoverTaskSummaryReferencesFromSessionEntries([
    toolResultTextEntry(`
<task-summary>
  <task id="Task&quot;A">
    <session>session-&#49;</session>
    <status>success</status>
    <result>Use &lt;tag&gt; &#65; &#x42; &apos;quote&apos; &amp; continue</result>
  </task>
</task-summary>`),
  ]);

  assert.deepEqual(references, [
    {
      id: "Task\"A",
      sessionId: "session-1",
      status: "finished",
      outputText: "Use <tag> A B 'quote' & continue",
    },
  ]);
});

runTest("recoverTaskSummaryReferencesFromSessionEntries leaves invalid numeric XML entities literal", () => {
  const references = recoverTaskSummaryReferencesFromSessionEntries([
    toolResultTextEntry(`
<task-summary>
  <task id="InvalidNumeric">
    <session>session-2</session>
    <status>finished</status>
    <result>Keep &#999999999999999999999999; &#x110000; &#xZ; &#; &#12oops; literal</result>
  </task>
</task-summary>`),
  ]);

  assert.deepEqual(references, [
    {
      id: "InvalidNumeric",
      sessionId: "session-2",
      status: "finished",
      outputText: "Keep &#999999999999999999999999; &#x110000; &#xZ; &#; &#12oops; literal",
    },
  ]);
});

runTest("recoverTaskSummaryReferencesFromSessionEntries normalizes statuses", () => {
  const references = recoverTaskSummaryReferencesFromSessionEntries([
    toolResultTextEntry(`
<task-summary>
  <task id="Complete"><status>complete</status><result>done</result></task>
  <task id="Timed"><status>timed out</status><result>late</result></task>
  <task id="Unknown"><status>mystery</status><result>bad</result></task>
</task-summary>`),
  ]);

  assert.deepEqual(
    references.map((reference) => [reference.id, reference.status]),
    [
      ["Complete", "finished"],
      ["Timed", "timed_out"],
      ["Unknown", "failed"],
    ],
  );
});

runTest("recoverTaskSummaryReferencesFromSessionEntries deduplicates by task and session", () => {
  const references = recoverTaskSummaryReferencesFromSessionEntries([
    toolResultTextEntry(`
<task-summary>
  <task id="TaskA"><session>session-1</session><status>failed</status><result>old</result></task>
  <task id="taska"><session>session-1</session><status>finished</status><result>new</result></task>
  <task id="TaskA"><session>session-2</session><status>finished</status><result>other</result></task>
</task-summary>`),
  ]);

  assert.deepEqual(references, [
    { id: "taska", sessionId: "session-1", status: "finished", outputText: "new" },
    { id: "TaskA", sessionId: "session-2", status: "finished", outputText: "other" },
  ]);
});

runTest("recoverTaskSummaryReferencesFromSessionEntries omits no-output results", () => {
  const references = recoverTaskSummaryReferencesFromSessionEntries([
    toolResultTextEntry(`
<task-summary>
  <task id="TaskA"><session>session-1</session><status>finished</status><result>(no output)</result></task>
</task-summary>`),
  ]);

  assert.deepEqual(references, [
    { id: "TaskA", sessionId: "session-1", status: "finished", outputText: undefined },
  ]);
});

runTest("recoverTaskSummaryReferencesFromSessionEntries skips malformed and non-text content", () => {
  const references = recoverTaskSummaryReferencesFromSessionEntries([
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ignored" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "image", text: "ignored" }] } },
    toolResultTextEntry(`<task-summary><task><status>finished</status><result>missing id</result></task>`),
    toolResultTextEntry(`<task-summary><task id="Valid"><status>finished</status><result>ok</result></task></task-summary>`),
  ]);

  assert.deepEqual(references, [
    { id: "Valid", sessionId: undefined, status: "finished", outputText: "ok" },
  ]);
});

runTest("recoverTaskSummaryReferencesFromSessionEntries keeps retry/context-relevant safe shape", () => {
  const references = recoverTaskSummaryReferencesFromSessionEntries([
    toolResultTextEntry(`
<task-summary>
  <task id="ContextTask"><session>../unsafe</session><status>running</status><result>live</result></task>
  <task id="RetryTask"><session>session-3</session><status>killed</status><result>retryable text</result></task>
</task-summary>`),
  ]);

  assert.deepEqual(references, [
    { id: "ContextTask", sessionId: undefined, status: "running", outputText: "live" },
    { id: "RetryTask", sessionId: "session-3", status: "killed", outputText: "retryable text" },
  ]);
});

console.log("All task session history tests passed.");
