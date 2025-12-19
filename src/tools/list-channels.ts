import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAllChannels } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ChannelSchema } from "@/types";

export const registerListChannelsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-channels",
    {
      title: "List Channels",
      description: "Lists all available channels for cross-agent communication.",
      inputSchema: z.object({}),
      outputSchema: z.object({
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
