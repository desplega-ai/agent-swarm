import {
  type AgentMemoryRow,
  BaseMemoryRepository,
  isConstraintViolation,
  jsonText,
  type MemoryHealthCountsRow,
  type MemoryReadExecutor,
  type MemorySearchFilter,
  type NewMemoryLink,
  type ReviewTaskRule,
  type SqlQuery,
  sql,
  sqlList,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

/**
 * `memory_fts` (FTS5) and `memory_vec` (sqlite-vec) are run-time tables of the
 * SQLite engine, outside the migration chain. Their Postgres forms (tsvector,
 * pgvector) are milestone M4: the methods that read or write them, and the
 * engine-scored exhaustive arm, stay `notOnPostgresYet` until then.
 */
export class PostgresMemoryRepository extends BaseMemoryRepository {
  protected notReviewTaskCompletion(alias: string, rule: ReviewTaskRule): SqlQuery {
    const p = this.prefix(alias);
    // Only string elements of an array count as tags, as SQLite's json_each
    // over a JSON array compared with text.
    return sql`NOT (${p}source = 'task_completion' AND EXISTS (
            SELECT 1 FROM agent_tasks rt
            WHERE rt.id = ${p}"sourceTaskId"
              AND (rt."taskType" = ${rule.taskType}
                OR (jsonb_typeof(rt.tags) = 'array' AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(rt.tags) AS tag(value)
                  WHERE jsonb_typeof(tag.value) = 'string'
                    AND tag.value #>> '{}' IN (${sqlList(rule.tags)}))))))`;
  }

  // ---- search arms ----

  searchFtsRows(
    _match: string,
    _filter: MemorySearchFilter,
    _limit: number,
    _reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { rank: number })[]> {
    return notOnPostgresYet("PostgresMemoryRepository.searchFtsRows");
  }

  searchVecRows(
    _embedding: Uint8Array,
    _filter: MemorySearchFilter,
    _knn: number,
    _limit: number,
    _reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { distance: number })[]> {
    return notOnPostgresYet("PostgresMemoryRepository.searchVecRows");
  }

  scoreCappedRows(
    _embedding: Uint8Array,
    _filter: MemorySearchFilter,
    _cap: number,
    _floor: number,
    _limit: number,
    _reader?: MemoryReadExecutor,
  ): Promise<{ id: string; similarity: number }[]> {
    return notOnPostgresYet("PostgresMemoryRepository.scoreCappedRows");
  }

  healthCounts(
    vectorBytes: number,
    vecUsable: boolean,
    reader?: MemoryReadExecutor,
  ): Promise<MemoryHealthCountsRow | null> {
    if (vecUsable) return notOnPostgresYet("PostgresMemoryRepository.healthCounts(memory_vec)");
    const valid = sql`embedding IS NOT NULL AND octet_length(embedding) = ${vectorBytes}`;
    const validCount = sql`(SELECT COUNT(*) FROM agent_memory WHERE ${valid})`;
    return this.via(reader).get<MemoryHealthCountsRow>(sql`
      SELECT
        (SELECT COUNT(*) FROM agent_memory) AS total,
        (SELECT COUNT(*) FROM agent_memory WHERE embedding IS NOT NULL) AS "withEmbedding",
        ${validCount} AS "validEmbedding",
        (SELECT COUNT(*) FROM agent_memory
          WHERE embedding IS NOT NULL AND octet_length(embedding) != ${vectorBytes}) AS "invalidEmbedding",
        (SELECT COUNT(*) FROM agent_memory
          WHERE ${valid} AND ("expiresAt" IS NULL OR "expiresAt" > statement_timestamp())) AS searchable,
        0 AS "memoryVec",
        ${validCount} AS "missingFromVec",
        0 AS "extraInVec"`);
  }

  // ---- run-time search indexes (M4) ----

  ftsTableSchema(): Promise<string | null> {
    return notOnPostgresYet("PostgresMemoryRepository.ftsTableSchema");
  }

  scanFtsBatch(
    _afterRowid: number,
    _limit: number,
  ): Promise<{ rowid: number; memoryId: string | null; orphan: number }[]> {
    return notOnPostgresYet("PostgresMemoryRepository.scanFtsBatch");
  }

  deleteFtsRowsByRowid(_rowids: number[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteFtsRowsByRowid");
  }

  async scanMemoryIdBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; id: string }[]> {
    const rows = await this.db.query<{ position: number; id: string }>(sql`
      SELECT "_rowid" AS position, id FROM agent_memory
      WHERE "_rowid" > ${afterRowid} ORDER BY "_rowid" LIMIT ${limit}`);
    return rows.map((row) => ({ rowid: row.position, id: row.id }));
  }

  insertMissingFtsRows(_ids: string[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.insertMissingFtsRows");
  }

  deleteFtsRow(_memoryId: string): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteFtsRow");
  }

  insertFtsRow(_memoryId: string, _name: string, _content: string): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.insertFtsRow");
  }

  deleteFtsRows(_memoryIds: string[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteFtsRows");
  }

  deleteVecRows(_memoryIds: string[]): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteVecRows");
  }

  deleteVecRow(_memoryId: string): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.deleteVecRow");
  }

  insertVecRow(_memoryId: string, _embedding: Uint8Array): Promise<void> {
    return notOnPostgresYet("PostgresMemoryRepository.insertVecRow");
  }

  // ---- memory_retrieval ----

  async purgeSearchRetrievalsBefore(cutoff: string, limit: number): Promise<number> {
    // Oldest first, as SQLite's plan on the retrievedAt index reads them.
    const result = await this.db.run(sql`
      DELETE FROM memory_retrieval WHERE "_rowid" IN (
        SELECT "_rowid" FROM memory_retrieval
        WHERE "eventType" = 'search' AND "retrievedAt" < ${cutoff}
        ORDER BY "retrievedAt", "_rowid" LIMIT ${limit})`);
    return result.changes;
  }

  // ---- memory_link ----

  async insertLinkIfAbsent(l: NewMemoryLink): Promise<void> {
    // SQLite's INSERT OR IGNORE skips a duplicate and also a row a CHECK or NOT
    // NULL constraint refuses. ON CONFLICT covers the duplicate; the savepoint
    // keeps a refused row from aborting the caller's transaction.
    try {
      await this.db.transaction(() =>
        this.db.run(sql`
          INSERT INTO memory_link
            (id, from_memory_id, "linkType", "targetKind", "targetId", strength, resolver, "sourceText", metadata, "createdAt", "updatedAt")
          VALUES (${l.id}, ${l.fromMemoryId}, ${l.linkType}, ${l.targetKind}, ${l.targetId}, ${l.strength}, ${l.resolver}, ${l.sourceText}, ${jsonText(l.metadata)}, ${l.now}, ${l.now})
          ON CONFLICT DO NOTHING`),
      );
    } catch (err) {
      if (isConstraintViolation(err, "check") || isConstraintViolation(err, "notNull")) return;
      throw err;
    }
  }
}
