import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { assertKeyWritable, MemoryKeyError } from "@/be/memory/key-guard";
import {
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_KEY_PATTERN,
  MEMORY_KEY_PATTERN_MESSAGE,
} from "@/be/memory/key-paths";
import { refreshLinks } from "@/be/memory/link-resolver";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "@/types";

// Loose, format-pin-free mirror of AgentMemorySchema for MCP output validation.
const agentMemoryOutputSchema = z.looseObject({
  id: z.string().optional(),
  agentId: z.string().nullable().optional(),
  scope: AgentMemoryScopeSchema.optional(),
  key: z.string().nullable().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  summary: z.string().nullable().optional(),
  source: AgentMemorySourceSchema.optional(),
  sourceTaskId: z.string().nullable().optional(),
  sourcePath: z.string().nullable().optional(),
  chunkIndex: z.number().int().optional(),
  totalChunks: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().nullable().optional(),
  accessedAt: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  accessCount: z.number().int().optional(),
  embeddingModel: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
  version: z.number().int().optional(),
});

export const registerMemoryEditTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-edit",
    {
      title: "Edit a memory",
      description:
        "Edit a single memory in place while preserving its ID, usefulness posterior, and audit history. Two modes: 'replace' overwrites the entire content (requires `content`); 'exact' performs a surgical find-and-replace of `oldString` with `newString` within the existing content (fails if `oldString` is missing or ambiguous). Use 'replace' for full rewrites, 'exact' for targeted edits. Pass `newKey` alone to move the memory to another logical path (every chunk, same ID, posterior, access counts and author). A move into /longterm also clears the expiry. Agents can edit their own memories; lead agents can edit any scope.",
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
        newKey: z
          .string()
          .max(MEMORY_KEY_MAX_LENGTH)
          .regex(MEMORY_KEY_PATTERN, MEMORY_KEY_PATTERN_MESSAGE)
          .optional()
          .describe(
            "Move the memory to this logical path, for example '/longterm/facts/swarm-runtime/slug'. Alone it is a pure move: omit content/oldString/newString. Fails when the key is already used in this scope by the same owner. Moving into /longterm marks the memory as curated on every chunk: it stops expiring and is protected from cleanup, and moving it out later does not bring the expiry back. A key under /longterm must start with /longterm/company-story, /longterm/entities/people, /longterm/entities/customers, /longterm/facts, /longterm/decisions, /longterm/workstreams or /longterm/timeline. Paths under /longterm/company-story, /longterm/entities and /longterm/timeline are lead-only.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        memory: agentMemoryOutputSchema.optional(),
        changed: z.boolean().optional(),
        previousVersion: z.number().int().optional(),
        version: z.number().int().optional(),
      }),
    },
    async (
      {
        memoryId,
        key,
        scope,
        mode,
        content,
        oldString,
        newString,
        intent,
        expectedVersion,
        newKey,
      },
      requestInfo,
      _meta,
    ) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required. Are you registered in the swarm?");
      }

      if (!memoryId && !(key && scope)) {
        return toolErr("memoryId or key+scope required.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      try {
        if (newKey) {
          const agent = await getAgentById(requestInfo.agentId);
          assertKeyWritable(newKey, "key", {
            principal: {
              kind: "agent",
              agentId: requestInfo.agentId,
              isLead: agent?.isLead ?? false,
            },
            source: "mcp",
          });
        }

        const store = getMemoryStore();
        // Key+scope edits already constrain the owner in store.edit(). IDs do not.
        // Keep this boundary gate out of the internal indexer/store write path.
        if (memoryId) {
          const memory = await store.peek(memoryId);
          if (!memory) {
            return toolErr(`Memory "${memoryId}" not found.`, {
              data: { yourAgentId: requestInfo.agentId },
            });
          }
          const agent = await getAgentById(requestInfo.agentId);
          const decision = can({
            principal: {
              kind: "agent",
              agentId: requestInfo.agentId,
              isLead: agent?.isLead ?? false,
            },
            verb: "memory.edit.any",
            resource: { kind: "owned", ownerAgentId: memory.agentId, scope: memory.scope },
            source: "mcp",
          });
          if (!decision.allow) {
            return toolErr(
              "Permission denied. You can only edit your own memories unless you are the lead.",
              {
                data: { yourAgentId: requestInfo.agentId },
              },
            );
          }
        }
        const result = await store.edit({
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
          newKey,
        });

        // A pure move leaves the content, so the embedding and links stay valid.
        const contentEdited =
          content !== undefined || oldString !== undefined || newString !== undefined;
        if (result.changed && (newKey === undefined || contentEdited)) {
          const provider = getEmbeddingProvider();
          const embedding = await provider.embed(result.memory.content);
          if (embedding) await store.updateEmbedding(result.memory.id, embedding, provider.name);
          try {
            // Edit path: prune links derived from removed content (sequel links survive).
            await refreshLinks(
              result.memory.id,
              result.memory.agentId ?? requestInfo.agentId,
              result.memory.content,
            );
          } catch (err) {
            console.error(
              `[memory-edit] Link resolution failed for ${result.memory.id}:`,
              (err as Error).message,
            );
          }
        }

        return toolOk(
          result.changed
            ? `Memory "${result.memory.id}" edited to version ${result.version}.`
            : `Memory "${result.memory.id}" unchanged.`,
          {
            data: {
              yourAgentId: requestInfo.agentId,
              memory: result.memory,
              changed: result.changed,
              previousVersion: result.previousVersion,
              version: result.version,
            },
          },
        );
      } catch (err) {
        if (err instanceof MemoryKeyError) {
          return toolErr(err.message, { data: { yourAgentId: requestInfo.agentId } });
        }
        return toolErr(`Memory edit failed: ${(err as Error).message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
