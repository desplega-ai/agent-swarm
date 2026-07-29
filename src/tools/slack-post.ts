import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { withAutoJoin } from "@/slack/channel-join";
import { markdownToSlack } from "@/slack/responses";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackPostTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-post",
    {
      title: "Post message to Slack channel",
      description:
        "Post a message to a Slack channel. By default creates a new top-level message; pass `threadTs` to post as a threaded reply under an existing message (obtain the ts from `slack-start-thread`). Requires lead privileges.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID to post to."),
        message: z.string().min(1).max(4000).describe("The message content to post."),
        threadTs: z
          .string()
          .optional()
          .describe(
            "Optional parent message ts to thread under. Obtain via `slack-start-thread`. When omitted, posts as a new top-level message.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        messageTs: z.string().optional(),
      }),
    },
    async ({ channelId, message, threadTs }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      // Require lead privileges to post directly to channels
      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.post",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Posting to Slack channels requires lead privileges.");
      }

      const app = getSlackApp();
      if (!app) {
        return toolErr("Slack not configured.");
      }

      try {
        const slackMessage = markdownToSlack(message);

        const result = await withAutoJoin(app.client, channelId, () =>
          app.client.chat.postMessage({
            channel: channelId,
            text: slackMessage, // Fallback for notifications
            username: agent.name,
            icon_emoji: ":crown:",
            ...(threadTs ? { thread_ts: threadTs } : {}),
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

        return toolOk("Message posted successfully.", {
          details: messageTs ? `Message timestamp: ${messageTs}` : undefined,
          data: { messageTs },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return toolErr(`Failed to post message: ${errorMsg}`);
      }
    },
  );
};
