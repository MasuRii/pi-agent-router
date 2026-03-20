/**
 * Active-agent prompt composition helpers.
 *
 * Ensures only one active-agent identity layer is present in the final system
 * prompt so agent switching replaces prior role instructions instead of
 * layering conflicting personas.
 */

import type { Agent } from "../types";

export type ActiveAgentInteractionMode = "direct" | "delegated";

export type BuildActiveAgentPromptOptions = {
  interactionMode?: ActiveAgentInteractionMode;
};

const ACTIVE_AGENT_BLOCK_REGEX =
  /\n?<active_agent\s+name=["'][^"']+["'][^>]*>[\s\S]*?<\/active_agent>\n?/gi;
const ACTIVE_AGENT_IDENTITY_BLOCK_REGEX =
  /\n?<active_agent_identity\b[^>]*>[\s\S]*?<\/active_agent_identity>\n?/gi;
export const ACTIVE_AGENT_FOLLOWUP_LINE =
  "You MUST follow the active_agent instructions for this turn.";

const GENERIC_BASE_IDENTITY_PATTERNS = [
  /^You are an AI assistant accessed via an API\.?$/i,
  /^You are an expert coding assistant operating inside pi(?:,\s*a coding agent harness\.)?$/i,
  /^You are an expert coding assistant operating inside pi\b.*$/i,
];

const LEADING_EMOJI_PATTERN =
  /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]\s*)+/u;

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\r\n/g, "\n");
}

function collapseExtraBlankLines(prompt: string): string {
  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeIdentityDescription(description: string, agentName: string): string {
  const normalizedDescription = normalizePrompt(description || "")
    .replace(/\s+/g, " ")
    .trim();
  const withoutLeadingEmoji = normalizedDescription.replace(
    LEADING_EMOJI_PATTERN,
    "",
  ).trim();

  return withoutLeadingEmoji || `Agent ${agentName}`;
}

function shouldStripGenericBaseIdentityLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  return GENERIC_BASE_IDENTITY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function stripActiveAgentPromptLayers(systemPrompt: string): string {
  const normalizedPrompt = normalizePrompt(systemPrompt || "");
  const withoutIdentityEnvelope = normalizedPrompt.replace(
    ACTIVE_AGENT_IDENTITY_BLOCK_REGEX,
    "\n",
  );
  const withoutAgentBlocks = withoutIdentityEnvelope.replace(
    ACTIVE_AGENT_BLOCK_REGEX,
    "\n",
  );
  const filteredLines = withoutAgentBlocks
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== ACTIVE_AGENT_FOLLOWUP_LINE &&
        !shouldStripGenericBaseIdentityLine(line),
    );

  return collapseExtraBlankLines(filteredLines.join("\n"));
}

export function buildActiveAgentIdentityEnvelope(
  agent: Pick<Agent, "name" | "description" | "systemPrompt">,
  options: BuildActiveAgentPromptOptions = {},
): string {
  const interactionMode = options.interactionMode || "direct";
  const roleSummary = normalizeIdentityDescription(agent.description, agent.name);
  const modeInstruction =
    interactionMode === "delegated"
      ? `This is delegated subagent execution inside pi. Maintain the ${agent.name} agent identity while following the delegated task instructions and the full active_agent workflow rules for substantive work.`
      : `In direct conversations, if the user asks who you are, what your role is, or what your purpose is, answer directly as the ${agent.name} agent operating inside pi and do not trigger heavy workflow preflight, repository inspection, or tool use unless the user also requested substantive work.`;

  return [
    `<active_agent_identity name="${agent.name}" mode="${interactionMode}">`,
    "You are operating inside pi.",
    `The selected active agent identity is "${agent.name}".`,
    `Role summary: ${roleSummary}`,
    `When the user asks about your identity, role, or purpose, answer as the ${agent.name} agent operating inside pi rather than as a generic base assistant.`,
    modeInstruction,
    "</active_agent_identity>",
    `<active_agent name="${agent.name}">`,
    agent.systemPrompt.trim(),
    "</active_agent>",
    ACTIVE_AGENT_FOLLOWUP_LINE,
  ].join("\n");
}

export function buildSystemPromptForActiveAgent(
  baseSystemPrompt: string,
  agent: Pick<Agent, "name" | "description" | "systemPrompt">,
  options: BuildActiveAgentPromptOptions = {},
): string {
  const sanitizedBasePrompt = stripActiveAgentPromptLayers(baseSystemPrompt);
  const activeAgentBlock = buildActiveAgentIdentityEnvelope(agent, options);

  if (!sanitizedBasePrompt) {
    return activeAgentBlock;
  }

  return [sanitizedBasePrompt, "", activeAgentBlock].join("\n");
}
