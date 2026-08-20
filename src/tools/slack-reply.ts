import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getAgentById,
  getInboxMessageById,
  getSlackTreeMessageByThread,
  getTaskById,
  markInboxMessageResponded,
  markTaskSlackReplySent,
  recordSlackMessage,
} from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { getTaskLink } from "@/slack/blocks";
import { withAutoJoin } from "@/slack/channel-join";
import { getAgentDisplayName, getAgentEmoji, markdownToSlack } from "@/slack/responses";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackReplyTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-reply",
    {
      title: "Reply to Slack thread",
      description:
        "Send a reply to a Slack thread. Use inboxMessageId for inbox messages, or taskId for task-related threads. The engine already publishes the task tree and outcome card, so send only a distinct agent-authored message. Prefer one reply per task over several, do not post progress, receipt, or acknowledgment messages, and match its length to what the user asked for.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        inboxMessageId: z
          .uuid()
          .optional()
          .describe("The inbox message ID to reply to (for leads responding to inbox)."),
        taskId: z
          .uuid()
          .optional()
          .describe("The task ID with Slack context (for task-related threads)."),
        message: z.string().min(1).max(4000).describe("The message to send to the Slack thread."),
        blocks: z
          .array(z.record(z.string(), z.unknown()))
          .max(50)
          .optional()
          .describe("Optional Block Kit blocks. When omitted, a mrkdwn section is generated."),
      }),
      outputSchema: swarmToolOutputSchema({
        messageTs: z.string().optional(),
      }),
    },
    async ({ inboxMessageId, taskId, message, blocks }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      let slackChannelId: string | undefined;
      let slackThreadTs: string | undefined;
      let contextKey: string | undefined;

      // Determine Slack context from inbox message or task
      if (inboxMessageId) {
        const inboxMsg = await getInboxMessageById(inboxMessageId);
        if (!inboxMsg) {
          return toolErr("Inbox message not found.");
        }
        if (inboxMsg.agentId !== requestInfo.agentId) {
          return toolErr("This inbox message is not yours.");
        }
        slackChannelId = inboxMsg.slackChannelId;
        slackThreadTs = inboxMsg.slackThreadTs;

        // Mark as responded
        await markInboxMessageResponded(inboxMessageId, message);
      } else if (taskId) {
        const task = await getTaskById(taskId);
        if (!task) {
          return toolErr("Task not found.");
        }
        // Verify agent has context for this task
        if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
          return toolErr("You don't have context for this task.");
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = task.slackThreadTs;
        contextKey = task.contextKey;
      } else {
        return toolErr("Must provide inboxMessageId or taskId.");
      }

      if (!slackChannelId || !slackThreadTs) {
        return toolErr("No Slack context available.");
      }

      // Send the reply
      const app = getSlackApp();
      if (!app) {
        return toolErr("Slack not configured.");
      }

      try {
        const slackMessage = markdownToSlack(message);

        const tree = await getSlackTreeMessageByThread(slackChannelId, slackThreadTs);
        const messageBlocks: Record<string, unknown>[] = [
          ...(blocks ?? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: slackMessage,
              },
            },
          ]),
        ];
        if (taskId && tree) {
          if (messageBlocks.length >= 50) {
            return toolErr("At most 49 blocks are allowed when a provenance footer is added.");
          }
          messageBlocks.push({
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `${agent.name} · ${getTaskLink(taskId)}`,
              },
            ],
          });
        }

        const result = await withAutoJoin(app.client, slackChannelId, () =>
          app.client.chat.postMessage({
            channel: slackChannelId,
            thread_ts: slackThreadTs,
            text: slackMessage, // Fallback for notifications
            unfurl_links: false,
            unfurl_media: false,
            username: getAgentDisplayName(agent),
            icon_emoji: getAgentEmoji(agent),
            // biome-ignore lint/suspicious/noExplicitAny: MCP accepts arbitrary valid Block Kit JSON
            blocks: messageBlocks as any,
          }),
        );

        const messageTs = result.ts;
        if (messageTs) {
          await recordSlackMessage({
            contextKey: contextKey ?? `task:slack:${slackChannelId}:${slackThreadTs}`,
            channelId: slackChannelId,
            threadTs: slackThreadTs,
            ts: messageTs,
            kind: "agent",
            taskId,
            finalized: true,
            actorId: agent.id,
          });
        }

        // After successful postMessage, mark task as having a Slack reply
        if (taskId) {
          await markTaskSlackReplySent(taskId);
          console.log(`[Slack] Marked slackReplySent=1 for task ${taskId}`);
        }

        return toolOk("Reply sent successfully.", {
          details: messageTs ? `Message timestamp: ${messageTs}` : undefined,
          data: { messageTs },
        });
      } catch (error) {
        return toolErr(`Failed to send reply: ${error}`);
      }
    },
  );
};
