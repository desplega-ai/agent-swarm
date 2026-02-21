import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteChannel, getAgentById, getChannelById, getChannelByName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

const GENERAL_CHANNEL_ID = "00000000-0000-4000-8000-000000000001";

export const registerDeleteChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-channel",
    {
      title: "Delete Channel",
      description:
        "Deletes a channel and all its messages. Only the lead agent can delete channels. The default 'general' channel cannot be deleted.",
      inputSchema: z.object({
        channelId: z.string().uuid().optional().describe("The ID of the channel to delete."),
        name: z.string().optional().describe("Channel name (alternative to channelId)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      if (!args.channelId && !args.name) {
        return {
          content: [{ type: "text", text: "Either channelId or name must be provided." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Either channelId or name must be provided.",
          },
        };
      }

      // Check authorization: must be lead agent
      const callingAgent = getAgentById(requestInfo.agentId);
      if (!callingAgent?.isLead) {
        return {
          content: [
            { type: "text", text: "Not authorized. Only the lead agent can delete channels." },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Not authorized. Only the lead agent can delete channels.",
          },
        };
      }

      try {
        // Find channel by ID or name
        let channel = args.channelId ? getChannelById(args.channelId) : null;
        if (!channel && args.name) {
          channel = getChannelByName(args.name);
        }

        if (!channel) {
          const identifier = args.channelId || args.name;
          return {
            content: [{ type: "text", text: `Channel not found: ${identifier}` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Channel not found: ${identifier}`,
            },
          };
        }

        // Protect the default general channel
        if (channel.id === GENERAL_CHANNEL_ID) {
          return {
            content: [{ type: "text", text: 'The default "general" channel cannot be deleted.' }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: 'The default "general" channel cannot be deleted.',
            },
          };
        }

        const channelName = channel.name;
        const deleted = deleteChannel(channel.id);

        if (!deleted) {
          return {
            content: [{ type: "text", text: "Failed to delete channel." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to delete channel.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Deleted channel "${channelName}" and all its messages.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Deleted channel "${channelName}".`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to delete channel: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to delete channel: ${message}`,
          },
        };
      }
    },
  );
};
