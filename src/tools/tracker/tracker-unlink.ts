import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteTrackerSync } from "@/be/db-queries/tracker";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema(),
    },
    async (args, _requestInfo, _meta) => {
      try {
        await deleteTrackerSync(args.syncId);
        return toolOk(`Removed tracker sync mapping ${args.syncId}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to unlink: ${message}`);
      }
    },
  );
};
