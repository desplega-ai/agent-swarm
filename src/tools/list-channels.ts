import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { getAllChannels } from "@swarm/storage";
import { ChannelSchema } from "@swarm/types";
import * as z from "zod";

export const registerListChannelsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-channels",
    {
      title: "List Channels",
      description: "Lists all available channels for cross-agent communication.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({}),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        channels: z.array(ChannelSchema),
      }),
    },
    async (_input, requestInfo, _meta) => {
      const channels = getAllChannels();

      return {
        content: [
          {
            type: "text",
            text: `Found ${channels.length} channel(s): ${channels.map((c) => c.name).join(", ") || "(none)"}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          channels,
        },
      };
    },
  );
};
