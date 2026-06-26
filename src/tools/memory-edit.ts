import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { storeLinks } from "@/be/memory/link-resolver";
import { createToolRegistrar } from "@/tools/utils";

export const registerMemoryEditTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-edit",
    {
      title: "Edit a memory in place",
      description:
        "Edit a memory's content in place, preserving its id, usefulness posteriors, and audit trail. Supports full replacement or exact string substitution.",
      annotations: { readOnlyHint: false },

      inputSchema: z.object({
        memoryId: z
          .string()
          .min(1)
          .optional()
          .describe("Memory ID to edit. Provide either this or key+scope."),
        key: z
          .string()
          .min(1)
          .optional()
          .describe("Structured key to look up the memory. Use with scope."),
        scope: z
          .enum(["agent", "swarm"])
          .optional()
          .describe("Memory scope (required with key lookup)."),
        mode: z
          .enum(["replace", "exact"])
          .describe(
            "'replace' replaces all content; 'exact' does a precise string substitution (oldString must occur exactly once).",
          ),
        content: z
          .string()
          .min(1)
          .optional()
          .describe("New content (required for mode='replace')."),
        oldString: z
          .string()
          .min(1)
          .optional()
          .describe("String to find (required for mode='exact')."),
        newString: z
          .string()
          .optional()
          .describe("Replacement string (required for mode='exact')."),
        name: z.string().min(1).max(500).optional().describe("Optionally update the memory name."),
        intent: z
          .string()
          .min(1)
          .describe(
            "Why you are editing this memory. Required. E.g. 'correct a stale fact about auth flow'.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        changed: z.boolean().optional(),
        id: z.string().uuid().optional(),
        version: z.number().int().optional(),
        contentHash: z.string().optional(),
        reason: z.string().optional(),
      }),
    },
    async (
      { memoryId, key, scope, mode, content, oldString, newString, name, intent },
      requestInfo,
    ) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID required for memory edit." }],
          structuredContent: {
            success: false,
            message: "Agent ID required. Are you registered in the swarm?",
          },
        };
      }

      if (!memoryId && !key) {
        return {
          content: [
            { type: "text", text: "Provide either memoryId or key to identify the memory." },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Provide either memoryId or key to identify the memory.",
          },
        };
      }

      const store = getMemoryStore();
      const result = store.edit({
        id: memoryId,
        key,
        scope: scope as "agent" | "swarm" | undefined,
        agentId: requestInfo.agentId,
        mode,
        content,
        oldString,
        newString,
        name,
        intent,
        changedByAgentId: requestInfo.agentId,
      });

      if (!result.changed) {
        return {
          content: [{ type: "text", text: `Memory not changed: ${result.reason}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: result.reason === "content_unchanged",
            message: `Memory not changed: ${result.reason}`,
            changed: false,
            reason: result.reason,
          },
        };
      }

      // Re-embed asynchronously
      if (result.id) {
        const memory = store.peek(result.id);
        if (memory) {
          // Re-resolve links
          try {
            storeLinks(result.id, requestInfo.agentId, memory.content);
          } catch (err) {
            console.error(
              `[memory-edit] Link resolution failed for ${result.id}:`,
              (err as Error).message,
            );
          }

          // Async re-embed
          (async () => {
            try {
              const provider = getEmbeddingProvider();
              const embedding = await provider.embed(memory.content);
              if (embedding) {
                store.updateEmbedding(result.id!, embedding, provider.name);
              }
            } catch (err) {
              console.error(
                `[memory-edit] Re-embed failed for ${result.id}:`,
                (err as Error).message,
              );
            }
          })();
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Memory ${result.id} edited → version ${result.version}.`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Memory ${result.id} edited → version ${result.version}.`,
          changed: true,
          id: result.id,
          version: result.version,
          contentHash: result.contentHash,
        },
      };
    },
  );
};
