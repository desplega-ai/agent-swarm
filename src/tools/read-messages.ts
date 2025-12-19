import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getAllChannels,
  getChannelById,
  getChannelByName,
  getChannelMessages,
  getMentionsForAgent,
  getUnreadMessages,
  updateReadState,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ChannelMessageSchema } from "@/types";

export const registerReadMessagesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "read-messages",
    {
      title: "Read Messages",
      description:
        "Reads messages from a channel. If no channel is specified, returns unread messages from ALL channels. Supports filtering by unread, mentions, and time range. Automatically marks messages as read.",
      inputSchema: z.object({
        channel: z
          .string()
          .optional()
          .describe("Channel name or ID. If omitted, returns unread messages from all channels."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Max messages to return per channel (default: 20, max: 100)."),
        since: z.iso.datetime().optional().describe("Only messages after this ISO timestamp."),
        unreadOnly: z.boolean().default(false).describe("Only return unread messages."),
        mentionsOnly: z
          .boolean()
          .default(false)
          .describe("Only return messages that @mention you."),
        markAsRead: z
          .boolean()
          .default(true)
          .describe("Update your read position after fetching (default: true)."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        channelName: z.string().optional(),
        messages: z.array(ChannelMessageSchema),
        unreadCount: z.number().optional(),
        totalUnreadCount: z.number().optional(),
      }),
    },
    async ({ channel, limit, since, unreadOnly, mentionsOnly, markAsRead }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            messages: [],
          },
        };
      }

      try {
        // If no channel specified, get unread messages from all channels
        if (!channel) {
          const allChannels = getAllChannels();
          let allMessages: ReturnType<typeof getUnreadMessages> = [];
          let totalUnreadCount = 0;

          for (const ch of allChannels) {
            const unreadMessages = getUnreadMessages(requestInfo.agentId, ch.id);
            totalUnreadCount += unreadMessages.length;

            // Add channel name to messages for context
            const messagesWithChannel = unreadMessages.slice(-limit).map((msg) => ({
              ...msg,
              agentName: msg.agentName ? `${msg.agentName} in #${ch.name}` : `#${ch.name}`,
            }));
            allMessages = allMessages.concat(messagesWithChannel);

            // Update read state if requested
            if (markAsRead && unreadMessages.length > 0) {
              updateReadState(requestInfo.agentId, ch.id);
            }
          }

          // Sort by createdAt and limit
          allMessages.sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );

          return {
            content: [
              {
                type: "text",
                text: `Found ${allMessages.length} unread message(s) across ${allChannels.length} channel(s).`,
              },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: true,
              message: `Found ${allMessages.length} unread message(s) across all channels.`,
              messages: allMessages,
              totalUnreadCount,
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
              messages: [],
            },
          };
        }

        let messages;

        if (mentionsOnly) {
          // Get messages that mention this agent
          messages = getMentionsForAgent(requestInfo.agentId, {
            unreadOnly,
            channelId: targetChannel.id,
          });
        } else if (unreadOnly) {
          // Get unread messages only
          messages = getUnreadMessages(requestInfo.agentId, targetChannel.id);
        } else {
          // Get regular messages with filters
          messages = getChannelMessages(targetChannel.id, {
            limit,
            since,
          });
        }

        // Apply limit if not already applied (unreadOnly and mentionsOnly don't limit)
        if ((unreadOnly || mentionsOnly) && messages.length > limit) {
          messages = messages.slice(-limit); // Keep most recent
        }

        // Update read state if requested
        if (markAsRead && messages.length > 0) {
          updateReadState(requestInfo.agentId, targetChannel.id);
        }

        // Get unread count for context
        const allUnread = getUnreadMessages(requestInfo.agentId, targetChannel.id);

        return {
          content: [
            {
              type: "text",
              text: `Found ${messages.length} message(s) in #${targetChannel.name}${unreadOnly ? " (unread)" : ""}${mentionsOnly ? " (mentions)" : ""}.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found ${messages.length} message(s) in #${targetChannel.name}.`,
            channelName: targetChannel.name,
            messages,
            unreadCount: allUnread.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to read messages: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to read messages: ${message}`,
            messages: [],
          },
        };
      }
    },
  );
};
