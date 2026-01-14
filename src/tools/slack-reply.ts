import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getInboxMessageById, getTaskById, markInboxMessageResponded } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { markdownToSlack } from "@/slack/responses";
import { createToolRegistrar } from "@/tools/utils";

export const registerSlackReplyTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-reply",
    {
      title: "Reply to Slack thread",
      description:
        "Send a reply to a Slack thread. Use inboxMessageId for inbox messages, or taskId for task-related threads.",
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
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ inboxMessageId, taskId, message }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: { success: false, message: "Agent not found." },
        };
      }

      let slackChannelId: string | undefined;
      let slackThreadTs: string | undefined;

      // Determine Slack context from inbox message or task
      if (inboxMessageId) {
        const inboxMsg = getInboxMessageById(inboxMessageId);
        if (!inboxMsg) {
          return {
            content: [{ type: "text", text: "Inbox message not found." }],
            structuredContent: { success: false, message: "Inbox message not found." },
          };
        }
        if (inboxMsg.agentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "This inbox message is not yours." }],
            structuredContent: { success: false, message: "This inbox message is not yours." },
          };
        }
        slackChannelId = inboxMsg.slackChannelId;
        slackThreadTs = inboxMsg.slackThreadTs;

        // Mark as responded
        markInboxMessageResponded(inboxMessageId, message);
      } else if (taskId) {
        const task = getTaskById(taskId);
        if (!task) {
          return {
            content: [{ type: "text", text: "Task not found." }],
            structuredContent: { success: false, message: "Task not found." },
          };
        }
        // Verify agent has context for this task
        if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "You don't have context for this task." }],
            structuredContent: { success: false, message: "You don't have context for this task." },
          };
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = task.slackThreadTs;
      } else {
        return {
          content: [{ type: "text", text: "Must provide inboxMessageId or taskId." }],
          structuredContent: { success: false, message: "Must provide inboxMessageId or taskId." },
        };
      }

      if (!slackChannelId || !slackThreadTs) {
        return {
          content: [{ type: "text", text: "No Slack context available." }],
          structuredContent: { success: false, message: "No Slack context available." },
        };
      }

      // Send the reply
      const app = getSlackApp();
      if (!app) {
        return {
          content: [{ type: "text", text: "Slack not configured." }],
          structuredContent: { success: false, message: "Slack not configured." },
        };
      }

      try {
        const slackMessage = markdownToSlack(message);

        await app.client.chat.postMessage({
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
        });

        return {
          content: [{ type: "text", text: "Reply sent successfully." }],
          structuredContent: { success: true, message: "Reply sent successfully." },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to send reply: ${error}` }],
          structuredContent: { success: false, message: `Failed to send reply: ${error}` },
        };
      }
    },
  );
};
