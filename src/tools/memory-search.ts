import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { CANDIDATE_SET_MULTIPLIER } from "@/be/memory/constants";
import { expandCandidatesWithGraph } from "@/be/memory/graph-expansion";
import { recordRetrievals } from "@/be/memory/raters/retrieval";
import { rerank } from "@/be/memory/reranker";
import { createToolRegistrar } from "@/tools/utils";
import type { AgentMemorySource } from "@/types";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "@/types";

const NUDGE_ELIGIBLE_SOURCES: ReadonlySet<AgentMemorySource> = new Set(["manual", "file_index"]);

function rateHintFor(memoryId: string): string {
  return `memory_rate(id="${memoryId}", useful=true|false)`;
}

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
        intent: z
          .string()
          .min(1)
          .describe(
            "Why you are searching for this memory. Required. E.g. 'looking for auth pattern to fix login bug'.",
          ),
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
              retrievalSource: z.enum(["vec", "fts", "hybrid", "fallback", "graph"]).optional(),
              tags: z.array(z.string()).optional(),
              createdAt: z.string(),
              rateHint: z.string().optional(),
            }),
          )
          .optional(),
        _ratingNudge: z.string().optional(),
      }),
    },
    async ({ query, intent, scope, limit, source }, requestInfo, _meta) => {
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

      const candidateLimit = limit * CANDIDATE_SET_MULTIPLIER;
      const candidates = store.search(queryEmbedding ?? new Float32Array(0), requestInfo.agentId, {
        scope: scope as "agent" | "swarm" | "all",
        limit: candidateLimit,
        source,
        isLead,
        queryText: query,
      });
      // 1-hop memory_link neighbor expansion (no-op unless MEMORY_GRAPH_EXPANSION=1).
      const expanded = expandCandidatesWithGraph(candidates, requestInfo.agentId, {
        scope: scope as "agent" | "swarm" | "all",
        isLead,
      });
      if (expanded.length > 0) {
        const ranked = rerank(expanded, { limit });

        // Retrieval bridge — when called inside a task scope, log one
        // `memory_retrieval` row per returned memory so server-side raters
        // (ImplicitCitationRater) can score them at task completion.
        // Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-2.md §3
        if (requestInfo.sourceTaskId) {
          try {
            recordRetrievals(
              requestInfo.sourceTaskId,
              requestInfo.agentId,
              ranked.map((r) => ({
                memoryId: r.id,
                similarity: r.similarity,
                retrievalSource: r.retrievalSource,
              })),
              requestInfo.sessionId,
              { intent, contextKey: requestInfo.contextKey, eventType: "search" },
            );
          } catch (err) {
            console.error("[memory-search] recordRetrievals failed:", (err as Error).message);
          }
        }

        const inTaskContext = !!requestInfo.sourceTaskId;
        const mapped = ranked.map((r) => ({
          id: r.id,
          name: r.name,
          summary: r.summary,
          source: r.source,
          scope: r.scope,
          similarity: r.similarity,
          retrievalSource: r.retrievalSource,
          tags: r.tags,
          createdAt: r.createdAt,
          ...(inTaskContext && NUDGE_ELIGIBLE_SOURCES.has(r.source as AgentMemorySource)
            ? { rateHint: rateHintFor(r.id) }
            : {}),
        }));

        const nudgeCount = mapped.filter((r) => r.rateHint).length;
        const _ratingNudge =
          nudgeCount > 0 ? "Rate memories that help or mislead you with memory_rate." : undefined;

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
            _ratingNudge,
          },
        };
      }

      // Fallback: list recent memories (no OPENAI_API_KEY and no FTS hit)
      const recent = store.list(requestInfo.agentId, {
        scope: scope as "agent" | "swarm" | "all",
        limit,
        isLead,
        source,
      });

      const mapped = recent.map((r) => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        source: r.source,
        scope: r.scope,
        tags: r.tags,
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
