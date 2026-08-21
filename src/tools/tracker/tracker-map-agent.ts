import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createTrackerAgentMapping } from "@/be/db-queries/tracker";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        mapping: z.unknown().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      try {
        const mapping = await createTrackerAgentMapping({
          provider: args.provider,
          agentId: args.agentId,
          externalUserId: args.externalUserId,
          agentName: args.agentName,
        });

        return toolOk(
          `Mapped agent ${args.agentName} to ${args.provider} user ${args.externalUserId}.`,
          { data: { mapping } },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to map agent: ${message}`);
      }
    },
  );
};
