import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { CANDIDATE_SET_MULTIPLIER } from "@/be/memory/constants";
import { rerank } from "@/be/memory/reranker";
import { createToolRegistrar } from "@/tools/utils";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "@/types";

export const registerMemorySearchTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-search",
    {
      title: "Search memories",
      description:
        "Search your accumulated memories using natural language. Returns summaries with IDs — use memory-get to retrieve full content.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        query: z.string().min(1).describe("Natural language search query."),
        scope: z
          .enum(["all", "agent", "swarm"])
          .default("all")
          .describe(
            "Search scope: 'all' (own + swarm), 'agent' (own only), 'swarm' (shared only).",
          ),
        limit: z.number().int().min(1).max(50).default(10).describe("Max results to return."),
        source: AgentMemorySourceSchema.optional().describe("Filter by memory source type."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        results: z
          .array(
            z.object({
              id: z.string().uuid(),
              name: z.string(),
              summary: z.string().nullable(),
              source: AgentMemorySourceSchema,
              scope: AgentMemoryScopeSchema,
              similarity: z.number().optional(),
              createdAt: z.string(),
            }),
          )
          .optional(),
      }),
    },
    async ({ query, scope, limit, source }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID required for memory search." }],
          structuredContent: {
            yourAgentId: undefined,
            success: false,
            message: "Agent ID required. Are you registered in the swarm?",
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      const isLead = agent?.isLead ?? false;

      // Try vector search first
      const provider = getEmbeddingProvider();
      const store = getMemoryStore();
      const queryEmbedding = await provider.embed(query);

      if (queryEmbedding) {
        const candidateLimit = limit * CANDIDATE_SET_MULTIPLIER;
        const candidates = store.search(queryEmbedding, requestInfo.agentId, {
          scope: scope as "agent" | "swarm" | "all",
          limit: candidateLimit,
          source,
          isLead,
        });
        const ranked = rerank(candidates, { limit });

        const mapped = ranked.map((r) => ({
          id: r.id,
          name: r.name,
          summary: r.summary,
          source: r.source,
          scope: r.scope,
          similarity: r.similarity,
          createdAt: r.createdAt,
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${mapped.length} memories matching "${query}".`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found ${mapped.length} memories matching "${query}".`,
            results: mapped,
          },
        };
      }

      // Fallback: list recent memories (no OPENAI_API_KEY)
      const recent = store.list(requestInfo.agentId, {
        scope: scope as "agent" | "swarm" | "all",
        limit,
        isLead,
      });

      const mapped = recent.map((r) => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        source: r.source,
        scope: r.scope,
        createdAt: r.createdAt,
      }));

      return {
        content: [
          {
            type: "text",
            text: `Embedding unavailable. Showing ${mapped.length} most recent memories.`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Embedding unavailable (no OPENAI_API_KEY). Showing ${mapped.length} most recent memories.`,
          results: mapped,
        },
      };
    },
  );
};
