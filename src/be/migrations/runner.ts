import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

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
  const migrationsDir = import.meta.dir;
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
      const tableCount = db
        .prepare(
          "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_migrations' ESCAPE '\\'",
        )
        .get() as { cnt: number };

      if (tableCount.cnt > 0) {
        console.log(
          "[migrations] Existing database detected — bootstrapping migration tracking",
        );
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
      }
    }
  }

  // 5. Run pending migrations
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

    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
        [
          migration.version,
          migration.name,
          new Date().toISOString(),
          migration.checksum,
        ],
      );
    })();

    const elapsed = (performance.now() - start).toFixed(1);
    console.log(`[migrations] Applied: ${migration.name} (${elapsed}ms)`);
  }
}
