/**
 * The memory search indexes of the SQLite engine (moved from
 * src/be/memory/providers/sqlite-store.ts, Postgres brief M4 step 5).
 * `memory_fts` (FTS5) and `memory_vec` (sqlite-vec vec0) are virtual tables
 * that the migration chain cannot create (vec0 needs the extension loaded and
 * the vector width of the deployment), so they are made here at run time and
 * filled from `agent_memory`. The statements run synchronously on the raw
 * handle: the memory store bootstraps them from its constructor.
 */

import type { Database } from "bun:sqlite";
import type {
  MemoryHealthCountsRow,
  MemoryReadExecutor,
  MemorySearchIndexes,
  MemoryVecPopulateStats,
  MemoryVectorsState,
} from "@desplega/storage";

export type SqliteMemoryIndexesOptions = {
  /** The application's bun:sqlite handle, resolved per call (tests reopen it). */
  database: () => Database;
  /** sqlite-vec is loaded into the connection. */
  vectorSearch: boolean;
  /** The off-loop read pool (createSqliteMemorySearchReader), if the server runs one. */
  searchReader?: MemoryReadExecutor;
};

export class SqliteMemoryIndexes implements MemorySearchIndexes {
  readonly searchReader?: MemoryReadExecutor;

  constructor(private readonly options: SqliteMemoryIndexesOptions) {
    if (options.searchReader) this.searchReader = options.searchReader;
  }

  ensureFullText(): { ready: boolean; backfill: boolean } {
    const db = this.options.database();
    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          memory_id UNINDEXED,
          name,
          content,
          tokenize='porter unicode61'
        )
      `);
      return { ready: true, backfill: true };
    } catch (err) {
      console.error(
        "[memory-fts] Failed to initialize memory_fts:",
        err instanceof Error ? err.message : String(err),
      );
      return { ready: false, backfill: false };
    }
  }

  ensureVectors(dimensions: number): MemoryVectorsState {
    if (!this.options.vectorSearch) {
      console.warn("[memory-vec] sqlite-vec extension_loaded=false; retrieval_mode=fallback");
      return { initialized: false, lastPopulate: null };
    }

    const db = this.options.database();
    const vectorBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
    try {
      console.log(`[memory-vec] sqlite-vec extension_loaded=true vector_dimensions=${dimensions}`);

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
          embedding float[${dimensions}] distance_metric=cosine
        )
      `);

      let lastPopulate: MemoryVecPopulateStats | null = null;
      const healthBefore = this.getHealthCounts(vectorBytes);
      if (healthBefore.missingFromVec > 0 || healthBefore.extraInVec > 0) {
        lastPopulate = this.populateVecTable(healthBefore.memoryVec, vectorBytes);
      } else {
        console.log(
          `[memory-vec] populate skipped attempted=0 inserted=0 memory_vec=${healthBefore.memoryVec} valid_embedding=${healthBefore.validEmbedding}`,
        );
      }

      return { initialized: true, lastPopulate };
    } catch (err) {
      console.error(
        "[memory-vec] Failed to initialize memory_vec:",
        err instanceof Error ? err.message : String(err),
      );
      return { initialized: false, lastPopulate: null };
    }
  }

  async healthCounts(vectorBytes: number): Promise<MemoryHealthCountsRow> {
    return this.getHealthCounts(vectorBytes);
  }

  private getVecTableSchema(): string | null {
    try {
      return (
        this.options
          .database()
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
      this.options
        .database()
        .prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_vec")
        .get()?.count ?? 0
    );
  }

  private populateVecTable(beforeCount: number, vectorBytes: number): MemoryVecPopulateStats {
    const db = this.options.database();
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
      .prepare<{ id: string; embedding: Uint8Array }, []>(
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
      if (row.embedding.length !== vectorBytes) {
        skippedInvalidDimensions++;
        continue;
      }

      attempted++;
      try {
        deleteVec.run(row.id);
        insertVec.run(row.id, row.embedding);
        inserted++;
      } catch (err) {
        failed++;
        console.error(
          `[memory-vec] populate failed memory_id=${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const afterCount = this.getVecCount();

    console.log(
      `[memory-vec] populate attempted=${attempted} inserted=${inserted} skipped_invalid_dimensions=${skippedInvalidDimensions} failed=${failed} before_count=${beforeCount} after_count=${afterCount}`,
    );

    if (failed > 0 || afterCount < attempted) {
      console.error(
        `[memory-vec] populate incomplete attempted=${attempted} after_count=${afterCount} failed=${failed}`,
      );
    }
    return { attempted, inserted, skippedInvalidDimensions, failed, beforeCount, afterCount };
  }

  private getHealthCounts(vectorBytes: number): MemoryHealthCountsRow {
    const db = this.options.database();
    const tableExists = this.getVecTableSchema() !== null;
    const tableUsable = tableExists && this.options.vectorSearch;
    const count = (sql: string) => db.prepare<{ count: number }, []>(sql).get()?.count ?? 0;
    const validEmbedding = count(
      `SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NOT NULL AND length(embedding) = ${vectorBytes}`,
    );

    return {
      total: count("SELECT COUNT(*) as count FROM agent_memory"),
      withEmbedding: count(
        "SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NOT NULL",
      ),
      validEmbedding,
      invalidEmbedding: count(
        `SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NOT NULL AND length(embedding) != ${vectorBytes}`,
      ),
      searchable: count(
        `SELECT COUNT(*) as count FROM agent_memory
         WHERE embedding IS NOT NULL
           AND length(embedding) = ${vectorBytes}
           AND (expiresAt IS NULL OR expiresAt > datetime('now'))`,
      ),
      memoryVec: tableUsable ? count("SELECT COUNT(*) as count FROM memory_vec") : 0,
      // Valid rows minus the valid rows memory_vec holds. memory_vec.memory_id
      // is its primary key, so the join counts each memory at most once. The
      // CROSS JOIN pins memory_vec as the outer loop: an agent_memory-driven
      // anti-join probes vec0 once per memory, which held the event loop for
      // seconds at 57k memories; this side is a primary-key lookup per vec row.
      missingFromVec: tableUsable
        ? validEmbedding -
          count(
            `SELECT COUNT(*) as count
             FROM memory_vec v
             CROSS JOIN agent_memory m ON m.id = v.memory_id
             WHERE m.embedding IS NOT NULL
               AND length(m.embedding) = ${vectorBytes}`,
          )
        : validEmbedding,
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
}
