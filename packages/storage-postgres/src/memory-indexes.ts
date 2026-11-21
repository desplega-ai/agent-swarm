import type {
  MemoryHealthCountsRow,
  MemoryRepository,
  MemorySearchIndexes,
  MemoryVectorsState,
} from "@desplega/storage";

/**
 * The memory search indexes of the Postgres engine. Migration 369 creates
 * both: full text is an expression GIN index on `agent_memory` (it indexes
 * every row as it is written, so there is nothing to backfill), and
 * `memory_vec` is a pgvector table that the memory store writes with each
 * embedding. No off-loop reader: the pool's reads never block the event loop.
 */
export class PostgresMemoryIndexes implements MemorySearchIndexes {
  constructor(
    private readonly memory: MemoryRepository,
    private readonly vectorSearch: boolean,
  ) {}

  ensureFullText(): { ready: boolean; backfill: boolean } {
    return { ready: true, backfill: false };
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
