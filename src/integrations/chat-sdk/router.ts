import {
  deleteKv,
  getAgentById,
  getAgentWorkingOnContextKey,
  getAllAgents,
  getKv,
  getLeadAgent,
  upsertKv,
} from "@/be/db";
import { isAgentReachable } from "@/be/runtime-pools/reachability";
import { chatSdkContextKey } from "@/tasks/context-key";
import type { Agent, RoutingReason } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";

/** KV namespace of the channel-to-agent/workflow mapping, written by `register-chat-channel`. */
export const CHAT_CHANNELS_NAMESPACE = "integrations:chat:channels";

export interface ChatChannelMapping {
  agentId?: string;
  workflowId?: string;
  name?: string;
  createdAt?: string;
}

export interface ChatAgentMatch {
  /** Null when no lead exists: the task is created unassigned and queued. */
  agent: Agent | null;
  reason: RoutingReason;
  matchedText: string;
}

export type ChatRouteTarget =
  | { kind: "agents"; matches: ChatAgentMatch[] }
  | { kind: "workflow"; workflowId: string };

export interface ChatRouteContext {
  adapter: string;
  channelId: string;
  threadId: string;
  botMentioned: boolean;
  isDirectMessage: boolean;
}

/**
 * KV key of a channel mapping. SDK channel ids already carry the adapter
 * prefix (`telegram:555001`, `slack:C123`); the prefix is added only when an
 * adapter returns a bare id, so the key is always `<adapter>:<platform id>`.
 */
export function chatChannelKey(adapter: string, channelId: string): string {
  return channelId.startsWith(`${adapter}:`) ? channelId : `${adapter}:${channelId}`;
}

export async function getChatChannelMapping(
  adapter: string,
  channelId: string,
): Promise<ChatChannelMapping | null> {
  const row = await getKv(CHAT_CHANNELS_NAMESPACE, chatChannelKey(adapter, channelId));
  if (!row || typeof row.value !== "object" || row.value === null) return null;
  return row.value as ChatChannelMapping;
}

/** Store a channel mapping under `chatChannelKey(adapter, channelId)`. Returns the key. */
export async function putChatChannelMapping(
  adapter: string,
  channelId: string,
  mapping: ChatChannelMapping,
): Promise<string> {
  const key = chatChannelKey(adapter, channelId);
  await upsertKv({
    namespace: CHAT_CHANNELS_NAMESPACE,
    key,
    value: mapping,
    valueType: "json",
    expiresAt: null,
  });
  return key;
}

export async function deleteChatChannelMapping(
  adapter: string,
  channelId: string,
): Promise<boolean> {
  return deleteKv(CHAT_CHANNELS_NAMESPACE, chatChannelKey(adapter, channelId));
}

/** Remove `swarm#<uuid>` and `swarm#all` routing tokens from task text. */
export function stripRoutingTokens(text: string): string {
  return text
    .replace(/swarm#[a-f0-9-]{36}/gi, "")
    .replace(/swarm#all/gi, "")
    .trim();
}

async function leadMatch(reachable: Agent[], matchedText: string): Promise<ChatAgentMatch> {
  const lead = reachable.find((agent) => agent.isLead) ?? (await getLeadAgent());
  return { agent: lead, reason: "skill", matchedText };
}

/**
 * Port of `src/slack/router.ts` for Chat SDK threads. Order: `swarm#<uuid>`,
 * `swarm#all`, KV channel mapping (agent, or workflow for a mention or DM), the
 * thread owner (lead when the owner is offline), the lead for a mention or DM.
 * Returns null when the message is not addressed to the swarm.
 */
export async function routeChatMessage(
  text: string,
  ctx: ChatRouteContext,
): Promise<ChatRouteTarget | null> {
  const allAgents = await getAllAgents();
  const reachableFlags = await Promise.all(allAgents.map((agent) => isAgentReachable(agent)));
  const reachable = allAgents.filter((_, index) => reachableFlags[index]);

  const matches: ChatAgentMatch[] = [];
  for (const match of text.matchAll(/swarm#([a-f0-9-]{36})/gi)) {
    const agentId = match[1];
    if (!agentId || matches.some((m) => m.agent?.id === agentId)) continue;
    const agent = await getAgentById(agentId);
    if (agent && (await isAgentReachable(agent))) {
      matches.push({ agent, reason: "human_pinned", matchedText: match[0] });
    }
  }
  if (/swarm#all/i.test(text)) {
    for (const agent of reachable) {
      if (agent.isLead || matches.some((m) => m.agent?.id === agent.id)) continue;
      matches.push({ agent, reason: "human_pinned", matchedText: "swarm#all" });
    }
  }
  if (matches.length > 0) return { kind: "agents", matches };

  const mapping = await getChatChannelMapping(ctx.adapter, ctx.channelId);
  // A workflow run has no continuity: an unaddressed reply in the subscribed
  // thread must not start another run. It still reaches a thread owner below.
  if (mapping?.workflowId && (ctx.botMentioned || ctx.isDirectMessage)) {
    return { kind: "workflow", workflowId: mapping.workflowId };
  }
  if (mapping?.agentId) {
    const agent = await getAgentById(mapping.agentId);
    if (agent) {
      return {
        kind: "agents",
        matches: [{ agent, reason: "human_pinned", matchedText: "channel mapping" }],
      };
    }
    console.warn(
      scrubSecrets(
        `[chat-sdk] Channel mapping for ${ctx.channelId} names unknown agent ${mapping.agentId}; using the default route`,
      ),
    );
  }

  const owner = await getAgentWorkingOnContextKey(chatSdkContextKey(ctx.threadId), "chat");
  if (owner && (await isAgentReachable(owner))) {
    return {
      kind: "agents",
      matches: [{ agent: owner, reason: "continuity", matchedText: "thread follow-up" }],
    };
  }
  if (owner) {
    return {
      kind: "agents",
      matches: [await leadMatch(reachable, "thread follow-up (lead fallback)")],
    };
  }

  if (ctx.botMentioned || ctx.isDirectMessage) {
    return { kind: "agents", matches: [await leadMatch(reachable, "@bot")] };
  }
  return null;
}
