import { Assistant } from "@slack/bolt";
import {
  createTaskExtended,
  getAgentWorkingOnThread,
  getLeadAgent,
  getMostRecentTaskInThread,
} from "../be/db";
import { bufferThreadMessage } from "./thread-buffer";

const additiveSlack = process.env.ADDITIVE_SLACK === "true";

export function createAssistant(): Assistant {
  return new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
      try {
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
      } catch (error) {
        console.error("[Slack] Assistant threadStarted error:", error);
      }
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ message, say, setStatus, setTitle, getThreadContext }) => {
      try {
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
          const latestTask = getMostRecentTaskInThread(channelId, threadTs);
          createTaskExtended(messageText, {
            agentId: workingAgent.id,
            source: "slack",
            slackChannelId: channelId,
            slackThreadTs: threadTs,
            slackUserId: userId,
            parentTaskId: latestTask?.id,
          });

          await setStatus("Processing follow-up...");
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
          createTaskExtended(messageText + channelContext, {
            source: "slack",
            slackChannelId: channelId,
            slackThreadTs: threadTs,
            slackUserId: userId,
          });
          await say(
            "No agents are available right now. Your request has been queued and will be processed when agents come back online.",
          );
          return;
        }

        createTaskExtended(messageText + channelContext, {
          agentId: lead.id,
          source: "slack",
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          slackUserId: userId,
        });
        // setStatus shows typing indicator — watcher will post final result when done
      } catch (error) {
        console.error("[Slack] Assistant userMessage error:", error);
      }
    },
  });
}
