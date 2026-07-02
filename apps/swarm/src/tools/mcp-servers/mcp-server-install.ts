import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getMcpServerById, installMcpServer } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMcpServerInstallTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-install",
    {
      title: "Install MCP Server",
      annotations: { destructiveHint: false },
      description:
        "Install an MCP server for an agent. Self-install is always allowed; cross-agent install requires lead.",
      inputSchema: z.object({
        mcpServerId: z.string().describe("ID of the MCP server to install"),
        agentId: z
          .string()
          .optional()
          .describe("Target agent (default: calling agent). Lead can install for others."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        installation: z.any().optional(),
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

      // Cross-agent install requires lead
      if (targetAgentId !== requestInfo.agentId) {
        const agent = getAgentById(requestInfo.agentId);
        if (!agent?.isLead) {
          return {
            content: [
              {
                type: "text",
                text: "Only leads can install MCP servers for other agents.",
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

      const mcpServer = getMcpServerById(args.mcpServerId);
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

      if (!mcpServer.isEnabled) {
        return {
          content: [{ type: "text", text: "MCP server is disabled." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "MCP server is disabled.",
          },
        };
      }

      try {
        const installation = installMcpServer(targetAgentId, args.mcpServerId);
        return {
          content: [
            {
              type: "text",
              text: `Installed MCP server "${mcpServer.name}" for agent ${targetAgentId}.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Installed MCP server "${mcpServer.name}".`,
            installation,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed: ${message}`,
          },
        };
      }
    },
  );
};
