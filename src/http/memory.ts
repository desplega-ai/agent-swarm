import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { chunkContent } from "../be/chunking";
import { getEmbeddingProvider, getMemoryStore } from "../be/memory";
import { CANDIDATE_SET_MULTIPLIER } from "../be/memory/constants";
import { rerank } from "../be/memory/reranker";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const indexMemory = route({
  method: "post",
  path: "/api/memory/index",
  pattern: ["api", "memory", "index"],
  summary: "Ingest content into memory system (async embedding)",
  tags: ["Memory"],
  body: z.object({
    agentId: z.string().uuid().optional(),
    content: z.string().min(1),
    name: z.string().min(1),
    scope: AgentMemoryScopeSchema,
    source: AgentMemorySourceSchema,
    sourceTaskId: z.string().uuid().optional(),
    sourcePath: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  responses: {
    202: { description: "Content queued for embedding" },
    400: { description: "Validation error" },
  },
});

const searchMemory = route({
  method: "post",
  path: "/api/memory/search",
  pattern: ["api", "memory", "search"],
  summary: "Search memories by natural language query",
  tags: ["Memory"],
  auth: { apiKey: true, agentId: true },
  body: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  responses: {
    200: { description: "Search results" },
    400: { description: "Missing query or agent ID" },
  },
});

const reEmbedMemory = route({
  method: "post",
  path: "/api/memory/re-embed",
  pattern: ["api", "memory", "re-embed"],
  summary: "Re-embed all memories using the current embedding provider",
  tags: ["Memory"],
  auth: { apiKey: true },
  body: z.object({
    agentId: z
      .string()
      .uuid()
      .optional()
      .describe("Re-embed only this agent's memories. Omit for all."),
    batchSize: z.number().int().min(1).max(100).default(20).describe("Memories per batch"),
  }),
  responses: {
    202: { description: "Re-embedding started" },
  },
});

const listMemory = route({
  method: "post",
  path: "/api/memory/list",
  pattern: ["api", "memory", "list"],
  summary: "List or semantically search memories across all agents (debug/admin)",
  tags: ["Memory"],
  auth: { apiKey: true },
  body: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Natural-language query. If present, runs semantic search; otherwise lists by recency.",
      ),
    agentId: z.string().uuid().optional().describe("Filter to a single agent. Omit for all."),
    scope: z.enum(["agent", "swarm", "all"]).default("all"),
    source: AgentMemorySourceSchema.optional(),
    sourcePath: z
      .string()
      .optional()
      .describe(
        "Substring match against sourcePath (case-insensitive). Useful for file_index memories.",
      ),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),
  responses: {
    200: { description: "Memory list / search results" },
    400: { description: "Validation error" },
  },
});

const deleteMemoryById = route({
  method: "delete",
  path: "/api/memory/{id}",
  pattern: ["api", "memory", null],
  summary: "Delete a single memory by ID (debug/admin)",
  tags: ["Memory"],
  auth: { apiKey: true },
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Memory deleted" },
    404: { description: "Memory not found" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleMemory(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (indexMemory.match(req.method, pathSegments)) {
    const parsed = await indexMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { agentId, content, name, scope, source, sourceTaskId, sourcePath, tags } = parsed.body;

    // Chunk content and create memories
    const contentChunks = chunkContent(content);
    if (contentChunks.length === 0) {
      contentChunks.push({
        content: content.trim(),
        chunkIndex: 0,
        totalChunks: 1,
        headings: [],
      });
    }

    const store = getMemoryStore();
    const provider = getEmbeddingProvider();

    // Dedup — delete old chunks for this source path
    if (sourcePath && agentId) {
      store.deleteBySourcePath(sourcePath, agentId);
    }

    // Atomic batch insert — all chunks or none
    const memories = store.storeBatch(
      contentChunks.map((chunk) => ({
        agentId: agentId || null,
        content: chunk.content,
        name,
        scope,
        source,
        sourcePath: sourcePath || null,
        sourceTaskId: sourceTaskId || null,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        tags: tags || [],
      })),
    );

    // Async batch embed (fire and forget)
    (async () => {
      try {
        const embeddings = await provider.embedBatch(contentChunks.map((c) => c.content));
        for (let i = 0; i < embeddings.length; i++) {
          if (embeddings[i]) {
            store.updateEmbedding(memories[i]!.id, embeddings[i]!, provider.name);
          }
        }
      } catch (err) {
        console.error("[memory] Batch embedding failed:", (err as Error).message);
      }
    })();

    json(res, { queued: true, memoryIds: memories.map((m) => m.id) }, 202);
    return true;
  }

  if (searchMemory.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing required fields: query, X-Agent-ID header", 400);
      return true;
    }

    const parsed = await searchMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { query, limit } = parsed.body;

    try {
      const provider = getEmbeddingProvider();
      const store = getMemoryStore();
      const queryEmbedding = await provider.embed(query);

      if (!queryEmbedding) {
        json(res, { results: [] });
        return true;
      }

      const candidateLimit = Math.min(limit, 20) * CANDIDATE_SET_MULTIPLIER;
      const candidates = store.search(queryEmbedding, myAgentId, {
        scope: "all",
        limit: candidateLimit,
        isLead: false,
      });
      const ranked = rerank(candidates, { limit: Math.min(limit, 20) });

      json(res, {
        results: ranked.map((r) => ({
          id: r.id,
          name: r.name,
          content: r.content,
          similarity: r.similarity,
          source: r.source,
          scope: r.scope,
        })),
      });
    } catch (err) {
      console.error("[memory-search] Error:", (err as Error).message);
      json(res, { results: [] });
    }
    return true;
  }

  if (listMemory.match(req.method, pathSegments)) {
    const parsed = await listMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { query, agentId, scope, source, sourcePath, limit, offset } = parsed.body;
    const store = getMemoryStore();
    const pathNeedle = sourcePath?.trim().toLowerCase();
    const matchesPath = (p: string | null) =>
      !pathNeedle || (p?.toLowerCase().includes(pathNeedle) ?? false);

    try {
      if (query && query.trim().length > 0) {
        const provider = getEmbeddingProvider();
        const queryEmbedding = await provider.embed(query.trim());

        if (!queryEmbedding) {
          json(res, { results: [], total: 0, mode: "semantic" });
          return true;
        }

        const candidateLimit = Math.min(limit, 100) * CANDIDATE_SET_MULTIPLIER;
        let candidates = store.search(queryEmbedding, agentId ?? "", {
          scope,
          limit: candidateLimit,
          isLead: true,
          source,
        });
        if (agentId) {
          candidates = candidates.filter((c) => c.agentId === agentId);
        }
        if (pathNeedle) {
          candidates = candidates.filter((c) => matchesPath(c.sourcePath));
        }
        const ranked = rerank(candidates, { limit: Math.min(limit, 100) });

        json(res, {
          results: ranked.map((r) => ({
            id: r.id,
            name: r.name,
            content: r.content,
            agentId: r.agentId,
            scope: r.scope,
            source: r.source,
            similarity: r.similarity,
            createdAt: r.createdAt,
            accessedAt: r.accessedAt,
            accessCount: r.accessCount ?? 0,
            expiresAt: r.expiresAt ?? null,
            embeddingModel: r.embeddingModel ?? null,
            sourceTaskId: r.sourceTaskId,
            sourcePath: r.sourcePath,
            chunkIndex: r.chunkIndex,
            totalChunks: r.totalChunks,
            tags: r.tags,
          })),
          total: ranked.length,
          mode: "semantic",
        });
        return true;
      }

      // When filtering by sourcePath, over-fetch then post-filter so the visible
      // page isn't gutted by the in-memory filter.
      const fetchLimit = pathNeedle
        ? Math.min(500, Math.max(limit * 10, 100))
        : Math.min(limit, 100);
      let rows = store.list(agentId ?? "", {
        scope,
        limit: fetchLimit,
        offset,
        isLead: true,
      });
      if (agentId) {
        rows = rows.filter((r) => r.agentId === agentId);
      }
      if (source) {
        rows = rows.filter((r) => r.source === source);
      }
      if (pathNeedle) {
        rows = rows.filter((r) => matchesPath(r.sourcePath));
      }
      rows = rows.slice(0, Math.min(limit, 100));

      json(res, {
        results: rows.map((r) => ({
          id: r.id,
          name: r.name,
          content: r.content,
          agentId: r.agentId,
          scope: r.scope,
          source: r.source,
          createdAt: r.createdAt,
          accessedAt: r.accessedAt,
          accessCount: r.accessCount ?? 0,
          expiresAt: r.expiresAt ?? null,
          embeddingModel: r.embeddingModel ?? null,
          sourceTaskId: r.sourceTaskId,
          sourcePath: r.sourcePath,
          chunkIndex: r.chunkIndex,
          totalChunks: r.totalChunks,
          tags: r.tags,
        })),
        total: rows.length,
        mode: "list",
      });
    } catch (err) {
      console.error("[memory-list] Error:", (err as Error).message);
      jsonError(res, "Memory list failed", 500);
    }
    return true;
  }

  if (deleteMemoryById.match(req.method, pathSegments)) {
    const parsed = await deleteMemoryById.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const store = getMemoryStore();
    const deleted = store.delete(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Memory not found", 404);
      return true;
    }
    json(res, { deleted: true });
    return true;
  }

  if (reEmbedMemory.match(req.method, pathSegments)) {
    const parsed = await reEmbedMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { agentId, batchSize } = parsed.body;
    const store = getMemoryStore();
    const provider = getEmbeddingProvider();
    const memories = store.listForReembedding(agentId ? { agentId } : undefined);

    json(res, { started: true, totalMemories: memories.length }, 202);

    // Async re-embed in batches
    (async () => {
      for (let i = 0; i < memories.length; i += batchSize) {
        const batch = memories.slice(i, i + batchSize);
        try {
          const embeddings = await provider.embedBatch(batch.map((m) => m.content));
          for (let j = 0; j < embeddings.length; j++) {
            if (embeddings[j]) {
              store.updateEmbedding(batch[j]!.id, embeddings[j]!, provider.name);
            }
          }
          console.log(
            `[memory] Re-embedded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(memories.length / batchSize)}`,
          );
        } catch (err) {
          console.error("[memory] Re-embed batch failed:", (err as Error).message);
        }
      }
      console.log(`[memory] Re-embedding complete: ${memories.length} memories`);
    })();

    return true;
  }

  return false;
}
