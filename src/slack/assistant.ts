import { Assistant } from "@slack/bolt";
import { createTaskExtended, getAgentWorkingOnThread, getLeadAgent } from "../be/db";
import { getTaskLink } from "./blocks";
import { bufferThreadMessage } from "./thread-buffer";
import { registerTaskMessage } from "./watcher";

const additiveSlack = process.env.ADDITIVE_SLACK === "true";

export function createAssistant(): Assistant {
  return new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
      await saveThreadContext();

      await say("Hi! I'm your Agent Swarm assistant. How can I help?");

      await setSuggestedPrompts({
        title: "Try these:",
        prompts: [
          { title: "Check status", message: "What's the current status of all agents?" },
          { title: "Assign a task", message: "Can you help me with..." },
          { title: "List recent tasks", message: "Show me the most recent tasks" },
        ],
      });
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ message, say, setStatus, setTitle, getThreadContext }) => {
      // Cast to access fields — Bolt's message union type is complex
      const msg = message as unknown as Record<string, unknown>;
      const threadTs = (msg.thread_ts as string) || message.ts;
      const channelId = message.channel;
      const messageText = (msg.text as string) || "";
      const userId = (msg.user as string) || "";

      // 1. Check if an agent is already working in this thread
      const workingAgent = getAgentWorkingOnThread(channelId, threadTs);

      if (workingAgent && workingAgent.status !== "offline") {
        // Follow-up message → route to the same agent
        if (additiveSlack) {
          bufferThreadMessage(channelId, threadTs, messageText, userId, message.ts);
          await setStatus("Queuing follow-up...");
          return;
        }

        // Otherwise, create a follow-up task for the working agent
        const task = createTaskExtended(messageText, {
          agentId: workingAgent.id,
          source: "slack",
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          slackUserId: userId,
        });

        const followResp = await say(
          `Follow-up sent to *${workingAgent.name}* (${getTaskLink(task.id)})`,
        );
        if (followResp?.ts) {
          registerTaskMessage(task.id, channelId, threadTs, followResp.ts);
        }
        return;
      }

      // 2. First message in thread — create new task for lead
      await setStatus("Processing your request...");

      if (messageText) {
        const title = messageText.length > 50 ? `${messageText.slice(0, 47)}...` : messageText;
        await setTitle(title);
      }

      // Optionally enrich with channel context
      const ctx = await getThreadContext();
      const channelContext =
        ctx && typeof ctx === "object" && "channel_id" in ctx && ctx.channel_id
          ? `\n\n[User is viewing channel <#${ctx.channel_id}>]`
          : "";

      const lead = getLeadAgent();
      if (!lead) {
        // No lead — still queue the task
        const task = createTaskExtended(messageText + channelContext, {
          source: "slack",
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          slackUserId: userId,
        });
        const queuedResp = await say(
          `No lead agent is available right now. Your request has been queued (${getTaskLink(task.id)}).`,
        );
        if (queuedResp?.ts) {
          registerTaskMessage(task.id, channelId, threadTs, queuedResp.ts);
        }
        return;
      }

      const task = createTaskExtended(messageText + channelContext, {
        agentId: lead.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackUserId: userId,
      });

      const resp = await say(
        `Task created and assigned to *${lead.name}* (${getTaskLink(task.id)}). I'll update you here when it's done.`,
      );
      if (resp?.ts) {
        registerTaskMessage(task.id, channelId, threadTs, resp.ts);
      }
    },
  });
}
