import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getMemoryById, markMemoryStale } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerMemoryMarkStaleTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-mark-stale",
    {
      title: "Mark memory as stale",
      description:
        "Mark a memory as stale (e.g., when the referenced file no longer exists). Stale memories are excluded from search results but remain accessible via memory-get.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        memoryId: z.uuid().describe("ID of the memory to mark as stale."),
        reason: z
          .string()
          .optional()
          .describe("Why this memory is stale (e.g., 'file deleted', 'outdated info')."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ memoryId, reason }, requestInfo, _meta) => {
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

      // Ownership check: agent owns the memory or is lead
      const agent = getAgentById(requestInfo.agentId);
      const isLead = agent?.isLead ?? false;
      if (memory.agentId !== requestInfo.agentId && !isLead) {
        return {
          content: [{ type: "text", text: "You can only mark your own memories as stale." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message:
              "You can only mark your own memories as stale. Lead agents can mark any memory.",
          },
        };
      }

      const marked = markMemoryStale(memoryId);
      if (!marked) {
        return {
          content: [{ type: "text", text: "Failed to mark memory as stale." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Failed to mark memory as stale.",
          },
        };
      }

      const reasonSuffix = reason ? ` Reason: ${reason}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Memory "${memory.name}" marked as stale.${reasonSuffix}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Memory "${memory.name}" marked as stale. It will be excluded from search results.${reasonSuffix}`,
        },
      };
    },
  );
};
