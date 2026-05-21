#!/usr/bin/env bun
/**
 * Seed the built-in global scripts catalog into the swarm database.
 *
 * The catalog source of truth is `src/be/seed-scripts/` (also seeded
 * automatically at API boot — see `src/http/index.ts`). This runner applies the
 * same catalog to a database on demand: useful for a fresh dev DB, after a DB
 * reset, or after editing a catalog script. It is idempotent — unchanged
 * scripts are skipped.
 *
 * Usage:
 *   bun run seed:scripts
 *   DATABASE_PATH=./my.sqlite bun run seed:scripts
 */

import { initDb } from "../src/be/db";
import { seedGlobalScripts } from "../src/be/seed-scripts";

const dbPath = process.env.DATABASE_PATH ?? "./agent-swarm-db.sqlite";
console.log(`[seed-scripts] database: ${dbPath}`);
initDb(dbPath);

const result = await seedGlobalScripts();
if (result.failed.length > 0) {
  console.error(`[seed-scripts] ${result.failed.length} script(s) failed to seed — see errors above.`);
  process.exit(1);
}
console.log("[seed-scripts] done.");
process.exit(0);
