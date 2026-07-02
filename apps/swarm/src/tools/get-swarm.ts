import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAllAgents } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentSchema } from "@/types";

export const registerGetSwarmTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-swarm",
    {
      title: "Get the agent swarm",
      description:
        "Returns a list of agents in the swarm without their tasks. Identity markdown (claudeMd/soulMd/identityMd/toolsMd/heartbeatMd/setupScript) is omitted by default — pass includeFull:true to include it.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        a: z.string().optional(),
        includeFull: z
          .boolean()
          .optional()
          .describe(
            "Include the six identity-markdown blobs (claudeMd/soulMd/identityMd/toolsMd/heartbeatMd/setupScript). Default false — they are large and rarely needed at the swarm-overview level.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        agents: z.array(AgentSchema),
      }),
    },
    async ({ includeFull }, requestInfo, _meta) => {
      const agents = getAllAgents({ slim: !includeFull });

      return {
        content: [
          {
            type: "text",
            text: `Found ${agents.length} agent(s) in the swarm. Requested by session: ${requestInfo.sessionId}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          agents,
        },
      };
    },
  );
};
