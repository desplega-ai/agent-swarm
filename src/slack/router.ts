import { getAgentById, getAgentWorkingOnThread, getAllAgents } from "../be/db";
import { isAgentReachable } from "../be/runtime-pools/reachability";
import type { Agent } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";
import type { AgentMatch } from "./types";

export interface ThreadContext {
  channelId: string;
  threadTs: string;
}

/**
 * Returns true if the text contains a `<@U...>` mention of anyone other than our bot.
 * Exported for testing.
 */
export function hasOtherUserMention(text: string, botUserId: string): boolean {
  const mentions = text.match(/<@([A-Z0-9]+)>/g) ?? [];
  return mentions.some((m) => m !== `<@${botUserId}>`);
}

/**
 * Returns true if a thread message mentions another user, so it is addressed to
 * that user and not to the swarm. `SLACK_THREAD_WAKE_ON_ANY_MESSAGE=true` turns
 * this guard off: the swarm then wakes on every thread message. Callers combine
 * the result with `!botMentioned`.
 */
export function isAddressedToOtherUser(text: string, botUserId: string): boolean {
  if (isEnvFlagEnabled("SLACK_THREAD_WAKE_ON_ANY_MESSAGE", false)) return false;
  return hasOtherUserMention(text, botUserId);
}

/**
 * Build the matches for an explicit swarm#all broadcast.
 */
export function broadcastMatches(agents: Agent[]): AgentMatch[] {
  return agents
    .filter((agent) => !agent.isLead)
    .map((agent) => ({ agent, matchedText: "swarm#all" }));
}

/**
 * Routes a Slack message to the appropriate agent(s) based on mentions.
 *
 * Routing rules:
 * - `swarm#<uuid>` → exact agent by ID
 * - `swarm#all` → all non-lead agents
 * - Everything else → lead agent
 */
export async function routeMessage(
  text: string,
  botUserId: string,
  botMentioned: boolean,
  threadContext?: ThreadContext,
): Promise<AgentMatch[]> {
  const matches: AgentMatch[] = [];
  const requireMentionForThreadFollowup = isEnvFlagEnabled(
    "SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION",
    false,
  );
  const allAgents = await getAllAgents();
  const reachable = await Promise.all(allAgents.map((agent) => isAgentReachable(agent)));
  const agents = allAgents.filter((_, index) => reachable[index]);

  // Check for explicit swarm#<id> syntax
  const idMatches = text.matchAll(/swarm#([a-f0-9-]{36})/gi);
  for (const match of idMatches) {
    const agentId = match[1];
    if (!agentId) continue;
    const agent = await getAgentById(agentId);
    if (agent && (await isAgentReachable(agent))) {
      matches.push({ agent, matchedText: match[0] });
    }
  }

  // Check for swarm#all broadcast
  if (/swarm#all/i.test(text)) {
    for (const broadcastMatch of broadcastMatches(agents)) {
      const agent = broadcastMatch.agent;
      if (!matches.some((m) => m.agent.id === agent.id)) {
        matches.push(broadcastMatch);
      }
    }
  }

  // Thread follow-up — route to agent already working in this thread.
  // Skip if the message @-mentions someone other than our bot (e.g. "@Devin wdyt?")
  // and does not mention our bot: that message is directed at a different bot/user,
  // not a follow-up intended for the swarm (unless SLACK_THREAD_WAKE_ON_ANY_MESSAGE).
  if (matches.length === 0 && threadContext && (!requireMentionForThreadFollowup || botMentioned)) {
    if (!botMentioned && isAddressedToOtherUser(text, botUserId)) {
      console.log(
        `[Slack] Skipping thread follow-up in ${threadContext.channelId}/${threadContext.threadTs}: message mentions another user`,
      );
      return matches;
    }
    const workingAgent = await getAgentWorkingOnThread(
      threadContext.channelId,
      threadContext.threadTs,
    );
    if (workingAgent && (await isAgentReachable(workingAgent))) {
      console.log(
        `[Slack] Thread follow-up: routing to agent ${workingAgent.name} (${workingAgent.id}) in thread ${threadContext.threadTs}`,
      );
      matches.push({ agent: workingAgent, matchedText: "thread follow-up" });
    } else if (workingAgent) {
      // Agent is offline but thread has history — route to lead without requiring @mention
      console.log(
        `[Slack] Thread follow-up: agent ${workingAgent.name} is offline, routing to lead`,
      );
      const lead = agents.find((a) => a.isLead);
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
  const botMention = new RegExp(`<@${botUserId}>`, "g");
  return (
    text
      .split("\n")
      // Remove bot mentions, except in pasted table rows (`| a | b |`): a cell
      // that names the bot is content, left for rewriteSlackMentions.
      .map((line) => (line.startsWith("|") ? line : line.replace(botMention, "")))
      .join("\n")
      .replace(/swarm#[a-f0-9-]{36}/gi, "") // Remove swarm#<id>
      .replace(/swarm#all/gi, "") // Remove swarm#all
      .trim()
  );
}
