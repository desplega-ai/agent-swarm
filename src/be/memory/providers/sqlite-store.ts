import { getDb, isSqliteVecAvailable } from "@/be/db";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "@/be/embedding";
import type { AgentMemory, AgentMemoryScope, AgentMemorySource } from "@/types";
import {
  EMBEDDING_DIMENSIONS,
  MIN_SIMILARITY,
  PROTECTED_SOURCES,
  TTL_DEFAULTS,
} from "../constants";
import type {
  MemoryCandidate,
  MemoryEditInput,
  MemoryEditResult,
  MemoryHealth,
  MemoryInput,
  MemoryListOptions,
  MemorySearchOptions,
  MemoryStats,
  MemoryStore,
  MemoryVecPopulateStats,
} from "../types";

const VECTOR_BYTES = EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

function contentSha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function sanitizeFtsQuery(query: string): string | null {
  const terms = query
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

type AgentMemoryRow = {
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
    accessedAt: row.accessedAt,
    expiresAt: row.expiresAt ?? null,
    accessCount: row.accessCount ?? 0,
    embeddingModel: row.embeddingModel ?? null,
  };
}

function rowToCandidate(row: AgentMemoryRow, similarity: number): MemoryCandidate {
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

  // ─── FTS5 lifecycle ────────────────────────────────────────────────────────

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

      const missing = db
        .prepare<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM agent_memory am
           WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id = am.id)`,
        )
        .get();

      if (missing && missing.count > 0) {
        this.populateFtsTable();
      } else {
        console.log("[memory-fts] populate skipped — all rows present");
      }

      this.ftsInitialized = true;
      console.log("[memory-fts] initialized");
    } catch (err) {
      this.ftsInitialized = false;
      console.error("[memory-fts] Failed to initialize:", (err as Error).message);
    }
  }

  private populateFtsTable(): void {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO memory_fts(memory_id, name, content)
         SELECT id, name, content FROM agent_memory am
         WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id = am.id)`,
      )
      .run();
    console.log(`[memory-fts] populate inserted=${result.changes}`);
  }

  private ftsInsert(id: string, name: string, content: string): void {
    if (!this.ftsInitialized) return;
    try {
      getDb()
        .prepare("INSERT INTO memory_fts(memory_id, name, content) VALUES (?, ?, ?)")
        .run(id, name, content);
    } catch (err) {
      console.error(`[memory-fts] insert failed memory_id=${id}:`, (err as Error).message);
    }
  }

  private ftsDelete(id: string): void {
    if (!this.ftsInitialized) return;
    try {
      getDb().prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
    } catch (err) {
      console.error(`[memory-fts] delete failed memory_id=${id}:`, (err as Error).message);
    }
  }

  private ftsUpdate(id: string, name: string, content: string): void {
    if (!this.ftsInitialized) return;
    this.ftsDelete(id);
    this.ftsInsert(id, name, content);
  }

  store(input: MemoryInput): AgentMemory {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = computeExpiresAt(input.source);
    const hash = contentSha256(input.content);
    const key = input.sourcePath ?? `${input.scope}/${input.source}/${id}`;

    const row = db
      .prepare<AgentMemoryRow, (string | number | null)[]>(
        `INSERT INTO agent_memory (id, agentId, scope, name, content, summary, source, sourceTaskId, sourcePath, chunkIndex, totalChunks, tags, createdAt, accessedAt, expiresAt, accessCount, embeddingModel, contextKey, key, contentHash, version, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) RETURNING *`,
      )
      .get(
        id,
        input.agentId ?? null,
        input.scope,
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
        expiresAt,
        0,
        null,
        input.contextKey ?? null,
        key,
        hash,
        now,
      );

    if (!row) throw new Error("Failed to create memory");

    // Version ledger — seed with version=1 create entry
    try {
      db.prepare(
        `INSERT INTO agent_memory_version (id, memory_id, version, content, contentHash, intent, operation, changedByAgentId, createdAt)
         VALUES (?, ?, 1, ?, ?, ?, 'create', ?, ?)`,
      ).run(
        crypto.randomUUID(),
        id,
        input.content,
        hash,
        input.intent ?? null,
        input.agentId ?? null,
        now,
      );
    } catch {
      // Version ledger is best-effort on store — table may not exist yet on first boot
    }

    this.ftsInsert(row.id, row.name, row.content);
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
    const {
      scope = "all",
      limit = 10,
      source,
      isLead = false,
      includeExpired = false,
      queryText,
    } = options;

    const health = this.getHealth();
    const hasVec = health.retrievalMode === "vec" && embedding.length === EMBEDDING_DIMENSIONS;
    const hasFts = this.ftsInitialized && queryText && queryText.trim().length > 0;

    if (hasVec && hasFts) {
      console.log(
        `[memory-search] retrieval_path=hybrid scope=${scope} limit=${limit} vec_rows=${health.counts.memoryVec}`,
      );
      return this.searchHybrid(embedding, queryText!, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
      });
    }

    if (hasFts && !hasVec) {
      console.log(`[memory-search] retrieval_path=fts_only scope=${scope} limit=${limit}`);
      return this.searchFts(queryText!, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
      });
    }

    if (hasVec) {
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
      candidates.push(rowToCandidate(row, similarity));
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
      candidates.push(rowToCandidate(row, similarity));
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, limit);
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
    const ftsQuery = sanitizeFtsQuery(queryText);
    if (!ftsQuery) return [];

    const db = getDb();
    const { scope, limit, source, isLead, includeExpired } = options;
    const conditions: string[] = ["memory_fts MATCH ?"];
    const params: (string | number | null)[] = [ftsQuery];

    this.addScopeConditions(conditions, params, agentId, scope, isLead, "m");

    if (source) {
      conditions.push("m.source = ?");
      params.push(source);
    }
    if (!includeExpired) {
      conditions.push("(m.expiresAt IS NULL OR m.expiresAt > datetime('now'))");
    }

    try {
      const rows = db
        .prepare<AgentMemoryRow & { rank: number }, (string | number | null)[]>(
          `SELECT m.*, f.rank
           FROM memory_fts f
           JOIN agent_memory m ON m.id = f.memory_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY f.rank
           LIMIT ?`,
        )
        .all(...params, limit);

      return rows.map((row) => {
        const bm25Score = -row.rank;
        const normalizedScore = Math.min(1.0, bm25Score / 20);
        return rowToCandidate(row, normalizedScore);
      });
    } catch (err) {
      console.error("[memory-fts] search failed:", (err as Error).message);
      return [];
    }
  }

  private searchHybrid(
    embedding: Float32Array,
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
    const RRF_K = 60;
    const overFetch = Math.max(options.limit * 3, 30);

    const vecResults = this.searchWithVec(embedding, agentId, {
      ...options,
      limit: overFetch,
    });
    const ftsResults = this.searchFts(queryText, agentId, {
      ...options,
      limit: overFetch,
    });

    const rrfScores = new Map<string, number>();
    const candidateMap = new Map<string, MemoryCandidate>();

    for (let i = 0; i < vecResults.length; i++) {
      const c = vecResults[i]!;
      rrfScores.set(c.id, (rrfScores.get(c.id) ?? 0) + 1 / (RRF_K + i + 1));
      candidateMap.set(c.id, c);
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const c = ftsResults[i]!;
      rrfScores.set(c.id, (rrfScores.get(c.id) ?? 0) + 1 / (RRF_K + i + 1));
      if (!candidateMap.has(c.id)) {
        candidateMap.set(c.id, c);
      }
    }

    const merged: MemoryCandidate[] = [];
    for (const [id, rrfScore] of rrfScores) {
      const candidate = candidateMap.get(id)!;
      merged.push({
        ...candidate,
        rawSimilarity: candidate.similarity,
        similarity: rrfScore,
      });
    }

    merged.sort((a, b) => b.similarity - a.similarity);
    return merged.slice(0, options.limit);
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

  delete(id: string): boolean {
    const db = getDb();
    if (this.vecInitialized && this.getVecTableSchema()) {
      db.prepare("DELETE FROM memory_vec WHERE memory_id = ?").run(id);
    }
    this.ftsDelete(id);
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

    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      if (this.vecInitialized && this.getVecTableSchema()) {
        db.prepare(`DELETE FROM memory_vec WHERE memory_id IN (${placeholders})`).run(
          ...ids.map((r) => r.id),
        );
      }
      if (this.ftsInitialized) {
        db.prepare(`DELETE FROM memory_fts WHERE memory_id IN (${placeholders})`).run(
          ...ids.map((r) => r.id),
        );
      }
    }

    const count = ids.length;
    db.prepare("DELETE FROM agent_memory WHERE sourcePath = ? AND agentId = ?").run(
      sourcePath,
      agentId,
    );
    return count;
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
      const batch = expiredIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(",");
      if (this.vecInitialized && this.getVecTableSchema()) {
        db.prepare(`DELETE FROM memory_vec WHERE memory_id IN (${placeholders})`).run(
          ...batch.map((r) => r.id),
        );
      }
      if (this.ftsInitialized) {
        db.prepare(`DELETE FROM memory_fts WHERE memory_id IN (${placeholders})`).run(
          ...batch.map((r) => r.id),
        );
      }
    }

    const count = expiredIds.length;
    db.prepare(
      "DELETE FROM agent_memory WHERE expiresAt IS NOT NULL AND expiresAt <= datetime('now')",
    ).run();

    console.log(`[memory] Purged ${count} expired memory row(s) (vec cleanup: ${count} id(s))`);
    return count;
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

  // ─── Phase 2: In-place editing ──────────────────────────────────────────────

  edit(input: MemoryEditInput): MemoryEditResult {
    const db = getDb();

    // Resolve the target memory
    let row: AgentMemoryRow | null = null;
    if (input.id) {
      row =
        db
          .prepare<AgentMemoryRow, [string]>("SELECT * FROM agent_memory WHERE id = ?")
          .get(input.id) ?? null;
    } else if (input.key && input.scope) {
      row =
        db
          .prepare<AgentMemoryRow, [string, string, string, number]>(
            `SELECT * FROM agent_memory
           WHERE key = ? AND scope = ? AND COALESCE(agentId,'') = ? AND chunkIndex = ?`,
          )
          .get(input.key, input.scope, input.agentId ?? "", input.chunkIndex ?? 0) ?? null;
    }

    if (!row) {
      return { changed: false, reason: "not_found" };
    }

    if (row.totalChunks > 1) {
      return { changed: false, reason: "multi_chunk" };
    }

    // Compute new content
    let newContent: string;
    if (input.mode === "exact") {
      if (!input.oldString || !input.newString) {
        return { changed: false, reason: "exact_mode_requires_old_and_new_string" };
      }
      const occurrences = row.content.split(input.oldString).length - 1;
      if (occurrences === 0) {
        return { changed: false, reason: "old_string_not_found" };
      }
      if (occurrences > 1) {
        return { changed: false, reason: "old_string_ambiguous" };
      }
      newContent = row.content.replace(input.oldString, input.newString);
    } else {
      if (!input.content) {
        return { changed: false, reason: "replace_mode_requires_content" };
      }
      newContent = input.content;
    }

    // Content-hash dedup short-circuit
    const newHash = contentSha256(newContent);
    if (row.contentHash && newHash === row.contentHash) {
      return { changed: false, reason: "content_unchanged" };
    }

    const now = new Date().toISOString();
    const newVersion = (row.version ?? 1) + 1;

    // Version ledger — optimistic concurrency via UNIQUE(memory_id, version)
    try {
      db.prepare(
        `INSERT INTO agent_memory_version (id, memory_id, version, content, contentHash, intent, operation, changedByAgentId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, 'edit', ?, ?)`,
      ).run(
        crypto.randomUUID(),
        row.id,
        newVersion,
        newContent,
        newHash,
        input.intent,
        input.changedByAgentId ?? null,
        now,
      );
    } catch (err) {
      if ((err as Error).message.includes("UNIQUE constraint")) {
        return { changed: false, reason: "version_conflict" };
      }
      throw err;
    }

    // Update the memory row in place — id preserved, alpha/beta untouched
    db.prepare(
      `UPDATE agent_memory
       SET content = ?, contentHash = ?, version = ?, updatedAt = ?, name = COALESCE(?, name)
       WHERE id = ?`,
    ).run(newContent, newHash, newVersion, now, input.name ?? null, row.id);

    // Sync FTS
    this.ftsUpdate(row.id, input.name ?? row.name, newContent);

    return {
      changed: true,
      id: row.id,
      version: newVersion,
      contentHash: newHash,
    };
  }

  // ─── Phase 2: Find existing memory by key for id-preserving re-index ──────

  findByKey(key: string, scope: string, agentId: string, chunkIndex = 0): AgentMemory | null {
    const row = getDb()
      .prepare<AgentMemoryRow, [string, string, string, number]>(
        `SELECT * FROM agent_memory
         WHERE key = ? AND scope = ? AND COALESCE(agentId,'') = ? AND chunkIndex = ?`,
      )
      .get(key, scope, agentId, chunkIndex);
    if (!row) return null;
    return rowToAgentMemory(row);
  }

  findBySourcePath(sourcePath: string, agentId: string): AgentMemory[] {
    const rows = getDb()
      .prepare<AgentMemoryRow, [string, string]>(
        "SELECT * FROM agent_memory WHERE sourcePath = ? AND agentId = ?",
      )
      .all(sourcePath, agentId);
    return rows.map(rowToAgentMemory);
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
      fts: {
        initialized: this.ftsInitialized,
      },
      counts,
      retrievalMode: reasons.length === 0 ? "vec" : "fallback",
      reasons,
    };
  }
}
