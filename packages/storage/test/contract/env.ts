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
};
