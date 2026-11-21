import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import {
  assertNotEmptySqliteDatabase,
  backfillScriptRunSources,
  runSqliteMigrations,
} from "../storage-root";

/**
 * The SQLite migration runner lives in the SQLite engine package
 * (`@desplega/storage-sqlite`, `boot/migrations.ts`). This module keeps the
 * call sites and tests on their import path (decision D5) and owns only the
 * location of the `.sql` files, which stay in this directory.
 */

export function assertNotEmptyDatabase(db: Database, reason: string): void {
  assertNotEmptySqliteDatabase(db, reason);
}

/** Prefix `import.meta.dir` resolves to inside a `bun build --compile` binary. */
const BUNFS_PREFIX = "/$bunfs/";

/**
 * Resolves the directory to load `.sql` migration files from.
 *
 * `import.meta.dir` resolves to `/$bunfs/root` in a `bun build --compile`
 * binary — a virtual, read-only filesystem embedded in the executable that
 * does not contain the `.sql` files (those are copied to a real path at
 * `MIGRATIONS_DIR` by the Dockerfile instead; see `runner.ts`'s historical
 * comment and the Dockerfile `COPY src/be/migrations/*.sql /app/migrations/`
 * step). This used to be detected by calling `readdirSync` and catching the
 * exception it threw on `/$bunfs/`. Bun 1.4 changed `readdirSync` to succeed
 * there instead (returning the compiled binary's own directory listing), so
 * the exception never fires, `MIGRATIONS_DIR` is never consulted, and the
 * subsequent `.sql` filter matches nothing — silently skipping every
 * migration on a fresh database. Detect the virtual filesystem by prefix
 * instead of relying on `readdirSync`'s throw/no-throw behavior, which is not
 * a stable contract across Bun versions.
 */
export function resolveMigrationsDir(
  importDir: string,
  migrationsDirEnv: string | undefined = process.env.MIGRATIONS_DIR,
): string | null {
  if (importDir.startsWith(BUNFS_PREFIX)) {
    if (migrationsDirEnv) return migrationsDirEnv;
    console.warn(
      "[migrations] Running from a compiled binary (bunfs) and MIGRATIONS_DIR not set — skipping",
    );
    return null;
  }

  try {
    readdirSync(importDir);
    return importDir;
  } catch {
    if (migrationsDirEnv) return migrationsDirEnv;
    console.warn(
      "[migrations] Cannot read migrations directory and MIGRATIONS_DIR not set — skipping",
    );
    return null;
  }
}

/** Runs all pending migrations from this directory, then the script-run source backfill. */
export function runMigrations(db: Database): void {
  runSqliteMigrations(db, {
    migrationsDir: resolveMigrationsDir(import.meta.dir),
    afterMigrations: backfillScriptRunSources,
  });
}
