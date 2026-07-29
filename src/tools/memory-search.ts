import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { CANDIDATE_SET_MULTIPLIER } from "@/be/memory/constants";
import { expandCandidatesWithGraph } from "@/be/memory/graph-expansion";
import { recordRetrievals } from "@/be/memory/raters/retrieval";
import { rerank } from "@/be/memory/reranker";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import type { AgentMemorySource } from "@/types";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "@/types";

const NUDGE_ELIGIBLE_SOURCES: ReadonlySet<AgentMemorySource> = new Set(["manual", "file_index"]);

function rateHintFor(memoryId: string): string {
  return `memory_rate(id="${memoryId}", useful=true|false)`;
}

type MemorySearchResult = {
  id: string;
  name: string;
  summary: string | null;
  source: string;
  scope: string;
  similarity?: number;
  retrievalSource?: string;
  tags?: string[];
  createdAt: string;
  rateHint?: string;
};

function renderResults(results: MemorySearchResult[]): string | undefined {
  if (results.length === 0) return undefined;
  return results
    .map((r) => {
      const score = typeof r.similarity === "number" ? ` score=${r.similarity.toFixed(3)}` : "";
      const summary = r.summary ? ` — ${r.summary}` : "";
      return `- ${r.id} [${r.source}/${r.scope}]${score}${summary}`;
    })
    .join("\n");
}

export const memorySearchOutputSchema = swarmToolOutputSchema({
  // Plain string, NOT .uuid(): agents may join with custom IDs (AGENT_ID env /
  // join-swarm agentId), and a UUID constraint here makes the response fail MCP
  // output validation after the handler already ran.
  yourAgentId: z.string().optional(),
  results: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        name: z.string().optional(),
        summary: z.string().nullable().optional(),
        source: AgentMemorySourceSchema.optional(),
        scope: AgentMemoryScopeSchema.optional(),
        similarity: z.number().optional(),
        retrievalSource: z.enum(["vec", "fts", "hybrid", "fallback", "graph"]).optional(),
        tags: z.array(z.string()).optional(),
        createdAt: z.string().optional(),
        rateHint: z.string().optional(),
      }),
    )
    .optional(),
});

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
      outputSchema: memorySearchOutputSchema,
    },
    async ({ query, intent, scope, limit, source }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required. Are you registered in the swarm?");
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
      // Default-on 1-hop memory_link neighbor expansion (disable with
      // MEMORY_GRAPH_EXPANSION=0|false).
      const expanded = expandCandidatesWithGraph(candidates, requestInfo.agentId, {
        scope: scope as "agent" | "swarm" | "all",
        source,
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

        // The conditional rating steer lives in the central NUDGES map
        // (src/tools/utils.ts), keyed off rateHint presence in the results.
        return toolOk(`Found ${mapped.length} memories matching "${query}".`, {
          details: renderResults(mapped),
          data: { yourAgentId: requestInfo.agentId, results: mapped },
        });
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

      return toolOk(
        `Embedding unavailable (no OPENAI_API_KEY). Showing ${mapped.length} most recent memories.`,
        {
          details: renderResults(mapped),
          data: { yourAgentId: requestInfo.agentId, results: mapped },
        },
      );
    },
  );
};
