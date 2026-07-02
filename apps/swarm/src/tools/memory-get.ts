import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getMemoryStore } from "@/be/memory";
import { canReadMemory } from "@/be/memory/access";
import { recordRetrievals } from "@/be/memory/raters/retrieval";
import { createToolRegistrar } from "@/tools/utils";
import type { AgentMemorySource } from "@/types";
import { AgentMemorySchema } from "@/types";

const NUDGE_ELIGIBLE_SOURCES: ReadonlySet<AgentMemorySource> = new Set(["manual", "file_index"]);

export const registerMemoryGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-get",
    {
      title: "Get memory details",
      description:
        "Retrieve the full content of a specific memory by its ID. Use memory-search to find memory IDs first.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        memoryId: z.uuid().describe("The ID of the memory to retrieve."),
        intent: z
          .string()
          .min(1)
          .describe(
            "Why you are retrieving this memory. Required. E.g. 'need full details of the auth fix pattern'.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        memory: AgentMemorySchema.optional(),
        rateHint: z.string().optional(),
      }),
    },
    async ({ memoryId, intent }, requestInfo, _meta) => {
      const store = getMemoryStore();
      const memoryForAuth = store.peek(memoryId);

      if (!memoryForAuth) {
        return {
          content: [{ type: "text", text: `Memory "${memoryId}" not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Memory "${memoryId}" not found.`,
          },
        };
      }

      if (!canReadMemory(memoryForAuth, requestInfo.agentId)) {
        return {
          content: [{ type: "text", text: "Not authorized" }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Not authorized",
          },
        };
      }

      const memory = store.get(memoryId)!;

      if (requestInfo.sourceTaskId && requestInfo.agentId) {
        try {
          recordRetrievals(
            requestInfo.sourceTaskId,
            requestInfo.agentId,
            [{ memoryId: memory.id, similarity: 1.0 }],
            requestInfo.sessionId,
            { intent, contextKey: requestInfo.contextKey, eventType: "get" },
          );
        } catch (err) {
          console.error("[memory-get] recordRetrievals failed:", (err as Error).message);
        }
      }

      const inTaskContext = !!requestInfo.sourceTaskId;
      const rateHint =
        inTaskContext && NUDGE_ELIGIBLE_SOURCES.has(memory.source as AgentMemorySource)
          ? `memory_rate(id="${memory.id}", useful=true|false)`
          : undefined;

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
          rateHint,
        },
      };
    },
  );
};
