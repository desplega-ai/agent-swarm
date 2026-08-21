import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createChannel, getChannelByName } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { ChannelTypeSchema } from "@/types";

const ChannelOutputSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  type: ChannelTypeSchema.optional(),
  createdBy: z.string().optional(),
  participants: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
});

export const registerCreateChannelTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-channel",
    {
      title: "Create Channel",
      annotations: { destructiveHint: false },
      description: "Creates a new channel for cross-agent communication.",
      inputSchema: z.object({
        name: z.string().min(1).max(100).describe("Channel name (must be unique)."),
        description: z.string().max(500).optional().describe("Channel description."),
        type: ChannelTypeSchema.optional().describe("Channel type: 'public' (default) or 'dm'."),
        participants: z.array(z.string()).optional().describe("Agent IDs for DM channels."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        channel: ChannelOutputSchema.optional(),
      }),
    },
    async ({ name, description, type, participants }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      // Check if channel already exists
      const existing = await getChannelByName(name);
      if (existing) {
        return toolErr(`Channel "${name}" already exists.`, {
          data: { yourAgentId: requestInfo.agentId, channel: existing },
        });
      }

      try {
        const channel = createChannel(name, {
          description,
          type: type ?? "public",
          createdBy: requestInfo.agentId,
          participants,
        });

        return toolOk(`Created channel "${name}".`, {
          data: { yourAgentId: requestInfo.agentId, channel },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to create channel: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
