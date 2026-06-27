/**
 * `seed_state` accessors — the per-(kind, key) record of the content hash the
 * seeder framework last wrote. Lets {@link runSeeder} tell a pristine upstream
 * entity from one a user has modified. See migration 070_seed_state.sql.
 */

import { getDb } from "../db";

export type SeedStateRow = {
  kind: string;
  key: string;
  seededHash: string;
  seededAt: string;
};

/** The last hash this framework seeded for `(kind, key)`, or null if never seeded. */
export function getSeedState(kind: string, key: string): SeedStateRow | null {
  const row = getDb()
    .prepare<SeedStateRow, [string, string]>(
      "SELECT kind, key, seededHash, seededAt FROM seed_state WHERE kind = ? AND key = ?",
    )
    .get(kind, key);
  return row ?? null;
}

/** Record (or refresh) the hash this framework just seeded for `(kind, key)`. */
export function recordSeedState(kind: string, key: string, seededHash: string): void {
  getDb().run(
    `INSERT INTO seed_state (kind, key, seededHash, seededAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, key) DO UPDATE SET
       seededHash = excluded.seededHash,
       seededAt = excluded.seededAt`,
    [kind, key, seededHash, new Date().toISOString()],
  );
}
