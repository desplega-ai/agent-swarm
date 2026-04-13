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
 * Runs all pending database migrations.
 *
 * - Creates the `_migrations` tracking table if it doesn't exist
 * - Reads `.sql` files from the migrations directory (sorted by numeric prefix)
 * - For existing databases (pre-migration-system), bootstraps by marking 001_initial as applied
 * - Applies pending migrations in order, each within its own transaction
 * - Verifies checksums of previously-applied migrations (warns on mismatch)
 */
export function runMigrations(db: Database): void {
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
  // import.meta.dir resolves to /$bunfs/root in compiled binaries, which isn't scannable.
  // Fall back to MIGRATIONS_DIR env var (set in Dockerfile) for compiled binary support.
  const migrationsDir = (() => {
    const dir = import.meta.dir;
    try {
      readdirSync(dir);
      return dir;
    } catch {
      const fallback = process.env.MIGRATIONS_DIR;
      if (fallback) return fallback;
      console.warn(
        "[migrations] Cannot read migrations directory and MIGRATIONS_DIR not set — skipping",
      );
      return null;
    }
  })();

  if (!migrationsDir) return;

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
    return;
  }

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
        // Database has some tables but not all baseline tables — the schema is
        // partial or from a very old version. We can't safely run 001_initial
        // on top because CREATE TABLE IF NOT EXISTS would skip existing tables
        // (keeping their old schema) while indexes/seeds reference new columns.
        // Drop all user tables so 001_initial creates everything from scratch.
        console.log(
          "[migrations] Existing database appears incomplete — dropping old tables and applying fresh",
        );
        const existingTables = db
          .prepare<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\'",
          )
          .all()
          .map((r) => r.name);
        db.run("PRAGMA foreign_keys = OFF");
        for (const table of existingTables) {
          db.run(`DROP TABLE IF EXISTS "${table}"`);
        }
        db.run("PRAGMA foreign_keys = ON");
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
    console.debug(`[migrations] Applying: ${migration.name}`);
    const start = performance.now();

    db.transaction(() => {
      db.exec(migration.sql);
      db.run("INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)", [
        migration.version,
        migration.name,
        new Date().toISOString(),
        migration.checksum,
      ]);
    })();

    const elapsed = (performance.now() - start).toFixed(1);
    console.debug(`[migrations] Applied: ${migration.name} (${elapsed}ms)`);
  }

  db.run("PRAGMA foreign_keys = ON");
}
