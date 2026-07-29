import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getAgentById,
  getInboxMessageById,
  getTaskById,
  markInboxMessageResponded,
  markTaskSlackReplySent,
} from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { withAutoJoin } from "@/slack/channel-join";
import { markdownToSlack } from "@/slack/responses";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackReplyTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-reply",
    {
      title: "Reply to Slack thread",
      description:
        "Send a reply to a Slack thread. Use inboxMessageId for inbox messages, or taskId for task-related threads.",
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
      }),
      outputSchema: swarmToolOutputSchema({
        messageTs: z.string().optional(),
      }),
    },
    async ({ inboxMessageId, taskId, message }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      let slackChannelId: string | undefined;
      let slackThreadTs: string | undefined;

      // Determine Slack context from inbox message or task
      if (inboxMessageId) {
        const inboxMsg = getInboxMessageById(inboxMessageId);
        if (!inboxMsg) {
          return toolErr("Inbox message not found.");
        }
        if (inboxMsg.agentId !== requestInfo.agentId) {
          return toolErr("This inbox message is not yours.");
        }
        slackChannelId = inboxMsg.slackChannelId;
        slackThreadTs = inboxMsg.slackThreadTs;

        // Mark as responded
        markInboxMessageResponded(inboxMessageId, message);
      } else if (taskId) {
        const task = getTaskById(taskId);
        if (!task) {
          return toolErr("Task not found.");
        }
        // Verify agent has context for this task
        if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
          return toolErr("You don't have context for this task.");
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = task.slackThreadTs;
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

        const result = await withAutoJoin(app.client, slackChannelId, () =>
          app.client.chat.postMessage({
            channel: slackChannelId,
            thread_ts: slackThreadTs,
            text: slackMessage, // Fallback for notifications
            username: agent.name,
            icon_emoji: agent.isLead ? ":crown:" : ":robot_face:",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: slackMessage,
                },
              },
            ],
          }),
        );

        const messageTs = result.ts;

        // After successful postMessage, mark task as having a Slack reply
        if (taskId) {
          markTaskSlackReplySent(taskId);
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
