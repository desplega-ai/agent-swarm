import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { storeLinks } from "@/be/memory/link-resolver";
import { createToolRegistrar } from "@/tools/utils";
import { AgentMemorySchema, AgentMemoryScopeSchema } from "@/types";

export const registerMemoryEditTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-edit",
    {
      title: "Edit a memory",
      description:
        "Edit a single memory in place while preserving its ID, usefulness posterior, and audit history. Two modes: 'replace' overwrites the entire content (requires `content`); 'exact' performs a surgical find-and-replace of `oldString` with `newString` within the existing content (fails if `oldString` is missing or ambiguous). Use 'replace' for full rewrites, 'exact' for targeted edits.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        memoryId: z.uuid().optional().describe("The memory ID to edit."),
        key: z.string().min(1).optional().describe("Structured key alternative to memoryId."),
        scope: AgentMemoryScopeSchema.optional().describe("Required when editing by key."),
        mode: z
          .enum(["replace", "exact"])
          .default("replace")
          .describe(
            "'replace' overwrites the entire memory content; 'exact' finds a unique substring (oldString) and replaces it with newString.",
          ),
        content: z
          .string()
          .min(1)
          .optional()
          .describe("Full replacement content. Required for 'replace' mode, ignored in 'exact'."),
        oldString: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Substring to find in existing content. Required for 'exact' mode. Must appear exactly once.",
          ),
        newString: z
          .string()
          .optional()
          .describe(
            "Replacement for oldString. Required for 'exact' mode. Can be empty to delete.",
          ),
        intent: z.string().min(1).describe("Why you are editing this memory."),
        expectedVersion: z.number().int().min(1).optional(),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        memory: AgentMemorySchema.optional(),
        changed: z.boolean().optional(),
        previousVersion: z.number().int().optional(),
        version: z.number().int().optional(),
      }),
    },
    async (
      { memoryId, key, scope, mode, content, oldString, newString, intent, expectedVersion },
      requestInfo,
      _meta,
    ) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID required to edit memories." }],
          structuredContent: {
            yourAgentId: undefined,
            success: false,
            message: "Agent ID required. Are you registered in the swarm?",
          },
        };
      }

      if (!memoryId && !(key && scope)) {
        return {
          content: [{ type: "text", text: "memoryId or key+scope required." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "memoryId or key+scope required.",
          },
        };
      }

      try {
        const store = getMemoryStore();
        const result = store.edit({
          id: memoryId,
          key,
          scope,
          agentId: requestInfo.agentId,
          mode,
          content,
          oldString,
          newString,
          intent,
          expectedVersion,
          changedByAgentId: requestInfo.agentId,
        });

        if (result.changed) {
          const provider = getEmbeddingProvider();
          const embedding = await provider.embed(result.memory.content);
          if (embedding) store.updateEmbedding(result.memory.id, embedding, provider.name);
          try {
            storeLinks(result.memory.id, requestInfo.agentId, result.memory.content);
          } catch (err) {
            console.error(
              `[memory-edit] Link resolution failed for ${result.memory.id}:`,
              (err as Error).message,
            );
          }
        }

        return {
          content: [
            {
              type: "text",
              text: result.changed
                ? `Memory "${result.memory.id}" edited to version ${result.version}.`
                : `Memory "${result.memory.id}" unchanged.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: result.changed
              ? `Memory edited to version ${result.version}.`
              : "Memory unchanged.",
            memory: result.memory,
            changed: result.changed,
            previousVersion: result.previousVersion,
            version: result.version,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Memory edit failed: ${(err as Error).message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Memory edit failed: ${(err as Error).message}`,
          },
        };
      }
    },
  );
};
