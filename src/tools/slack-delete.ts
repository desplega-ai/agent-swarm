import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { getSlackApp } from "@/slack/app";
import { parseSlackTs } from "@/slack/message-text";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-delete",
    {
      title: "Delete a Slack message",
      description:
        "Deletes a Slack message that THIS bot authored (e.g. a message previously posted via `slack-post`/`slack-reply`). Cannot delete messages authored by humans or other apps. Requires lead privileges.",
      annotations: { openWorldHint: true, destructiveHint: true },

      inputSchema: z.object({
        channelId: z.string().min(1).describe("The Slack channel ID the message is in."),
        messageTs: z
          .string()
          .min(1)
          .describe(
            "Timestamp of the message to delete. Accepts the dotted form (1783411554.596189), the 'p' deep-link form (p1783411554596189), or a full Slack permalink URL.",
          ),
      }),
      outputSchema: swarmToolOutputSchema(),
    },
    async ({ channelId, messageTs }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.delete",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Deleting Slack messages requires lead privileges.");
      }

      const app = getSlackApp();
      if (!app) {
        return toolErr("Slack not configured.");
      }

      try {
        const ts = parseSlackTs(messageTs);
        await app.client.chat.delete({ channel: channelId, ts });

        return toolOk("Message deleted successfully.");
      } catch (error) {
        const errorCode = (error as { data?: { error?: string } } | undefined)?.data?.error;
        const errorMsg = error instanceof Error ? error.message : String(error);

        let message: string;
        switch (errorCode) {
          case "message_not_found":
            message = "No message found at that timestamp in this channel.";
            break;
          case "cant_delete_message":
            message = "Cannot delete this message — the bot can only delete messages it authored.";
            break;
          case "channel_not_found":
            message = "Channel not found or the bot has no access.";
            break;
          case "not_in_channel":
            message = "The bot is not in that channel.";
            break;
          default:
            message = `Failed to delete message: ${errorMsg}`;
        }

        return toolErr(message);
      }
    },
  );
};
