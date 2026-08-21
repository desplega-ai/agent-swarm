import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getAllChannels,
  getChannelById,
  getChannelByName,
  getChannelMessages,
  getMentionsForAgent,
  getUnreadMessages,
  releaseMentionProcessing,
  updateReadState,
} from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import type { ChannelMessage } from "@/types";

const ChannelMessageOutputSchema = z.looseObject({
  id: z.string().optional(),
  channelId: z.string().optional(),
  agentId: z.string().nullable().optional(),
  agentName: z.string().optional(),
  content: z.string().optional(),
  replyToId: z.string().optional(),
  mentions: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
});

/** Concise text rendering of messages for the details channel. */
function renderMessages(messages: ChannelMessage[]): string | undefined {
  if (messages.length === 0) return undefined;
  return messages
    .map((m) => `- [${m.createdAt}] ${m.agentName ?? m.agentId ?? "?"}: ${m.content}`)
    .join("\n");
}

export const registerReadMessagesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "read-messages",
    {
      title: "Read Messages",
      description:
        "Reads messages from a channel. If no channel is specified, returns unread messages from ALL channels. Supports filtering by unread, mentions, and time range. Automatically marks messages as read.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        channel: z
          .string()
          .optional()
          .describe("Channel name or ID. If omitted, returns unread messages from all channels."),
        limit: z
          .number()
          .int()
          .min(1)
          .default(20)
          .describe("Max messages to return per channel (default: 20)."),
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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        channelName: z.string().optional(),
        messages: z.array(ChannelMessageOutputSchema).optional(),
        unreadCount: z.number().optional(),
        totalUnreadCount: z.number().optional(),
      }),
    },
    async ({ channel, limit, since, unreadOnly, mentionsOnly, markAsRead }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.', {
          data: { messages: [] },
        });
      }

      try {
        // If no channel specified, get unread messages from all channels
        if (!channel) {
          const allChannels = await getAllChannels();
          let allMessages: Awaited<ReturnType<typeof getUnreadMessages>> = [];
          let totalUnreadCount = 0;

          for (const ch of allChannels) {
            const unreadMessages = await getUnreadMessages(requestInfo.agentId, ch.id);
            totalUnreadCount += unreadMessages.length;

            // Add channel name to messages for context
            const messagesWithChannel = unreadMessages.slice(-limit).map((msg) => ({
              ...msg,
              agentName: msg.agentName ? `${msg.agentName} in #${ch.name}` : `#${ch.name}`,
            }));
            allMessages = allMessages.concat(messagesWithChannel);

            // Update read state if requested
            if (markAsRead && unreadMessages.length > 0) {
              await updateReadState(requestInfo.agentId, ch.id);
              await releaseMentionProcessing(requestInfo.agentId, [ch.id]); // Release processing claim
            }
          }

          // Sort by createdAt and limit
          allMessages.sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );

          return toolOk(`Found ${allMessages.length} unread message(s) across all channels.`, {
            details: renderMessages(allMessages),
            data: {
              yourAgentId: requestInfo.agentId,
              messages: allMessages,
              totalUnreadCount,
            },
          });
        }

        // Find channel by name or ID
        let targetChannel = await getChannelByName(channel);
        if (!targetChannel) {
          targetChannel = await getChannelById(channel);
        }

        if (!targetChannel) {
          return toolErr(`Channel "${channel}" not found.`, {
            data: { yourAgentId: requestInfo.agentId, messages: [] },
          });
        }

        let messages: ChannelMessage[] = [];

        if (mentionsOnly) {
          // Get messages that mention this agent
          messages = await getMentionsForAgent(requestInfo.agentId, {
            unreadOnly,
            channelId: targetChannel.id,
          });
        } else if (unreadOnly) {
          // Get unread messages only
          messages = await getUnreadMessages(requestInfo.agentId, targetChannel.id);
        } else {
          // Get regular messages with filters
          messages = await getChannelMessages(targetChannel.id, {
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
          await updateReadState(requestInfo.agentId, targetChannel.id);
          await releaseMentionProcessing(requestInfo.agentId, [targetChannel.id]); // Release processing claim
        }

        // Get unread count for context
        const allUnread = await getUnreadMessages(requestInfo.agentId, targetChannel.id);

        return toolOk(
          `Found ${messages.length} message(s) in #${targetChannel.name}${unreadOnly ? " (unread)" : ""}${mentionsOnly ? " (mentions)" : ""}.`,
          {
            details: renderMessages(messages),
            data: {
              yourAgentId: requestInfo.agentId,
              channelName: targetChannel.name,
              messages,
              unreadCount: allUnread.length,
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to read messages: ${message}`, {
          data: {
            yourAgentId: requestInfo.agentId,
            messages: [],
          },
        });
      }
    },
  );
};
