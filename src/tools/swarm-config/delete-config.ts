import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteSwarmConfig, getSwarmConfigById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeleteConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-config",
    {
      title: "Delete Config",
      description:
        "Delete a swarm configuration entry by its ID. Use list-config to find config IDs first.",
      inputSchema: z.object({
        id: z.string().uuid().describe("The config entry ID to delete."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ id }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      try {
        // Check if config exists first for a better error message
        const existing = getSwarmConfigById(id);
        if (!existing) {
          return {
            content: [{ type: "text", text: `Config entry "${id}" not found.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Config entry "${id}" not found.`,
            },
          };
        }

        const deleted = deleteSwarmConfig(id);
        if (!deleted) {
          return {
            content: [{ type: "text", text: `Failed to delete config entry "${id}".` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Failed to delete config entry "${id}".`,
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Config "${existing.key}" (scope: ${existing.scope}${existing.scopeId ? `, scopeId: ${existing.scopeId}` : ""}) deleted successfully.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Config "${existing.key}" deleted successfully.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to delete config: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to delete config: ${message}`,
          },
        };
      }
    },
  );
};
