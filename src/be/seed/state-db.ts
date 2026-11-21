/**
 * `seed_state` accessors — the per-(kind, key) record of the content hash the
 * seeder framework last wrote. Lets {@link runSeeder} tell a pristine upstream
 * entity from one a user has modified. See migration 070_seed_state.sql.
 */

import type { SeedStateRow } from "@desplega/storage";
import { getStorage } from "../storage";

export type { SeedStateRow };

/** The last hash this framework seeded for `(kind, key)`, or null if never seeded. */
export async function getSeedState(kind: string, key: string): Promise<SeedStateRow | null> {
  return getStorage().repos.config.getSeedState(kind, key);
}

/** Record (or refresh) the hash this framework just seeded for `(kind, key)`. */
export async function recordSeedState(
  kind: string,
  key: string,
  seededHash: string,
): Promise<void> {
  await getStorage().repos.config.upsertSeedState({
    kind,
    key,
    seededHash,
    seededAt: new Date().toISOString(),
  });
}

/** Forget `(kind, key)`, e.g. after the seeder retires the entity it seeded. */
export async function deleteSeedState(kind: string, key: string): Promise<void> {
  await getStorage().repos.config.deleteSeedState(kind, key);
}
