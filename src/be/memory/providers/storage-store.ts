import {
  type AgentMemoryRow,
  type MemoryListFilter,
  type MemoryReadExecutor,
  type MemorySearchFilter,
  SerializationFailureError,
} from "@desplega/storage";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "@/be/embedding";
import { getStorage } from "@/be/storage";
import { currentEngineHandle } from "@/be/storage-root";
import { contentSha256 } from "@/commands/profile-sync";
import type { AgentMemory, AgentMemoryScope, AgentMemorySource } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { isInTransaction } from "../../db-client";
import { currentLoopPath, withLoopPath } from "../../event-loop-lag";
import {
  EMBEDDING_DIMENSIONS,
  EXHAUSTIVE_SEARCH_MAX_ROWS,
  isHybridSearchEnabled,
  LEARNING_TTL_DAYS,
  minSimilarity,
  PROTECTED_SOURCES,
  TTL_DEFAULTS,
} from "../constants";
import { isLearningKey, isLongtermKey, LONGTERM_ROOT, tierSource } from "../key-paths";
import { recencyDecay } from "../reranker";
import { REVIEW_TASK_RULE } from "../review-recall-filter";
import { MAX_CANDIDATE_FETCH } from "../search-candidates";
import type {
  MemoryCandidate,
  MemoryDocumentRef,
  MemoryEditInput,
  MemoryEditResult,
  MemoryHealth,
  MemoryInput,
  MemoryListOptions,
  MemoryRetrievalSource,
  MemoryScrubFields,
  MemorySearchOptions,
  MemoryStats,
  MemoryStore,
  MemoryVecPopulateStats,
} from "../types";

const VECTOR_BYTES = EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

/**
 * Rows one hybrid or FTS arm fetches for a `limit`-row search: 4x overfetch up
 * to 100, never fewer than `limit`. A fixed 100 ceiling returned the same rows
 * for every wider limit, so searchMemoryCandidates read it as exhaustion while
 * other documents sat behind 100 chunks of one task.
 */
function armFetchLimit(limit: number): number {
  return Math.min(Math.max(Math.min(limit * 4, 100), limit), MAX_CANDIDATE_FETCH);
}

export type { AgentMemoryRow };
/** How long search reuses one health result. Stale by at most this long. */
export const SEARCH_HEALTH_TTL_MS = 60_000;
/** Off-loop health refreshes a search retries when writes invalidate them, before it counts in-process. */
const SEARCH_HEALTH_MAX_REFRESHES = 3;
/** An off-loop health refresh, for the DB and generation it started under. */
type SearchHealthRefresh = { db: unknown; generation: number; promise: Promise<MemoryHealth> };
const FTS_SCAN_BATCH_SIZE = 1000;
const FTS_POPULATE_BATCH_SIZE = 500;

const memoryRepo = () => getStorage().repos.memory;
/** The engine's off-loop reader for search statements, or undefined (its reads are async already). */
const searchReader = (): MemoryReadExecutor | undefined => getStorage().memoryIndexes.searchReader;
/** The engine has vector search (sqlite-vec loaded, or pgvector installed). */
const vectorSearch = () => getStorage().capabilities.vectorSearch;

/**
 * A serialization failure must reach the transaction that retries it
 * (decision D6): the store's catch-and-continue sites rethrow it.
 */
function rethrowIfRetryable(err: unknown): void {
  if (err instanceof SerializationFailureError) throw err;
}

/** The full-text query terms of `queryText` (at most 12); the repository ORs them as phrases. */
function ftsTerms(queryText: string): string[] {
  return queryText
    .trim()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 12);
}

type SearchArmOptions = {
  scope: string;
  limit: number;
  source?: AgentMemorySource;
  isLead: boolean;
  includeExpired: boolean;
  keyPrefix?: string;
  excludeReviewTaskCompletions?: boolean;
  minSimilarity?: number;
};

/** The repository filter of one search arm. */
function searchFilter(agentId: string, options: SearchArmOptions): MemorySearchFilter {
  return {
    agentId,
    scope: options.scope,
    isLead: options.isLead,
    keyPrefix: options.keyPrefix,
    source: options.source,
    includeExpired: options.includeExpired,
    excludeReviewTaskCompletions: options.excludeReviewTaskCompletions
      ? REVIEW_TASK_RULE
      : undefined,
  };
}

function rowToAgentMemory(row: AgentMemoryRow): AgentMemory {
  return {
    id: row.id,
    agentId: row.agentId,
    scope: row.scope as AgentMemoryScope,
    key: row.key ?? null,
    name: row.name,
    content: row.content,
    summary: row.summary,
    source: row.source as AgentMemorySource,
    sourceTaskId: row.sourceTaskId,
    sourcePath: row.sourcePath,
    chunkIndex: row.chunkIndex,
    totalChunks: row.totalChunks,
    tags: JSON.parse(row.tags || "[]"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
    accessedAt: row.accessedAt,
    expiresAt: row.expiresAt ?? null,
    accessCount: row.accessCount ?? 0,
    embeddingModel: row.embeddingModel ?? null,
    contentHash: row.contentHash ?? null,
    version: row.version ?? 1,
  };
}

export function rowToCandidate(row: AgentMemoryRow, similarity: number): MemoryCandidate {
  return {
    ...rowToAgentMemory(row),
    similarity,
    accessCount: row.accessCount ?? 0,
    expiresAt: row.expiresAt ?? null,
    embeddingModel: row.embeddingModel ?? null,
    alpha: row.alpha ?? 1.0,
    beta: row.beta ?? 1.0,
  };
}

function retrievalSourceFor(sources: Set<MemoryRetrievalSource>): MemoryRetrievalSource {
  if (sources.has("fts") && sources.has("vec")) return "hybrid";
  if (sources.has("fts")) return "fts";
  if (sources.has("vec")) return "vec";
  return "fallback";
}

/**
 * RRF (Reciprocal Rank Fusion) score for hybrid search.
 *
 * Combines rankings from vector (semantic) and FTS (keyword) arms into a single
 * comparable score using the standard RRF formula: score = Σ 1/(k + rank + 1)
 * where k=60 is the smoothing constant that prevents top-ranked results from
 * dominating. The score is then modulated by source-aware recency decay so
 * ephemeral sources (session_summary, task_completion) naturally age out.
 *
 * A memory that appears in BOTH vec and FTS arms receives two reciprocal-rank
 * contributions that SUM, boosting it above single-arm matches (compounding).
 *
 * Score range: (0, ~0.033] per arm contribution (1/(60+0+1)=0.0164 max per arm).
 * After decay: [0, ~0.033]. Scores are directly comparable across results.
 */
export function computeRrfScore(rank: number, decayFactor: number, k = 60): number {
  return (1 / (k + rank + 1)) * decayFactor;
}

/**
 * Hybrid score on the vec arm's [0,1] cosine scale.
 *
 * Raw RRF tops out at 2/(k+1) ≈ 0.033 and is rank-based, so the best row of
 * an unrelated query scores the same as an exact hit. The cosine is the
 * absolute relevance signal; RRF, normalised to (0,1] by its two-arm maximum,
 * scales it by keyword/semantic agreement: rank 1 in both arms keeps the full
 * cosine, rank 1 in one arm keeps 75%, and no factor drops below 50%.
 */
export function fusedSimilarity(cosine: number, rrfScore: number, k = 60): number {
  const agreement = Math.min(1, (rrfScore * (k + 1)) / 2);
  return cosine * (0.5 + 0.5 * agreement);
}

/**
 * Compute the next content for a memory edit. Returns the new content string.
 * Throws if validation fails (missing fields, oldString not found, ambiguous match).
 */
export function applyEditMode(
  mode: "replace" | "exact",
  currentContent: string,
  fields: { content?: string; oldString?: string; newString?: string },
): string {
  if (mode === "replace") {
    if (fields.content == null) throw new Error("replace mode requires content");
    return fields.content;
  }
  if (!fields.oldString || fields.newString == null) {
    throw new Error("exact mode requires oldString and newString");
  }
  const first = currentContent.indexOf(fields.oldString);
  if (first === -1) throw new Error("oldString not found");
  if (currentContent.indexOf(fields.oldString, first + fields.oldString.length) !== -1) {
    throw new Error("oldString is ambiguous");
  }
  return (
    currentContent.slice(0, first) +
    fields.newString +
    currentContent.slice(first + fields.oldString.length)
  );
}

function computeExpiresAt(source: AgentMemorySource, key: string | null): string | null {
  const ttlDays = isLearningKey(key) ? LEARNING_TTL_DAYS : TTL_DEFAULTS[tierSource(source, key)];
  if (ttlDays == null) return null;
  return new Date(Date.now() + ttlDays * 86400000).toISOString();
}

/**
 * The memory store over the storage repositories, on either engine. The
 * engine's search indexes (`memoryIndexes`) create and fill `memory_fts` and
 * `memory_vec` where the engine keeps them apart from `agent_memory`, and
 * provide the off-loop search reader where the engine's reads block.
 */
export class StorageMemoryStore implements MemoryStore {
  private vecInitialized = false;
  private ftsInitialized = false;
  private ftsPopulate: Promise<void> | null = null;
  private lastPopulate: MemoryVecPopulateStats | null = null;
  private searchHealthCache: { health: MemoryHealth; db: unknown; at: number } | null = null;
  /** The newest refresh. An older one may still run; its result is checked, not shared. */
  private searchHealthRefresh: SearchHealthRefresh | null = null;
  /**
   * Bumped when the cache is dropped. A refresh that started under an older
   * generation is neither stored nor returned to a search waiting on it.
   */
  private searchHealthGeneration = 0;

  constructor() {
    this.ensureVecTable();
    this.ensureFtsTable();
  }

  private ensureFtsTable(): void {
    if (this.ftsInitialized) return;
    const { ready, backfill } = getStorage().memoryIndexes.ensureFullText();
    this.ftsInitialized = ready;
    if (ready && backfill) {
      this.ftsPopulate = this.populateFtsTable().catch((err) => {
        console.error(
          "[memory-fts] Failed to populate memory_fts:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  private async getFtsTableSchema(): Promise<string | null> {
    try {
      return await memoryRepo().ftsTableSchema();
    } catch (err) {
      rethrowIfRetryable(err);
      return null;
    }
  }

  /**
   * Backfill memory_fts from agent_memory off the constructor's call stack.
   *
   * Two things kept this cheap: the diff SQL is linear (see
   * FTS_MISSING_IDS_SQL), and inserts run in batches that yield the event loop
   * between them, so a cold rebuild cannot stall the API the way the old
   * synchronous correlated anti-join did at boot. Rows written by
   * store()/delete() while this runs go through syncFtsRow/deleteFtsRows.
   * The insert below skips ids memory_fts already holds, in one statement, so
   * a write that commits its memory and FTS rows together cannot be doubled.
   */
  private async populateFtsTable(): Promise<void> {
    const repo = memoryRepo();
    const startedAt = performance.now();
    const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

    // Drop orphan rows and collect the memory ids the index holds.
    const indexed = new Set<string>();
    let removed = 0;
    for (let after = 0; ; ) {
      const rows = await repo.scanFtsBatch(after, FTS_SCAN_BATCH_SIZE);
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.rowid;
      const orphans = rows.filter((row) => row.orphan).map((row) => row.rowid);
      if (orphans.length > 0) {
        await repo.deleteFtsRowsByRowid(orphans);
        removed += orphans.length;
      }
      for (const row of rows) if (!row.orphan && row.memoryId) indexed.add(row.memoryId);
      await yieldLoop();
    }
    if (removed > 0) {
      console.warn(`[memory-fts] removed_extra_rows count=${removed}`);
    }

    const missing: { id: string }[] = [];
    for (let after = 0; ; ) {
      const rows = await repo.scanMemoryIdBatch(after, FTS_SCAN_BATCH_SIZE);
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.rowid;
      for (const row of rows) if (!indexed.has(row.id)) missing.push(row);
      await yieldLoop();
    }

    for (let i = 0; i < missing.length; i += FTS_POPULATE_BATCH_SIZE) {
      const ids = missing.slice(i, i + FTS_POPULATE_BATCH_SIZE).map((row) => row.id);
      await repo.insertMissingFtsRows(ids);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    console.log(
      `[memory-fts] populate missing=${missing.length} ms=${Math.round(performance.now() - startedAt)}`,
    );
  }

  /** Resolves once the boot-time FTS backfill has finished (or failed). */
  whenFtsPopulated(): Promise<void> {
    return this.ftsPopulate ?? Promise.resolve();
  }

  /**
   * Delete and insert run in one transaction (a SAVEPOINT inside a caller's),
   * so a backfill insert cannot land between them, and a failure rolls back
   * only the FTS write. `freshId`: the caller inserted the memory row under a
   * new id in the same transaction, so no FTS row can exist for it and the
   * delete, a full memory_fts scan (memory_id is UNINDEXED), is skipped.
   */
  private async syncFtsRow(
    memoryId: string,
    name: string,
    content: string,
    freshId = false,
  ): Promise<void> {
    if (!this.ftsInitialized && !(await this.getFtsTableSchema())) return;
    try {
      const storage = getStorage();
      await storage.transaction(async () => {
        if (!freshId) await storage.repos.memory.deleteFtsRow(memoryId);
        await storage.repos.memory.insertFtsRow(memoryId, name, content);
      });
    } catch (err) {
      rethrowIfRetryable(err);
      console.error(
        `[memory-fts] sync failed memory_id=${memoryId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async deleteFtsRows(ids: string[]): Promise<void> {
    // Always re-check the CURRENT db's schema instead of trusting
    // ftsInitialized — the flag can outlive a DB swap (tests reinit the DB
    // process-wide), and a stale `true` would make this DELETE throw
    // "no such table: memory_fts". Mirrors the vec guard in purgeByIds.
    if (ids.length === 0 || !(await this.getFtsTableSchema())) return;
    await memoryRepo().deleteFtsRows(ids);
  }

  private ensureVecTable(): void {
    if (this.vecInitialized) return;
    const { initialized, lastPopulate } =
      getStorage().memoryIndexes.ensureVectors(EMBEDDING_DIMENSIONS);
    this.vecInitialized = initialized;
    if (lastPopulate) {
      this.dropSearchHealth();
      this.lastPopulate = lastPopulate;
    }
  }

  /**
   * The vector table's definition, or null when it does not exist. `reader`:
   * read it off the loop with the search health counts, so the read does not
   * wait behind a transaction on the main connection.
   */
  private async getVecTableSchema(reader?: MemoryReadExecutor): Promise<string | null> {
    try {
      return await memoryRepo().vecTableSchema(reader);
    } catch (err) {
      rethrowIfRetryable(err);
      return null;
    }
  }

  private toVecBuffer(embedding: Float32Array): Buffer | null {
    if (embedding.length !== EMBEDDING_DIMENSIONS) return null;
    return serializeEmbedding(embedding);
  }

  async store(input: MemoryInput): Promise<AgentMemory> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const key = input.key ?? `${input.scope}/${input.source}/${id}`;
    const expiresAt = computeExpiresAt(input.source, key);
    // Scrub before the hash, the FTS sync and the caller's embedding (callers
    // embed the returned row's content), so all of them see the same text.
    const name = scrubSecrets(input.name);
    const content = scrubSecrets(input.content);
    const summary = input.summary == null ? null : scrubSecrets(input.summary);
    const contentHash = contentSha256(content);
    const version = 1;

    const storage = getStorage();
    const repo = storage.repos.memory;
    const row = await storage.transaction(async () => {
      const inserted = await repo.insertMemory({
        id,
        agentId: input.agentId ?? null,
        scope: input.scope,
        key,
        name,
        content,
        summary,
        source: input.source,
        sourceTaskId: input.sourceTaskId ?? null,
        sourcePath: input.sourcePath ?? null,
        chunkIndex: input.chunkIndex ?? 0,
        totalChunks: input.totalChunks ?? 1,
        tags: JSON.stringify((input.tags ?? []).map((tag) => scrubSecrets(tag))),
        now,
        expiresAt,
        contextKey: input.contextKey ?? null,
        contentHash,
        version,
      });

      if (!inserted) throw new Error("Failed to create memory");
      await repo.insertMemoryVersion({
        id: crypto.randomUUID(),
        memoryId: inserted.id,
        version,
        content,
        contentHash,
        intent: input.intent ?? "create memory",
        operation: "create",
        changedByAgentId: input.agentId ?? null,
        now,
      });
      // Same transaction: a backfill sees the memory row only with its FTS row.
      await this.syncFtsRow(inserted.id, inserted.name, inserted.content, true);
      return inserted;
    });

    return rowToAgentMemory(row);
  }

  async storeBatch(inputs: MemoryInput[]): Promise<AgentMemory[]> {
    return await getStorage().transaction(async () => {
      const results: AgentMemory[] = [];
      for (const input of inputs) {
        results.push(await this.store(input));
      }
      return results;
    });
  }

  async replaceDocument(
    document: MemoryDocumentRef,
    inputs: MemoryInput[],
  ): Promise<AgentMemory[]> {
    const storage = getStorage();
    return await storage.transaction(async () => {
      // Only this owner's rows of this source, in this scope, under this key.
      // Another source holding the key is left alone and the insert fails.
      const ids = await storage.repos.memory.listDocumentIdsOfSource(
        { key: document.key, scope: document.scope, agentId: document.agentId ?? null },
        document.source,
      );
      if (ids.length > 0) {
        await this.purgeByIds(ids);
        await storage.repos.memory.deleteMemoriesByIds(ids);
      }
      const results: AgentMemory[] = [];
      for (const input of inputs) {
        results.push(await this.store(input));
      }
      return results;
    });
  }

  async get(id: string): Promise<AgentMemory | null> {
    const repo = memoryRepo();
    const row = await repo.findMemoryById(id);
    if (!row) return null;

    // Update accessedAt and increment accessCount
    await repo.touchMemory(id, new Date().toISOString());

    return rowToAgentMemory(row);
  }

  async peek(id: string): Promise<AgentMemory | null> {
    const row = await memoryRepo().findMemoryById(id);
    if (!row) return null;
    return rowToAgentMemory(row);
  }

  async search(
    embedding: Float32Array,
    agentId: string,
    options: MemorySearchOptions = {},
  ): Promise<MemoryCandidate[]> {
    // Nested breadcrumb: the stall line keeps the caller and names the search.
    return withLoopPath(`${currentLoopPath()} > memory.search`, () =>
      this.searchInLoopPath(embedding, agentId, options),
    );
  }

  private async searchInLoopPath(
    embedding: Float32Array,
    agentId: string,
    options: MemorySearchOptions,
  ): Promise<MemoryCandidate[]> {
    const {
      scope = "all",
      limit = 10,
      source,
      isLead = false,
      includeExpired = false,
      keyPrefix,
      excludeReviewTaskCompletions,
    } = options;

    if (options.exhaustive) {
      return this.searchExhaustive(embedding, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
        keyPrefix,
        excludeReviewTaskCompletions,
        minSimilarity: options.minSimilarity,
      });
    }

    const health = await this.searchHealth();
    if (
      isHybridSearchEnabled() &&
      options.queryText &&
      this.ftsInitialized &&
      (await this.getFtsTableSchema()) &&
      health.retrievalMode === "vec" &&
      embedding.length === EMBEDDING_DIMENSIONS
    ) {
      console.log(
        `[memory-search] retrieval_path=hybrid scope=${scope} limit=${limit} vec_rows=${health.counts.memoryVec} searchable=${health.counts.searchable}`,
      );
      return this.searchHybrid(embedding, options.queryText, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
        keyPrefix,
        excludeReviewTaskCompletions,
      });
    }

    if (health.retrievalMode === "vec" && embedding.length === EMBEDDING_DIMENSIONS) {
      console.log(
        `[memory-search] retrieval_path=vec scope=${scope} limit=${limit} vec_rows=${health.counts.memoryVec} searchable=${health.counts.searchable}`,
      );
      return this.searchWithVec(embedding, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
        keyPrefix,
        excludeReviewTaskCompletions,
        minSimilarity: options.minSimilarity,
      });
    }

    if (options.queryText && this.ftsInitialized && (await this.getFtsTableSchema())) {
      console.log(
        `[memory-search] retrieval_path=fts scope=${scope} limit=${limit} reason=${embedding.length !== EMBEDDING_DIMENSIONS ? "query_dimension_mismatch" : health.reasons.join("|") || "vec_unavailable"}`,
      );
      return this.searchFts(options.queryText, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
        keyPrefix,
        excludeReviewTaskCompletions,
      });
    }

    console.log(
      `[memory-search] retrieval_path=fallback scope=${scope} limit=${limit} reason=${embedding.length !== EMBEDDING_DIMENSIONS ? "query_dimension_mismatch" : health.reasons.join("|") || "vec_unavailable"}`,
    );
    return this.searchBruteForce(embedding, agentId, {
      scope,
      limit,
      source,
      isLead,
      includeExpired,
      keyPrefix,
      excludeReviewTaskCompletions,
      minSimilarity: options.minSimilarity,
    });
  }

  private async searchHybrid(
    queryEmbedding: Float32Array,
    queryText: string,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
      keyPrefix?: string;
      excludeReviewTaskCompletions?: boolean;
    },
  ): Promise<MemoryCandidate[]> {
    const overfetchLimit = armFetchLimit(options.limit);
    const vectorCandidates = await this.searchWithVec(queryEmbedding, agentId, {
      ...options,
      limit: overfetchLimit,
    });
    const ftsCandidates = await this.searchFts(queryText, agentId, {
      ...options,
      limit: overfetchLimit,
    });

    const byId = new Map<string, MemoryCandidate>();
    const rrf = new Map<string, number>();
    const cosines = new Map<string, number>();
    const sources = new Map<string, Set<MemoryRetrievalSource>>();
    const add = (candidate: MemoryCandidate, rank: number) => {
      byId.set(candidate.id, byId.get(candidate.id) ?? candidate);
      const retrievalSource = candidate.retrievalSource === "fts" ? "fts" : "vec";
      const candidateSources = sources.get(candidate.id) ?? new Set<MemoryRetrievalSource>();
      candidateSources.add(retrievalSource);
      sources.set(candidate.id, candidateSources);
      if (retrievalSource === "vec") cosines.set(candidate.id, candidate.similarity);
      rrf.set(candidate.id, (rrf.get(candidate.id) ?? 0) + computeRrfScore(rank, 1.0));
    };

    vectorCandidates.forEach(add);
    ftsCandidates.forEach(add);
    await this.fillCosines(queryEmbedding, [...byId.keys()], cosines);

    // Fused score on the same [0,1] scale as the vec arm's cosine, so graph
    // neighbours (derived from it) and the injection threshold compare
    // like with like. Recency decay is left to rerank(), as on the vec path.
    return [...byId.values()]
      .map((candidate) => {
        const similarity = fusedSimilarity(
          cosines.get(candidate.id) ?? 0,
          rrf.get(candidate.id) ?? 0,
        );
        return {
          ...candidate,
          rawSimilarity: similarity,
          similarity,
          retrievalSource: retrievalSourceFor(sources.get(candidate.id) ?? new Set()),
          recencyDecayApplied: false,
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.limit);
  }

  /** Cosine to the query for FTS-only candidates, read from the stored embedding. */
  private async fillCosines(
    queryEmbedding: Float32Array,
    ids: string[],
    cosines: Map<string, number>,
  ): Promise<void> {
    const missing = ids.filter((id) => !cosines.has(id));
    if (missing.length === 0) return;
    const rows = await memoryRepo().listEmbeddingsByIds(missing, searchReader());
    for (const row of rows) {
      if (!row.embedding) continue;
      const embedding = deserializeEmbedding(row.embedding);
      if (embedding.length !== queryEmbedding.length) continue;
      cosines.set(row.id, Math.max(0, cosineSimilarity(queryEmbedding, embedding)));
    }
  }

  private async searchFts(
    queryText: string,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
      keyPrefix?: string;
      excludeReviewTaskCompletions?: boolean;
    },
  ): Promise<MemoryCandidate[]> {
    const terms = ftsTerms(queryText);
    if (terms.length === 0) return [];

    const { limit } = options;
    const filter = searchFilter(agentId, options);

    try {
      const sqlLimit = armFetchLimit(limit);
      const rows = await memoryRepo().searchFtsRows(terms, filter, sqlLimit, searchReader());

      const now = new Date();
      return rows
        .map((row, index) => {
          const rawSimilarity = 1 / (index + 1);
          return {
            ...rowToCandidate(
              row,
              rawSimilarity *
                recencyDecay(row.createdAt, now, row.source as AgentMemorySource, row.key),
            ),
            rawSimilarity,
            retrievalSource: "fts" as const,
            recencyDecayApplied: true,
          };
        })
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    } catch (err) {
      rethrowIfRetryable(err);
      console.warn("[memory-fts] query failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  private async searchWithVec(
    queryEmbedding: Float32Array,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
      keyPrefix?: string;
      excludeReviewTaskCompletions?: boolean;
      minSimilarity?: number;
    },
  ): Promise<MemoryCandidate[]> {
    const { limit } = options;
    const floor = options.minSimilarity ?? minSimilarity();

    const embeddingBuffer = serializeEmbedding(queryEmbedding);
    // sqlite-vec's hard ceiling for knn queries. A table with fewer rows
    // returns them all, so no per-query row count is needed to size k.
    const knnLimit = 4096;

    const rows = await memoryRepo().searchVecRows(
      embeddingBuffer,
      searchFilter(agentId, options),
      knnLimit,
      limit,
      searchReader(),
    );

    const candidates: MemoryCandidate[] = [];
    for (const row of rows) {
      const similarity = 1 - row.distance;
      if (similarity < floor) continue;
      candidates.push({ ...rowToCandidate(row, similarity), retrievalSource: "vec" });
    }

    return candidates;
  }

  /**
   * Exact cosine over the newest EXHAUSTIVE_SEARCH_MAX_ROWS eligible rows,
   * `updatedAt DESC` with an `id` tie-break. While the eligible set fits the
   * cap, every eligible row is scored; past it, older rows are not scored and
   * the call logs `capped=true`. With sqlite-vec loaded, SQLite scores the
   * capped set with `vec_distance_cosine` and only the top `limit` rows leave
   * the query. Without it, JS scores the same capped set reading only id and
   * embedding, then loads full rows for the top `limit`. One call's memory and
   * CPU stay bounded whatever the corpus size, and a missing extension never
   * makes it throw.
   */
  private async searchExhaustive(
    queryEmbedding: Float32Array,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
      keyPrefix?: string;
      excludeReviewTaskCompletions?: boolean;
      minSimilarity?: number;
    },
  ): Promise<MemoryCandidate[]> {
    const { scope, limit } = options;
    const floor = options.minSimilarity ?? minSimilarity();
    // The capped eligible set, newest first, so a capped scan drops the oldest rows.
    const filter = searchFilter(agentId, options);

    const { scanned, top } = vectorSearch()
      ? await this.scoreCappedInSql(queryEmbedding, filter, floor, limit)
      : await this.scoreCappedInJs(queryEmbedding, filter, floor, limit);
    console.log(
      `[memory-search] retrieval_path=exhaustive scope=${scope} limit=${limit} scanned=${scanned} hits=${top.length}${scanned >= EXHAUSTIVE_SEARCH_MAX_ROWS ? " capped=true" : ""}`,
    );
    if (top.length === 0) return [];

    const rows = await memoryRepo().listRowsByIds(
      top.map((hit) => hit.id),
      searchReader(),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const candidates: MemoryCandidate[] = [];
    for (const hit of top) {
      const row = byId.get(hit.id);
      if (row)
        candidates.push({ ...rowToCandidate(row, hit.similarity), retrievalSource: "fallback" });
    }
    return candidates;
  }

  /** Rank the capped set in the engine's vector arithmetic; only the top `limit` ids come back. */
  private async scoreCappedInSql(
    queryEmbedding: Float32Array,
    filter: MemorySearchFilter,
    floor: number,
    limit: number,
  ): Promise<{ scanned: number; top: { id: string; similarity: number }[] }> {
    const repo = memoryRepo();
    const scanned = await repo.countCappedRows(filter, EXHAUSTIVE_SEARCH_MAX_ROWS, searchReader());
    const queryBuffer = serializeEmbedding(queryEmbedding);
    const top = await repo.scoreCappedRows(
      queryBuffer,
      filter,
      EXHAUSTIVE_SEARCH_MAX_ROWS,
      floor,
      limit,
      searchReader(),
    );
    return { scanned, top };
  }

  /** Score the capped set in JS when the engine has no vector search, reading only id + embedding. */
  private async scoreCappedInJs(
    queryEmbedding: Float32Array,
    filter: MemorySearchFilter,
    floor: number,
    limit: number,
  ): Promise<{ scanned: number; top: { id: string; similarity: number }[] }> {
    const rows = await memoryRepo().listCappedEmbeddings(
      filter,
      EXHAUSTIVE_SEARCH_MAX_ROWS,
      searchReader(),
    );
    const scored: { id: string; similarity: number }[] = [];
    for (const row of rows) {
      const emb = deserializeEmbedding(row.embedding);
      if (emb.length !== queryEmbedding.length) continue;
      const similarity = cosineSimilarity(queryEmbedding, emb);
      if (similarity >= floor) scored.push({ id: row.id, similarity });
    }
    scored.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { scanned: rows.length, top: scored.slice(0, limit) };
  }

  private async searchBruteForce(
    queryEmbedding: Float32Array,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
      keyPrefix?: string;
      excludeReviewTaskCompletions?: boolean;
      minSimilarity?: number;
    },
  ): Promise<MemoryCandidate[]> {
    const { limit } = options;
    const floor = options.minSimilarity ?? minSimilarity();

    const rows = await memoryRepo().listEmbeddedRows(
      searchFilter(agentId, options),
      searchReader(),
    );

    const candidates: MemoryCandidate[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const emb = deserializeEmbedding(row.embedding);
      if (emb.length !== queryEmbedding.length) continue;
      const similarity = cosineSimilarity(queryEmbedding, emb);
      if (similarity < floor) continue;
      candidates.push({ ...rowToCandidate(row, similarity), retrievalSource: "fallback" });
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, limit);
  }

  private listFilter(agentId: string, options: MemoryListOptions): MemoryListFilter {
    const { scope = "all", isLead = false, ownerAgentId, source, sourcePath, keyPrefix } = options;
    return {
      agentId,
      scope,
      isLead,
      keyPrefix,
      ownerAgentId,
      source,
      sourcePathNeedle: sourcePath?.trim().toLowerCase() || undefined,
    };
  }

  async list(agentId: string, options: MemoryListOptions = {}): Promise<AgentMemory[]> {
    const { limit = 20, offset = 0 } = options;
    const rows = await memoryRepo().list(this.listFilter(agentId, options), limit, offset);

    return rows.map(rowToAgentMemory);
  }

  async count(agentId: string, options: MemoryListOptions = {}): Promise<number> {
    return memoryRepo().count(this.listFilter(agentId, options));
  }

  isSourceProtected(source: AgentMemorySource, key?: string | null): boolean {
    return PROTECTED_SOURCES.has(tierSource(source, key));
  }

  async edit(input: MemoryEditInput): Promise<MemoryEditResult> {
    if (!input.id && !(input.key && input.scope)) {
      throw new Error("memory edit requires either id or key+scope");
    }

    // The row read, the single-chunk assertion and the `expectedVersion`
    // optimistic-lock check all run INSIDE the transaction: once every read is
    // awaited, a concurrent edit could otherwise commit between the version
    // read and the UPDATE and silently win.
    const storage = getStorage();
    const repo = storage.repos.memory;
    return await storage.transaction(async (): Promise<MemoryEditResult> => {
      const row = input.id
        ? await repo.findMemoryById(input.id)
        : await repo.findFirstChunk({
            key: input.key!,
            scope: input.scope!,
            agentId: input.agentId ?? null,
          });

      if (!row) throw new Error("memory not found");
      // A pure move (newKey, no content fields) may span every chunk; any
      // content edit still needs a single-chunk row.
      const moveOnly =
        input.newKey !== undefined &&
        input.content === undefined &&
        input.oldString === undefined &&
        input.newString === undefined;
      if (!moveOnly && (row.totalChunks ?? 1) !== 1)
        throw new Error("memory edit only supports single-chunk rows");
      if (input.expectedVersion && input.expectedVersion !== (row.version ?? 1)) {
        throw new Error("memory version conflict");
      }

      const previousVersion = row.version ?? 1;
      const moving = input.newKey !== undefined && input.newKey !== row.key;
      // Scrub the edited text before the hash and FTS sync; callers embed the
      // returned content, so the vector matches the stored row.
      const nextContent = moveOnly
        ? row.content
        : scrubSecrets(
            applyEditMode(input.mode, row.content, {
              content: input.content,
              oldString: input.oldString,
              newString: input.newString,
            }),
          );

      const nextHash = contentSha256(nextContent);
      const contentChanged = !moveOnly && nextHash !== row.contentHash;
      if (!contentChanged && !moving) {
        return {
          memory: rowToAgentMemory(row),
          changed: false,
          previousVersion,
          version: previousVersion,
          contentHash: nextHash,
        };
      }

      // Every chunk of the document shares one key, so the move covers all of
      // them. Legacy multi-chunk manual docs carry a distinct key per chunk and
      // cannot be located by key: refuse rather than split the document.
      let targets: AgentMemoryRow[] = [row];
      if (moving) {
        const owner = row.agentId ?? null;
        if (row.key) {
          targets = await repo.listChunks({ key: row.key, scope: row.scope, agentId: owner });
        }
        if (
          targets.length !== (row.totalChunks ?? 1) ||
          targets.some((target, index) => target.chunkIndex !== index)
        ) {
          throw new Error(
            "memory move needs every chunk of the document under one key; this document's chunks do not share one, re-store it with a key",
          );
        }
        const taken = await repo.findAnyIdOfDocument({
          key: input.newKey!,
          scope: row.scope,
          agentId: owner,
        });
        if (taken) throw new Error(`key "${input.newKey}" is already used in this scope`);
      }

      // A move takes the expiry of its destination when the key decides it:
      // into /longterm (curated, never expires), into /learnings (ages out) or
      // out of /learnings (the source's own TTL; none for manual). Any other
      // move, and every in-place edit, keeps the expiry the row already has.
      const resetExpiry =
        moving &&
        (isLongtermKey(input.newKey) || isLearningKey(row.key) !== isLearningKey(input.newKey));
      const expiresAt = resetExpiry
        ? computeExpiresAt(row.source as AgentMemorySource, input.newKey!)
        : row.expiresAt;
      const now = new Date().toISOString();
      const versionIntent = moving
        ? `${input.intent} [key ${row.key ?? "(none)"} -> ${input.newKey}]`
        : input.intent;
      let nextVersion = previousVersion + 1;
      for (const target of targets) {
        const addressed = target.id === row.id;
        const targetContent = addressed ? nextContent : target.content;
        const targetHash = addressed
          ? nextHash
          : (target.contentHash ?? contentSha256(target.content));
        const targetVersion = (target.version ?? 1) + 1;
        if (addressed) nextVersion = targetVersion;
        await repo.insertMemoryVersion({
          id: crypto.randomUUID(),
          memoryId: target.id,
          version: targetVersion,
          content: targetContent,
          contentHash: targetHash,
          intent: versionIntent,
          operation: "edit",
          changedByAgentId: input.changedByAgentId ?? null,
          now,
        });
        await repo.updateChunk({
          id: target.id,
          content: targetContent,
          contentHash: targetHash,
          version: targetVersion,
          updatedAt: now,
          key: moving ? input.newKey! : target.key,
          resetExpiry,
          expiresAt,
        });
      }

      // Same transaction as the row update: a search never sees the new
      // content with the old full-text row, or the reverse.
      if (contentChanged) await this.syncFtsRow(row.id, row.name, nextContent);

      return {
        memory: rowToAgentMemory({
          ...row,
          content: nextContent,
          contentHash: nextHash,
          version: nextVersion,
          updatedAt: now,
          key: moving ? input.newKey! : row.key,
          expiresAt,
        }),
        changed: true,
        previousVersion,
        version: nextVersion,
        contentHash: nextHash,
      };
    });
  }

  async listForCuration(
    agentId?: string,
  ): Promise<{ id: string; source: string; name: string; createdAt: string }[]> {
    // A /longterm key is protected whatever its source (see tierSource).
    return memoryRepo().listForCuration(
      agentId || undefined,
      [...PROTECTED_SOURCES],
      LONGTERM_ROOT,
    );
  }

  async listForReembedding(options?: {
    agentId?: string;
  }): Promise<{ id: string; content: string }[]> {
    return memoryRepo().listForReembedding(options?.agentId || undefined);
  }

  private async purgeByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this.vecInitialized && (await this.getVecTableSchema())) {
      await memoryRepo().deleteVecRows(ids);
      this.noteVecWrite();
    }
    await this.deleteFtsRows(ids);
  }

  async delete(id: string): Promise<boolean> {
    const storage = getStorage();
    const repo = storage.repos.memory;
    return storage.transaction(async () => {
      const row = await repo.findMemoryById(id);
      if (!row) return false;
      // Explicit keys identify a document. Legacy generated keys identify only a row.
      const ids = row.key
        ? await repo.listDocumentIds({ key: row.key, scope: row.scope, agentId: row.agentId })
        : [id];
      await this.purgeByIds(ids);
      await repo.deleteMemoriesByIds(ids);
      return true;
    });
  }

  async deleteBySourcePath(sourcePath: string, agentId: string): Promise<number> {
    const repo = memoryRepo();

    const ids = await repo.listIdsBySourcePath(sourcePath, agentId);

    await this.purgeByIds(ids);

    const changes = await repo.deleteBySourcePath(sourcePath, agentId);
    return ids.length || changes;
  }

  async purgeExpired(): Promise<number> {
    const storage = getStorage();
    const repo = storage.repos.memory;

    const expiredIds = await repo.listExpiredIds();

    if (expiredIds.length === 0) return 0;

    const batchSize = 500;
    let purged = 0;
    for (let i = 0; i < expiredIds.length; i += batchSize) {
      // Yield a macrotask between batches: chained awaits on the DB client are
      // microtasks, so without it the whole purge is one event-loop stall.
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const batch = expiredIds.slice(i, i + batchSize);
      // A memory can be curated (moved to /longterm, expiry cleared) during
      // the yield. Recheck expiry and delete the index rows and memory rows of
      // the batch in one transaction, so a live row never loses its index.
      purged += await storage.transaction(async () => {
        const ids = await repo.filterStillExpired(batch);
        if (ids.length === 0) return 0;
        await this.purgeByIds(ids);
        return repo.deleteMemoriesByIds(ids);
      });
    }

    console.log(
      `[memory] Purged ${purged} expired memory row(s) (candidates: ${expiredIds.length} id(s))`,
    );
    return purged;
  }

  async updateEmbedding(id: string, embedding: Float32Array, model: string): Promise<void> {
    const buffer = serializeEmbedding(embedding);
    // One transaction: a delete or replaceDocument queued behind this write
    // cannot land between the row UPDATE and the vec insert and orphan it.
    const storage = getStorage();
    const repo = storage.repos.memory;
    await storage.transaction(async () => {
      const changes = await repo.setEmbedding(id, buffer, model);
      // The row was deleted (or replaced) while its embedding was in flight:
      // a vec row now would point at nothing.
      if (changes === 0) return;

      if (this.vecInitialized && (await this.getVecTableSchema())) {
        const vecBuffer = this.toVecBuffer(embedding);
        if (!vecBuffer) {
          console.warn(
            `[memory-vec] update skipped memory_id=${id} reason=invalid_dimensions dimensions=${embedding.length} expected=${EMBEDDING_DIMENSIONS}`,
          );
          return;
        }
        try {
          await repo.deleteVecRow(id);
          // A savepoint: on Postgres a failed statement aborts the whole
          // transaction, so the embedding update could not commit after it.
          await storage.transaction(() => repo.insertVecRow(id, vecBuffer));
          this.noteVecWrite();
        } catch (err) {
          rethrowIfRetryable(err);
          console.error(
            `[memory-vec] update failed memory_id=${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // The row now misses from memory_vec: search must see the fallback.
          this.invalidateSearchHealth();
        }
      }
    });
  }

  async clearEmbedding(id: string): Promise<void> {
    const storage = getStorage();
    await storage.transaction(async () => {
      await storage.repos.memory.clearEmbedding(id);
      if (this.vecInitialized && (await this.getVecTableSchema())) {
        await storage.repos.memory.deleteVecRow(id);
        this.noteVecWrite();
      }
    });
  }

  async rewriteForScrub(
    id: string,
    before: MemoryScrubFields,
    after: MemoryScrubFields,
  ): Promise<boolean> {
    const contentChanged = after.content !== before.content;
    const storage = getStorage();
    const repo = storage.repos.memory;
    return storage.transaction(async () => {
      // Compare-and-set: the sweep scrubbed `before` outside the write lock, so
      // skip the row if a concurrent write moved it since.
      const changes = await repo.rewriteForScrub(id, before, {
        name: after.name,
        content: after.content,
        summary: after.summary,
        contentHash: contentSha256(after.content),
        dropEmbedding: contentChanged,
      });
      if (changes === 0) return false;
      // The vector embeds the old (secret-bearing) content. Drop it; the
      // re-embed backfill picks the row up via `embedding IS NULL`.
      if (contentChanged && this.vecInitialized && (await this.getVecTableSchema())) {
        await repo.deleteVecRow(id);
        this.noteVecWrite();
      }
      if (after.name !== before.name || contentChanged) {
        await this.syncFtsRow(id, after.name, after.content);
      }
      return true;
    });
  }

  async getStats(agentId: string): Promise<MemoryStats> {
    const {
      total,
      bySource: bySourceRows,
      byScope: byScopeRows,
      withEmbeddings,
      expired,
    } = await memoryRepo().getStatsRows(agentId);

    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) bySource[row.source] = row.count;

    const byScope: Record<string, number> = {};
    for (const row of byScopeRows) byScope[row.scope] = row.count;

    return {
      total,
      bySource,
      byScope,
      withEmbeddings,
      expired,
    };
  }

  /**
   * The same eight counts as getHealth(), as one statement on the engine's
   * off-loop reader (SQLite: a read worker) so the scans block that thread and
   * not the API event loop. One statement keeps the other worker free for
   * searches while it runs.
   */
  private async getHealthCountsOffLoop(): Promise<MemoryHealth["counts"]> {
    const reader = searchReader();
    const tableUsable = (await this.getVecTableSchema(reader)) !== null && vectorSearch();
    const row = await memoryRepo().healthCounts(VECTOR_BYTES, tableUsable, reader);
    if (!row) throw new Error("health counts returned no row");
    return {
      total: row.total,
      withEmbedding: row.withEmbedding,
      validEmbedding: row.validEmbedding,
      invalidEmbedding: row.invalidEmbedding,
      searchable: row.searchable,
      memoryVec: row.memoryVec,
      missingFromVec: row.missingFromVec,
      extraInVec: row.extraInVec,
    };
  }

  /** Fresh counts on the caller's connection (the health endpoint's read). */
  private async getHealthCounts(): Promise<MemoryHealth["counts"]> {
    const row = await getStorage().memoryIndexes.healthCounts(VECTOR_BYTES);
    return {
      total: row.total,
      withEmbedding: row.withEmbedding,
      validEmbedding: row.validEmbedding,
      invalidEmbedding: row.invalidEmbedding,
      searchable: row.searchable,
      memoryVec: row.memoryVec,
      missingFromVec: row.missingFromVec,
      extraInVec: row.extraInVec,
    };
  }

  /**
   * getHealth() for the search path. The counts scan agent_memory and
   * memory_vec (about 0.8 s at 63k memories), so search never runs them on the
   * event loop: one read worker computes them, search reuses one result per
   * window, and an expired "vec" result is served while a refresh runs in the
   * background. The health endpoint keeps calling getHealth() for fresh counts.
   */
  private async searchHealth(): Promise<MemoryHealth> {
    const db = currentEngineHandle();
    const cached = this.searchHealthCache;
    const inTransaction = isInTransaction();
    // The db check drops a result that outlived a DB swap (tests reinit it).
    if (cached && cached.db === db) {
      if (Date.now() - cached.at < SEARCH_HEALTH_TTL_MS) return cached.health;
      // A stale "vec" is at worst one refresh old; a stale fallback is
      // awaited so a repaired index is seen on the next search.
      if (cached.health.retrievalMode === "vec" && !inTransaction) {
        if (!this.searchHealthRefresh) this.startSearchHealthRefresh(db).promise.catch(() => {});
        return cached.health;
      }
    }
    // A transaction must see its own writes, which may still roll back, and
    // its search reads run in-process anyway: count there, share and store nothing.
    if (inTransaction) return this.getHealth();
    return this.currentSearchHealth();
  }

  /**
   * A health result that no write invalidated before it returns. Searches
   * share one refresh per DB and generation; one a write overtook is retried,
   * for every search waiting on it.
   */
  private async currentSearchHealth(): Promise<MemoryHealth> {
    for (let attempt = 0; attempt < SEARCH_HEALTH_MAX_REFRESHES; attempt++) {
      const db = currentEngineHandle();
      const generation = this.searchHealthGeneration;
      const inFlight = this.searchHealthRefresh;
      const refresh =
        inFlight && inFlight.db === db && inFlight.generation === generation
          ? inFlight
          : this.startSearchHealthRefresh(db);
      const health = await refresh.promise;
      if (currentEngineHandle() === db && this.searchHealthGeneration === generation) return health;
    }
    // Writes kept overtaking the off-loop counts. In-process, no write can
    // land between the count and the return.
    const health = await this.getHealth();
    this.searchHealthCache = { health, db: currentEngineHandle(), at: Date.now() };
    return health;
  }

  private startSearchHealthRefresh(db: unknown): SearchHealthRefresh {
    const generation = this.searchHealthGeneration;
    const promise = (async () => {
      let health: MemoryHealth;
      try {
        health = await this.healthFromCounts(await this.getHealthCountsOffLoop(), searchReader());
      } catch (err) {
        console.warn(
          "[memory-search] health counts failed:",
          err instanceof Error ? err.message : String(err),
        );
        health = await this.getHealth();
      }
      // A DB swap or a vec write mid-refresh invalidated this result.
      if (currentEngineHandle() === db && generation === this.searchHealthGeneration)
        this.searchHealthCache = { health, db, at: Date.now() };
      return health;
    })().finally(() => {
      // A newer refresh may have replaced this one: leave it in place.
      if (this.searchHealthRefresh === entry) this.searchHealthRefresh = null;
    });
    const entry: SearchHealthRefresh = { db, generation, promise };
    this.searchHealthRefresh = entry;
    return entry;
  }

  /**
   * A vec write can heal a cached fallback (first vector, backfilled row), so
   * it drops one. A cached "vec" stays: dropping it on every write would
   * recount on the next search, and a stale "vec" is at worst one TTL old.
   */
  private noteVecWrite(): void {
    if (this.searchHealthCache?.health.retrievalMode !== "vec") this.invalidateSearchHealth();
  }

  /**
   * Drop now, so no refresh in flight is stored or returned, and again once
   * the writing transaction commits: a refresh that starts before the commit
   * reads the snapshot without this write.
   */
  private invalidateSearchHealth(): void {
    this.dropSearchHealth();
    if (isInTransaction()) getStorage().afterCommit(() => this.dropSearchHealth());
  }

  private dropSearchHealth(): void {
    this.searchHealthCache = null;
    this.searchHealthGeneration++;
  }

  async getHealth(): Promise<MemoryHealth> {
    return this.healthFromCounts(await this.getHealthCounts());
  }

  private async healthFromCounts(
    counts: MemoryHealth["counts"],
    reader?: MemoryReadExecutor,
  ): Promise<MemoryHealth> {
    const schema = await this.getVecTableSchema(reader);
    const extensionLoaded = vectorSearch();
    const reasons: string[] = [];

    // The field and reason names predate Postgres; they name the engine's vector extension.
    if (!extensionLoaded) reasons.push("sqlite_vec_extension_unavailable");
    if (!schema) reasons.push("memory_vec_table_missing");
    if (!this.vecInitialized) reasons.push("memory_vec_not_initialized");
    if (counts.memoryVec === 0) reasons.push("memory_vec_empty");
    if (counts.missingFromVec > 0) reasons.push("memory_vec_missing_embeddings");
    if (counts.extraInVec > 0) reasons.push("memory_vec_extra_rows");

    return {
      sqliteVec: {
        extensionLoaded,
        tableExists: schema !== null,
        initialized: this.vecInitialized,
        vectorDimensions: EMBEDDING_DIMENSIONS,
        distanceMetric: "cosine",
        schema,
        lastPopulate: this.lastPopulate,
      },
      counts,
      retrievalMode: reasons.length === 0 ? "vec" : "fallback",
      reasons,
    };
  }
}
