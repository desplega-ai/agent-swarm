import type { Chat, Message, Thread } from "chat";
import { getAllAgents } from "@/be/db";
import { isAgentReachable } from "@/be/runtime-pools/reachability";
import { chatSdkContextKey } from "@/tasks/context-key";
import { createTaskWithSiblingAwareness } from "@/tasks/sibling-awareness";
import { scrubSecrets } from "@/utils/secret-scrubber";

/** The reachable lead, resolved the same way `src/slack/router.ts` does. */
async function resolveLead() {
  const agents = await getAllAgents();
  for (const agent of agents) {
    if (agent.isLead && (await isAgentReachable(agent))) return agent;
  }
  return null;
}

/**
 * Phase 1 inbound: one Lead task per mention or DM. Phase 2 replaces this body
 * with the buffered, routed pipeline; the registration point stays.
 */
async function handleInbound(thread: Thread, message: Message): Promise<void> {
  await thread.subscribe();
  const lead = await resolveLead();
  const adapter = thread.adapter.name;
  const task = await createTaskWithSiblingAwareness(
    message.text,
    {
      agentId: lead?.id ?? null,
      routingReason: lead ? "skill" : undefined,
      routingSource: lead ? "engine_default" : undefined,
      source: "chat",
      taskType: "chat-inbound",
      tags: ["chat-sdk", adapter],
      priority: 70,
      contextKey: chatSdkContextKey(thread.id),
    },
    { origin: "webhook" },
  );
  console.log(
    scrubSecrets(
      `[chat-sdk] ${adapter} inbound created task ${task.id}${lead ? ` for lead ${lead.id}` : " (no reachable lead, unassigned)"}`,
    ),
  );
}

export function registerChatHandlers(chat: Chat): void {
  chat.onNewMention(async (thread, message) => handleInbound(thread, message));
  chat.onDirectMessage(async (thread, message) => handleInbound(thread, message));
}
