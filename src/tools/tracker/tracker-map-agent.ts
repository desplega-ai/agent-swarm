import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createTrackerAgentMapping } from "@/be/db-queries/tracker";
import { createToolRegistrar } from "@/tools/utils";

export const registerTrackerMapAgentTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-map-agent",
    {
      title: "Map Agent to Tracker User",
      description: "Map a swarm agent to an external tracker user (for assignment sync).",
      annotations: { destructiveHint: false },

      inputSchema: z.object({
        provider: z.string().describe("Tracker provider (e.g. 'linear', 'jira')"),
        agentId: z.string().describe("The swarm agent ID"),
        externalUserId: z.string().describe("The external user ID in the tracker"),
        agentName: z.string().describe("Display name for the agent mapping"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        mapping: z.any().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      try {
        const mapping = createTrackerAgentMapping({
          provider: args.provider,
          agentId: args.agentId,
          externalUserId: args.externalUserId,
          agentName: args.agentName,
        });

        return {
          content: [
            {
              type: "text",
              text: `Mapped agent ${args.agentName} to ${args.provider} user ${args.externalUserId}`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Mapped agent ${args.agentName} to ${args.provider} user ${args.externalUserId}.`,
            mapping,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to map agent: ${message}` }],
          structuredContent: { success: false, message: `Failed: ${message}` },
        };
      }
    },
  );
};
