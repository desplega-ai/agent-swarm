import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteTrackerSync } from "@/be/db-queries/tracker";
import { createToolRegistrar } from "@/tools/utils";

export const registerTrackerUnlinkTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-unlink",
    {
      title: "Unlink Tracker Sync",
      description: "Remove a tracker sync mapping by ID.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        syncId: z.string().describe("The tracker sync mapping ID to remove"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      try {
        deleteTrackerSync(args.syncId);
        return {
          content: [{ type: "text", text: `Removed tracker sync mapping ${args.syncId}` }],
          structuredContent: {
            success: true,
            message: `Removed tracker sync mapping ${args.syncId}.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to unlink: ${message}` }],
          structuredContent: { success: false, message: `Failed: ${message}` },
        };
      }
    },
  );
};
