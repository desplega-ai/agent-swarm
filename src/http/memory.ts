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
