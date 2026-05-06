import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { chunkContent } from "../be/chunking";
import { getEmbeddingProvider, getMemoryStore } from "../be/memory";
import { CANDIDATE_SET_MULTIPLIER } from "../be/memory/constants";
import { listEdgesForAgent } from "../be/memory/edges-store";
import { recordRetrievals } from "../be/memory/raters/retrieval";
import { applyRating, ExplicitSelfDuplicateError } from "../be/memory/raters/store";
import {
  type RatingEvent,
  REFERENCES_SOURCE_MAX_LENGTH,
  sanitizeReferencesSource,
} from "../be/memory/raters/types";
import { rerank } from "../be/memory/reranker";
import { getRetrievalsForAgent, hasRetrievalForTask } from "../be/memory/retrieval-store";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "../types";
import { route } from "./route-def";
import { json, jsonError, parseQueryParams } from "./utils";

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

// Memory rater v1.5 — worker-facing rating endpoints. Plan:
// thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-3.md
//
// `source` is restricted to `llm` and `explicit-self` at the HTTP boundary —
// `implicit-citation` runs in-process server-side via applyRating directly
// and must never arrive over HTTP (defence against worker spoofing).
// `referencesSource` (step-6 §4) — Q2 free-form contract: ≤512 chars,
// control-char strip, NUL byte rejection. Convention `<source>:<identifier>`
// (e.g. github:owner/repo#N, linear:KEY-N, customer:<slug>) is documented
// only in the OpenAPI description — server does NOT validate prefixes and
// does NOT enforce a closed enum. The transform throws via `z.NEVER` when
// sanitization rejects the input so the request fails with a clear 400.
const ReferencesSourceSchema = z
  .string()
  .min(1)
  .max(REFERENCES_SOURCE_MAX_LENGTH)
  .transform((value, ctx) => {
    const cleaned = sanitizeReferencesSource(value);
    if (cleaned === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "referencesSource must not contain NUL bytes or strip to empty",
      });
      return z.NEVER;
    }
    return cleaned;
  })
  .describe(
    'Optional external source ID this memory references. Free-form string, convention "<source>:<identifier>" (e.g. "github:owner/repo#N", "linear:KEY-N", "customer:<slug>", "slack:<channel>:<ts>", "agentmail:<thread-id>"). Pick any prefix that fits — no closed enum. When present, an edge from this memory to the external source is created/updated.',
  );

const RateEventSchema = z.object({
  memoryId: z.string().min(1),
  signal: z.number().min(-1).max(1),
  weight: z.number().min(0).max(1),
  source: z.enum(["llm", "explicit-self"]),
  reasoning: z.string().max(500).optional(),
  taskId: z.string().uuid().optional(),
  referencesSource: ReferencesSourceSchema.optional(),
});

const rateMemory = route({
  method: "post",
  path: "/api/memory/rate",
  pattern: ["api", "memory", "rate"],
  summary: "Submit RatingEvents to update memory usefulness posteriors",
  tags: ["Memory"],
  auth: { apiKey: true, agentId: true },
  body: z.object({
    events: z.array(RateEventSchema).min(1).max(50),
  }),
  responses: {
    200: { description: "Ratings applied; per-event rejections returned in body" },
    400: { description: "Validation error or explicit-self R6 spam-guard rejection" },
    409: { description: "Duplicate explicit-self rating for (taskId, memoryId)" },
  },
});

const getRetrievals = route({
  method: "get",
  path: "/api/memory/retrievals",
  pattern: ["api", "memory", "retrievals"],
  summary: "List memories retrieved for a task or session (rater input)",
  tags: ["Memory"],
  auth: { apiKey: true, agentId: true },
  query: z
    .object({
      taskId: z.string().uuid().optional(),
      sessionId: z.string().optional(),
    })
    .refine((q) => q.taskId || q.sessionId, {
      message: "taskId or sessionId required",
    }),
  responses: {
    200: { description: "Retrieval rows joined with agent_memory" },
    400: { description: "Missing taskId/sessionId or X-Agent-ID" },
  },
});

// Memory rater v1.5 step-6 — the edges-list endpoint that powers the
// homepage demo ("this memory references PR #377"). Auth by X-Agent-ID +
// Bearer with defence-in-depth: the joined `agent_memory` row must either
// be swarm-scope or owned by the requesting agent. Plan §7.
const getMemoryEdges = route({
  method: "get",
  path: "/api/memory/edges",
  pattern: ["api", "memory", "edges"],
  summary: "List references-source edges for a memory",
  tags: ["Memory"],
  auth: { apiKey: true, agentId: true },
  query: z.object({
    memoryId: z.string().min(1),
  }),
  responses: {
    200: { description: "Edges with computed usefulness scores" },
    400: { description: "Missing memoryId or X-Agent-ID" },
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

      // Retrieval bridge — when caller passed `X-Source-Task-ID`, record one
      // `memory_retrieval` row per returned memory so server-side raters
      // (ImplicitCitationRater, fired from store-progress on task completion)
      // know which memories were surfaced. Best-effort: a logging failure must
      // never poison search.
      const sourceTaskIdHeader = req.headers["x-source-task-id"];
      const sourceTaskId = Array.isArray(sourceTaskIdHeader)
        ? sourceTaskIdHeader[0]
        : sourceTaskIdHeader;
      if (sourceTaskId) {
        try {
          recordRetrievals(
            sourceTaskId,
            myAgentId,
            ranked.map((r) => ({ memoryId: r.id, similarity: r.similarity })),
          );
        } catch (err) {
          console.error("[memory-search] recordRetrievals failed:", (err as Error).message);
        }
      }

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

  if (rateMemory.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const parsed = await rateMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { events } = parsed.body;

    // R6 spam guard: explicit-self requires a matching memory_retrieval row.
    // Reject the whole batch on first offender so the worker sees a clear 400.
    for (const evt of events) {
      if (evt.source !== "explicit-self") continue;
      if (!evt.taskId) {
        jsonError(res, `explicit-self rating for memoryId=${evt.memoryId} requires taskId`, 400);
        return true;
      }
      if (!hasRetrievalForTask(evt.taskId, evt.memoryId)) {
        jsonError(
          res,
          `explicit-self rating rejected: memoryId=${evt.memoryId} not present in memory_retrieval for task=${evt.taskId}`,
          400,
        );
        return true;
      }
    }

    // applyRating's ctx carries a single taskId for the batch. Group events by
    // taskId so each call gets a single coherent ctx (and one transaction).
    const groups = new Map<string | undefined, typeof events>();
    for (const evt of events) {
      const list = groups.get(evt.taskId) ?? [];
      list.push(evt);
      groups.set(evt.taskId, list);
    }

    let applied = 0;
    const rejected: { memoryId: string; reason: string }[] = [];
    try {
      for (const [taskId, batch] of groups) {
        const ratingEvents: RatingEvent[] = batch.map((e) => ({
          memoryId: e.memoryId,
          signal: e.signal,
          weight: e.weight,
          source: e.source,
          reasoning: e.reasoning,
          ...(e.referencesSource !== undefined ? { referencesSource: e.referencesSource } : {}),
        }));
        const result = applyRating(ratingEvents, { taskId });
        applied += result.applied;
        for (const r of result.rejected) {
          rejected.push({ memoryId: r.event.memoryId, reason: r.reason });
        }
      }
    } catch (err) {
      if (err instanceof ExplicitSelfDuplicateError) {
        jsonError(res, `Duplicate explicit-self rating for memoryId=${err.event.memoryId}`, 409);
        return true;
      }
      throw err;
    }

    json(res, { applied, rejected });
    return true;
  }

  if (getRetrievals.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const queryParams = parseQueryParams(req.url || "");
    const parsed = await getRetrievals.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { taskId, sessionId } = parsed.query;
    const rows = getRetrievalsForAgent(myAgentId, { taskId, sessionId });
    json(res, { results: rows });
    return true;
  }

  if (getMemoryEdges.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const queryParams = parseQueryParams(req.url || "");
    const parsed = await getMemoryEdges.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { memoryId } = parsed.query;
    const edges = listEdgesForAgent(myAgentId, memoryId);
    json(res, { edges });
    return true;
  }

  return false;
}
