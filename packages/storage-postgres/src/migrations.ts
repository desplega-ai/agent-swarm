import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PostgresClient } from "./client";

/**
 * The Postgres migration runner (decision D12).
 *
 * - Holds a session advisory lock on one reserved connection for the whole
 *   run, so a second runner on the same database waits, then finds nothing to
 *   do.
 * - Creates `_migrations` (the columns of the SQLite runner: version, name,
 *   applied_at, checksum).
 * - Applies each pending `.sql` file of the Postgres chain in its own
 *   transaction, and records it in the same transaction.
 * - Verifies the checksum of each applied file and warns on a mismatch, like
 *   the SQLite runner.
 *
 * Files: `<ordinal>_<name>.sql` directly in `migrationsDir` (subdirectories
 * such as `parts/` and non-SQL files are ignored). The chain starts with the
 * generated baseline.
 */

/** Key of the session advisory lock the runner holds (`pg_advisory_lock(bigint)`). */
export const MIGRATION_LOCK_KEY = 7_365_420_301n;

type ReservedConnection = {
  unsafe(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  release(): void;
};
type ReservablePool = { reserve(): Promise<ReservedConnection> };

export type PostgresMigrationOptions = {
  /** Directory of the Postgres chain (`src/be/migrations/postgres`). */
  migrationsDir: string;
  /** Progress lines; `console.log` by default. */
  log?: (line: string) => void;
  /** Checksum mismatch warnings; `console.warn` by default. */
  warn?: (line: string) => void;
  /**
   * The caller already holds a transaction on the reserved connection (the data
   * copy): each migration runs inside it, with no BEGIN or COMMIT of its own, so
   * the caller's ROLLBACK also undoes the chain.
   */
  inCallerTransaction?: boolean;
};

export type PostgresMigrationResult = {
  /** Names of the files applied by this run, in order. */
  applied: string[];
  /** Names of the files that were already applied. */
  alreadyApplied: string[];
};

type MigrationFile = { version: number; name: string; sql: string; checksum: string };

export function loadPostgresMigrations(migrationsDir: string): MigrationFile[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f) && statSync(join(migrationsDir, f)).isFile())
    .sort();
  const seen = new Map<number, string>();
  return files.map((file) => {
    const version = Number.parseInt(file.split("_")[0] ?? "", 10);
    const name = file.replace(/\.sql$/, "");
    const previous = seen.get(version);
    if (previous) {
      throw new Error(`[pg-migrations] ordinal ${version} is used twice: ${previous}, ${name}`);
    }
    seen.set(version, name);
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { version, name, sql, checksum };
  });
}

function poolOf(target: PostgresClient | ReservablePool): ReservablePool {
  return "pool" in target ? (target.pool as unknown as ReservablePool) : target;
}

export async function runPostgresMigrations(
  target: PostgresClient | ReservablePool,
  options: PostgresMigrationOptions,
): Promise<PostgresMigrationResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const migrations = loadPostgresMigrations(options.migrationsDir);
  if (migrations.length === 0) {
    throw new Error(`[pg-migrations] no .sql migration files found in ${options.migrationsDir}`);
  }

  const conn = await poolOf(target).reserve();
  let locked = false;
  try {
    await conn.unsafe("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    locked = true;
    await conn.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version bigint PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL,
        checksum text NOT NULL
      )
    `);
    const rows = await conn.unsafe("SELECT version, name, checksum FROM _migrations");
    const applied = new Map<number, { name: string; checksum: string }>();
    for (const row of rows) {
      applied.set(Number(row.version), { name: String(row.name), checksum: String(row.checksum) });
    }

    const result: PostgresMigrationResult = { applied: [], alreadyApplied: [] };
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          warn(
            `[pg-migrations] WARNING: Migration ${migration.name} checksum mismatch. ` +
              `Applied: ${existing.checksum.slice(0, 12)}..., Current: ${migration.checksum.slice(0, 12)}... ` +
              "Do not modify applied migrations — create a new one instead.",
          );
        }
        result.alreadyApplied.push(migration.name);
        continue;
      }
      log(`[pg-migrations] Applying: ${migration.name}`);
      const started = performance.now();
      try {
        if (!options.inCallerTransaction) await conn.unsafe("BEGIN");
        // No parameters: the simple query protocol runs every statement of the file.
        await conn.unsafe(migration.sql);
        await conn.unsafe(
          "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES ($1, $2, statement_timestamp(), $3)",
          [migration.version, migration.name, migration.checksum],
        );
        if (!options.inCallerTransaction) await conn.unsafe("COMMIT");
      } catch (error) {
        if (!options.inCallerTransaction) await conn.unsafe("ROLLBACK").catch(() => {});
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[pg-migrations] Migration ${migration.version} (${migration.name}) failed: ${detail}`,
          { cause: error },
        );
      }
      log(
        `[pg-migrations] Applied: ${migration.name} (${(performance.now() - started).toFixed(1)}ms)`,
      );
      result.applied.push(migration.name);
    }
    return result;
  } finally {
    if (locked) {
      await conn.unsafe("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    conn.release();
  }
}
