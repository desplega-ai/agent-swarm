import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getMemoryById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentMemorySchema } from "@/types";

export const registerMemoryGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-get",
    {
      title: "Get memory details",
      description:
        "Retrieve the full content of a specific memory by its ID. Use memory-search to find memory IDs first.",
      inputSchema: z.object({
        memoryId: z.uuid().describe("The ID of the memory to retrieve."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        memory: AgentMemorySchema.optional(),
      }),
    },
    async ({ memoryId }, requestInfo, _meta) => {
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

      return {
        content: [
          {
            type: "text",
            text: `Memory "${memory.name}" retrieved.\n\n${memory.content}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Memory "${memory.name}" retrieved.`,
          memory,
        },
      };
    },
  );
};
