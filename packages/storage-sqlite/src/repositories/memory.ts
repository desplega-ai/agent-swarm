import {
  type AgentMemoryRow,
  BaseMemoryRepository,
  type MemoryHealthCountsRow,
  type MemoryReadExecutor,
  type MemorySearchFilter,
  type NewMemoryLink,
  type ReviewTaskRule,
  SqlQuery,
  sql,
  sqlJoin,
  sqlList,
} from "@desplega/storage";

// memory_fts.memory_id is UNINDEXED (FTS5 cannot index it), so a CORRELATED
// lookup against it is a full table scan per outer row. The backfill reads
// each table once, in rowid batches (FTS5 seeks a rowid range). A memory_fts
// row is an orphan when its memory is gone; that check is a lookup on the
// agent_memory primary key. A NULL memory_id is never an orphan.
export const FTS_SCAN_BATCH_SQL = `SELECT rowid AS rowid, memory_id AS "memoryId",
  memory_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM agent_memory m WHERE m.id = memory_fts.memory_id) AS orphan
  FROM memory_fts WHERE rowid > ? ORDER BY rowid LIMIT ?`;
export const MEMORY_ID_BATCH_SQL = `SELECT rowid AS rowid, id FROM agent_memory
  WHERE rowid > ? ORDER BY rowid LIMIT ?`;

/**
 * The last health-count alias, written unquoted (SQLite keeps its case): the
 * search-stall test recognises the off-loop count statement by this text.
 */
const EXTRA_IN_VEC_ALIAS = new SqlQuery(["AS extraInVec"], []);

/**
 * The capped set's order in the engine-scored exhaustive arm, written unquoted
 * (SQLite identifiers fold case): the learning-dedup test asserts this text.
 */
const CAPPED_ORDER_BY = new SqlQuery(["ORDER BY updatedAt DESC, id"], []);

/** A `?`-placeholder statement as a query, so the executed text is exactly the constant. */
function fromPlaceholders(text: string, values: (string | number)[]): SqlQuery {
  const strings = text.split("?");
  if (strings.length !== values.length + 1) throw new Error("placeholder count mismatch");
  return new SqlQuery(strings, values);
}

export class SqliteMemoryRepository extends BaseMemoryRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }

  protected notReviewTaskCompletion(alias: string, rule: ReviewTaskRule): SqlQuery {
    const p = this.prefix(alias);
    // The CASE keeps json_each off malformed or non-array tags (read as no tags).
    return sql`NOT (${p}source = 'task_completion' AND EXISTS (
            SELECT 1 FROM agent_tasks rt
            WHERE rt.id = ${p}"sourceTaskId"
              AND (rt."taskType" = ${rule.taskType}
                OR CASE WHEN json_valid(rt.tags)
                     THEN json_type(rt.tags) = 'array' AND EXISTS (
                       SELECT 1 FROM json_each(rt.tags)
                       WHERE value IN (${sqlList(rule.tags)}))
                     ELSE 0 END)))`;
  }

  // ---- search arms ----

  async searchFtsRows(
    terms: string[],
    filter: MemorySearchFilter,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { rank: number })[]> {
    if (terms.length === 0) return [];
    // Each term is an FTS5 phrase; any phrase matches.
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const conditions = this.searchConditions([sql`memory_fts MATCH ${match}`], filter, "m");
    return this.via(reader).query<AgentMemoryRow & { rank: number }>(sql`
      SELECT m.*, bm25(memory_fts) AS rank
        FROM memory_fts
        JOIN agent_memory m ON m.id = memory_fts.memory_id
       WHERE ${sqlJoin(conditions, sql` AND `)}
       ORDER BY rank
       LIMIT ${limit}`);
  }

  searchVecRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    knn: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { distance: number })[]> {
    const conditions = this.searchConditions([sql`v.embedding MATCH ${embedding}`], filter, "m");
    conditions.push(sql`v.k = ${knn}`);
    return this.via(reader).query<AgentMemoryRow & { distance: number }>(sql`
      SELECT m.*, v.distance
        FROM memory_vec v
        JOIN agent_memory m ON m.id = v.memory_id
       WHERE ${sqlJoin(conditions, sql` AND `)}
       ORDER BY v.distance
       LIMIT ${limit}`);
  }

  scoreCappedRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    cap: number,
    floor: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; similarity: number }[]> {
    // The length guard keeps a row of another dimension from raising inside
    // vec_distance_cosine; a zero vector scores NULL and fails the floor.
    return this.via(reader).query<{ id: string; similarity: number }>(sql`
      SELECT id, similarity FROM (
        SELECT id,
          CASE WHEN length(embedding) = ${embedding.byteLength} THEN 1 - vec_distance_cosine(embedding, ${embedding}) END
            AS similarity
        FROM (SELECT id, embedding ${this.cappedSet(filter, cap, CAPPED_ORDER_BY)})
      )
      WHERE similarity >= ${floor}
      ORDER BY similarity DESC, id
      LIMIT ${limit}`);
  }

  healthCounts(
    vectorBytes: number,
    vecUsable: boolean,
    reader?: MemoryReadExecutor,
  ): Promise<MemoryHealthCountsRow | null> {
    const valid = sql`embedding IS NOT NULL AND length(embedding) = ${vectorBytes}`;
    const validCount = sql`(SELECT COUNT(*) FROM agent_memory WHERE ${valid})`;
    return this.via(reader).get<MemoryHealthCountsRow>(sql`
      SELECT
        (SELECT COUNT(*) FROM agent_memory) AS total,
        (SELECT COUNT(*) FROM agent_memory WHERE embedding IS NOT NULL) AS "withEmbedding",
        ${validCount} AS "validEmbedding",
        (SELECT COUNT(*) FROM agent_memory
          WHERE embedding IS NOT NULL AND length(embedding) != ${vectorBytes}) AS "invalidEmbedding",
        (SELECT COUNT(*) FROM agent_memory
          WHERE ${valid} AND ("expiresAt" IS NULL OR "expiresAt" > datetime('now'))) AS searchable,
        ${vecUsable ? sql`(SELECT COUNT(*) FROM memory_vec)` : sql`0`} AS "memoryVec",
        ${
          vecUsable
            ? sql`${validCount}
               - (SELECT COUNT(*) FROM memory_vec v CROSS JOIN agent_memory m ON m.id = v.memory_id
                  WHERE m.embedding IS NOT NULL AND length(m.embedding) = ${vectorBytes})`
            : validCount
        } AS "missingFromVec",
        ${
          vecUsable
            ? sql`(SELECT COUNT(*) FROM memory_vec v LEFT JOIN agent_memory m ON m.id = v.memory_id
                WHERE m.id IS NULL)`
            : sql`0`
        } ${EXTRA_IN_VEC_ALIAS}`);
  }

  // ---- run-time search indexes ----

  async ftsTableSchema(): Promise<string | null> {
    const row = await this.db.get<{ sql: string | null }>(
      sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'`,
    );
    return row?.sql ?? null;
  }

  async vecTableSchema(reader?: MemoryReadExecutor): Promise<string | null> {
    const row = await this.via(reader).get<{ sql: string | null }>(
      sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_vec'`,
    );
    return row?.sql ?? null;
  }

  scanFtsBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; memoryId: string | null; orphan: number }[]> {
    return this.db.query(fromPlaceholders(FTS_SCAN_BATCH_SQL, [afterRowid, limit]));
  }

  async deleteFtsRowsByRowid(rowids: number[]): Promise<void> {
    if (rowids.length === 0) return;
    await this.db.run(sql`DELETE FROM memory_fts WHERE rowid IN (${sqlList(rowids)})`);
  }

  scanMemoryIdBatch(afterRowid: number, limit: number): Promise<{ rowid: number; id: string }[]> {
    return this.db.query(fromPlaceholders(MEMORY_ID_BATCH_SQL, [afterRowid, limit]));
  }

  async insertMissingFtsRows(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.run(sql`
      INSERT INTO memory_fts(memory_id, name, content)
      SELECT m.id, m.name, m.content
        FROM agent_memory m
       WHERE m.id IN (${sqlList(ids)})
         AND m.id NOT IN (SELECT memory_id FROM memory_fts WHERE memory_id IS NOT NULL)`);
  }

  async deleteFtsRow(memoryId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM memory_fts WHERE memory_id = ${memoryId}`);
  }

  async insertFtsRow(memoryId: string, name: string, content: string): Promise<void> {
    await this.db.run(
      sql`INSERT INTO memory_fts(memory_id, name, content) VALUES (${memoryId}, ${name}, ${content})`,
    );
  }

  async deleteFtsRows(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.db.run(sql`DELETE FROM memory_fts WHERE memory_id IN (${sqlList(memoryIds)})`);
  }

  async deleteVecRows(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.db.run(sql`DELETE FROM memory_vec WHERE memory_id IN (${sqlList(memoryIds)})`);
  }

  async deleteVecRow(memoryId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM memory_vec WHERE memory_id = ${memoryId}`);
  }

  async insertVecRow(memoryId: string, embedding: Uint8Array): Promise<void> {
    await this.db.run(
      sql`INSERT INTO memory_vec(memory_id, embedding) VALUES (${memoryId}, ${embedding})`,
    );
  }

  // ---- memory_retrieval ----

  async purgeSearchRetrievalsBefore(cutoff: string, limit: number): Promise<number> {
    // `+eventType` keeps the planner on the retrievedAt range. Without
    // sqlite_stat1 it prefers the eventType equality, which reads every
    // search row to test its date, even when nothing is stale.
    const result = await this.db.run(sql`
      DELETE FROM memory_retrieval WHERE rowid IN (
        SELECT rowid FROM memory_retrieval
        WHERE +"eventType" = 'search' AND "retrievedAt" < ${cutoff} LIMIT ${limit})`);
    return result.changes;
  }

  // ---- memory_link ----

  async insertLinkIfAbsent(l: NewMemoryLink): Promise<void> {
    // OR IGNORE also skips a row a CHECK constraint refuses, as before.
    await this.db.run(sql`
      INSERT OR IGNORE INTO memory_link
        (id, from_memory_id, "linkType", "targetKind", "targetId", strength, resolver, "sourceText", metadata, "createdAt", "updatedAt")
      VALUES (${l.id}, ${l.fromMemoryId}, ${l.linkType}, ${l.targetKind}, ${l.targetId}, ${l.strength}, ${l.resolver}, ${l.sourceText}, ${l.metadata}, ${l.now}, ${l.now})`);
  }
}
