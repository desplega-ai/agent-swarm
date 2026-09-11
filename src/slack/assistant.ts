import { Assistant } from "@slack/bolt";
import { getAgentWorkingOnThread, getLeadAgent, getMostRecentTaskInThread } from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { slackContextKey } from "../tasks/context-key";
import { ackSlackMessage, reactionName } from "./ack";
import { resolveSlackUserId, rewriteSlackMentions } from "./enrich";
import { wasEventSeen } from "./event-dedup";
import type { SlackFile } from "./files";
import {
  bufferedFileFailures,
  buildEffectiveText,
  createSlackTaskWithFiles,
  fetchSlackFiles,
  notifySlackFileFailures,
} from "./inbound-files";
import { ensureSlackThreadTree, isSlackRenderV2Enabled } from "./render-v2";
import { hasOtherUserMention } from "./router";
import { bufferThreadMessage, getBufferMessageCount } from "./thread-buffer";
// Side-effect import: registers all Slack event templates in the in-memory registry
import "./templates";
import { isEnvFlagEnabled } from "../utils/env-flag";

const isAdditiveSlack = () => isEnvFlagEnabled("ADDITIVE_SLACK", false);

// Cache the bot's own Slack user ID so we can suppress messages that @-mention
// a different agent (e.g. Devin) rather than our bot.
let cachedBotUserId: string | null = null;

export function createAssistant(): Assistant {
  return new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
      try {
        await saveThreadContext();

        if (!isSlackRenderV2Enabled()) {
          const greetingResult = resolveTemplate("slack.assistant.greeting", {});
          await say(greetingResult.text);
        }

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

    userMessage: async ({ message, body, say, setStatus, setTitle, getThreadContext, client }) => {
      // Slack retries deliveries on 3s timeout / 5xx. Drop duplicates before
      // any task-creation work runs (DES-293).
      const eventId = body?.event_id;
      if (wasEventSeen(eventId)) {
        console.log(`[Slack] dropping Slack retry: event_id=${eventId}`);
        return;
      }

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
        // `file_share` messages land here too: an image sent with no caption
        // arrives with empty `text` and everything in `files`.
        const files = msg.files as SlackFile[] | undefined;
        const userId = (msg.user as string) || "";

        // Resolve the bot's own Slack user ID (cached after first call) so we can
        // check whether this message is actually addressed to us.
        if (!cachedBotUserId) {
          try {
            const authResult = await client.auth.test();
            cachedBotUserId = (authResult.user_id as string) ?? null;
          } catch (e) {
            console.warn("[Slack] assistant: auth.test() failed — skipping bot-mention check", e);
          }
        }

        // If the message @-mentions someone OTHER than our bot and does NOT mention
        // our bot, it is addressed to a different agent/user — do not spawn a task.
        if (cachedBotUserId) {
          const botMentioned = messageText.includes(`<@${cachedBotUserId}>`);
          if (!botMentioned && hasOtherUserMention(messageText, cachedBotUserId)) {
            console.log(
              `[Slack] assistant: skipping message in ${channelId}/${threadTs} — mentions another user, not us`,
            );
            return;
          }
        }

        // Resolve canonical user identity via the shared cascade. On no-email,
        // the cascade records the user in the kv unmapped tracker; this handler
        // proceeds without a `requestedByUserId`.
        const requestedByUserId = userId
          ? await resolveSlackUserId(client, userId, {
              sampleEventType: "assistant_message",
              sampleContext: messageText,
            })
          : undefined;

        // 1. Check if an agent is already working in this thread
        const workingAgent = await getAgentWorkingOnThread(channelId, threadTs);

        // Follow-up message → route to the same agent. Buffered follow-ups
        // carry the `[File: …]` lines only; their files are not attached.
        if (workingAgent && workingAgent.status !== "offline" && isAdditiveSlack()) {
          const unattached = bufferedFileFailures(files);
          bufferThreadMessage(
            channelId,
            threadTs,
            buildEffectiveText(messageText, files, unattached),
            userId,
            message.ts,
          );
          const count = getBufferMessageCount(`${channelId}:${threadTs}`);
          const event = count === 1 ? "accepted" : "buffered";
          await ackSlackMessage(client, channelId, message.ts, reactionName(event), event);
          await notifySlackFileFailures(client, channelId, threadTs, unattached);
          await safeSetStatus("Queuing follow-up...");
          return;
        }

        // Fetch shared files before the task text is final: a file that can't be
        // downloaded is flagged in it.
        if (files?.length) await safeSetStatus("Downloading attachments...");
        const inbound = await fetchSlackFiles(client, files);
        // Any in-body `<@U…>` mention the requester typed is rewritten via
        // the identity primitive before it reaches agent-visible task text —
        // never a raw Slack ID. Bot-mention routing checks above use the
        // raw `messageText`, not this rendered copy.
        const renderedMessageText = await rewriteSlackMentions(
          buildEffectiveText(messageText, inbound.files, inbound.failed),
        );

        if (workingAgent && workingAgent.status !== "offline") {
          // Otherwise, create a follow-up task for the working agent
          const latestTask = await getMostRecentTaskInThread(channelId, threadTs);
          const { task, unattached } = await createSlackTaskWithFiles(
            renderedMessageText,
            {
              agentId: workingAgent.id,
              source: "slack",
              slackChannelId: channelId,
              slackThreadTs: threadTs,
              slackTriggerMessageTs: message.ts,
              slackUserId: userId,
              parentTaskId: latestTask?.id,
              requestedByUserId,
              contextKey: slackContextKey({ channelId, threadTs }),
            },
            inbound,
          );
          await ackSlackMessage(
            client,
            channelId,
            message.ts,
            reactionName("accepted"),
            "accepted",
          );
          await notifySlackFileFailures(client, channelId, threadTs, unattached);

          if (isSlackRenderV2Enabled()) await ensureSlackThreadTree([task.id]);

          await safeSetStatus("Processing follow-up...");
          return;
        }

        // 2. First message in thread — create new task for lead
        await safeSetStatus("Processing your request...");

        if (renderedMessageText) {
          const title =
            renderedMessageText.length > 50
              ? `${renderedMessageText.slice(0, 47)}...`
              : renderedMessageText;
          await safeSetTitle(title);
        }

        // Optionally enrich with channel context
        const ctx = await getThreadContext();
        const channelContext =
          ctx && typeof ctx === "object" && "channel_id" in ctx && ctx.channel_id
            ? `\n\n[User is viewing channel <#${ctx.channel_id}>]`
            : "";

        const lead = await getLeadAgent();
        if (!lead) {
          // No lead — still queue the task
          const { task, unattached } = await createSlackTaskWithFiles(
            renderedMessageText + channelContext,
            {
              source: "slack",
              slackChannelId: channelId,
              slackThreadTs: threadTs,
              slackTriggerMessageTs: message.ts,
              slackUserId: userId,
              requestedByUserId,
              contextKey: slackContextKey({ channelId, threadTs }),
            },
            inbound,
          );
          await ackSlackMessage(
            client,
            channelId,
            message.ts,
            reactionName("accepted"),
            "accepted",
          );
          await notifySlackFileFailures(client, channelId, threadTs, unattached);
          if (isSlackRenderV2Enabled()) {
            await ensureSlackThreadTree([task.id]);
          } else {
            const offlineResult = resolveTemplate("slack.assistant.offline", {});
            await say(offlineResult.text);
          }
          return;
        }

        const { task, unattached } = await createSlackTaskWithFiles(
          renderedMessageText + channelContext,
          {
            agentId: lead.id,
            source: "slack",
            slackChannelId: channelId,
            slackThreadTs: threadTs,
            slackTriggerMessageTs: message.ts,
            slackUserId: userId,
            requestedByUserId,
            contextKey: slackContextKey({ channelId, threadTs }),
          },
          inbound,
        );
        await ackSlackMessage(client, channelId, message.ts, reactionName("accepted"), "accepted");
        await notifySlackFileFailures(client, channelId, threadTs, unattached);
        if (isSlackRenderV2Enabled()) await ensureSlackThreadTree([task.id]);
        // setStatus shows typing indicator — watcher will post final result when done
      } catch (error) {
        console.error("[Slack] Assistant userMessage error:", error);
      }
    },
  });
}
