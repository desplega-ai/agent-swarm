import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createTrackerSync } from "@/be/db-queries/tracker";
import { createToolRegistrar } from "@/tools/utils";

export const registerTrackerLinkEpicTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-link-epic",
    {
      title: "Link Epic to Tracker",
      description: "Link a swarm epic to an external tracker issue or project.",
      annotations: { destructiveHint: false },

      inputSchema: z.object({
        provider: z.string().describe("Tracker provider (e.g. 'linear')"),
        swarmEpicId: z.string().describe("The swarm epic ID to link"),
        externalId: z.string().describe("The external issue/project ID in the tracker"),
        externalIdentifier: z
          .string()
          .optional()
          .describe("Human-readable identifier (e.g. 'ENG-42')"),
        externalUrl: z.string().optional().describe("URL to the external issue/project"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        sync: z.any().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      try {
        const sync = createTrackerSync({
          provider: args.provider,
          entityType: "epic",
          swarmId: args.swarmEpicId,
          externalId: args.externalId,
          externalIdentifier: args.externalIdentifier ?? null,
          externalUrl: args.externalUrl ?? null,
          syncDirection: "bidirectional",
        });

        return {
          content: [
            {
              type: "text",
              text: `Linked epic ${args.swarmEpicId} to ${args.provider} issue ${args.externalIdentifier ?? args.externalId}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Linked epic ${args.swarmEpicId} to ${args.provider} issue ${args.externalIdentifier ?? args.externalId}.`,
            sync,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to link epic: ${message}` }],
          structuredContent: { success: false, message: `Failed: ${message}` },
        };
      }
    },
  );
};
