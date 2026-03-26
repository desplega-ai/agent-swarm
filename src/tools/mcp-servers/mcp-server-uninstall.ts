import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, uninstallMcpServer } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMcpServerUninstallTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-uninstall",
    {
      title: "Uninstall MCP Server",
      annotations: { destructiveHint: true },
      description:
        "Uninstall an MCP server from an agent. Self-uninstall is always allowed; cross-agent requires lead.",
      inputSchema: z.object({
        mcpServerId: z.string().describe("ID of the MCP server to uninstall"),
        agentId: z.string().optional().describe("Target agent (default: calling agent)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      const targetAgentId = args.agentId ?? requestInfo.agentId;

      if (targetAgentId !== requestInfo.agentId) {
        const agent = getAgentById(requestInfo.agentId);
        if (!agent?.isLead) {
          return {
            content: [
              {
                type: "text",
                text: "Only leads can uninstall MCP servers for other agents.",
              },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Permission denied.",
            },
          };
        }
      }

      const removed = uninstallMcpServer(targetAgentId, args.mcpServerId);
      return {
        content: [
          {
            type: "text",
            text: removed ? "MCP server uninstalled." : "MCP server was not installed.",
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: removed,
          message: removed
            ? "MCP server uninstalled."
            : "MCP server was not installed for this agent.",
        },
      };
    },
  );
};
