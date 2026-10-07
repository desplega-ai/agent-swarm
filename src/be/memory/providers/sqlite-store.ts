import { getDb, getDbClient, isSqliteVecAvailable } from "@/be/db";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "@/be/embedding";
import { contentSha256 } from "@/commands/profile-sync";
import type { AgentMemory, AgentMemoryScope, AgentMemorySource } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";
import {
  EMBEDDING_DIMENSIONS,
  isHybridSearchEnabled,
  minSimilarity,
  PROTECTED_SOURCES,
  TTL_DEFAULTS,
} from "../constants";
import { isLongtermKey, LONGTERM_ROOT, tierSource } from "../key-paths";
import { recencyDecay } from "../reranker";
import type {
  MemoryCandidate,
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

// memory_fts.memory_id is UNINDEXED (FTS5 cannot index it), so a CORRELATED
// lookup against it is a full table scan per outer row. The old backfill used
// `WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id = m.id)`,
// which is N x N: at ~18k memories it held the main connection for minutes at
// boot. Both statements below use a non-correlated `NOT IN (subquery)`, which
// SQLite evaluates once into an ephemeral index, so each is one pass over each
// table. `memory_id IS NOT NULL` keeps a stray NULL row from turning every
// NOT IN into NULL (which would insert nothing).
export const FTS_DELETE_EXTRA_SQL = `DELETE FROM memory_fts
  WHERE memory_id NOT IN (SELECT id FROM agent_memory)`;
export const FTS_MISSING_IDS_SQL = `SELECT m.id FROM agent_memory m
  WHERE m.id NOT IN (SELECT memory_id FROM memory_fts WHERE memory_id IS NOT NULL)`;
const FTS_POPULATE_BATCH_SIZE = 500;

export type AgentMemoryRow = {
  id: string;
  agentId: string | null;
  scope: string;
  name: string;
  content: string;
  summary: string | null;
  embedding: Buffer | null;
  source: string;
  sourceTaskId: string | null;
  sourcePath: string | null;
  chunkIndex: number;
  totalChunks: number;
  tags: string;
  createdAt: string;
  accessedAt: string;
  expiresAt: string | null;
  accessCount: number;
  embeddingModel: string | null;
  alpha: number;
  beta: number;
  key: string | null;
  contentHash: string | null;
  version: number;
  updatedAt: string | null;
};

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
  const ttlDays = TTL_DEFAULTS[tierSource(source, key)];
  if (ttlDays == null) return null;
  return new Date(Date.now() + ttlDays * 86400000).toISOString();
}

export class SqliteMemoryStore implements MemoryStore {
  private vecInitialized = false;
  private ftsInitialized = false;
  private ftsPopulate: Promise<void> | null = null;
  private lastPopulate: MemoryVecPopulateStats | null = null;

  constructor() {
    this.ensureVecTable();
    this.ensureFtsTable();
  }

  private ensureFtsTable(): void {
    if (this.ftsInitialized) return;
    const db = getDb();
    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          memory_id UNINDEXED,
          name,
          content,
          tokenize='porter unicode61'
        )
      `);
      this.ftsInitialized = true;
      this.ftsPopulate = this.populateFtsTable().catch((err) => {
        console.error("[memory-fts] Failed to populate memory_fts:", (err as Error).message);
      });
    } catch (err) {
      this.ftsInitialized = false;
      console.error("[memory-fts] Failed to initialize memory_fts:", (err as Error).message);
    }
  }

  private async getFtsTableSchema(): Promise<string | null> {
    try {
      const row = await getDbClient().get<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'",
      );
      return row?.sql ?? null;
    } catch {
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
   * store()/delete() while this runs go through syncFtsRow/deleteFtsRows,
   * which delete-then-insert, so a concurrent write cannot leave a duplicate.
   */
  private async populateFtsTable(): Promise<void> {
    const client = getDbClient();
    const startedAt = performance.now();
    const deletedExtra = await client.run(FTS_DELETE_EXTRA_SQL);
    if (deletedExtra.changes > 0) {
      console.warn(`[memory-fts] removed_extra_rows count=${deletedExtra.changes}`);
    }

    const missing = await client.query<{ id: string }>(FTS_MISSING_IDS_SQL);
    for (let i = 0; i < missing.length; i += FTS_POPULATE_BATCH_SIZE) {
      const ids = missing.slice(i, i + FTS_POPULATE_BATCH_SIZE).map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      await client.run(
        `INSERT INTO memory_fts(memory_id, name, content)
         SELECT m.id, m.name, m.content
         FROM agent_memory m
         WHERE m.id IN (${placeholders})
           AND m.id NOT IN (SELECT memory_id FROM memory_fts WHERE memory_id IS NOT NULL)`,
        ids,
      );
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

  private async syncFtsRow(memoryId: string, name: string, content: string): Promise<void> {
    if (!this.ftsInitialized && !(await this.getFtsTableSchema())) return;
    try {
      await getDbClient().run("DELETE FROM memory_fts WHERE memory_id = ?", [memoryId]);
      await getDbClient().run("INSERT INTO memory_fts(memory_id, name, content) VALUES (?, ?, ?)", [
        memoryId,
        name,
        content,
      ]);
    } catch (err) {
      console.error(`[memory-fts] sync failed memory_id=${memoryId}: ${(err as Error).message}`);
    }
  }

  private async deleteFtsRows(ids: string[]): Promise<void> {
    // Always re-check the CURRENT db's schema instead of trusting
    // ftsInitialized — the flag can outlive a DB swap (tests reinit the DB
    // process-wide), and a stale `true` would make this DELETE throw
    // "no such table: memory_fts". Mirrors the vec guard in purgeByIds.
    if (ids.length === 0 || !(await this.getFtsTableSchema())) return;
    const placeholders = ids.map(() => "?").join(",");
    await getDbClient().run(`DELETE FROM memory_fts WHERE memory_id IN (${placeholders})`, ids);
  }

  private ensureVecTable(): void {
    if (this.vecInitialized) return;

    if (!isSqliteVecAvailable()) {
      console.warn("[memory-vec] sqlite-vec extension_loaded=false; retrieval_mode=fallback");
      return;
    }

    const db = getDb();
    try {
      console.log(
        `[memory-vec] sqlite-vec extension_loaded=true vector_dimensions=${EMBEDDING_DIMENSIONS}`,
      );

      const existingSchema = this.getVecTableSchema();
      if (existingSchema && !existingSchema.includes("distance_metric=cosine")) {
        console.warn(
          "[memory-vec] Existing memory_vec table is missing cosine distance metric; rebuilding from agent_memory",
        );
        db.run("DROP TABLE memory_vec");
      }

      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
        )
      `);

      const healthBefore = this.getHealthCounts();
      if (healthBefore.missingFromVec > 0 || healthBefore.extraInVec > 0) {
        this.populateVecTable(healthBefore.memoryVec);
      } else {
        console.log(
          `[memory-vec] populate skipped attempted=0 inserted=0 memory_vec=${healthBefore.memoryVec} valid_embedding=${healthBefore.validEmbedding}`,
        );
      }

      this.vecInitialized = true;
    } catch (err) {
      this.vecInitialized = false;
      console.error("[memory-vec] Failed to initialize memory_vec:", (err as Error).message);
    }
  }

  private getVecTableSchema(): string | null {
    try {
      return (
        getDb()
          .prepare<{ sql: string | null }, []>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_vec'",
          )
          .get()?.sql ?? null
      );
    } catch {
      return null;
    }
  }

  private getVecCount(): number {
    if (!this.getVecTableSchema()) return 0;
    return (
      getDb().prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_vec").get()
        ?.count ?? 0
    );
  }

  private populateVecTable(beforeCount: number): void {
    const db = getDb();
    const deletedExtra = db
      .prepare(
        `DELETE FROM memory_vec
         WHERE memory_id NOT IN (SELECT id FROM agent_memory)`,
      )
      .run();
    if (deletedExtra.changes > 0) {
      console.warn(`[memory-vec] removed_extra_rows count=${deletedExtra.changes}`);
    }

    const rows = db
      .prepare<{ id: string; embedding: Buffer }, []>(
        "SELECT id, embedding FROM agent_memory WHERE embedding IS NOT NULL",
      )
      .all();
    const deleteVec = db.prepare("DELETE FROM memory_vec WHERE memory_id = ?");
    const insertVec = db.prepare("INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)");

    let attempted = 0;
    let inserted = 0;
    let skippedInvalidDimensions = 0;
    let failed = 0;

    for (const row of rows) {
      const embeddingBuffer = this.toVecBuffer(row.embedding);
      if (!embeddingBuffer) {
        skippedInvalidDimensions++;
        continue;
      }

      attempted++;
      try {
        deleteVec.run(row.id);
        insertVec.run(row.id, embeddingBuffer);
        inserted++;
      } catch (err) {
        failed++;
        console.error(
          `[memory-vec] populate failed memory_id=${row.id}: ${(err as Error).message}`,
        );
      }
    }

    const afterCount = this.getVecCount();
    this.lastPopulate = {
      attempted,
      inserted,
      skippedInvalidDimensions,
      failed,
      beforeCount,
      afterCount,
    };

    console.log(
      `[memory-vec] populate attempted=${attempted} inserted=${inserted} skipped_invalid_dimensions=${skippedInvalidDimensions} failed=${failed} before_count=${beforeCount} after_count=${afterCount}`,
    );

    if (failed > 0 || afterCount < attempted) {
      console.error(
        `[memory-vec] populate incomplete attempted=${attempted} after_count=${afterCount} failed=${failed}`,
      );
    }
  }

  private toVecBuffer(embedding: Buffer | Float32Array): Buffer | null {
    if (embedding instanceof Float32Array) {
      if (embedding.length !== EMBEDDING_DIMENSIONS) return null;
      return serializeEmbedding(embedding);
    }
    if (embedding.length !== VECTOR_BYTES) return null;
    return embedding;
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

    const row = await getDbClient().transaction(async (tx) => {
      const inserted = await tx.get<AgentMemoryRow>(
        `INSERT INTO agent_memory (id, agentId, scope, key, name, content, summary, source, sourceTaskId, sourcePath, chunkIndex, totalChunks, tags, createdAt, updatedAt, accessedAt, expiresAt, accessCount, embeddingModel, contextKey, contentHash, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [
          id,
          input.agentId ?? null,
          input.scope,
          key,
          name,
          content,
          summary,
          input.source,
          input.sourceTaskId ?? null,
          input.sourcePath ?? null,
          input.chunkIndex ?? 0,
          input.totalChunks ?? 1,
          JSON.stringify(input.tags ?? []),
          now,
          now,
          now,
          expiresAt,
          0,
          null,
          input.contextKey ?? null,
          contentHash,
          version,
        ],
      );

      if (!inserted) throw new Error("Failed to create memory");
      await tx.run(
        `INSERT INTO agent_memory_version (id, memory_id, version, content, contentHash, intent, operation, changedByAgentId, createdAt, updatedAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'create', ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          inserted.id,
          version,
          content,
          contentHash,
          input.intent ?? "create memory",
          input.agentId ?? null,
          now,
          now,
          input.agentId ?? null,
          input.agentId ?? null,
        ],
      );
      return inserted;
    });

    await this.syncFtsRow(row.id, row.name, row.content);
    return rowToAgentMemory(row);
  }

  async storeBatch(inputs: MemoryInput[]): Promise<AgentMemory[]> {
    const results: AgentMemory[] = [];
    await getDbClient().transaction(async () => {
      for (const input of inputs) {
        results.push(await this.store(input));
      }
    });
    return results;
  }

  async get(id: string): Promise<AgentMemory | null> {
    const db = getDbClient();
    const row = await db.get<AgentMemoryRow>("SELECT * FROM agent_memory WHERE id = ?", [id]);
    if (!row) return null;

    // Update accessedAt and increment accessCount
    await db.run(
      "UPDATE agent_memory SET accessedAt = ?, accessCount = accessCount + 1 WHERE id = ?",
      [new Date().toISOString(), id],
    );

    return rowToAgentMemory(row);
  }

  async peek(id: string): Promise<AgentMemory | null> {
    const row = await getDbClient().get<AgentMemoryRow>("SELECT * FROM agent_memory WHERE id = ?", [
      id,
    ]);
    if (!row) return null;
    return rowToAgentMemory(row);
  }

  async search(
    embedding: Float32Array,
    agentId: string,
    options: MemorySearchOptions = {},
  ): Promise<MemoryCandidate[]> {
    const {
      scope = "all",
      limit = 10,
      source,
      isLead = false,
      includeExpired = false,
      keyPrefix,
    } = options;

    const health = this.getHealth();
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
    },
  ): Promise<MemoryCandidate[]> {
    const overfetchLimit = Math.min(Math.max(options.limit * 4, options.limit), 100);
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
    const rows = await getDbClient().query<{ id: string; embedding: Buffer | null }>(
      `SELECT id, embedding FROM agent_memory WHERE id IN (${missing.map(() => "?").join(",")})`,
      missing,
    );
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
    },
  ): Promise<MemoryCandidate[]> {
    const match = this.buildFtsMatch(queryText);
    if (!match) return [];

    const { scope, limit, source, isLead, includeExpired, keyPrefix } = options;
    const conditions: string[] = ["memory_fts MATCH ?"];
    const params: (Buffer | string | number | null)[] = [match];

    this.addScopeConditions(conditions, params, agentId, scope, isLead, "m");
    this.addKeyPrefixCondition(conditions, params, keyPrefix, "m");

    if (source) {
      conditions.push("m.source = ?");
      params.push(source);
    }

    if (!includeExpired) {
      conditions.push("(m.expiresAt IS NULL OR m.expiresAt > datetime('now'))");
    }

    try {
      const sqlLimit = Math.min(Math.max(limit * 4, limit), 100);
      const rows = await getDbClient().query<AgentMemoryRow & { rank: number }>(
        `SELECT m.*, bm25(memory_fts) AS rank
         FROM memory_fts
         JOIN agent_memory m ON m.id = memory_fts.memory_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY rank
         LIMIT ?`,
        [...params, sqlLimit],
      );

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
      console.warn("[memory-fts] query failed:", (err as Error).message);
      return [];
    }
  }

  private buildFtsMatch(queryText: string): string | null {
    const terms = queryText
      .trim()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
      .slice(0, 12);
    if (terms.length === 0) return null;
    return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
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
    },
  ): Promise<MemoryCandidate[]> {
    const { scope, limit, source, isLead, includeExpired, keyPrefix } = options;

    const embeddingBuffer = serializeEmbedding(queryEmbedding);
    // sqlite-vec hard ceiling is 4096 for knn queries
    const knnLimit = Math.min(Math.max(limit, this.getVecCount()), 4096);

    const conditions: string[] = ["v.embedding MATCH ?"];
    const params: (Buffer | string | number | null)[] = [embeddingBuffer];

    this.addScopeConditions(conditions, params, agentId, scope, isLead, "m");
    this.addKeyPrefixCondition(conditions, params, keyPrefix, "m");

    if (source) {
      conditions.push("m.source = ?");
      params.push(source);
    }

    if (!includeExpired) {
      conditions.push("(m.expiresAt IS NULL OR m.expiresAt > datetime('now'))");
    }

    conditions.push("v.k = ?");
    params.push(knnLimit);

    const rows = await getDbClient().query<AgentMemoryRow & { distance: number }>(
      `SELECT m.*, v.distance
       FROM memory_vec v
       JOIN agent_memory m ON m.id = v.memory_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY v.distance
       LIMIT ?`,
      [...params, limit],
    );

    const candidates: MemoryCandidate[] = [];
    for (const row of rows) {
      const similarity = 1 - row.distance;
      if (similarity < minSimilarity()) continue;
      candidates.push({ ...rowToCandidate(row, similarity), retrievalSource: "vec" });
    }

    return candidates;
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
    },
  ): Promise<MemoryCandidate[]> {
    const { scope, limit, source, isLead, includeExpired, keyPrefix } = options;

    const conditions: string[] = ["embedding IS NOT NULL"];
    const params: (string | null)[] = [];

    this.addScopeConditions(conditions, params, agentId, scope, isLead);
    this.addKeyPrefixCondition(conditions, params, keyPrefix);

    if (source) {
      conditions.push("source = ?");
      params.push(source);
    }

    if (!includeExpired) {
      conditions.push("(expiresAt IS NULL OR expiresAt > datetime('now'))");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await getDbClient().query<AgentMemoryRow>(
      `SELECT * FROM agent_memory ${whereClause}`,
      params,
    );

    const candidates: MemoryCandidate[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const emb = deserializeEmbedding(row.embedding);
      if (emb.length !== queryEmbedding.length) continue;
      const similarity = cosineSimilarity(queryEmbedding, emb);
      if (similarity < minSimilarity()) continue;
      candidates.push({ ...rowToCandidate(row, similarity), retrievalSource: "fallback" });
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, limit);
  }

  private addScopeConditions(
    conditions: string[],
    params: (Buffer | string | number | null)[],
    agentId: string,
    scope: string,
    isLead: boolean,
    tableAlias = "",
  ): void {
    const col = (name: string) => (tableAlias ? `${tableAlias}.${name}` : name);
    if (!isLead) {
      if (scope === "agent") {
        conditions.push(`${col("agentId")} = ? AND ${col("scope")} = 'agent'`);
        params.push(agentId);
      } else if (scope === "swarm") {
        conditions.push(`${col("scope")} = 'swarm'`);
      } else {
        conditions.push(`(${col("agentId")} = ? OR ${col("scope")} = 'swarm')`);
        params.push(agentId);
      }
    } else {
      if (scope === "agent") {
        conditions.push(`${col("scope")} = 'agent'`);
      } else if (scope === "swarm") {
        conditions.push(`${col("scope")} = 'swarm'`);
      }
    }
  }

  /**
   * Literal prefix match on `key`. substr/length instead of GLOB or LIKE so a
   * prefix holding `*`, `?`, `[` or `%` is matched as text, not as a pattern.
   */
  private addKeyPrefixCondition(
    conditions: string[],
    params: (Buffer | string | number | null)[],
    keyPrefix: string | undefined,
    tableAlias = "",
  ): void {
    if (!keyPrefix) return;
    const key = tableAlias ? `${tableAlias}.key` : "key";
    conditions.push(`substr(${key}, 1, length(?)) = ?`);
    params.push(keyPrefix, keyPrefix);
  }

  private buildListWhereClause(
    agentId: string,
    options: MemoryListOptions,
  ): { whereClause: string; params: (Buffer | string | number | null)[] } {
    const { scope = "all", isLead = false, ownerAgentId, source, sourcePath, keyPrefix } = options;
    const conditions: string[] = [];
    const params: (Buffer | string | number | null)[] = [];

    this.addScopeConditions(conditions, params, agentId, scope, isLead);
    this.addKeyPrefixCondition(conditions, params, keyPrefix);

    if (ownerAgentId) {
      conditions.push("agentId = ?");
      params.push(ownerAgentId);
    }

    if (source) {
      conditions.push("source = ?");
      params.push(source);
    }

    const sourcePathNeedle = sourcePath?.trim().toLowerCase();
    if (sourcePathNeedle) {
      conditions.push("instr(lower(coalesce(sourcePath, '')), ?) > 0");
      params.push(sourcePathNeedle);
    }

    return {
      whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  async list(agentId: string, options: MemoryListOptions = {}): Promise<AgentMemory[]> {
    const { limit = 20, offset = 0 } = options;
    const { whereClause, params } = this.buildListWhereClause(agentId, options);
    const queryParams = [...params, limit, offset];

    const rows = await getDbClient().query<AgentMemoryRow>(
      `SELECT * FROM agent_memory ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      queryParams,
    );

    return rows.map(rowToAgentMemory);
  }

  async count(agentId: string, options: MemoryListOptions = {}): Promise<number> {
    const { whereClause, params } = this.buildListWhereClause(agentId, options);
    const row = await getDbClient().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM agent_memory ${whereClause}`,
      params,
    );

    return row?.count ?? 0;
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
    const { result, ftsContent } = await getDbClient().transaction(async (tx) => {
      const row = input.id
        ? await tx.get<AgentMemoryRow>("SELECT * FROM agent_memory WHERE id = ?", [input.id])
        : await tx.get<AgentMemoryRow>(
            `SELECT * FROM agent_memory
             WHERE key = ? AND scope = ? AND coalesce(agentId, '') = coalesce(?, '')
             ORDER BY chunkIndex ASC
             LIMIT 1`,
            [input.key!, input.scope!, input.agentId ?? null],
          );

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
          result: {
            memory: rowToAgentMemory(row),
            changed: false,
            previousVersion,
            version: previousVersion,
            contentHash: nextHash,
          },
          ftsContent: null,
        };
      }

      // Every chunk of the document shares one key, so the move covers all of
      // them. Legacy multi-chunk manual docs carry a distinct key per chunk and
      // cannot be located by key: refuse rather than split the document.
      let targets: AgentMemoryRow[] = [row];
      if (moving) {
        const owner = row.agentId ?? null;
        if (row.key) {
          targets = await tx.query<AgentMemoryRow>(
            `SELECT * FROM agent_memory
             WHERE key = ? AND scope = ? AND coalesce(agentId, '') = coalesce(?, '')
             ORDER BY chunkIndex ASC`,
            [row.key, row.scope, owner],
          );
        }
        if (
          targets.length !== (row.totalChunks ?? 1) ||
          targets.some((target, index) => target.chunkIndex !== index)
        ) {
          throw new Error(
            "memory move needs every chunk of the document under one key; this document's chunks do not share one, re-store it with a key",
          );
        }
        const taken = await tx.get<{ id: string }>(
          `SELECT id FROM agent_memory
           WHERE key = ? AND scope = ? AND coalesce(agentId, '') = coalesce(?, '')
           LIMIT 1`,
          [input.newKey!, row.scope, owner],
        );
        if (taken) throw new Error(`key "${input.newKey}" is already used in this scope`);
      }

      // Moving into /longterm makes the memory curated, so it stops expiring.
      // Moving out restores nothing: the TTL it had is gone.
      const clearExpiry = moving && isLongtermKey(input.newKey);
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
        await tx.run(
          `INSERT INTO agent_memory_version (id, memory_id, version, content, contentHash, intent, operation, changedByAgentId, createdAt, updatedAt, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            target.id,
            targetVersion,
            targetContent,
            targetHash,
            versionIntent,
            input.changedByAgentId ?? null,
            now,
            now,
            input.changedByAgentId ?? null,
            input.changedByAgentId ?? null,
          ],
        );
        await tx.run(
          `UPDATE agent_memory
           SET content = ?, contentHash = ?, version = ?, updatedAt = ?, key = ?,
               expiresAt = CASE WHEN ? = 1 THEN NULL ELSE expiresAt END
           WHERE id = ?`,
          [
            targetContent,
            targetHash,
            targetVersion,
            now,
            moving ? input.newKey! : target.key,
            clearExpiry ? 1 : 0,
            target.id,
          ],
        );
      }

      return {
        result: {
          memory: rowToAgentMemory({
            ...row,
            content: nextContent,
            contentHash: nextHash,
            version: nextVersion,
            updatedAt: now,
            key: moving ? input.newKey! : row.key,
            expiresAt: clearExpiry ? null : row.expiresAt,
          }),
          changed: true,
          previousVersion,
          version: nextVersion,
          contentHash: nextHash,
        },
        ftsContent: contentChanged ? nextContent : null,
      };
    });

    if (ftsContent !== null) {
      await this.syncFtsRow(result.memory.id, result.memory.name, ftsContent);
    }

    return result;
  }

  async listForCuration(
    agentId?: string,
  ): Promise<{ id: string; source: string; name: string; createdAt: string }[]> {
    const db = getDbClient();
    const protectedList = [...PROTECTED_SOURCES].map((s) => `'${s}'`).join(",");
    // A /longterm key is protected whatever its source (see tierSource).
    const notLongterm = `coalesce(key, '') != '${LONGTERM_ROOT}' AND substr(coalesce(key, ''), 1, ${LONGTERM_ROOT.length + 1}) != '${LONGTERM_ROOT}/'`;
    if (agentId) {
      return db.query<{ id: string; source: string; name: string; createdAt: string }>(
        `SELECT id, source, name, createdAt FROM agent_memory
         WHERE agentId = ? AND source NOT IN (${protectedList}) AND ${notLongterm}`,
        [agentId],
      );
    }
    return db.query<{ id: string; source: string; name: string; createdAt: string }>(
      `SELECT id, source, name, createdAt FROM agent_memory
       WHERE source NOT IN (${protectedList}) AND ${notLongterm}`,
    );
  }

  async listForReembedding(options?: {
    agentId?: string;
  }): Promise<{ id: string; content: string }[]> {
    const db = getDbClient();
    if (options?.agentId) {
      return db.query<{ id: string; content: string }>(
        "SELECT id, content FROM agent_memory WHERE agentId = ?",
        [options.agentId],
      );
    }
    return db.query<{ id: string; content: string }>("SELECT id, content FROM agent_memory");
  }

  private async purgeByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this.vecInitialized && this.getVecTableSchema()) {
      const placeholders = ids.map(() => "?").join(",");
      await getDbClient().run(`DELETE FROM memory_vec WHERE memory_id IN (${placeholders})`, ids);
    }
    await this.deleteFtsRows(ids);
  }

  async delete(id: string): Promise<boolean> {
    return getDbClient().transaction(async (tx) => {
      const row = await tx.get<AgentMemoryRow>("SELECT * FROM agent_memory WHERE id = ?", [id]);
      if (!row) return false;
      // Explicit keys identify a document. Legacy generated keys identify only a row.
      const rows = row.key
        ? await tx.query<{ id: string }>(
            "SELECT id FROM agent_memory WHERE key = ? AND scope = ? AND COALESCE(agentId, '') = COALESCE(?, '')",
            [row.key, row.scope, row.agentId],
          )
        : [{ id }];
      const ids = rows.map((chunk) => chunk.id);
      await this.purgeByIds(ids);
      const placeholders = ids.map(() => "?").join(",");
      await tx.run(`DELETE FROM agent_memory WHERE id IN (${placeholders})`, ids);
      return true;
    });
  }

  async deleteBySourcePath(sourcePath: string, agentId: string): Promise<number> {
    const db = getDbClient();

    const ids = await db.query<{ id: string }>(
      "SELECT id FROM agent_memory WHERE sourcePath = ? AND agentId = ?",
      [sourcePath, agentId],
    );

    await this.purgeByIds(ids.map((r) => r.id));

    const result = await db.run("DELETE FROM agent_memory WHERE sourcePath = ? AND agentId = ?", [
      sourcePath,
      agentId,
    ]);
    return ids.length || result.changes;
  }

  async purgeExpired(): Promise<number> {
    const db = getDbClient();

    const expiredIds = await db.query<{ id: string }>(
      "SELECT id FROM agent_memory WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now')",
    );

    if (expiredIds.length === 0) return 0;

    const batchSize = 500;
    for (let i = 0; i < expiredIds.length; i += batchSize) {
      await this.purgeByIds(expiredIds.slice(i, i + batchSize).map((r) => r.id));
    }

    const result = await db.run(
      "DELETE FROM agent_memory WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now')",
    );

    console.log(
      `[memory] Purged ${result.changes} expired memory row(s) (vec cleanup: ${expiredIds.length} id(s))`,
    );
    return result.changes;
  }

  async updateEmbedding(id: string, embedding: Float32Array, model: string): Promise<void> {
    const db = getDbClient();
    const buffer = serializeEmbedding(embedding);
    await db.run("UPDATE agent_memory SET embedding = ?, embeddingModel = ? WHERE id = ?", [
      buffer,
      model,
      id,
    ]);

    if (this.vecInitialized && this.getVecTableSchema()) {
      const vecBuffer = this.toVecBuffer(embedding);
      if (!vecBuffer) {
        console.warn(
          `[memory-vec] update skipped memory_id=${id} reason=invalid_dimensions dimensions=${embedding.length} expected=${EMBEDDING_DIMENSIONS}`,
        );
        return;
      }
      try {
        await db.run("DELETE FROM memory_vec WHERE memory_id = ?", [id]);
        await db.run("INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)", [id, vecBuffer]);
      } catch (err) {
        console.error(`[memory-vec] update failed memory_id=${id}: ${(err as Error).message}`);
      }
    }
  }

  async rewriteForScrub(
    id: string,
    before: MemoryScrubFields,
    after: MemoryScrubFields,
  ): Promise<boolean> {
    const contentChanged = after.content !== before.content;
    return getDbClient().transaction(async (tx) => {
      // Compare-and-set: the sweep scrubbed `before` outside the write lock, so
      // skip the row if a concurrent write moved it since.
      const result = await tx.run(
        `UPDATE agent_memory
         SET name = ?, content = ?, summary = ?, contentHash = ?,
             embedding = CASE WHEN ? = 1 THEN NULL ELSE embedding END,
             embeddingModel = CASE WHEN ? = 1 THEN NULL ELSE embeddingModel END
         WHERE id = ? AND name IS ? AND content IS ? AND summary IS ?`,
        [
          after.name,
          after.content,
          after.summary,
          contentSha256(after.content),
          contentChanged ? 1 : 0,
          contentChanged ? 1 : 0,
          id,
          before.name,
          before.content,
          before.summary,
        ],
      );
      if (result.changes === 0) return false;
      // The vector embeds the old (secret-bearing) content. Drop it; the
      // re-embed backfill picks the row up via `embedding IS NULL`.
      if (contentChanged && this.vecInitialized && this.getVecTableSchema()) {
        await tx.run("DELETE FROM memory_vec WHERE memory_id = ?", [id]);
      }
      if (after.name !== before.name || contentChanged) {
        await this.syncFtsRow(id, after.name, after.content);
      }
      return true;
    });
  }

  async getStats(agentId: string): Promise<MemoryStats> {
    const db = getDbClient();

    const total = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM agent_memory WHERE agentId = ?",
      [agentId],
    );

    const bySourceRows = await db.query<{ source: string; count: number }>(
      "SELECT source, COUNT(*) as count FROM agent_memory WHERE agentId = ? GROUP BY source",
      [agentId],
    );

    const byScopeRows = await db.query<{ scope: string; count: number }>(
      "SELECT scope, COUNT(*) as count FROM agent_memory WHERE agentId = ? GROUP BY scope",
      [agentId],
    );

    const withEmbeddings = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM agent_memory WHERE agentId = ? AND embedding IS NOT NULL",
      [agentId],
    );

    const expired = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM agent_memory WHERE agentId = ? AND expiresAt IS NOT NULL AND expiresAt <= datetime('now')",
      [agentId],
    );

    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) bySource[row.source] = row.count;

    const byScope: Record<string, number> = {};
    for (const row of byScopeRows) byScope[row.scope] = row.count;

    return {
      total: total?.count ?? 0,
      bySource,
      byScope,
      withEmbeddings: withEmbeddings?.count ?? 0,
      expired: expired?.count ?? 0,
    };
  }

  private getHealthCounts(): MemoryHealth["counts"] {
    const db = getDb();
    const tableExists = this.getVecTableSchema() !== null;
    const tableUsable = tableExists && isSqliteVecAvailable();
    const count = (sql: string) => db.prepare<{ count: number }, []>(sql).get()?.count ?? 0;

    return {
      total: count("SELECT COUNT(*) as count FROM agent_memory"),
      withEmbedding: count(
        "SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NOT NULL",
      ),
      validEmbedding: count(
        `SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NOT NULL AND length(embedding) = ${VECTOR_BYTES}`,
      ),
      invalidEmbedding: count(
        `SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NOT NULL AND length(embedding) != ${VECTOR_BYTES}`,
      ),
      searchable: count(
        `SELECT COUNT(*) as count FROM agent_memory
         WHERE embedding IS NOT NULL
           AND length(embedding) = ${VECTOR_BYTES}
           AND (expiresAt IS NULL OR expiresAt > datetime('now'))`,
      ),
      memoryVec: tableUsable ? count("SELECT COUNT(*) as count FROM memory_vec") : 0,
      missingFromVec: tableUsable
        ? count(
            `SELECT COUNT(*) as count
             FROM agent_memory m
             LEFT JOIN memory_vec v ON v.memory_id = m.id
             WHERE m.embedding IS NOT NULL
               AND length(m.embedding) = ${VECTOR_BYTES}
               AND v.memory_id IS NULL`,
          )
        : count(
            `SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NOT NULL AND length(embedding) = ${VECTOR_BYTES}`,
          ),
      extraInVec: tableUsable
        ? count(
            `SELECT COUNT(*) as count
             FROM memory_vec v
             LEFT JOIN agent_memory m ON m.id = v.memory_id
             WHERE m.id IS NULL`,
          )
        : 0,
    };
  }

  getHealth(): MemoryHealth {
    const schema = this.getVecTableSchema();
    const counts = this.getHealthCounts();
    const reasons: string[] = [];

    if (!isSqliteVecAvailable()) reasons.push("sqlite_vec_extension_unavailable");
    if (!schema) reasons.push("memory_vec_table_missing");
    if (!this.vecInitialized) reasons.push("memory_vec_not_initialized");
    if (counts.memoryVec === 0) reasons.push("memory_vec_empty");
    if (counts.missingFromVec > 0) reasons.push("memory_vec_missing_embeddings");
    if (counts.extraInVec > 0) reasons.push("memory_vec_extra_rows");

    return {
      sqliteVec: {
        extensionLoaded: isSqliteVecAvailable(),
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
