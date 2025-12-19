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
      description: "Returns a list of agents in the swarm without their tasks.",
      inputSchema: z.object({
        a: z.string().optional(),
      }),
      outputSchema: z.object({
        agents: z.array(AgentSchema),
      }),
    },
    async (_input, requestInfo, _meta) => {
      const agents = getAllAgents();

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
