import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getSlackApp } from "@/slack/app";
import { parseSlackTs } from "@/slack/message-text";
import { markdownToSlack } from "@/slack/responses";
import { createToolRegistrar } from "@/tools/utils";

export const registerSlackUpdateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-update",
    {
      title: "Edit a Slack message",
      description:
        "Edits (in place) the text of a Slack message that THIS bot authored — use it to post corrections to your own messages. Cannot edit messages authored by humans or other apps. Note: editing may reset the message's display name/icon to the app default (Slack's chat.update cannot set the crown persona). Requires lead privileges.",
      annotations: { openWorldHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID the message is in."),
        messageTs: z
          .string()
          .min(1)
          .describe(
            "Timestamp of the message to edit (dotted, 'p' deep-link, or full permalink URL).",
          ),
        message: z.string().min(1).max(4000).describe("The new message content."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        messageTs: z.string().optional(),
      }),
    },
    async ({ channelId, messageTs, message }, requestInfo, _meta) => {
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
          content: [{ type: "text", text: "Editing Slack messages requires lead privileges." }],
          structuredContent: {
            success: false,
            message: "Editing Slack messages requires lead privileges.",
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
        const ts = parseSlackTs(messageTs);
        const slackMessage = markdownToSlack(message);

        const result = await app.client.chat.update({
          channel: channelId,
          ts,
          text: slackMessage,
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
          content: [{ type: "text", text: "Message updated successfully." }],
          structuredContent: {
            success: true,
            message: "Message updated successfully.",
            messageTs: result.ts,
          },
        };
      } catch (error) {
        const errorCode = (error as { data?: { error?: string } } | undefined)?.data?.error;
        const errorMsg = error instanceof Error ? error.message : String(error);

        let message: string;
        switch (errorCode) {
          case "message_not_found":
            message = "No message found at that timestamp in this channel.";
            break;
          case "cant_update_message":
            message = "Cannot edit this message — the bot can only edit messages it authored.";
            break;
          case "edit_window_closed":
            message = "The edit window for this message has closed.";
            break;
          case "channel_not_found":
            message = "Channel not found or the bot has no access.";
            break;
          case "not_in_channel":
            message = "The bot is not in that channel.";
            break;
          default:
            message = `Failed to update message: ${errorMsg}`;
        }

        return {
          content: [{ type: "text", text: message }],
          structuredContent: { success: false, message },
        };
      }
    },
  );
};
