import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAllTrackerSyncs } from "@/be/db-queries/tracker";
import { createToolRegistrar } from "@/tools/utils";

export const registerTrackerSyncStatusTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-sync-status",
    {
      title: "Tracker Sync Status",
      description: "Show all tracker sync mappings with their state.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        provider: z.string().optional().describe("Filter by provider (e.g. 'linear')"),
        entityType: z.enum(["task", "epic"]).optional().describe("Filter by entity type"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        count: z.number(),
        syncs: z.array(z.any()),
      }),
    },
    async (args, _requestInfo, _meta) => {
      const syncs = getAllTrackerSyncs(args.provider, args.entityType);

      return {
        content: [
          {
            type: "text",
            text: `Found ${syncs.length} tracker sync mapping(s)${args.provider ? ` for ${args.provider}` : ""}${args.entityType ? ` (${args.entityType})` : ""}.`,
          },
        ],
        structuredContent: {
          success: true,
          count: syncs.length,
          syncs,
        },
      };
    },
  );
};
