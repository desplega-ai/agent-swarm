import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

const BASELINE_TABLES = [
  "agents",
  "channels",
  "agent_tasks",
  "agent_log",
  "channel_messages",
  "channel_read_state",
  "services",
  "session_logs",
  "session_costs",
  "inbox_messages",
  "scheduled_tasks",
  "swarm_config",
  "swarm_repos",
  "agent_memory",
  "active_sessions",
  "agentmail_inbox_mappings",
  "context_versions",
];

// 090 was renumbered after being applied in production (2026-06-10): PR #722
// shipped the metrics seed as 090_seed_swarm_operations_metrics; PR #719 then
// took 090 for model tiers and renumbered the seed to 091. Databases that
// applied seed-as-090 recorded version 90 with the seed's checksum, so the
// runner skipped 090_model_tiers forever and task inserts crashed on the
// missing modelTier column. Detect that exact history and repair it in place:
// apply the missing ALTERs and repoint row 90 at 090_model_tiers. No-op on
// fresh databases and on histories where 090_model_tiers applied normally.
const SEED_APPLIED_AS_090_CHECKSUM =
  "8ca4a05263b42d115b419f468bf5113caa5b7ee4363177568897513549224b01";

function repairRenumberedModelTiers(db: Database, migrations: Migration[]): void {
  const modelTiers = migrations.find((m) => m.name === "090_model_tiers");
  if (!modelTiers) return;

  const row = db
    .prepare<AppliedMigration, []>(
      "SELECT version, name, checksum FROM _migrations WHERE version = 90",
    )
    .get();
  if (
    !row ||
    row.name !== "090_seed_swarm_operations_metrics" ||
    row.checksum !== SEED_APPLIED_AS_090_CHECKSUM
  ) {
    return;
  }

  console.warn(
    "[migrations] Repairing renumbered migration 090: applying 090_model_tiers over seed-as-090 history",
  );

  db.transaction(() => {
    for (const table of ["agent_tasks", "scheduled_tasks"]) {
      const hasColumn = db
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = 'modelTier'",
        )
        .get(table);
      if (!hasColumn?.n) {
        db.run(`ALTER TABLE ${table} ADD COLUMN modelTier TEXT`);
      }
    }
    db.run("UPDATE _migrations SET name = ?, checksum = ? WHERE version = 90", [
      modelTiers.name,
      modelTiers.checksum,
    ]);
  }).immediate();
}

function shouldBootstrapInitialMigration(db: Database): boolean {
  const rows = db
    .prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_migrations' ESCAPE '\\'",
    )
    .all();

  if (rows.length === 0) {
    return false;
  }

  const existingTables = new Set(rows.map((row) => row.name));
  return BASELINE_TABLES.every((table) => existingTables.has(table));
}

/**
 * A missing migrations directory or an empty migration set is a safe no-op
 * on a database that already has tables (an already-migrated database, or a
 * pre-migration-system legacy one that `shouldBootstrapInitialMigration`
 * will handle). On a genuinely empty database it means the baseline schema
 * — including `agents` — will never be created, and the process will instead
 * crash several layers downstream (e.g. `ensureAgentProfileColumns` hitting
 * `no such table: agents`) with no indication of the real cause. Fail loudly
 * here instead, at the point where the cause is still known.
 */
export function assertNotEmptySqliteDatabase(db: Database, reason: string): void {
  const rows = db
    .prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_migrations' ESCAPE '\\'",
    )
    .all();
  if (rows.length === 0) {
    throw new Error(
      `[migrations] Refusing to boot: ${reason}, and the database has no tables yet. ` +
        "This looks like a fresh database whose baseline schema never got created — " +
        "check MIGRATIONS_DIR and that the migrations directory is packaged correctly.",
    );
  }
}

/**
 * Runs all pending database migrations.
 *
 * - Creates the `_migrations` tracking table if it doesn't exist
 * - Reads `.sql` files from the migrations directory (sorted by numeric prefix)
 * - For existing databases (pre-migration-system), bootstraps by marking 001_initial as applied
 * - Applies pending migrations in order, each within its own transaction
 * - Verifies checksums of previously-applied migrations (warns on mismatch)
 */
export type SqliteMigrationOptions = {
  /** Directory of the `.sql` files; `null` when none could be located. */
  migrationsDir: string | null;
  /** Runs after the migrations (also on the no-files paths), on the same handle. */
  afterMigrations?: (db: Database) => void;
};

export function runSqliteMigrations(db: Database, options: SqliteMigrationOptions): void {
  const after = options.afterMigrations ?? (() => {});
  // 1. Ensure tracking table exists
  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);

  // 2. Load migration files
  const migrationsDir = options.migrationsDir;

  if (!migrationsDir) {
    assertNotEmptySqliteDatabase(
      db,
      "no migrations directory could be located (see the preceding [migrations] warning)",
    );
    after(db);
    return;
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const migrations: Migration[] = files.map((file) => {
    const version = parseInt(file.split("_")[0] ?? "0", 10);
    const name = file.replace(".sql", "");
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { version, name, sql, checksum };
  });

  if (migrations.length === 0) {
    assertNotEmptySqliteDatabase(db, `no .sql migration files found in ${migrationsDir}`);
    after(db);
    return;
  }

  repairRenumberedModelTiers(db, migrations);

  // 3. Get applied migrations
  const applied = new Map<number, AppliedMigration>();
  const rows = db
    .prepare("SELECT version, name, checksum FROM _migrations")
    .all() as AppliedMigration[];
  for (const row of rows) {
    applied.set(row.version, {
      version: row.version,
      name: row.name,
      checksum: row.checksum,
    });
  }

  // 4. Bootstrap existing databases
  // If no migrations have been applied yet and database tables already exist,
  // this is a pre-migration-system database. Mark 001_initial as applied without
  // executing it (the schema already exists).
  if (applied.size === 0) {
    const initialMigration = migrations.find((m) => m.version === 1);
    if (initialMigration) {
      if (shouldBootstrapInitialMigration(db)) {
        console.debug("[migrations] Existing database detected — bootstrapping migration tracking");
        db.run(
          "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
          [
            initialMigration.version,
            initialMigration.name,
            new Date().toISOString(),
            initialMigration.checksum,
          ],
        );
        applied.set(initialMigration.version, {
          version: initialMigration.version,
          name: initialMigration.name,
          checksum: initialMigration.checksum,
        });
      } else {
        console.warn(
          "[migrations] Existing database appears incomplete — applying 001_initial migration",
        );
      }
    }
  }

  // 5. Run pending migrations
  // Disable FK checks for the entire migration pass. Individual migrations
  // (008, 025, 026) need to DROP + recreate tables, which can violate FKs
  // mid-transaction. PRAGMA foreign_keys cannot be changed inside a transaction,
  // so we disable it here, outside any transaction, and re-enable after.
  db.run("PRAGMA foreign_keys = OFF");

  for (const migration of migrations) {
    const existing = applied.get(migration.version);

    if (existing) {
      // Verify checksum hasn't changed
      if (existing.checksum !== migration.checksum) {
        console.warn(
          `[migrations] WARNING: Migration ${migration.name} checksum mismatch. ` +
            `Applied: ${existing.checksum.slice(0, 12)}..., Current: ${migration.checksum.slice(0, 12)}... ` +
            `Do not modify applied migrations — create a new one instead.`,
        );
      }
      continue;
    }

    // Apply migration in a transaction
    console.log(`[migrations] Applying: ${migration.name}`);
    const start = performance.now();

    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.run(
          "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
          [migration.version, migration.name, new Date().toISOString(), migration.checksum],
        );
      }).immediate();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[migrations] Migration ${migration.version} (${migration.name}) failed: ${detail}`,
        { cause: error },
      );
    }

    const elapsed = (performance.now() - start).toFixed(1);
    console.log(`[migrations] Applied: ${migration.name} (${elapsed}ms)`);
  }

  db.run("PRAGMA foreign_keys = ON");

  // Run outside the schema transactions so an interrupted boot keeps completed
  // batches. Check the actual schema even when its SQL file is not packaged:
  // an upgraded database can reuse it even with an incomplete migration bundle.
  after(db);
}
