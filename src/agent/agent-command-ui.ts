/**
 * Agent command UI helpers.
 *
 * Keeps /agent selection rendering and non-interactive summaries modular.
 */

import { getCyclablePrimaryAgents, isPrimaryAgent } from "./agent-discovery";
import type { Agent, AgentMode } from "../types";

const DISABLED_AGENT_LABEL = "Off [disabled] — disable active agent mode";

export type AgentSelectionMenu = {
  labels: string[];
  valueByLabel: Map<string, string | null>;
};

function truncateDescription(description: string, maxLength = 72): string {
  const normalized = description.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function resolveDisplayMode(agent: Agent): AgentMode | "primary" {
  if (agent.mode === "primary" || agent.mode === "subagent" || agent.mode === "all") {
    return agent.mode;
  }

  return isPrimaryAgent(agent) ? "primary" : "subagent";
}

function formatModeBadge(agent: Agent): string {
  const displayMode = resolveDisplayMode(agent);
  if (displayMode === "all") {
    return "[all]";
  }

  return `[${displayMode}]`;
}

function formatCurrentMarker(
  activeAgentName: string | null,
  candidateAgentName: string | null,
): string {
  return activeAgentName === candidateAgentName ? "●" : "○";
}

function formatAgentOptionLabel(
  agent: Agent,
  activeAgentName: string | null,
): string {
  return [
    formatCurrentMarker(activeAgentName, agent.name),
    agent.name,
    formatModeBadge(agent),
    "—",
    truncateDescription(agent.description),
  ].join(" ");
}

export function buildAgentSelectionMenu(
  agents: readonly Agent[],
  activeAgentName: string | null,
): AgentSelectionMenu {
  const labels: string[] = [];
  const valueByLabel = new Map<string, string | null>();

  const disabledLabel = `${formatCurrentMarker(activeAgentName, null)} ${DISABLED_AGENT_LABEL}`;
  labels.push(disabledLabel);
  valueByLabel.set(disabledLabel, null);

  for (const agent of agents) {
    const label = formatAgentOptionLabel(agent, activeAgentName);
    labels.push(label);
    valueByLabel.set(label, agent.name);
  }

  return {
    labels,
    valueByLabel,
  };
}

export function buildAgentListSummary(
  agents: readonly Agent[],
  activeAgentName: string | null,
): string {
  const current = activeAgentName || "none";
  const agentLines = agents.length
    ? agents.map((agent) => {
      const marker = activeAgentName === agent.name ? "*" : "-";
      return `${marker} ${agent.name} ${formatModeBadge(agent)}`;
    })
    : ["- (no agents found)"];

  const tabCyclePrimaries = getCyclablePrimaryAgents([...agents]);
  const tabCycleLine = tabCyclePrimaries.length
    ? tabCyclePrimaries.join(", ")
    : "(no primary agents found)";

  return [
    `Active: ${current}`,
    "Agents:",
    ...agentLines,
    `Tab-cycle primaries: ${tabCycleLine}`,
  ].join("\n");
}
