import { getAgentById, getAgentWorkingOnThread, getAllAgents } from "../be/db";
import type { AgentMatch } from "./types";

export interface ThreadContext {
  channelId: string;
  threadTs: string;
}

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
  threadContext?: ThreadContext,
): AgentMatch[] {
  const matches: AgentMatch[] = [];
  const requireMentionForThreadFollowup =
    process.env.SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION === "true";
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

  // Thread follow-up — route to agent already working in this thread
  if (matches.length === 0 && threadContext && (!requireMentionForThreadFollowup || botMentioned)) {
    const workingAgent = getAgentWorkingOnThread(threadContext.channelId, threadContext.threadTs);
    if (workingAgent && workingAgent.status !== "offline") {
      console.log(
        `[Slack] Thread follow-up: routing to agent ${workingAgent.name} (${workingAgent.id}) in thread ${threadContext.threadTs}`,
      );
      matches.push({ agent: workingAgent, matchedText: "thread follow-up" });
    } else if (workingAgent) {
      // Agent is offline but thread has history — route to lead without requiring @mention
      console.log(
        `[Slack] Thread follow-up: agent ${workingAgent.name} is offline, routing to lead`,
      );
      const allAgents = getAllAgents();
      const lead = allAgents.find((a) => a.isLead && a.status !== "offline");
      if (lead) {
        matches.push({ agent: lead, matchedText: "thread follow-up (lead fallback)" });
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
