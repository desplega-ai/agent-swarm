import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { markdownToSlack } from "@/slack/responses";
import { createToolRegistrar } from "@/tools/utils";

export const registerSlackStartThreadTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-start-thread",
    {
      title: "Start a new Slack thread",
      description:
        "Post a new top-level message to a Slack channel and return its ts so the caller can thread replies under it. Pass the returned `ts` as `threadTs` on subsequent `slack-post` calls to keep replies in the same thread. Requires lead privileges.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID to post to."),
        message: z.string().min(1).max(4000).describe("The message content to post."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        channelId: z.string().optional(),
        ts: z.string().optional(),
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

        const ts = result.ts;
        const resolvedChannelId = result.channel ?? channelId;

        if (!ts) {
          return {
            content: [
              {
                type: "text",
                text: "Message posted but Slack did not return a ts — cannot thread replies.",
              },
            ],
            structuredContent: {
              success: false,
              message: "Message posted but Slack did not return a ts — cannot thread replies.",
              channelId: resolvedChannelId,
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Thread started. channelId=${resolvedChannelId}, ts=${ts}. Pass ts as threadTs on slack-post to reply in-thread.`,
            },
          ],
          structuredContent: {
            success: true,
            message: "Thread started successfully.",
            channelId: resolvedChannelId,
            ts,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to start thread: ${errorMsg}` }],
          structuredContent: { success: false, message: `Failed to start thread: ${errorMsg}` },
        };
      }
    },
  );
};
