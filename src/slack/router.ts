import { getAgentById, getAllAgents } from "../be/db";
import type { AgentMatch } from "./types";

/**
 * Routes a Slack message to the appropriate agent(s) based on mentions.
 *
 * Routing rules:
 * - `swarm#<uuid>` → exact agent by ID
 * - `swarm#all` → all non-lead agents
 * - Everything else → lead agent
 */
export function routeMessage(
  text: string,
  _botUserId: string,
  botMentioned: boolean,
): AgentMatch[] {
  const matches: AgentMatch[] = [];
  const agents = getAllAgents().filter((a) => a.status !== "offline");

  // Check for explicit swarm#<id> syntax
  const idMatches = text.matchAll(/swarm#([a-f0-9-]{36})/gi);
  for (const match of idMatches) {
    const agentId = match[1];
    if (!agentId) continue;
    const agent = getAgentById(agentId);
    if (agent && agent.status !== "offline") {
      matches.push({ agent, matchedText: match[0] });
    }
  }

  // Check for swarm#all broadcast
  if (/swarm#all/i.test(text)) {
    const nonLeadAgents = agents.filter((a) => !a.isLead);
    for (const agent of nonLeadAgents) {
      if (!matches.some((m) => m.agent.id === agent.id)) {
        matches.push({ agent, matchedText: "swarm#all" });
      }
    }
  }

  // Default to lead for everything else
  if (matches.length === 0 && botMentioned) {
    const lead = agents.find((a) => a.isLead);
    if (lead) {
      matches.push({ agent: lead, matchedText: "@bot" });
    }
  }

  return matches;
}

/**
 * Extracts the task description from a message, removing bot mentions and agent references.
 */
export function extractTaskFromMessage(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}>`, "g"), "") // Remove bot mentions
    .replace(/swarm#[a-f0-9-]{36}/gi, "") // Remove swarm#<id>
    .replace(/swarm#all/gi, "") // Remove swarm#all
    .trim();
}
