import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createTrackerSync } from "@/be/db-queries/tracker";
import { createToolRegistrar } from "@/tools/utils";

export const registerTrackerLinkTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-link-task",
    {
      title: "Link Task to Tracker",
      description: "Link a swarm task to an external tracker issue.",
      annotations: { destructiveHint: false },

      inputSchema: z.object({
        provider: z.string().describe("Tracker provider (e.g. 'linear', 'jira')"),
        swarmTaskId: z.string().describe("The swarm task ID to link"),
        externalId: z.string().describe("The external issue ID in the tracker"),
        externalIdentifier: z
          .string()
          .optional()
          .describe("Human-readable identifier (e.g. 'ENG-42')"),
        externalUrl: z.string().optional().describe("URL to the external issue"),
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
          entityType: "task",
          swarmId: args.swarmTaskId,
          externalId: args.externalId,
          externalIdentifier: args.externalIdentifier ?? null,
          externalUrl: args.externalUrl ?? null,
          syncDirection: "bidirectional",
        });

        return {
          content: [
            {
              type: "text",
              text: `Linked task ${args.swarmTaskId} to ${args.provider} issue ${args.externalIdentifier ?? args.externalId}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Linked task ${args.swarmTaskId} to ${args.provider} issue ${args.externalIdentifier ?? args.externalId}.`,
            sync,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to link task: ${message}` }],
          structuredContent: { success: false, message: `Failed: ${message}` },
        };
      }
    },
  );
};
