import { Assistant } from "@slack/bolt";
import {
  getAgentWorkingOnThread,
  getLeadAgent,
  getMostRecentTaskInThread,
  resolveUser,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { slackContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { bufferThreadMessage } from "./thread-buffer";
// Side-effect import: registers all Slack event templates in the in-memory registry
import "./templates";

const additiveSlack = process.env.ADDITIVE_SLACK === "true";

export function createAssistant(): Assistant {
  return new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
      try {
        await saveThreadContext();

        const greetingResult = resolveTemplate("slack.assistant.greeting", {});
        await say(greetingResult.text);

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
      // Wrap setStatus/setTitle to swallow all errors gracefully.
      // These calls can fail for various reasons (no_permission when the thread
      // wasn't started by the assistant, network errors, etc.), so we log and continue.
      const safeSetStatus = async (status: string) => {
        try {
          await setStatus(status);
        } catch (error) {
          console.warn("[Slack] setStatus failed (thread may not be an assistant thread):", error);
        }
      };
      const safeSetTitle = async (title: string) => {
        try {
          await setTitle(title);
        } catch (error) {
          console.warn("[Slack] setTitle failed (thread may not be an assistant thread):", error);
        }
      };

      try {
        // Cast to access fields — Bolt's message union type is complex
        const msg = message as unknown as Record<string, unknown>;
        const threadTs = (msg.thread_ts as string) || message.ts;
        const channelId = message.channel;
        const messageText = (msg.text as string) || "";
        const userId = (msg.user as string) || "";

        // Resolve canonical user identity (graceful — null if not found)
        const requestedByUserId = userId ? resolveUser({ slackUserId: userId })?.id : undefined;

        // 1. Check if an agent is already working in this thread
        const workingAgent = getAgentWorkingOnThread(channelId, threadTs);

        if (workingAgent && workingAgent.status !== "offline") {
          // Follow-up message → route to the same agent
          if (additiveSlack) {
            bufferThreadMessage(channelId, threadTs, messageText, userId, message.ts);
            await safeSetStatus("Queuing follow-up...");
            return;
          }

          // Otherwise, create a follow-up task for the working agent
          const latestTask = getMostRecentTaskInThread(channelId, threadTs);
          createTaskWithSiblingAwareness(messageText, {
            agentId: workingAgent.id,
            source: "slack",
            slackChannelId: channelId,
            slackThreadTs: threadTs,
            slackUserId: userId,
            parentTaskId: latestTask?.id,
            requestedByUserId,
            contextKey: slackContextKey({ channelId, threadTs }),
          });

          await safeSetStatus("Processing follow-up...");
          return;
        }

        // 2. First message in thread — create new task for lead
        await safeSetStatus("Processing your request...");

        if (messageText) {
          const title = messageText.length > 50 ? `${messageText.slice(0, 47)}...` : messageText;
          await safeSetTitle(title);
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
          createTaskWithSiblingAwareness(messageText + channelContext, {
            source: "slack",
            slackChannelId: channelId,
            slackThreadTs: threadTs,
            slackUserId: userId,
            requestedByUserId,
            contextKey: slackContextKey({ channelId, threadTs }),
          });
          const offlineResult = resolveTemplate("slack.assistant.offline", {});
          await say(offlineResult.text);
          return;
        }

        createTaskWithSiblingAwareness(messageText + channelContext, {
          agentId: lead.id,
          source: "slack",
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          slackUserId: userId,
          requestedByUserId,
          contextKey: slackContextKey({ channelId, threadTs }),
        });
        // setStatus shows typing indicator — watcher will post final result when done
      } catch (error) {
        console.error("[Slack] Assistant userMessage error:", error);
      }
    },
  });
}
