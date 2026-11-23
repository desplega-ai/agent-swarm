import path from "node:path";

/**
 * The API's data directory: where the encryption key file and the page-session
 * secret live (decision D2). It does not depend on the storage engine.
 *
 * `SWARM_DATA_DIR` sets it. Without it the directory of the SQLite file is
 * used (`DATABASE_PATH`, default `./agent-swarm-db.sqlite`), which gives the
 * same paths as before the setting existed.
 */
export function swarmDataDir(
  dbPath: string = process.env.DATABASE_PATH || "./agent-swarm-db.sqlite",
): string {
  const configured = process.env.SWARM_DATA_DIR?.trim();
  return configured ? configured : path.dirname(dbPath);
}
