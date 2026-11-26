import type { MemoryHealthCountsRow, MemoryReadExecutor } from "./repositories/memory";

/** What one fill of the vector table from `agent_memory` did. */
export type MemoryVecPopulateStats = {
  attempted: number;
  inserted: number;
  skippedInvalidDimensions: number;
  failed: number;
  beforeCount: number;
  afterCount: number;
};

/** The vector table after `ensureVectors`. */
export type MemoryVectorsState = {
  /** The vector table exists and the memory store may write and search it. */
  initialized: boolean;
  /** Set when this call filled the table from agent_memory. */
  lastPopulate: MemoryVecPopulateStats | null;
};

/**
 * The memory search indexes of an engine: full text (`memory_fts`) and vectors
 * (`memory_vec`). SQLite creates both at run time, outside the migration
 * chain (FTS5 and sqlite-vec virtual tables), and fills them from
 * `agent_memory`; Postgres has both in the chain (the table `memory_fts` of
 * migration 386 and the pgvector table of 369). The memory store asks this
 * object, never the engine name.
 */
export interface MemorySearchIndexes {
  /**
   * Make the full-text index usable. `backfill`: it can lack rows written
   * before it existed, so the store runs its backfill (the repository's FTS
   * scan methods). Synchronous: the store calls it from its constructor.
   */
  ensureFullText(): { ready: boolean; backfill: boolean };
  /**
   * Make the vector table usable for float32 vectors of `dimensions`, and fill
   * it from `agent_memory` when the engine keeps it apart and its rows
   * disagree. Never throws: a failure leaves it uninitialized (logged).
   * Synchronous, like `ensureFullText`.
   */
  ensureVectors(dimensions: number): MemoryVectorsState;
  /** Fresh health counts, on the caller's connection (the health endpoint). */
  healthCounts(vectorBytes: number): Promise<MemoryHealthCountsRow>;
  /**
   * The reader of memory search statements. SQLite: a pool of worker threads,
   * each with its own read-only connection, so the reads do not block the API
   * event loop. Postgres: a READ ONLY transaction for each statement outside a
   * caller's transaction, so a long search does not hold back the predicate
   * locks of SERIALIZABLE writers. Absent: the engine's executor.
   */
  readonly searchReader?: MemoryReadExecutor;
}
