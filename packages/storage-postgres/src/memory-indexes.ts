import type {
  DbClient,
  DbParam,
  MemoryHealthCountsRow,
  MemoryReadExecutor,
  MemoryRepository,
  MemorySearchIndexes,
  MemoryVectorsState,
} from "@desplega/storage";

/**
 * The memory search indexes of the Postgres engine. The chain creates both:
 * full text is the table `memory_fts` (migration 386), which the memory store
 * writes with each memory and which the migration and db-copy fill for
 * existing rows; `memory_vec` (migration 369) is a pgvector table that the
 * memory store writes with each embedding.
 */
export class PostgresMemoryIndexes implements MemorySearchIndexes {
  /**
   * Search statements outside a transaction run in a READ ONLY transaction.
   * A plain statement is a read-write SERIALIZABLE transaction (decision D6),
   * and while one runs Postgres keeps the predicate locks of every
   * serializable transaction that commits. A READ ONLY transaction stops
   * holding them back once no read-write transaction that overlaps its
   * snapshot is still open, which for short API writes is at once. Inside a
   * caller's transaction the statement joins it, to see its own writes.
   */
  readonly searchReader: MemoryReadExecutor;

  constructor(
    private readonly memory: MemoryRepository,
    private readonly vectorSearch: boolean,
    client: DbClient,
  ) {
    const read = <T>(run: (executor: DbClient) => Promise<T>): Promise<T> =>
      client.inTransaction()
        ? run(client)
        : client.transaction(() => run(client), { readOnly: true });
    this.searchReader = {
      query: <T>(text: string, params: DbParam[]) => read((c) => c.query<T>(text, params)),
      get: <T>(text: string, params: DbParam[]) => read((c) => c.get<T>(text, params)),
    };
  }

  ensureFullText(): { ready: boolean; backfill: boolean } {
    // The store's backfill indexes any memory without a memory_fts row (a
    // document that failed to build when the memory was written). It finds
    // none on a database that migration 386 or db-copy filled.
    return { ready: true, backfill: true };
  }

  ensureVectors(dimensions: number): MemoryVectorsState {
    if (!this.vectorSearch) {
      console.warn("[memory-vec] pgvector extension_loaded=false; retrieval_mode=fallback");
      return { initialized: false, lastPopulate: null };
    }
    console.log(
      `[memory-vec] pgvector extension_loaded=true vector_dimensions=${dimensions} (memory_vec from migration 369)`,
    );
    return { initialized: true, lastPopulate: null };
  }

  async healthCounts(vectorBytes: number): Promise<MemoryHealthCountsRow> {
    const vecUsable = this.vectorSearch && (await this.memory.vecTableSchema()) !== null;
    const row = await this.memory.healthCounts(vectorBytes, vecUsable);
    if (!row) throw new Error("health counts returned no row");
    return row;
  }
}
