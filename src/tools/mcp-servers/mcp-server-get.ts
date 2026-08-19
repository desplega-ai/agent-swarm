import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getMcpServerById, getMcpServerByName } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerMcpServerGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-get",
    {
      title: "Get MCP Server",
      annotations: { destructiveHint: false },
      description:
        "Get MCP server details by ID or name. Name resolution uses scope cascade: agent > swarm > global.",
      inputSchema: z.object({
        id: z.string().optional().describe("MCP server ID"),
        name: z.string().optional().describe("MCP server name (resolved with scope cascade)"),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        server: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!args.id && !args.name) {
        return toolErr("Provide id or name.", { data: { yourAgentId: requestInfo.agentId } });
      }

      let mcpServer = null;

      if (args.id) {
        mcpServer = await getMcpServerById(args.id);
      } else if (args.name && requestInfo.agentId) {
        // Scope cascade: agent > swarm > global
        mcpServer =
          (await getMcpServerByName(args.name, "agent", requestInfo.agentId)) ||
          (await getMcpServerByName(args.name, "swarm", null)) ||
          (await getMcpServerByName(args.name, "global", null));
      } else if (args.name) {
        mcpServer =
          (await getMcpServerByName(args.name, "swarm", null)) ||
          (await getMcpServerByName(args.name, "global", null));
      }

      if (!mcpServer) {
        return toolErr("MCP server not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      return toolOk(`Found MCP server "${mcpServer.name}".`, {
        details: `MCP server "${mcpServer.name}" (${mcpServer.id}): ${mcpServer.transport} transport, scope=${mcpServer.scope}`,
        data: { yourAgentId: requestInfo.agentId, server: mcpServer },
      });
    },
  );
};
