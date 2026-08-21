import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAllChannels } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";
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

export const registerListChannelsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-channels",
    {
      title: "List Channels",
      description: "Lists all available channels for cross-agent communication.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({}),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        channels: z.array(ChannelOutputSchema).optional(),
      }),
    },
    async (_input, requestInfo, _meta) => {
      const channels = await getAllChannels();

      const details = channels.length
        ? channels.map((c) => `- #${c.name} (${c.type}) — ${c.id}`).join("\n")
        : undefined;

      return toolOk(
        `Found ${channels.length} channel(s): ${channels.map((c) => c.name).join(", ") || "(none)"}`,
        {
          details,
          data: { yourAgentId: requestInfo.agentId, channels },
        },
      );
    },
  );
};
