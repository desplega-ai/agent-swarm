import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getMcpServerById, getMcpServerByName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        server: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!args.id && !args.name) {
        return {
          content: [{ type: "text", text: "Provide id or name." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Provide id or name.",
          },
        };
      }

      let mcpServer = null;

      if (args.id) {
        mcpServer = getMcpServerById(args.id);
      } else if (args.name && requestInfo.agentId) {
        // Scope cascade: agent > swarm > global
        mcpServer =
          getMcpServerByName(args.name, "agent", requestInfo.agentId) ||
          getMcpServerByName(args.name, "swarm", null) ||
          getMcpServerByName(args.name, "global", null);
      } else if (args.name) {
        mcpServer =
          getMcpServerByName(args.name, "swarm", null) ||
          getMcpServerByName(args.name, "global", null);
      }

      if (!mcpServer) {
        return {
          content: [{ type: "text", text: "MCP server not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "MCP server not found.",
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `MCP server "${mcpServer.name}" (${mcpServer.id}): ${mcpServer.transport} transport, scope=${mcpServer.scope}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Found MCP server "${mcpServer.name}".`,
          server: mcpServer,
        },
      };
    },
  );
};
