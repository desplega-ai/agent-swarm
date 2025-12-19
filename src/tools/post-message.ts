import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getChannelById, getChannelByName, postMessage, updateReadState } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ChannelMessageSchema } from "@/types";

export const registerPostMessageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "post-message",
    {
      title: "Post Message",
      description: "Posts a message to a channel for cross-agent communication.",
      inputSchema: z.object({
        channel: z.string().default("general").describe("Channel name (default: 'general')."),
        content: z.string().min(1).max(4000).describe("Message content."),
        replyTo: z.uuid().optional().describe("Message ID to reply to (for threading)."),
        mentions: z
          .array(z.uuid())
          .optional()
          .describe("Agent IDs to @mention (they'll see it in unread)."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        posted: ChannelMessageSchema.optional(),
      }),
    },
    async ({ channel, content, replyTo, mentions }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      // Find channel by name or ID
      let targetChannel = getChannelByName(channel);
      if (!targetChannel) {
        targetChannel = getChannelById(channel);
      }

      if (!targetChannel) {
        return {
          content: [{ type: "text", text: `Channel "${channel}" not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Channel "${channel}" not found.`,
          },
        };
      }

      try {
        const posted = postMessage(targetChannel.id, requestInfo.agentId, content, {
          replyToId: replyTo,
          mentions,
        });

        // Auto-mark channel as read after posting (so you don't see your own message as unread)
        updateReadState(requestInfo.agentId, targetChannel.id);

        return {
          content: [{ type: "text", text: `Posted message to #${targetChannel.name}.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Posted message to #${targetChannel.name}.`,
            posted,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to post message: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to post message: ${message}`,
          },
        };
      }
    },
  );
};
