import { getDb, isSqliteVecAvailable } from "@/be/db";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "@/be/embedding";
import { contentSha256 } from "@/commands/profile-sync";
import type { AgentMemory, AgentMemoryScope, AgentMemorySource } from "@/types";
import {
  EMBEDDING_DIMENSIONS,
  isHybridSearchEnabled,
  MIN_SIMILARITY,
  PROTECTED_SOURCES,
  TTL_DEFAULTS,
} from "../constants";
import { recencyDecay } from "../reranker";
import type {
  MemoryCandidate,
  MemoryEditInput,
  MemoryEditResult,
  MemoryHealth,
  MemoryInput,
  MemoryListOptions,
  MemoryRetrievalSource,
  MemorySearchOptions,
  MemoryStats,
  MemoryStore,
  MemoryVecPopulateStats,
} from "../types";

const VECTOR_BYTES = EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

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

function computeExpiresAt(source: AgentMemorySource): string | null {
  const ttlDays = TTL_DEFAULTS[source];
  if (ttlDays == null) return null;
  return new Date(Date.now() + ttlDays * 86400000).toISOString();
}

export class SqliteMemoryStore implements MemoryStore {
  private vecInitialized = false;
  private ftsInitialized = false;
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
      this.populateFtsTable();
      this.ftsInitialized = true;
    } catch (err) {
      this.ftsInitialized = false;
      console.error("[memory-fts] Failed to initialize memory_fts:", (err as Error).message);
    }
  }

  private getFtsTableSchema(): string | null {
    try {
      return (
        getDb()
          .prepare<{ sql: string | null }, []>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'",
          )
          .get()?.sql ?? null
      );
    } catch {
      return null;
    }
  }

  private populateFtsTable(): void {
    const db = getDb();
    const deletedExtra = db
      .prepare(
        `DELETE FROM memory_fts
         WHERE memory_id NOT IN (SELECT id FROM agent_memory)`,
      )
      .run();
    if (deletedExtra.changes > 0) {
      console.warn(`[memory-fts] removed_extra_rows count=${deletedExtra.changes}`);
    }

    const inserted = db
      .prepare(
        `INSERT INTO memory_fts(memory_id, name, content)
         SELECT m.id, m.name, m.content
         FROM agent_memory m
         WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id = m.id)`,
      )
      .run();
    console.log(`[memory-fts] populate inserted=${inserted.changes}`);
  }

  private syncFtsRow(memoryId: string, name: string, content: string): void {
    if (!this.ftsInitialized && !this.getFtsTableSchema()) return;
    const db = getDb();
    try {
      db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
      db.prepare("INSERT INTO memory_fts(memory_id, name, content) VALUES (?, ?, ?)").run(
        memoryId,
        name,
        content,
      );
    } catch (err) {
      console.error(`[memory-fts] sync failed memory_id=${memoryId}: ${(err as Error).message}`);
    }
  }

  private deleteFtsRows(ids: string[]): void {
    if (ids.length === 0 || (!this.ftsInitialized && !this.getFtsTableSchema())) return;
    const db = getDb();
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM memory_fts WHERE memory_id IN (${placeholders})`).run(...ids);
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

  store(input: MemoryInput): AgentMemory {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = computeExpiresAt(input.source);
    const key = input.key ?? `${input.scope}/${input.source}/${id}`;
    const contentHash = contentSha256(input.content);
    const version = 1;
    const db = getDb();

    let row: AgentMemoryRow | null | undefined;
    const tx = db.transaction(() => {
      row = db
        .prepare<AgentMemoryRow, (string | number | null)[]>(
          `INSERT INTO agent_memory (id, agentId, scope, key, name, content, summary, source, sourceTaskId, sourcePath, chunkIndex, totalChunks, tags, createdAt, updatedAt, accessedAt, expiresAt, accessCount, embeddingModel, contextKey, contentHash, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.agentId ?? null,
          input.scope,
          key,
          input.name,
          input.content,
          input.summary ?? null,
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
        );

      if (!row) throw new Error("Failed to create memory");
      db.prepare(
        `INSERT INTO agent_memory_version (id, memory_id, version, content, contentHash, intent, operation, changedByAgentId, createdAt, updatedAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'create', ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        row.id,
        version,
        input.content,
        contentHash,
        input.intent ?? "create memory",
        input.agentId ?? null,
        now,
        now,
        input.agentId ?? null,
        input.agentId ?? null,
      );
    });
    tx();

    if (!row) throw new Error("Failed to create memory");
    this.syncFtsRow(row.id, row.name, row.content);
    return rowToAgentMemory(row);
  }

  storeBatch(inputs: MemoryInput[]): AgentMemory[] {
    const db = getDb();
    const results: AgentMemory[] = [];
    const tx = db.transaction(() => {
      for (const input of inputs) {
        results.push(this.store(input));
      }
    });
    tx();
    return results;
  }

  get(id: string): AgentMemory | null {
    const db = getDb();
    const row = db
      .prepare<AgentMemoryRow, [string]>("SELECT * FROM agent_memory WHERE id = ?")
      .get(id);
    if (!row) return null;

    // Update accessedAt and increment accessCount
    db.prepare(
      "UPDATE agent_memory SET accessedAt = ?, accessCount = accessCount + 1 WHERE id = ?",
    ).run(new Date().toISOString(), id);

    return rowToAgentMemory(row);
  }

  peek(id: string): AgentMemory | null {
    const row = getDb()
      .prepare<AgentMemoryRow, [string]>("SELECT * FROM agent_memory WHERE id = ?")
      .get(id);
    if (!row) return null;
    return rowToAgentMemory(row);
  }

  search(
    embedding: Float32Array,
    agentId: string,
    options: MemorySearchOptions = {},
  ): MemoryCandidate[] {
    const { scope = "all", limit = 10, source, isLead = false, includeExpired = false } = options;

    const health = this.getHealth();
    if (
      isHybridSearchEnabled() &&
      options.queryText &&
      this.ftsInitialized &&
      this.getFtsTableSchema() &&
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
      });
    }

    if (options.queryText && this.ftsInitialized && this.getFtsTableSchema()) {
      console.log(
        `[memory-search] retrieval_path=fts scope=${scope} limit=${limit} reason=${embedding.length !== EMBEDDING_DIMENSIONS ? "query_dimension_mismatch" : health.reasons.join("|") || "vec_unavailable"}`,
      );
      return this.searchFts(options.queryText, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
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
    });
  }

  private searchHybrid(
    queryEmbedding: Float32Array,
    queryText: string,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
    },
  ): MemoryCandidate[] {
    const overfetchLimit = Math.min(Math.max(options.limit * 4, options.limit), 100);
    const vectorCandidates = this.searchWithVec(queryEmbedding, agentId, {
      ...options,
      limit: overfetchLimit,
    });
    const ftsCandidates = this.searchFts(queryText, agentId, { ...options, limit: overfetchLimit });
    if (ftsCandidates.length === 0) return vectorCandidates.slice(0, options.limit);

    const byId = new Map<string, MemoryCandidate>();
    const scores = new Map<string, number>();
    const sources = new Map<string, Set<MemoryRetrievalSource>>();
    const now = new Date();
    const add = (candidate: MemoryCandidate, rank: number) => {
      byId.set(candidate.id, byId.get(candidate.id) ?? candidate);
      const retrievalSource = candidate.retrievalSource === "fts" ? "fts" : "vec";
      const candidateSources = sources.get(candidate.id) ?? new Set<MemoryRetrievalSource>();
      candidateSources.add(retrievalSource);
      sources.set(candidate.id, candidateSources);

      const decay = recencyDecay(candidate.createdAt, now, candidate.source);
      scores.set(candidate.id, (scores.get(candidate.id) ?? 0) + computeRrfScore(rank, decay));
    };

    vectorCandidates.forEach(add);
    ftsCandidates.forEach(add);

    return [...byId.values()]
      .map((candidate) => ({
        ...candidate,
        rawSimilarity: candidate.rawSimilarity ?? candidate.similarity,
        similarity: scores.get(candidate.id) ?? candidate.similarity,
        retrievalSource: retrievalSourceFor(sources.get(candidate.id) ?? new Set()),
        recencyDecayApplied: true,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.limit);
  }

  private searchFts(
    queryText: string,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
    },
  ): MemoryCandidate[] {
    const match = this.buildFtsMatch(queryText);
    if (!match) return [];

    const db = getDb();
    const { scope, limit, source, isLead, includeExpired } = options;
    const conditions: string[] = ["memory_fts MATCH ?"];
    const params: (Buffer | string | number | null)[] = [match];

    this.addScopeConditions(conditions, params, agentId, scope, isLead, "m");

    if (source) {
      conditions.push("m.source = ?");
      params.push(source);
    }

    if (!includeExpired) {
      conditions.push("(m.expiresAt IS NULL OR m.expiresAt > datetime('now'))");
    }

    try {
      const sqlLimit = Math.min(Math.max(limit * 4, limit), 100);
      const rows = db
        .prepare<AgentMemoryRow & { rank: number }, (Buffer | string | number | null)[]>(
          `SELECT m.*, bm25(memory_fts) AS rank
           FROM memory_fts
           JOIN agent_memory m ON m.id = memory_fts.memory_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...params, sqlLimit);

      const now = new Date();
      return rows
        .map((row, index) => {
          const rawSimilarity = 1 / (index + 1);
          return {
            ...rowToCandidate(
              row,
              rawSimilarity * recencyDecay(row.createdAt, now, row.source as AgentMemorySource),
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

  private searchWithVec(
    queryEmbedding: Float32Array,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
    },
  ): MemoryCandidate[] {
    const db = getDb();
    const { scope, limit, source, isLead, includeExpired } = options;

    const embeddingBuffer = serializeEmbedding(queryEmbedding);
    // sqlite-vec hard ceiling is 4096 for knn queries
    const knnLimit = Math.min(Math.max(limit, this.getVecCount()), 4096);

    const conditions: string[] = ["v.embedding MATCH ?"];
    const params: (Buffer | string | number | null)[] = [embeddingBuffer];

    this.addScopeConditions(conditions, params, agentId, scope, isLead, "m");

    if (source) {
      conditions.push("m.source = ?");
      params.push(source);
    }

    if (!includeExpired) {
      conditions.push("(m.expiresAt IS NULL OR m.expiresAt > datetime('now'))");
    }

    conditions.push("v.k = ?");
    params.push(knnLimit);

    const rows = db
      .prepare<AgentMemoryRow & { distance: number }, (Buffer | string | number | null)[]>(
        `SELECT m.*, v.distance
         FROM memory_vec v
         JOIN agent_memory m ON m.id = v.memory_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY v.distance
         LIMIT ?`,
      )
      .all(...params, limit);

    const candidates: MemoryCandidate[] = [];
    for (const row of rows) {
      const similarity = 1 - row.distance;
      if (similarity < MIN_SIMILARITY) continue;
      candidates.push({ ...rowToCandidate(row, similarity), retrievalSource: "vec" });
    }

    return candidates;
  }

  private searchBruteForce(
    queryEmbedding: Float32Array,
    agentId: string,
    options: {
      scope: string;
      limit: number;
      source?: AgentMemorySource;
      isLead: boolean;
      includeExpired: boolean;
    },
  ): MemoryCandidate[] {
    const { scope, limit, source, isLead, includeExpired } = options;
    const db = getDb();

    const conditions: string[] = ["embedding IS NOT NULL"];
    const params: (string | null)[] = [];

    this.addScopeConditions(conditions, params, agentId, scope, isLead);

    if (source) {
      conditions.push("source = ?");
      params.push(source);
    }

    if (!includeExpired) {
      conditions.push("(expiresAt IS NULL OR expiresAt > datetime('now'))");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .prepare<AgentMemoryRow, (string | null)[]>(`SELECT * FROM agent_memory ${whereClause}`)
      .all(...params);

    const candidates: MemoryCandidate[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const emb = deserializeEmbedding(row.embedding);
      if (emb.length !== queryEmbedding.length) continue;
      const similarity = cosineSimilarity(queryEmbedding, emb);
      if (similarity < MIN_SIMILARITY) continue;
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

  private buildListWhereClause(
    agentId: string,
    options: MemoryListOptions,
  ): { whereClause: string; params: (Buffer | string | number | null)[] } {
    const { scope = "all", isLead = false, ownerAgentId, source, sourcePath } = options;
    const conditions: string[] = [];
    const params: (Buffer | string | number | null)[] = [];

    this.addScopeConditions(conditions, params, agentId, scope, isLead);

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

  list(agentId: string, options: MemoryListOptions = {}): AgentMemory[] {
    const { limit = 20, offset = 0 } = options;
    const db = getDb();
    const { whereClause, params } = this.buildListWhereClause(agentId, options);
    const queryParams = [...params, limit, offset];

    const rows = db
      .prepare<AgentMemoryRow, (Buffer | string | number | null)[]>(
        `SELECT * FROM agent_memory ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      )
      .all(...queryParams);

    return rows.map(rowToAgentMemory);
  }

  count(agentId: string, options: MemoryListOptions = {}): number {
    const db = getDb();
    const { whereClause, params } = this.buildListWhereClause(agentId, options);
    const row = db
      .prepare<{ count: number }, (Buffer | string | number | null)[]>(
        `SELECT COUNT(*) AS count FROM agent_memory ${whereClause}`,
      )
      .get(...params);

    return row?.count ?? 0;
  }

  isSourceProtected(source: AgentMemorySource): boolean {
    return PROTECTED_SOURCES.has(source);
  }

  edit(input: MemoryEditInput): MemoryEditResult {
    if (!input.id && !(input.key && input.scope)) {
      throw new Error("memory edit requires either id or key+scope");
    }

    const db = getDb();
    const row = input.id
      ? db
          .prepare<AgentMemoryRow, [string]>("SELECT * FROM agent_memory WHERE id = ?")
          .get(input.id)
      : db
          .prepare<AgentMemoryRow, [string, string, string | null]>(
            `SELECT * FROM agent_memory
             WHERE key = ? AND scope = ? AND coalesce(agentId, '') = coalesce(?, '')
             ORDER BY chunkIndex ASC
             LIMIT 1`,
          )
          .get(input.key!, input.scope!, input.agentId ?? null);

    if (!row) throw new Error("memory not found");
    if ((row.totalChunks ?? 1) !== 1)
      throw new Error("memory edit only supports single-chunk rows");
    if (input.expectedVersion && input.expectedVersion !== (row.version ?? 1)) {
      throw new Error("memory version conflict");
    }

    const previousVersion = row.version ?? 1;
    const nextContent = applyEditMode(input.mode, row.content, {
      content: input.content,
      oldString: input.oldString,
      newString: input.newString,
    });

    const nextHash = contentSha256(nextContent);
    if (nextHash === row.contentHash) {
      return {
        memory: rowToAgentMemory(row),
        changed: false,
        previousVersion,
        version: previousVersion,
        contentHash: nextHash,
      };
    }

    const nextVersion = previousVersion + 1;
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO agent_memory_version (id, memory_id, version, content, contentHash, intent, operation, changedByAgentId, createdAt, updatedAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        row.id,
        nextVersion,
        nextContent,
        nextHash,
        input.intent,
        input.changedByAgentId ?? null,
        now,
        now,
        input.changedByAgentId ?? null,
        input.changedByAgentId ?? null,
      );
      db.prepare(
        `UPDATE agent_memory
         SET content = ?, contentHash = ?, version = ?, updatedAt = ?
         WHERE id = ?`,
      ).run(nextContent, nextHash, nextVersion, now, row.id);
    });
    tx();

    this.syncFtsRow(row.id, row.name, nextContent);
    const updated = db
      .prepare<AgentMemoryRow, [string]>("SELECT * FROM agent_memory WHERE id = ?")
      .get(row.id);
    if (!updated) throw new Error("memory disappeared after edit");

    return {
      memory: rowToAgentMemory(updated),
      changed: true,
      previousVersion,
      version: nextVersion,
      contentHash: nextHash,
    };
  }

  listForCuration(
    agentId?: string,
  ): { id: string; source: string; name: string; createdAt: string }[] {
    const db = getDb();
    const protectedList = [...PROTECTED_SOURCES].map((s) => `'${s}'`).join(",");
    if (agentId) {
      return db
        .prepare<{ id: string; source: string; name: string; createdAt: string }, [string]>(
          `SELECT id, source, name, createdAt FROM agent_memory
           WHERE agentId = ? AND source NOT IN (${protectedList})`,
        )
        .all(agentId);
    }
    return db
      .prepare<{ id: string; source: string; name: string; createdAt: string }, []>(
        `SELECT id, source, name, createdAt FROM agent_memory
         WHERE source NOT IN (${protectedList})`,
      )
      .all();
  }

  listForReembedding(options?: { agentId?: string }): { id: string; content: string }[] {
    const db = getDb();
    if (options?.agentId) {
      return db
        .prepare<{ id: string; content: string }, [string]>(
          "SELECT id, content FROM agent_memory WHERE agentId = ?",
        )
        .all(options.agentId);
    }
    return db
      .prepare<{ id: string; content: string }, []>("SELECT id, content FROM agent_memory")
      .all();
  }

  private purgeByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const db = getDb();
    if (this.vecInitialized && this.getVecTableSchema()) {
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_vec WHERE memory_id IN (${placeholders})`).run(...ids);
    }
    this.deleteFtsRows(ids);
  }

  delete(id: string): boolean {
    const db = getDb();
    this.purgeByIds([id]);
    const result = db.prepare("DELETE FROM agent_memory WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteBySourcePath(sourcePath: string, agentId: string): number {
    const db = getDb();

    const ids = db
      .prepare<{ id: string }, [string, string]>(
        "SELECT id FROM agent_memory WHERE sourcePath = ? AND agentId = ?",
      )
      .all(sourcePath, agentId);

    this.purgeByIds(ids.map((r) => r.id));

    const result = db
      .prepare("DELETE FROM agent_memory WHERE sourcePath = ? AND agentId = ?")
      .run(sourcePath, agentId);
    return ids.length || result.changes;
  }

  purgeExpired(): number {
    const db = getDb();

    const expiredIds = db
      .prepare<{ id: string }, []>(
        "SELECT id FROM agent_memory WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now')",
      )
      .all();

    if (expiredIds.length === 0) return 0;

    const batchSize = 500;
    for (let i = 0; i < expiredIds.length; i += batchSize) {
      this.purgeByIds(expiredIds.slice(i, i + batchSize).map((r) => r.id));
    }

    const result = db
      .prepare(
        "DELETE FROM agent_memory WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now')",
      )
      .run();

    console.log(
      `[memory] Purged ${result.changes} expired memory row(s) (vec cleanup: ${expiredIds.length} id(s))`,
    );
    return result.changes;
  }

  updateEmbedding(id: string, embedding: Float32Array, model: string): void {
    const db = getDb();
    const buffer = serializeEmbedding(embedding);
    db.prepare("UPDATE agent_memory SET embedding = ?, embeddingModel = ? WHERE id = ?").run(
      buffer,
      model,
      id,
    );

    if (this.vecInitialized && this.getVecTableSchema()) {
      const vecBuffer = this.toVecBuffer(embedding);
      if (!vecBuffer) {
        console.warn(
          `[memory-vec] update skipped memory_id=${id} reason=invalid_dimensions dimensions=${embedding.length} expected=${EMBEDDING_DIMENSIONS}`,
        );
        return;
      }
      try {
        db.prepare("DELETE FROM memory_vec WHERE memory_id = ?").run(id);
        db.prepare("INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)").run(id, vecBuffer);
      } catch (err) {
        console.error(`[memory-vec] update failed memory_id=${id}: ${(err as Error).message}`);
      }
    }
  }

  getStats(agentId: string): MemoryStats {
    const db = getDb();

    const total = db
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM agent_memory WHERE agentId = ?",
      )
      .get(agentId);

    const bySourceRows = db
      .prepare<{ source: string; count: number }, [string]>(
        "SELECT source, COUNT(*) as count FROM agent_memory WHERE agentId = ? GROUP BY source",
      )
      .all(agentId);

    const byScopeRows = db
      .prepare<{ scope: string; count: number }, [string]>(
        "SELECT scope, COUNT(*) as count FROM agent_memory WHERE agentId = ? GROUP BY scope",
      )
      .all(agentId);

    const withEmbeddings = db
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM agent_memory WHERE agentId = ? AND embedding IS NOT NULL",
      )
      .get(agentId);

    const expired = db
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM agent_memory WHERE agentId = ? AND expiresAt IS NOT NULL AND expiresAt <= datetime('now')",
      )
      .get(agentId);

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
