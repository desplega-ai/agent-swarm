import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteChannel, getAgentById, getChannelById, getChannelByName } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const GENERAL_CHANNEL_ID = "00000000-0000-4000-8000-000000000001";

export const registerDeleteChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-channel",
    {
      title: "Delete Channel",
      description:
        "Deletes a channel and all its messages. Only the lead agent can delete channels. The default 'general' channel cannot be deleted.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        channelId: z.string().uuid().optional().describe("The ID of the channel to delete."),
        name: z.string().optional().describe("Channel name (alternative to channelId)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      if (!args.channelId && !args.name) {
        return toolErr("Either channelId or name must be provided.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      // Check authorization: must be lead agent
      const callingAgent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: callingAgent?.isLead ?? false,
        },
        verb: "channel.delete",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Not authorized. Only the lead agent can delete channels.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      try {
        // Find channel by ID or name
        let channel = args.channelId ? getChannelById(args.channelId) : null;
        if (!channel && args.name) {
          channel = getChannelByName(args.name);
        }

        if (!channel) {
          const identifier = args.channelId || args.name;
          return toolErr(`Channel not found: ${identifier}`, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        // Protect the default general channel
        if (channel.id === GENERAL_CHANNEL_ID) {
          return toolErr('The default "general" channel cannot be deleted.', {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const channelName = channel.name;
        const deleted = deleteChannel(channel.id);

        if (!deleted) {
          return toolErr("Failed to delete channel.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        return toolOk(`Deleted channel "${channelName}".`, {
          details: `Deleted channel "${channelName}" and all its messages.`,
          data: { yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to delete channel: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
