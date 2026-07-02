#!/usr/bin/env bun
/**
 * Seed the built-in entity catalog into the swarm database.
 *
 * The catalog source of truth lives under `src/be/` (scripts in
 * `src/be/seed-scripts/`; future kinds register their own seeder). It is also
 * seeded automatically at API boot — see `src/http/index.ts`. This runner
 * applies the same catalog to a database on demand: useful for a fresh dev DB,
 * after a DB reset, or after editing a catalog entry.
 *
 * Re-seeding is version-aware: a pristine entity updates when its source
 * changes, a user-modified one is preserved. See `src/be/seed`.
 *
 * Usage:
 *   bun run seed:scripts
 *   DATABASE_PATH=./my.sqlite bun run seed:scripts
 */

import { initDb } from "../apps/swarm/src/be/db";
import { runAllSeeders } from "../apps/swarm/src/be/seed";

const dbPath = process.env.DATABASE_PATH ?? "./agent-swarm-db.sqlite";
console.log(`[seed] database: ${dbPath}`);
initDb(dbPath);

const results = await runAllSeeders();
const failed = results.reduce((n, r) => n + r.failed.length, 0);
if (failed > 0) {
  console.error(`[seed] ${failed} entit(ies) failed to seed — see errors above.`);
  process.exit(1);
}
console.log("[seed] done.");
process.exit(0);
