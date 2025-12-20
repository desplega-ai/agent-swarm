import { getAgentById, getAgentWorkingOnThread, getAllAgents } from "../be/db";
import type { AgentMatch } from "./types";

interface ThreadContext {
  channelId: string;
  threadTs: string;
}

// Common 3-letter words to exclude from matching
const COMMON_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "his",
  "how",
  "its",
  "let",
  "may",
  "new",
  "now",
  "old",
  "see",
  "way",
  "who",
  "boy",
  "did",
  "get",
  "say",
  "she",
  "too",
  "use",
  "hey",
  "hi",
  "hello",
  "please",
  "help",
]);

/**
 * Check if a word is suitable for agent name matching.
 * Allows 3+ char words if they're not common words.
 * Always allows uppercase words (CEO, CTO, etc).
 */
function isMatchableWord(word: string): boolean {
  if (word.length < 3) return false;
  // Always allow fully uppercase words (acronyms like CEO, CTO)
  if (word === word.toUpperCase() && word.length >= 3) return true;
  // Allow 3+ char words that aren't common
  if (word.length >= 3 && !COMMON_WORDS.has(word.toLowerCase())) return true;
  return false;
}

/**
 * Routes a Slack message to the appropriate agent(s) based on mentions.
 *
 * Routing rules:
 * - `swarm#<uuid>` → exact agent by ID
 * - `swarm#all` → all non-lead agents
 * - Partial name match (3+ chars, not common words) → agent by name
 * - Multiple partial matches → route to lead (let lead decide)
 * - Thread follow-up (no match but agent working on thread) → route to that agent
 * - Bot @mention only → lead agent
 */
export function routeMessage(
  text: string,
  _botUserId: string,
  botMentioned: boolean,
  threadContext?: ThreadContext,
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

  // Check for partial name matches (3+ chars, not common words)
  if (matches.length === 0) {
    for (const agent of agents) {
      const nameWords = agent.name.split(/\s+/).filter(isMatchableWord);
      for (const word of nameWords) {
        const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
        if (regex.test(text)) {
          if (!matches.some((m) => m.agent.id === agent.id)) {
            matches.push({ agent, matchedText: word });
          }
          break;
        }
      }
    }

    // If multiple agents matched a partial name, route to lead instead (let lead decide)
    if (matches.length > 1) {
      const lead = agents.find((a) => a.isLead);
      if (lead) {
        const matchedWords = matches.map((m) => m.matchedText).join(", ");
        const matchedAgents = matches.map((m) => m.agent.name).join(", ");
        return [
          {
            agent: lead,
            matchedText: `ambiguous match "${matchedWords}" (could be: ${matchedAgents})`,
          },
        ];
      }
    }
  }

  // Thread follow-up: If no matches and we're in a thread, check if an agent is working on it
  if (matches.length === 0 && threadContext) {
    const workingAgent = getAgentWorkingOnThread(threadContext.channelId, threadContext.threadTs);
    if (workingAgent && workingAgent.status !== "offline") {
      matches.push({ agent: workingAgent, matchedText: "thread follow-up" });
    }
  }

  // If only bot was mentioned and no agents matched, route to lead
  if (matches.length === 0 && botMentioned) {
    const lead = agents.find((a) => a.isLead);
    if (lead) {
      matches.push({ agent: lead, matchedText: "@bot" });
    }
  }

  return matches;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
