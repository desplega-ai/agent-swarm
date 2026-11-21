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
 * The guard is keyed on the live engine handle (`currentEngineHandle()`)
 * rather than a bare boolean:
 * `closeDb()` + `initDb()` (tests, DB swaps) yields a new handle that has not
 * been seeded, so it is seeded again. A failed seed does not mark the handle
 * done, so the next caller retries and still sees the error.
 */

import { ensureRbacSeedsSynced } from "./rbac-roles";
import { seedModelGroups } from "./seed-model-groups";
import { seedModelProfiles } from "./seed-model-profiles";
import { seedPricingFromModelsDev } from "./seed-pricing";
import { currentEngineHandle } from "./storage-root";

const pricingSeededDbs = new WeakSet<object>();
const rbacSyncedDbs = new WeakSet<object>();
const modelProfilesSeededDbs = new WeakSet<object>();

/** Seed the pricing table from the vendored models.dev snapshot. */
export async function ensurePricingSeeded(): Promise<void> {
  const db = currentEngineHandle();
  if (pricingSeededDbs.has(db)) return;
  await seedPricingFromModelsDev();
  pricingSeededDbs.add(db);
}

/** Sync the built-in RBAC roles, permissions and default-role trigger. */
export async function ensureRbacSeeded(): Promise<void> {
  const db = currentEngineHandle();
  if (rbacSyncedDbs.has(db)) return;
  await ensureRbacSeedsSynced();
  rbacSyncedDbs.add(db);
}

/**
 * Seed the shipped `<harness>-<tier>` model profiles (src/be/seed-model-profiles.ts),
 * then the four tier groups that list them (src/be/seed-model-groups.ts).
 */
export async function ensureModelProfilesSeeded(): Promise<void> {
  const db = currentEngineHandle();
  if (modelProfilesSeededDbs.has(db)) return;
  const inserted = await seedModelProfiles();
  if (inserted > 0) console.log(`[startup] Seeded ${inserted} model profiles`);
  const groups = await seedModelGroups();
  if (groups > 0) console.log(`[startup] Seeded ${groups} model groups`);
  modelProfilesSeededDbs.add(db);
}
