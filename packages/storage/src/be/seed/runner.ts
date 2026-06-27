/**
 * The seeder harness. Drives every {@link Seeder} the same way and enforces the
 * versioning rule documented in {@link ./types}. Adding a new seedable kind
 * never requires touching this file.
 */

import { getSeedState, recordSeedState } from "./state-db";
import type { Seeder, SeederResult, SeederRunOptions } from "./types";

/**
 * Apply one seeder. Idempotent and version-aware:
 *   - upstream absent              -> create
 *   - upstream pristine, src moved -> update
 *   - upstream pristine, src same  -> no-op
 *   - upstream user-modified       -> preserve (never overwrite)
 */
export async function runSeeder(seeder: Seeder, opts?: SeederRunOptions): Promise<SeederResult> {
  const result: SeederResult = {
    kind: seeder.kind,
    created: 0,
    updated: 0,
    skippedUnchanged: 0,
    skippedUserModified: 0,
    failed: [],
  };

  const items = await seeder.items();
  for (const item of items) {
    try {
      const upstream = await seeder.upstreamHash(item);

      // Absent upstream -> create.
      if (upstream === null) {
        await seeder.apply(item, "create", opts);
        recordSeedState(seeder.kind, item.key, item.contentHash);
        result.created += 1;
        continue;
      }

      const state = getSeedState(seeder.kind, item.key);
      // "Pristine" = the live upstream copy still matches what we last seeded.
      // With no recorded state (first run after this framework landed, or a
      // pre-existing entity) we can only treat it as pristine when it is
      // byte-identical to the source — otherwise we conservatively assume a
      // user authored it and must not be clobbered.
      const pristine = state ? upstream === state.seededHash : upstream === item.contentHash;

      if (!pristine) {
        // A user changed the upstream copy since our last seed — preserve it.
        result.skippedUserModified += 1;
        continue;
      }

      if (upstream === item.contentHash) {
        // Neither side changed. Adopt an unrecorded-but-identical entity so the
        // next source change is correctly detectable as an update.
        if (!state) recordSeedState(seeder.kind, item.key, item.contentHash);
        result.skippedUnchanged += 1;
        continue;
      }

      // Pristine upstream + changed source -> update to the new source version.
      await seeder.apply(item, "update", opts);
      recordSeedState(seeder.kind, item.key, item.contentHash);
      result.updated += 1;
    } catch (err) {
      result.failed.push({
        key: item.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!opts?.quiet) {
    console.log(
      `[seed:${result.kind}] created=${result.created} updated=${result.updated} ` +
        `unchanged=${result.skippedUnchanged} preserved=${result.skippedUserModified} ` +
        `failed=${result.failed.length}`,
    );
    for (const f of result.failed) {
      console.error(`[seed:${result.kind}] FAILED ${f.key}: ${f.error}`);
    }
  }

  return result;
}

/** Apply a list of seeders in order. */
export async function runSeeders(
  seeders: Seeder[],
  opts?: SeederRunOptions,
): Promise<SeederResult[]> {
  const results: SeederResult[] = [];
  for (const seeder of seeders) {
    results.push(await runSeeder(seeder, opts));
  }
  return results;
}
