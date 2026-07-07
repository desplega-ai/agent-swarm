import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getMemoryStore } from "@/be/memory";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";

export const registerMemoryDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-delete",
    {
      title: "Delete a memory",
      description:
        "Delete a specific memory by its ID. Agents can delete their own memories; lead agents can also delete swarm-scoped memories.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        memoryId: z.uuid().describe("The ID of the memory to delete."),
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
          content: [{ type: "text", text: "Agent ID required to delete memories." }],
          structuredContent: {
            yourAgentId: undefined,
            success: false,
            message: "Agent ID required. Are you registered in the swarm?",
          },
        };
      }

      const store = getMemoryStore();
      const memory = store.peek(memoryId);

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

      // Permission check: own memories or lead can delete swarm-scoped
      const agent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "memory.delete.any",
        resource: { kind: "owned", ownerAgentId: memory.agentId, scope: memory.scope },
        source: "mcp",
      });
      if (!decision.allow) {
        return {
          content: [{ type: "text", text: "You don't have permission to delete this memory." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message:
              "Permission denied. You can only delete your own memories, or swarm memories if you are the lead.",
          },
        };
      }

      const deleted = store.delete(memoryId);

      return {
        content: [
          {
            type: "text",
            text: deleted
              ? `Memory "${memoryId}" deleted.`
              : `Failed to delete memory "${memoryId}".`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: deleted,
          message: deleted
            ? `Memory "${memoryId}" deleted.`
            : `Failed to delete memory "${memoryId}".`,
        },
      };
    },
  );
};
