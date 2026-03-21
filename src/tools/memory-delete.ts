import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteMemory, getAgentById, getMemoryById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMemoryDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-delete",
    {
      title: "Delete a memory",
      description: "Delete a memory you own. Lead agents can delete any memory.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        memoryId: z.uuid().describe("ID of the memory to delete."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ memoryId }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID required." }],
          structuredContent: {
            yourAgentId: undefined,
            success: false,
            message: "Agent ID required. Are you registered in the swarm?",
          },
        };
      }

      const memory = getMemoryById(memoryId);
      if (!memory) {
        return {
          content: [{ type: "text", text: `Memory "${memoryId}" not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Memory "${memoryId}" not found.`,
          },
        };
      }

      // Ownership check: agent owns it or agent is lead
      const agent = getAgentById(requestInfo.agentId);
      const isLead = agent?.isLead ?? false;
      if (memory.agentId !== requestInfo.agentId && !isLead) {
        return {
          content: [{ type: "text", text: "You can only delete your own memories." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "You can only delete your own memories. Lead agents can delete any memory.",
          },
        };
      }

      const deleted = deleteMemory(memoryId);
      if (!deleted) {
        return {
          content: [{ type: "text", text: "Failed to delete memory." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Failed to delete memory.",
          },
        };
      }

      return {
        content: [{ type: "text", text: `Memory "${memory.name}" deleted.` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Memory "${memory.name}" deleted successfully.`,
        },
      };
    },
  );
};
