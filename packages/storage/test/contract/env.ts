import type { Storage } from "../../src";

/**
 * What an engine gives the repository contract suite: a fresh storage per
 * test, on a database at the migration head with no rows the test did not
 * write (seeded rows aside).
 */
export type ContractEngine = {
  name: string;
  /** A new, empty database at the head schema. */
  fresh(): Promise<Storage>;
  /** Releases the storage of the last `fresh()` call. */
  release(storage: Storage): Promise<void>;
  /**
   * Makes the memory search indexes of `storage` usable for vectors of
   * `dimensions` floats: the run-time tables an engine creates outside the
   * migration chain (SQLite: memory_fts, memory_vec with sqlite-vec loaded),
   * or nothing when the chain already holds them.
   */
  prepareMemorySearch(storage: Storage, dimensions: number): Promise<void>;
};
