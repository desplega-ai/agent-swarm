import { getDb, isSqliteVecAvailable } from "@/be/db";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "@/be/embedding";
import type { AgentMemory, AgentMemoryScope, AgentMemorySource } from "@/types";
import { TTL_DEFAULTS } from "../constants";
import type {
  MemoryCandidate,
  MemoryInput,
  MemoryListOptions,
  MemorySearchOptions,
  MemoryStats,
  MemoryStore,
} from "../types";

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
  };
}

function computeExpiresAt(source: AgentMemorySource): string | null {
  const ttlDays = TTL_DEFAULTS[source];
  if (ttlDays == null) return null;
  return new Date(Date.now() + ttlDays * 86400000).toISOString();
}

export class SqliteMemoryStore implements MemoryStore {
  private vecInitialized = false;

  constructor() {
    this.ensureVecTable();
  }

  private ensureVecTable(): void {
    if (this.vecInitialized || !isSqliteVecAvailable()) return;

    const db = getDb();
    // Create the virtual table if it doesn't exist
    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[512]
        )
      `);

      // Populate from existing embeddings that aren't yet in the vec table
      const existing = db
        .prepare<{ id: string; embedding: Buffer }, []>(
          "SELECT id, embedding FROM agent_memory WHERE embedding IS NOT NULL",
        )
        .all();

      if (existing.length > 0) {
        const vecCount = db
          .prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_vec")
          .get();

        if ((vecCount?.count ?? 0) < existing.length) {
          const insert = db.prepare(
            "INSERT OR IGNORE INTO memory_vec(memory_id, embedding) VALUES (?, ?)",
          );
          const tx = db.transaction(() => {
            for (const row of existing) {
              insert.run(row.id, row.embedding);
            }
          });
          tx();
          console.log(`[memory] Synced ${existing.length} embeddings to memory_vec`);
        }
      }

      this.vecInitialized = true;
    } catch (err) {
      console.warn("[memory] Failed to initialize memory_vec:", (err as Error).message);
    }
  }

  store(input: MemoryInput): AgentMemory {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = computeExpiresAt(input.source);

    const row = getDb()
      .prepare<
        AgentMemoryRow,
        [
          string,
          string | null,
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          string | null,
          number,
          number,
          string,
          string,
          string,
          string | null,
          number,
          string | null,
        ]
      >(
        `INSERT INTO agent_memory (id, agentId, scope, name, content, summary, source, sourceTaskId, sourcePath, chunkIndex, totalChunks, tags, createdAt, accessedAt, expiresAt, accessCount, embeddingModel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      );

    if (!row) throw new Error("Failed to create memory");
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

    if (isSqliteVecAvailable() && this.vecInitialized) {
      return this.searchWithVec(embedding, agentId, {
        scope,
        limit,
        source,
        isLead,
        includeExpired,
      });
    }
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

    // KNN query — fetch more candidates than needed for post-filtering
    const knnLimit = limit * 5; // over-fetch to account for scope/expiry filters
    const embeddingBuffer = serializeEmbedding(queryEmbedding);

    const vecRows = db
      .prepare<{ memory_id: string; distance: number }, [Buffer, number]>(
        "SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = ?",
      )
      .all(embeddingBuffer, knnLimit);

    if (vecRows.length === 0) return [];

    // Build ID list and distance map
    const distanceMap = new Map<string, number>();
    const ids: string[] = [];
    for (const vr of vecRows) {
      distanceMap.set(vr.memory_id, vr.distance);
      ids.push(vr.memory_id);
    }

    // Hydrate from agent_memory with filters
    const placeholders = ids.map(() => "?").join(",");
    const conditions: string[] = [`id IN (${placeholders})`];
    const params: (string | null)[] = [...ids];

    this.addScopeConditions(conditions, params, agentId, scope, isLead);

    if (source) {
      conditions.push("source = ?");
      params.push(source);
    }

    if (!includeExpired) {
      conditions.push("(expiresAt IS NULL OR expiresAt > datetime('now'))");
    }

    const rows = db
      .prepare<AgentMemoryRow, (string | null)[]>(
        `SELECT * FROM agent_memory WHERE ${conditions.join(" AND ")}`,
      )
      .all(...params);

    // Map to candidates with similarity scores
    const candidates: MemoryCandidate[] = [];
    for (const row of rows) {
      const distance = distanceMap.get(row.id) ?? 1;
      const similarity = 1 - distance; // cosine distance to similarity
      candidates.push(rowToCandidate(row, similarity));
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, limit);
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
      candidates.push(rowToCandidate(row, similarity));
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, limit);
  }

  private addScopeConditions(
    conditions: string[],
    params: (string | null)[],
    agentId: string,
    scope: string,
    isLead: boolean,
  ): void {
    if (!isLead) {
      if (scope === "agent") {
        conditions.push("agentId = ? AND scope = 'agent'");
        params.push(agentId);
      } else if (scope === "swarm") {
        conditions.push("scope = 'swarm'");
      } else {
        conditions.push("(agentId = ? OR scope = 'swarm')");
        params.push(agentId);
      }
    } else {
      if (scope === "agent") {
        conditions.push("scope = 'agent'");
      } else if (scope === "swarm") {
        conditions.push("scope = 'swarm'");
      }
    }
  }

  list(agentId: string, options: MemoryListOptions = {}): AgentMemory[] {
    const { scope = "all", limit = 20, offset = 0, isLead = false } = options;
    const db = getDb();

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (!isLead) {
      if (scope === "agent") {
        conditions.push("agentId = ? AND scope = 'agent'");
        params.push(agentId);
      } else if (scope === "swarm") {
        conditions.push("scope = 'swarm'");
      } else {
        conditions.push("(agentId = ? OR scope = 'swarm')");
        params.push(agentId);
      }
    } else {
      if (scope === "agent") {
        conditions.push("scope = 'agent'");
      } else if (scope === "swarm") {
        conditions.push("scope = 'swarm'");
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const rows = db
      .prepare<AgentMemoryRow, (string | number)[]>(
        `SELECT * FROM agent_memory ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      )
      .all(...params);

    return rows.map(rowToAgentMemory);
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
    if (isSqliteVecAvailable() && this.vecInitialized) {
      db.prepare("DELETE FROM memory_vec WHERE memory_id = ?").run(id);
    }
    const result = db.prepare("DELETE FROM agent_memory WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteBySourcePath(sourcePath: string, agentId: string): number {
    const db = getDb();

    if (isSqliteVecAvailable() && this.vecInitialized) {
      // Get IDs first for vec table cleanup
      const ids = db
        .prepare<{ id: string }, [string, string]>(
          "SELECT id FROM agent_memory WHERE sourcePath = ? AND agentId = ?",
        )
        .all(sourcePath, agentId);

      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`DELETE FROM memory_vec WHERE memory_id IN (${placeholders})`).run(
          ...ids.map((r) => r.id),
        );
      }
    }

    const result = db
      .prepare("DELETE FROM agent_memory WHERE sourcePath = ? AND agentId = ?")
      .run(sourcePath, agentId);
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

    if (isSqliteVecAvailable() && this.vecInitialized) {
      db.prepare("INSERT OR REPLACE INTO memory_vec(memory_id, embedding) VALUES (?, ?)").run(
        id,
        buffer,
      );
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
}
