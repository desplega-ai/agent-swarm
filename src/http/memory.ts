import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { chunkContent } from "../be/chunking";
import { getDb, getTaskById } from "../be/db";
import { getEmbeddingProvider, getMemoryStore } from "../be/memory";
import { canReadMemory } from "../be/memory/access";
import { CANDIDATE_SET_MULTIPLIER } from "../be/memory/constants";
import { listEdgesForAgent } from "../be/memory/edges-store";
import { expandCandidatesWithGraph } from "../be/memory/graph-expansion";
import { refreshLinks, storeLinks } from "../be/memory/link-resolver";
import { getLinksForMemory, type MemoryLinksResult } from "../be/memory/links-store";
import { recordRetrievals } from "../be/memory/raters/retrieval";
import { applyRating, ExplicitSelfDuplicateError } from "../be/memory/raters/store";
import {
  type RatingEvent,
  REFERENCES_SOURCE_MAX_LENGTH,
  sanitizeReferencesSource,
} from "../be/memory/raters/types";
import { rerank } from "../be/memory/reranker";
import { getRetrievalsForAgent, hasRetrievalForTask } from "../be/memory/retrieval-store";
import { getUsefulnessStats } from "../be/memory/usefulness-stats";
import { shouldPersistAutomaticTaskMemory } from "../memory/automatic-task-gate";
import { AgentMemorySchema, AgentMemoryScopeSchema, AgentMemorySourceSchema } from "../types";
import { route } from "./route-def";
import { jsonError, parseQueryParams } from "./utils";

// ─── Response Schemas ────────────────────────────────────────────────────────

// Mirrors `MemoryRetrievalSource` (src/be/memory/types.ts) — the arm that
// surfaced a search candidate. Shared by the search and list result shapes.
const MemoryRetrievalSourceSchema = z.enum(["vec", "fts", "hybrid", "fallback", "graph"]);

// ─── Route Definitions ───────────────────────────────────────────────────────

// Shared shape across the three 202 sends: (1) automatic-task-memory skip,
// (2) single-chunk re-index of an existing sourcePath, (3) fresh batch queue.
const IndexMemoryResponseSchema = z.object({
  queued: z.boolean(),
  memoryIds: z.array(z.string()),
  skipped: z.string().optional(),
  edited: z.boolean().optional(),
});

const indexMemory = route({
  method: "post",
  path: "/api/memory/index",
  pattern: ["api", "memory", "index"],
  summary: "Ingest content into memory system (async embedding)",
  tags: ["Memory"],
  body: z.object({
    agentId: z.string().optional(),
    content: z.string().min(1),
    name: z.string().min(1),
    scope: AgentMemoryScopeSchema,
    source: AgentMemorySourceSchema,
    sourceTaskId: z.string().uuid().optional(),
    sourcePath: z.string().optional(),
    tags: z.array(z.string()).optional(),
    persistMemory: z.boolean().optional(),
    contextKey: z.string().optional(),
  }),
  responses: {
    202: { description: "Content queued for embedding", schema: IndexMemoryResponseSchema },
    400: { description: "Validation error" },
  },
});

const MemorySearchResultItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
  similarity: z.number(),
  rawSimilarity: z.number().optional(),
  compositeScore: z.number().optional(),
  retrievalSource: MemoryRetrievalSourceSchema.optional(),
  source: AgentMemorySourceSchema,
  scope: AgentMemoryScopeSchema,
  tags: z.array(z.string()),
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
    intent: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Why you are searching. Required for agent recall-edge tracking; omit for UI browse/search calls.",
      ),
    limit: z.number().int().min(1).max(20).default(5),
    scope: z.enum(["agent", "swarm", "all"]).default("all"),
    source: z.enum(["manual", "file_index", "session_summary", "task_completion"]).optional(),
  }),
  responses: {
    200: {
      description: "Search results",
      schema: z.object({ results: z.array(MemorySearchResultItemSchema) }),
    },
    400: { description: "Missing query or agent ID" },
  },
});

// Mirrors `MemoryEditResult` (src/be/memory/types.ts) — `store.edit()`'s
// return value, sent verbatim.
const MemoryEditResultSchema = z.object({
  memory: AgentMemorySchema,
  changed: z.boolean(),
  previousVersion: z.number(),
  version: z.number(),
  contentHash: z.string(),
});

const editMemory = route({
  method: "post",
  path: "/api/memory/edit",
  pattern: ["api", "memory", "edit"],
  summary:
    "Edit a single memory in place while preserving its ID and usefulness posterior. Modes: 'replace' overwrites entire content; 'exact' performs surgical find-and-replace of oldString→newString (fails if missing or ambiguous)",
  tags: ["Memory"],
  auth: { apiKey: true, agentId: true },
  body: z.object({
    memoryId: z.string().uuid().optional(),
    key: z.string().min(1).optional(),
    scope: AgentMemoryScopeSchema.optional(),
    mode: z.enum(["replace", "exact"]).default("replace"),
    content: z.string().min(1).optional(),
    oldString: z.string().min(1).optional(),
    newString: z.string().optional(),
    intent: z.string().min(1),
    expectedVersion: z.number().int().min(1).optional(),
  }),
  responses: {
    200: { description: "Memory edited", schema: MemoryEditResultSchema },
    400: { description: "Validation error" },
    404: { description: "Memory not found" },
    409: { description: "Version conflict" },
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
    202: {
      description: "Re-embedding started",
      schema: z.object({ started: z.boolean(), totalMemories: z.number() }),
    },
  },
});

// Shared result item across both listMemory branches: the semantic-search
// branch (query set) populates similarity/rawSimilarity/compositeScore/
// retrievalSource; the plain-list branch (query empty) omits them.
const MemoryListResultItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
  agentId: z.string().nullable(),
  scope: AgentMemoryScopeSchema,
  source: AgentMemorySourceSchema,
  similarity: z.number().optional(),
  rawSimilarity: z.number().optional(),
  compositeScore: z.number().optional(),
  retrievalSource: MemoryRetrievalSourceSchema.optional(),
  createdAt: z.string(),
  accessedAt: z.string(),
  accessCount: z.number(),
  expiresAt: z.string().nullable(),
  embeddingModel: z.string().nullable(),
  sourceTaskId: z.string().nullable(),
  sourcePath: z.string().nullable(),
  chunkIndex: z.number(),
  totalChunks: z.number(),
  tags: z.array(z.string()),
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
    agentId: z.string().optional().describe("Filter to a single agent. Omit for all."),
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
    200: {
      description: "Memory list / search results",
      schema: z.object({
        results: z.array(MemoryListResultItemSchema),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
        mode: z.enum(["semantic", "list"]),
      }),
    },
    400: { description: "Validation error" },
  },
});

// Mirrors `MemoryVecPopulateStats` (src/be/memory/types.ts).
const MemoryVecPopulateStatsSchema = z.object({
  attempted: z.number(),
  inserted: z.number(),
  skippedInvalidDimensions: z.number(),
  failed: z.number(),
  beforeCount: z.number(),
  afterCount: z.number(),
});

// Mirrors `MemoryHealth` (src/be/memory/types.ts) — `store.getHealth()`'s
// return value, sent verbatim.
const MemoryHealthSchema = z.object({
  sqliteVec: z.object({
    extensionLoaded: z.boolean(),
    tableExists: z.boolean(),
    initialized: z.boolean(),
    vectorDimensions: z.number(),
    distanceMetric: z.literal("cosine"),
    schema: z.string().nullable(),
    lastPopulate: MemoryVecPopulateStatsSchema.nullable(),
  }),
  counts: z.object({
    total: z.number(),
    withEmbedding: z.number(),
    validEmbedding: z.number(),
    invalidEmbedding: z.number(),
    searchable: z.number(),
    memoryVec: z.number(),
    missingFromVec: z.number(),
    extraInVec: z.number(),
  }),
  retrievalMode: z.enum(["vec", "fallback"]),
  reasons: z.array(z.string()),
});

const memoryHealth = route({
  method: "get",
  path: "/api/memory/health",
  pattern: ["api", "memory", "health"],
  summary: "Report memory vector index health and retrieval mode",
  tags: ["Memory"],
  auth: { apiKey: true },
  responses: {
    200: { description: "Memory vector index health", schema: MemoryHealthSchema },
  },
});

// Windowed usefulness analytics — sibling of the cheap /health probe.
// Reads memory_retrieval + memory_rating + agent_memory posteriors; plan:
// thoughts/taras/plans/2026-07-02-memory-retrieval-v2-graph-and-measurement.md Phase 1.
// Mirrors `UsefulnessStats` and its nested shapes (src/be/memory/usefulness-stats.ts)
// — `getUsefulnessStats()`'s return value, sent verbatim.
const UsefulnessStatsSchema = z.object({
  windowDays: z.number(),
  threshold: z.number(),
  cutoff: z.string(),
  volume: z.object({
    retrievals: z.number(),
    distinctMemories: z.number(),
    retrievalGroups: z.number(),
    byEventType: z.object({ search: z.number(), get: z.number() }),
  }),
  byArm: z.array(
    z.object({
      retrievalSource: z.string().nullable(),
      retrievals: z.number(),
      distinctMemories: z.number(),
      citedRetrievals: z.number(),
      citationRate: z.number(),
    }),
  ),
  citationBySource: z.array(
    z.object({
      source: z.string(),
      ratings: z.number(),
      positive: z.number(),
      citationRate: z.number(),
      avgSignal: z.number(),
    }),
  ),
  posterior: z.object({
    totalMemories: z.number(),
    movedFromPrior: z.number(),
    avgPosteriorMean: z.number().nullable(),
    avgPosteriorMeanMoved: z.number().nullable(),
    aboveThreshold: z.number(),
  }),
  sanity: z.object({
    totalRetrievalRows: z.number(),
    totalRatingRows: z.number(),
    ratingsBySource: z.array(z.object({ source: z.string(), count: z.number() })),
  }),
});

const memoryUsefulness = route({
  method: "get",
  path: "/api/memory/usefulness",
  pattern: ["api", "memory", "usefulness"],
  summary:
    "Windowed memory usefulness analytics: retrieval volume, per-arm breakdown, citation rate per source, posterior movement",
  tags: ["Memory"],
  auth: { apiKey: true },
  query: z.object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe("Analysis window in days (default 30)"),
    threshold: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.6)
      .describe("Posterior-mean threshold for the aboveThreshold count (default 0.6)"),
  }),
  responses: {
    200: { description: "Usefulness stats for the window", schema: UsefulnessStatsSchema },
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
    200: { description: "Memory deleted", schema: z.object({ deleted: z.boolean() }) },
    404: { description: "Memory not found" },
  },
});

// Mirrors `LinkType` / `TargetKind` (src/be/memory/link-resolver.ts).
const LinkTypeSchema = z.enum([
  "wikilink",
  "sequel",
  "agent-fs-file",
  "agent-ui",
  "pr",
  "external-source",
]);
const TargetKindSchema = z.enum(["memory", "agent-fs-file", "agent-ui", "pr", "external-source"]);

// Mirrors `LinkedMemoryRef` (src/be/memory/links-store.ts).
const LinkedMemoryRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string(),
});

// Mirrors `MemoryLinkView` (src/be/memory/links-store.ts).
const MemoryLinkViewSchema = z.object({
  id: z.string(),
  linkType: LinkTypeSchema,
  targetKind: TargetKindSchema,
  targetId: z.string(),
  strength: z.number(),
  resolver: z.string(),
  sourceText: z.string().nullable(),
  createdAt: z.string(),
  resolved: z.boolean(),
  target: LinkedMemoryRefSchema.optional(),
});

// Mirrors `MemoryBacklinkView` (src/be/memory/links-store.ts).
const MemoryBacklinkViewSchema = z.object({
  id: z.string(),
  linkType: LinkTypeSchema,
  strength: z.number(),
  sourceText: z.string().nullable(),
  createdAt: z.string(),
  from: LinkedMemoryRefSchema,
});

const getMemoryById = route({
  method: "get",
  path: "/api/memory/{id}",
  pattern: ["api", "memory", null],
  summary: "Get a single memory by ID",
  tags: ["Memory"],
  auth: { apiKey: true, agentId: true },
  params: z.object({ id: z.string().uuid() }),
  query: z.object({
    intent: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Why you are retrieving this memory. Required for agent recall-edge tracking; omit for UI browse calls.",
      ),
  }),
  responses: {
    200: {
      description:
        "Memory details, plus `links` (outgoing memory_link rows; memory-kind targets carry `resolved` + ACL-filtered `target` metadata) and `backlinks` (inbound links from other memories, ACL-filtered)",
      schema: z.object({
        memory: AgentMemorySchema,
        links: z.array(MemoryLinkViewSchema),
        backlinks: z.array(MemoryBacklinkViewSchema),
      }),
    },
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
    200: {
      description: "Ratings applied; per-event rejections returned in body",
      schema: z.object({
        applied: z.number(),
        rejected: z.array(z.object({ memoryId: z.string(), reason: z.string() })),
      }),
    },
    400: { description: "Validation error or explicit-self R6 spam-guard rejection" },
    409: { description: "Duplicate explicit-self rating for (taskId, memoryId)" },
  },
});

// Mirrors `RetrievalListRow` (src/be/memory/retrieval-store.ts).
const RetrievalListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
  scope: z.string(),
  source: z.string(),
  scheduleId: z.string().nullable(),
  similarity: z.number().nullable(),
  retrievalSource: z.string().nullable(),
  retrievedAt: z.string(),
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
    200: {
      description: "Retrieval rows joined with agent_memory",
      schema: z.object({ results: z.array(RetrievalListRowSchema) }),
    },
    400: { description: "Missing taskId/sessionId or X-Agent-ID" },
  },
});

// Memory rater v1.5 step-6 — the edges-list endpoint that powers the
// homepage demo ("this memory references PR #377"). Auth by X-Agent-ID +
// Bearer with defence-in-depth: the joined `agent_memory` row must either
// be swarm-scope or owned by the requesting agent. Plan §7.
// Mirrors `MemoryEdgeRow` (src/be/memory/edges-store.ts).
const MemoryEdgeRowSchema = z.object({
  to: z.string(),
  type: z.literal("references-source"),
  alpha: z.number(),
  beta: z.number(),
  usefulness: z.number(),
  createdAt: z.string(),
});

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
    200: {
      description: "Edges with computed usefulness scores",
      schema: z.object({ edges: z.array(MemoryEdgeRowSchema) }),
    },
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

    const {
      agentId,
      content,
      name,
      scope,
      source,
      sourceTaskId,
      sourcePath,
      tags,
      persistMemory,
      contextKey,
    } = parsed.body;
    const memoryAgentId = agentId ?? (scope === "agent" ? myAgentId : undefined);

    if (source === "session_summary" && sourceTaskId) {
      const sourceTask = getTaskById(sourceTaskId);
      if (sourceTask && !shouldPersistAutomaticTaskMemory(sourceTask, persistMemory)) {
        indexMemory.respond(res, 202, {
          queued: false,
          memoryIds: [],
          skipped: "automatic_task_memory_disabled",
        });
        return true;
      }
    }

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

    if (sourcePath && memoryAgentId && contentChunks.length === 1) {
      const existing = store
        .list(memoryAgentId, {
          scope,
          limit: 2,
          ownerAgentId: memoryAgentId,
          sourcePath,
        })
        .filter((memory) => memory.sourcePath === sourcePath);
      if (existing.length === 1 && existing[0]?.totalChunks === 1) {
        const result = store.edit({
          id: existing[0].id,
          mode: "replace",
          content: contentChunks[0]!.content,
          intent: "re-index memory source path",
          changedByAgentId: agentId,
        });
        const embedding = await provider.embed(contentChunks[0]!.content);
        if (embedding) store.updateEmbedding(result.memory.id, embedding, provider.name);
        try {
          // Re-index of an existing memory: prune stale content-derived links.
          refreshLinks(result.memory.id, memoryAgentId, result.memory.content);
        } catch (err) {
          console.error(
            `[memory] Link resolution failed for ${result.memory.id}:`,
            (err as Error).message,
          );
        }
        indexMemory.respond(res, 202, {
          queued: false,
          memoryIds: [result.memory.id],
          edited: result.changed,
        });
        return true;
      }
    }

    // Dedup multi-chunk or ambiguous source paths via the existing lossy path.
    if (sourcePath && memoryAgentId) {
      store.deleteBySourcePath(sourcePath, memoryAgentId);
    }

    // Derive contextKey from body or X-Context-Key header
    const headerContextKey = req.headers["x-context-key"];
    const resolvedContextKey =
      contextKey ??
      (Array.isArray(headerContextKey) ? headerContextKey[0] : headerContextKey) ??
      undefined;

    // Atomic batch insert — all chunks or none
    const memories = store.storeBatch(
      contentChunks.map((chunk) => ({
        agentId: memoryAgentId || null,
        content: chunk.content,
        name,
        scope,
        source,
        sourcePath: sourcePath || null,
        sourceTaskId: sourceTaskId || null,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        tags: tags || [],
        contextKey: resolvedContextKey ?? null,
        intent: "index memory content",
        key: sourcePath || null,
      })),
    );

    // Resolve and store deterministic links (wikilinks, PR refs, agent-fs paths)
    if (memoryAgentId) {
      for (const memory of memories) {
        try {
          storeLinks(memory.id, memoryAgentId, memory.content);
        } catch (err) {
          console.error(
            `[memory] Link resolution failed for ${memory.id}:`,
            (err as Error).message,
          );
        }
      }
    }

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

    indexMemory.respond(res, 202, { queued: true, memoryIds: memories.map((m) => m.id) });
    return true;
  }

  if (searchMemory.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing required fields: query, X-Agent-ID header", 400);
      return true;
    }

    const parsed = await searchMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { query, intent, limit, scope, source } = parsed.body;

    try {
      const provider = getEmbeddingProvider();
      const store = getMemoryStore();
      const queryEmbedding = await provider.embed(query);

      const candidateLimit = Math.min(limit, 20) * CANDIDATE_SET_MULTIPLIER;
      const candidates = store.search(queryEmbedding ?? new Float32Array(0), myAgentId, {
        scope,
        limit: candidateLimit,
        source,
        isLead: false,
        queryText: query,
      });
      // Default-on 1-hop memory_link neighbor expansion (disable with
      // MEMORY_GRAPH_EXPANSION=0|false).
      const expanded = expandCandidatesWithGraph(candidates, myAgentId, {
        scope,
        source,
        isLead: false,
      });
      const ranked = rerank(expanded, { limit: Math.min(limit, 20) });

      // Retrieval bridge — when caller passed `X-Source-Task-ID`, record one
      // `memory_retrieval` row per returned memory so server-side raters
      // (ImplicitCitationRater, fired from store-progress on task completion)
      // know which memories were surfaced. Best-effort: a logging failure must
      // never poison search.
      const sourceTaskIdHeader = req.headers["x-source-task-id"];
      const sourceTaskId = Array.isArray(sourceTaskIdHeader)
        ? sourceTaskIdHeader[0]
        : sourceTaskIdHeader;
      const contextKeyHeader = req.headers["x-context-key"];
      const contextKey = Array.isArray(contextKeyHeader) ? contextKeyHeader[0] : contextKeyHeader;
      if (sourceTaskId && intent) {
        try {
          recordRetrievals(
            sourceTaskId,
            myAgentId,
            ranked.map((r) => ({
              memoryId: r.id,
              similarity: r.similarity,
              retrievalSource: r.retrievalSource,
            })),
            undefined,
            { intent, contextKey, eventType: "search" },
          );
        } catch (err) {
          console.error("[memory-search] recordRetrievals failed:", (err as Error).message);
        }
      }

      searchMemory.respond(res, 200, {
        results: ranked.map((r) => ({
          id: r.id,
          name: r.name,
          content: r.content,
          similarity: r.similarity,
          rawSimilarity: r.rawSimilarity,
          compositeScore: r.compositeScore,
          retrievalSource: r.retrievalSource,
          source: r.source,
          scope: r.scope,
          tags: r.tags,
        })),
      });
    } catch (err) {
      console.error("[memory-search] Error:", (err as Error).message);
      searchMemory.respond(res, 200, { results: [] });
    }
    return true;
  }

  if (listMemory.match(req.method, pathSegments)) {
    const parsed = await listMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { query, agentId, scope, source, sourcePath, limit, offset } = parsed.body;
    const store = getMemoryStore();
    const pageLimit = Math.min(limit, 100);
    const pathNeedle = sourcePath?.trim().toLowerCase();
    const matchesPath = (p: string | null) =>
      !pathNeedle || (p?.toLowerCase().includes(pathNeedle) ?? false);

    try {
      if (query && query.trim().length > 0) {
        const provider = getEmbeddingProvider();
        const queryEmbedding = await provider.embed(query.trim());

        const candidateLimit = Math.min(
          4096,
          Math.max(offset + pageLimit, pageLimit) * CANDIDATE_SET_MULTIPLIER,
        );
        let candidates = store.search(queryEmbedding ?? new Float32Array(0), agentId ?? "", {
          scope,
          limit: candidateLimit,
          isLead: true,
          source,
          queryText: query.trim(),
        });
        if (agentId) {
          candidates = candidates.filter((c) => c.agentId === agentId);
        }
        if (pathNeedle) {
          candidates = candidates.filter((c) => matchesPath(c.sourcePath));
        }
        const ranked = rerank(candidates, { limit: candidates.length });
        const page = ranked.slice(offset, offset + pageLimit);

        listMemory.respond(res, 200, {
          results: page.map((r) => ({
            id: r.id,
            name: r.name,
            content: r.content,
            agentId: r.agentId,
            scope: r.scope,
            source: r.source,
            similarity: r.similarity,
            rawSimilarity: r.rawSimilarity,
            compositeScore: r.compositeScore,
            retrievalSource: r.retrievalSource,
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
          total: candidates.length,
          limit: pageLimit,
          offset,
          mode: "semantic",
        });
        return true;
      }

      const listOptions = {
        scope,
        limit: pageLimit,
        offset,
        isLead: true,
        ownerAgentId: agentId,
        source,
        sourcePath: pathNeedle,
      };
      const rows = store.list(agentId ?? "", listOptions);
      const total = store.count(agentId ?? "", listOptions);

      listMemory.respond(res, 200, {
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
        total,
        limit: pageLimit,
        offset,
        mode: "list",
      });
    } catch (err) {
      console.error("[memory-list] Error:", (err as Error).message);
      jsonError(res, "Memory list failed", 500);
    }
    return true;
  }

  if (editMemory.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const parsed = await editMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { memoryId, key, scope, mode, content, oldString, newString, intent, expectedVersion } =
      parsed.body;
    if (!memoryId && !(key && scope)) {
      jsonError(res, "memoryId or key+scope required", 400);
      return true;
    }

    try {
      const store = getMemoryStore();
      const result = store.edit({
        id: memoryId,
        key,
        scope,
        agentId: myAgentId,
        mode,
        content,
        oldString,
        newString,
        intent,
        expectedVersion,
        changedByAgentId: myAgentId,
      });
      if (result.changed) {
        const provider = getEmbeddingProvider();
        const embedding = await provider.embed(result.memory.content);
        if (embedding) store.updateEmbedding(result.memory.id, embedding, provider.name);
        try {
          // Edit path: prune links derived from removed content (sequel links survive).
          refreshLinks(result.memory.id, myAgentId, result.memory.content);
        } catch (err) {
          console.error(
            `[memory-edit] Link resolution failed for ${result.memory.id}:`,
            (err as Error).message,
          );
        }
      }
      editMemory.respond(res, 200, result);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("not found")) jsonError(res, message, 404);
      else if (message.includes("conflict")) jsonError(res, message, 409);
      else jsonError(res, message, 400);
    }
    return true;
  }

  if (memoryHealth.match(req.method, pathSegments)) {
    const parsed = await memoryHealth.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    memoryHealth.respond(res, 200, getMemoryStore().getHealth());
    return true;
  }

  if (memoryUsefulness.match(req.method, pathSegments)) {
    const queryParams = parseQueryParams(req.url || "");
    const parsed = await memoryUsefulness.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { days, threshold } = parsed.query;
    memoryUsefulness.respond(res, 200, getUsefulnessStats({ days, threshold }));
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
    deleteMemoryById.respond(res, 200, { deleted: true });
    return true;
  }

  if (reEmbedMemory.match(req.method, pathSegments)) {
    const parsed = await reEmbedMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { agentId, batchSize } = parsed.body;
    const store = getMemoryStore();
    const provider = getEmbeddingProvider();
    const memories = store.listForReembedding(agentId ? { agentId } : undefined);

    reEmbedMemory.respond(res, 202, { started: true, totalMemories: memories.length });

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
        const rateContextKeyHeader = req.headers["x-context-key"];
        const rateContextKey = Array.isArray(rateContextKeyHeader)
          ? rateContextKeyHeader[0]
          : rateContextKeyHeader;
        const result = applyRating(ratingEvents, { taskId, contextKey: rateContextKey });
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

    rateMemory.respond(res, 200, { applied, rejected });
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
    getRetrievals.respond(res, 200, { results: rows });
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
    getMemoryEdges.respond(res, 200, { edges });
    return true;
  }

  if (getMemoryById.match(req.method, pathSegments)) {
    const queryParams = parseQueryParams(req.url || "");
    const parsed = await getMemoryById.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const store = getMemoryStore();
    const memoryForAuth = store.peek(parsed.params.id);
    if (!memoryForAuth) {
      jsonError(res, "Memory not found", 404);
      return true;
    }

    if (!canReadMemory(memoryForAuth, myAgentId)) {
      jsonError(res, "Not authorized", 403);
      return true;
    }

    const memory = store.get(parsed.params.id)!;

    const { intent } = parsed.query;
    const sourceTaskIdHeader = req.headers["x-source-task-id"];
    const sourceTaskId = Array.isArray(sourceTaskIdHeader)
      ? sourceTaskIdHeader[0]
      : sourceTaskIdHeader;
    const contextKeyHeader = req.headers["x-context-key"];
    const contextKey = Array.isArray(contextKeyHeader) ? contextKeyHeader[0] : contextKeyHeader;
    if (sourceTaskId && myAgentId && intent) {
      try {
        recordRetrievals(
          sourceTaskId,
          myAgentId,
          [{ memoryId: memory.id, similarity: 1.0 }],
          undefined,
          { intent, contextKey, eventType: "get" },
        );
      } catch (err) {
        console.error("[memory-get] recordRetrievals failed:", (err as Error).message);
      }
    }

    // Link traversal (DES-639b) — best-effort: a graph read failure must
    // never break memory-get. Visibility mirrors the search ACL; the HTTP
    // surface has no lead special-casing (same as POST /api/memory/search).
    let linkBlocks: MemoryLinksResult = { links: [], backlinks: [] };
    try {
      linkBlocks = getLinksForMemory(memory.id, { viewerAgentId: myAgentId });
    } catch (err) {
      console.error("[memory-get] link traversal failed:", (err as Error).message);
    }

    getMemoryById.respond(res, 200, {
      memory,
      links: linkBlocks.links,
      backlinks: linkBlocks.backlinks,
    });
    return true;
  }

  return false;
}

// ─── Expired Memory GC ──────────────────────────────────────────────────────

const MEMORY_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let memoryGcTimer: ReturnType<typeof setInterval> | null = null;

const SEARCH_RETRIEVAL_TTL_DAYS = 90;

function purgeStaleSearchRetrievals(): number {
  try {
    const cutoff = new Date(
      Date.now() - SEARCH_RETRIEVAL_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = getDb()
      .prepare("DELETE FROM memory_retrieval WHERE eventType = 'search' AND retrievedAt < ?")
      .run(cutoff);
    return result.changes;
  } catch (err) {
    console.error("[memory-gc] Search retrieval purge failed:", (err as Error).message);
    return 0;
  }
}

export function startMemoryGc(intervalMs = MEMORY_GC_INTERVAL_MS): void {
  if (memoryGcTimer) return;

  // Run immediately on startup to clear any backlog
  try {
    const purged = getMemoryStore().purgeExpired();
    if (purged > 0) {
      console.log(`[memory-gc] Initial purge removed ${purged} expired memory row(s)`);
    }
    const searchPurged = purgeStaleSearchRetrievals();
    if (searchPurged > 0) {
      console.log(
        `[memory-gc] Initial purge removed ${searchPurged} stale search retrieval row(s)`,
      );
    }
  } catch (err) {
    console.error("[memory-gc] Initial purge failed:", err);
  }

  memoryGcTimer = setInterval(() => {
    try {
      const purged = getMemoryStore().purgeExpired();
      if (purged > 0) {
        console.log(`[memory-gc] Periodic purge removed ${purged} expired memory row(s)`);
      }
      const searchPurged = purgeStaleSearchRetrievals();
      if (searchPurged > 0) {
        console.log(
          `[memory-gc] Periodic purge removed ${searchPurged} stale search retrieval row(s)`,
        );
      }
    } catch (err) {
      console.error("[memory-gc] Periodic purge failed:", err);
    }
  }, intervalMs);
  if (typeof memoryGcTimer?.unref === "function") memoryGcTimer.unref();
}

export function stopMemoryGc(): void {
  if (memoryGcTimer) {
    clearInterval(memoryGcTimer);
    memoryGcTimer = null;
  }
}
