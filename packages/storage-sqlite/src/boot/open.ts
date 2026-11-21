import type { Database } from "bun:sqlite";

/**
 * The synchronous start steps of the SQLite engine that come before and right
 * after the migrations: connection PRAGMAs and the legacy-schema repairs.
 * The API's own start steps (seeds, audits, secret backfills) stay in `src/`.
 */

/** True when the file holds no schema object at all. Read before any table is created. */
export function isEmptySqliteDatabase(database: Database): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get() === null;
}

/** PRAGMAs of a connection to a database file. `fresh`: the file held no schema object. */
export function applySqliteFilePragmas(database: Database, opts: { fresh: boolean }): void {
  // NONE -> INCREMENTAL on an existing schema requires a full VACUUM. Set it
  // before the first table instead; upgrades keep their current mode.
  if (opts.fresh) database.run("PRAGMA auto_vacuum = INCREMENTAL;");
  database.run("PRAGMA journal_mode = WAL;");
  database.run("PRAGMA busy_timeout = 5000;");
  database.run("PRAGMA foreign_keys = ON;");
  database.run("PRAGMA synchronous = NORMAL;");
  database.run("PRAGMA cache_size = -64000;");
  database.run("PRAGMA mmap_size = 268435456;");
  database.run("PRAGMA temp_store = MEMORY;");
}

/** PRAGMAs of a connection restored from an in-memory test template. */
export function applySqliteTemplatePragmas(database: Database): void {
  database.run("PRAGMA busy_timeout = 5000;");
  database.run("PRAGMA foreign_keys = ON;");
}
