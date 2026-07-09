import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteMcpServer, getAgentById, getMcpServerById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";

export const registerMcpServerDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-delete",
    {
      title: "Delete MCP Server",
      annotations: { destructiveHint: true },
      description: "Delete an MCP server definition. Only the owning agent or lead can delete.",
      inputSchema: z.object({
        id: z.string().describe("ID of the MCP server to delete"),
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

      const existing = getMcpServerById(args.id);
      if (!existing) {
        return {
          content: [{ type: "text", text: "MCP server not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "MCP server not found.",
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "mcp-server.delete.any",
        resource: { kind: "owned", ownerAgentId: existing.ownerAgentId },
        source: "mcp",
      });
      if (!decision.allow) {
        return {
          content: [
            { type: "text", text: "Only the owning agent or lead can delete this MCP server." },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Permission denied.",
          },
        };
      }

      const result = deleteMcpServer(args.id);
      const message = result.deleted
        ? `Deleted MCP server "${existing.name}" and ${result.deletedScriptConnectionCount} script connection(s).`
        : "Delete failed.";
      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: result.deleted,
          message,
        },
      };
    },
  );
};
