import assert from "node:assert/strict";

import {
  buildActiveAgentIdentityEnvelope,
  buildSystemPromptForActiveAgent,
  stripActiveAgentPromptLayers,
} from "../agent/active-agent-prompt";
import { buildDelegatedActiveAgentIdentityExtensionSource } from "../agent/extension-sources";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

const gitAgent = {
  name: "git",
  description:
    "🐙 Expert Git Specialist with full context awareness that produces professional Git operations.",
  systemPrompt: "<role>\nYou are Git.\n</role>",
};

runTest("stripActiveAgentPromptLayers removes prior identity wrappers and generic base identity lines", () => {
  const prompt = [
    "You are an AI assistant accessed via an API.",
    "You are an expert coding assistant operating inside pi, a coding agent harness.",
    "<project_context>",
    "Keep this block.",
    "</project_context>",
    "<active_agent_identity name=\"code\" mode=\"direct\">",
    "Old identity",
    "</active_agent_identity>",
    "<active_agent name=\"code\">",
    "Old agent body",
    "</active_agent>",
    "You MUST follow the active_agent instructions for this turn.",
  ].join("\n");

  const stripped = stripActiveAgentPromptLayers(prompt);
  assert.equal(stripped.includes("AI assistant accessed via an API"), false);
  assert.equal(stripped.includes("expert coding assistant operating inside pi"), false);
  assert.equal(stripped.includes("<active_agent_identity"), false);
  assert.equal(stripped.includes("<active_agent name=\"code\""), false);
  assert.equal(stripped.includes("Keep this block."), true);
});

runTest("buildActiveAgentIdentityEnvelope uses normalized description and direct-mode guidance", () => {
  const envelope = buildActiveAgentIdentityEnvelope(gitAgent, {
    interactionMode: "direct",
  });

  assert.equal(envelope.includes("Role summary: Expert Git Specialist"), true);
  assert.equal(envelope.includes("do not trigger heavy workflow preflight"), true);
  assert.equal(envelope.includes('<active_agent name="git">'), true);
  assert.equal(envelope.includes("You are Git."), true);
});

runTest("buildSystemPromptForActiveAgent preserves unrelated context while injecting one canonical agent layer", () => {
  const basePrompt = [
    "You are an AI assistant accessed via an API.",
    "<policy>",
    "Preserve this.",
    "</policy>",
    '<active_agent name="code">old</active_agent>',
    "You MUST follow the active_agent instructions for this turn.",
  ].join("\n");

  const prompt = buildSystemPromptForActiveAgent(basePrompt, gitAgent, {
    interactionMode: "direct",
  });

  const activeAgentTagCount = (prompt.match(/<active_agent\s+name=/g) || []).length;
  assert.equal(activeAgentTagCount, 1);
  assert.equal(prompt.includes("Preserve this."), true);
  assert.equal(prompt.includes('The selected active agent identity is "git".'), true);
  assert.equal(prompt.includes("generic base assistant"), true);
});

runTest("buildSystemPromptForActiveAgent supports delegated mode semantics", () => {
  const prompt = buildSystemPromptForActiveAgent("", gitAgent, {
    interactionMode: "delegated",
  });

  assert.equal(prompt.includes("delegated subagent execution inside pi"), true);
  assert.equal(prompt.includes("heavy workflow preflight"), false);
});

runTest("buildDelegatedActiveAgentIdentityExtensionSource generates delegated identity runtime extension", () => {
  const source = buildDelegatedActiveAgentIdentityExtensionSource(gitAgent);

  assert.equal(source.includes("buildSystemPromptForActiveAgent"), true);
  assert.equal(source.includes('interactionMode: "delegated"'), true);
  assert.equal(source.includes('const delegatedAgent = {'), true);
  assert.equal(source.includes('"name": "git"'), true);
});

console.log("All active-agent prompt tests passed.");
