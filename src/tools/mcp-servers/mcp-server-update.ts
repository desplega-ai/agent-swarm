import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getMcpServerById, updateMcpServer } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMcpServerUpdateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "mcp-server-update",
    {
      title: "Update MCP Server",
      annotations: { destructiveHint: false },
      description: "Update an MCP server's configuration. Only the owner or lead can update.",
      inputSchema: z.object({
        id: z.string().describe("ID of the MCP server to update"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        transport: z.enum(["stdio", "http", "sse"]).optional().describe("New transport type"),
        command: z.string().optional().describe("New command (stdio)"),
        args: z.string().optional().describe("New JSON array of arguments (stdio)"),
        url: z.string().optional().describe("New URL (http/sse)"),
        headers: z.string().optional().describe("New JSON object of non-secret headers"),
        envConfigKeys: z.string().optional().describe("New env config key mappings"),
        headerConfigKeys: z.string().optional().describe("New header config key mappings"),
        isEnabled: z.boolean().optional().describe("Toggle enabled/disabled"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        server: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      try {
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

        // Only owner or lead can update
        const agent = getAgentById(requestInfo.agentId);
        if (existing.ownerAgentId !== requestInfo.agentId && !agent?.isLead) {
          return {
            content: [
              { type: "text", text: "Only the owning agent or lead can update this MCP server." },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Permission denied.",
            },
          };
        }

        const updates: Parameters<typeof updateMcpServer>[1] = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.description !== undefined) updates.description = args.description;
        if (args.transport !== undefined) updates.transport = args.transport;
        if (args.command !== undefined) updates.command = args.command;
        if (args.args !== undefined) updates.args = args.args;
        if (args.url !== undefined) updates.url = args.url;
        if (args.headers !== undefined) updates.headers = args.headers;
        if (args.envConfigKeys !== undefined) updates.envConfigKeys = args.envConfigKeys;
        if (args.headerConfigKeys !== undefined) updates.headerConfigKeys = args.headerConfigKeys;
        if (args.isEnabled !== undefined) updates.isEnabled = args.isEnabled;

        const updated = updateMcpServer(args.id, updates);
        if (!updated) {
          return {
            content: [{ type: "text", text: "Failed to update MCP server." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Update failed.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Updated MCP server "${updated.name}" (v${updated.version})`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Updated MCP server "${updated.name}" to version ${updated.version}.`,
            server: updated,
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
