import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMyAgentInfoTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "my-agent-info",
    {
      title: "Get your agent info",
      description: "Returns your agent ID based on the X-Agent-ID header.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        agentId: z.string().optional(),
      }),
    },
    async (_input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [
            {
              type: "text",
              text: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
          },
        };
      }

      const maybeAgent = getAgentById(requestInfo.agentId);

      let registeredMessage =
        " You are not registered as an agent, use the 'join-swarm' tool to register, use a nice name related to the project you are working on if not provided by the user.";

      if (maybeAgent) {
        registeredMessage = ` You are registered as agent "${maybeAgent.name}".`;
      }

      return {
        content: [
          {
            type: "text",
            text: `Your agent ID is: ${requestInfo.agentId}.${registeredMessage}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          yourAgentInfo: maybeAgent,
          success: true,
          message: `Your agent ID is: ${requestInfo.agentId}.${registeredMessage}`,
        },
      };
    },
  );
};
