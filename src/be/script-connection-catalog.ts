import { getDbClient } from "./db/runtime";

let generation = 0;

/**
 * Bumped by every script_connections write. The run-time connection catalog
 * cache (`loadScriptConnectionCatalog`) drops entries that predate a write
 * instead of waiting out its TTL. Its own module so `db.ts` can bump it
 * without importing `script-connections.ts` (which imports `db.ts`).
 */
export function getScriptConnectionCatalogGeneration(): number {
  return generation;
}

/** Call after every script_connections write, inside its transaction when there is one. */
export function invalidateScriptConnectionCatalog(): void {
  generation++;
  const client = getDbClient();
  // A read that starts before COMMIT (another Postgres connection) still sees the old rows.
  if (client.inTransaction()) client.afterCommit(() => void generation++);
}
