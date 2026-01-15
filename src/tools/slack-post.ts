import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { markdownToSlack } from "@/slack/responses";
import { createToolRegistrar } from "@/tools/utils";

export const registerSlackPostTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-post",
    {
      title: "Post new message to Slack channel",
      description:
        "Post a new message to a Slack channel. This creates a new message (not a thread reply). Requires lead privileges.",
      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID to post to."),
        message: z.string().min(1).max(4000).describe("The message content to post."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        messageTs: z.string().optional(),
      }),
    },
    async ({ channelId, message }, requestInfo, _meta) => {
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

      // Require lead privileges to post directly to channels
      if (!agent.isLead) {
        return {
          content: [{ type: "text", text: "Posting to Slack channels requires lead privileges." }],
          structuredContent: {
            success: false,
            message: "Posting to Slack channels requires lead privileges.",
          },
        };
      }

      const app = getSlackApp();
      if (!app) {
        return {
          content: [{ type: "text", text: "Slack not configured." }],
          structuredContent: { success: false, message: "Slack not configured." },
        };
      }

      try {
        const slackMessage = markdownToSlack(message);

        const result = await app.client.chat.postMessage({
          channel: channelId,
          text: slackMessage, // Fallback for notifications
          username: agent.name,
          icon_emoji: ":crown:",
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

        const messageTs = result.ts;

        return {
          content: [
            {
              type: "text",
              text: `Message posted successfully.${messageTs ? ` Message timestamp: ${messageTs}` : ""}`,
            },
          ],
          structuredContent: {
            success: true,
            message: "Message posted successfully.",
            messageTs,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to post message: ${errorMsg}` }],
          structuredContent: { success: false, message: `Failed to post message: ${errorMsg}` },
        };
      }
    },
  );
};
