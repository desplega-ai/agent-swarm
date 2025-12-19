import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createChannel, getChannelByName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ChannelSchema, ChannelTypeSchema } from "@/types";

export const registerCreateChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-channel",
    {
      title: "Create Channel",
      description: "Creates a new channel for cross-agent communication.",
      inputSchema: z.object({
        name: z.string().min(1).max(100).describe("Channel name (must be unique)."),
        description: z.string().max(500).optional().describe("Channel description."),
        type: ChannelTypeSchema.optional().describe("Channel type: 'public' (default) or 'dm'."),
        participants: z.array(z.uuid()).optional().describe("Agent IDs for DM channels."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        channel: ChannelSchema.optional(),
      }),
    },
    async ({ name, description, type, participants }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      // Check if channel already exists
      const existing = getChannelByName(name);
      if (existing) {
        return {
          content: [{ type: "text", text: `Channel "${name}" already exists.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Channel "${name}" already exists.`,
            channel: existing,
          },
        };
      }

      try {
        const channel = createChannel(name, {
          description,
          type: type ?? "public",
          createdBy: requestInfo.agentId,
          participants,
        });

        return {
          content: [{ type: "text", text: `Created channel "${name}".` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created channel "${name}".`,
            channel,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create channel: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to create channel: ${message}`,
          },
        };
      }
    },
  );
};
