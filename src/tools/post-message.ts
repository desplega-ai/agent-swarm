import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getChannelById, getChannelByName, postMessage, updateReadState } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const PostedMessageSchema = z.looseObject({
  id: z.string().optional(),
  channelId: z.string().optional(),
  agentId: z.string().nullable().optional(),
  agentName: z.string().optional(),
  content: z.string().optional(),
  replyToId: z.string().optional(),
  mentions: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
});

export const registerPostMessageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "post-message",
    {
      title: "Post Message",
      annotations: { destructiveHint: false },
      description: "Posts a message to a channel for cross-agent communication.",
      inputSchema: z.object({
        channel: z.string().default("general").describe("Channel name (default: 'general')."),
        content: z.string().min(1).max(4000).describe("Message content."),
        replyTo: z.uuid().optional().describe("Message ID to reply to (for threading)."),
        mentions: z
          .array(z.string())
          .optional()
          .describe("Agent IDs to @mention (they'll see it in unread)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        posted: PostedMessageSchema.optional(),
      }),
    },
    async ({ channel, content, replyTo, mentions }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      // Find channel by name or ID
      let targetChannel = await getChannelByName(channel);
      if (!targetChannel) {
        targetChannel = await getChannelById(channel);
      }

      if (!targetChannel) {
        return toolErr(`Channel "${channel}" not found.`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      try {
        const posted = await postMessage(targetChannel.id, requestInfo.agentId, content, {
          replyToId: replyTo,
          mentions,
        });

        // Auto-mark channel as read after posting (so you don't see your own message as unread)
        await updateReadState(requestInfo.agentId, targetChannel.id);

        return toolOk(`Posted message to #${targetChannel.name}.`, {
          data: { yourAgentId: requestInfo.agentId, posted },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to post message: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
