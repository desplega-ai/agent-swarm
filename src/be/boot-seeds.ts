/**
 * Once-per-database guards for seed work that belongs to boot.
 *
 * `createServer()` runs on every new MCP session (`POST /mcp`), and it used to
 * re-run the pricing seed (an 8.6 MB `JSON.parse` plus a 3,400-row
 * `BEGIN IMMEDIATE` insert transaction) and the RBAC seed sync on each one.
 * All of that is synchronous on the API's single event loop, so every agent
 * session start stalled every other route. Both seeds are idempotent, so the
 * first caller for a given database handle does the work and later callers
 * return immediately.
 *
 * The guard is keyed on the live `Database` handle rather than a bare boolean:
 * `closeDb()` + `initDb()` (tests, DB swaps) yields a new handle that has not
 * been seeded, so it is seeded again. A failed seed does not mark the handle
 * done, so the next caller retries and still sees the error.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "./db";
import { ensureRbacSeedsSynced } from "./rbac-roles";
import { seedPricingFromModelsDev } from "./seed-pricing";

const pricingSeededDbs = new WeakSet<Database>();
const rbacSyncedDbs = new WeakSet<Database>();

/** Seed the pricing table from the vendored models.dev snapshot. */
export function ensurePricingSeeded(): void {
  const db = getDb();
  if (pricingSeededDbs.has(db)) return;
  seedPricingFromModelsDev();
  pricingSeededDbs.add(db);
}

/** Sync the built-in RBAC roles, permissions and default-role trigger. */
export function ensureRbacSeeded(): void {
  const db = getDb();
  if (rbacSyncedDbs.has(db)) return;
  ensureRbacSeedsSynced();
  rbacSyncedDbs.add(db);
}
