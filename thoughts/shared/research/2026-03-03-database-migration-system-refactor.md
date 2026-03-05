# RFC: Database Migration System Refactor

**Status:** Proposal
**Author:** Researcher (swarm agent)
**Date:** 2026-03-03

## Summary

Replace the current inline try-catch migration pattern in `src/be/db.ts` with a dedicated migration system using numbered SQL files, a migrations tracking table, and an incremental runner. All 53 existing inline migrations would be collapsed into a single `001_initial.sql` baseline.

## Motivation

The current `db.ts` file is 6,210 lines long. ~450 of those lines (lines 456-906) are sequential `try { ALTER TABLE ... } catch {}` blocks that run on every application startup. This approach has several problems:

1. **No migration tracking** — there is no `schema_migrations` table, no `PRAGMA user_version`, no way to know which migrations have been applied. Every migration runs on every startup.
2. **Silent failures** — the `catch {}` pattern swallows all errors, not just "column already exists". A genuine bug in a migration (e.g., wrong column type, referencing a non-existent table) would be silently ignored.
3. **Monolithic file** — schema definitions, migrations, and query functions all live in one 6,210-line file. The migrations section grows linearly with every schema change.
4. **No rollback capability** — there is no `down` migration or any way to revert a schema change.
5. **Ordering is implicit** — migration order depends on line position in the source file. There are no explicit version numbers or dependency declarations.
6. **Difficult to review** — new migrations are added as yet another try-catch block at the bottom of `initDb()`. It's hard to see what changed in a PR without reading the entire function.

## Current State Analysis

### Architecture

- **Single file**: `src/be/db.ts` contains everything — schema, migrations, queries
- **Runtime**: Bun's built-in SQLite (`bun:sqlite`) with WAL journal mode
- **Initialization**: `initDb()` function (lines 38-908) runs on every server start
- **Schema**: 18 tables, 34+ indexes

### How Migrations Work Today

The `initDb()` function has three phases:

**Phase 1: Schema creation (lines 55-425)** — wrapped in a transaction, uses `CREATE TABLE IF NOT EXISTS` for all core tables and `CREATE INDEX IF NOT EXISTS` for indexes. This is idempotent.

**Phase 2: Data seeding (lines 431-454)** — fixes old general channel ID format, seeds default channel. Uses try-catch.

**Phase 3: Column migrations (lines 456-906)** — 53 sequential try-catch blocks, each adding a column or index:

```typescript
// Typical pattern (repeated 53 times)
try {
  db.run(`ALTER TABLE agent_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'mcp'`);
} catch { /* exists */ }
```

One notable exception: the `inbox_messages` table recreation (lines 678-733) checks `sqlite_master` to detect whether migration is needed, then performs a full table copy to modify a CHECK constraint. This is the only migration that properly detects state before acting.

### Tables and Migration Counts

| Table | Core Columns | Migrated Columns | Notes |
|-------|-------------|-------------------|-------|
| `agents` | 7 | 11 | Profile fields added incrementally |
| `agent_tasks` | 10 | 23 | Most migrated table by far |
| `agent_log` | 7 | 0 | Stable since creation |
| `channels` | 7 | 0 | Stable |
| `channel_messages` | 7 | 0 | Stable |
| `channel_read_state` | 3 | 1 | `processing_since` added |
| `services` | 11 | 5 | PM2 columns added |
| `session_logs` | 7 | 0 | Stable |
| `session_costs` | 13 | 0 | Stable |
| `inbox_messages` | 12 | 0 | Table recreated for CHECK constraint |
| `scheduled_tasks` | 16 | 4 | Error tracking + model |
| `epics` | 20 | 2 | Progress + channel |
| `swarm_config` | 10 | 0 | Stable |
| `swarm_repos` | 7 | 0 | Stable |
| `agent_memory` | 15 | 0 | Stable |
| `active_sessions` | 7 | 0 | UNIQUE index added post-creation |
| `agentmail_inbox_mappings` | 5 | 0 | Created outside main transaction |
| `context_versions` | 11 | 0 | Created outside main transaction |

## Proposed Solution

### 1. Migrations Folder Structure

```
src/be/
  migrations/
    001_initial.sql          # Collapsed baseline (all current schema)
    002_example_feature.sql   # Future migration example
    ...
    runner.ts                # Migration runner logic
  db.ts                      # Queries only (schema code removed)
```

Each migration file is a plain `.sql` file with a numeric prefix that determines execution order. The prefix is zero-padded to 3 digits (supports up to 999 migrations before needing more digits).

**Naming convention:** `{NNN}_{descriptive_name}.sql`

### 2. Baseline Migration: `001_initial.sql`

This file collapses ALL current tables, indexes, and column additions into a single coherent schema definition. No try-catch blocks, no ALTER TABLE ADD COLUMN — just clean `CREATE TABLE` statements with all columns present from the start.

The file would contain:
- All 18 `CREATE TABLE` statements with their full current schema (including all migrated columns)
- All 34+ `CREATE INDEX` statements
- The default `general` channel seed

This represents the "known good" state as of the migration system introduction.

### 3. Migration Tracking Table

Add a new table to track applied migrations:

```sql
CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,      -- e.g., 1, 2, 3
    name TEXT NOT NULL,               -- e.g., '001_initial'
    applied_at TEXT NOT NULL,         -- ISO timestamp
    checksum TEXT NOT NULL            -- SHA-256 of the .sql file content
);
```

Design decisions:
- **`_migrations` name** — underscore prefix to distinguish from application tables
- **`version` as INTEGER PRIMARY KEY** — extracted from the filename prefix, natural ordering
- **`checksum`** — detects if a previously-applied migration file has been modified (which would indicate a problem)
- **No `down` migrations** — SQLite's limited ALTER TABLE support makes reliable rollbacks impractical. If a migration is wrong, the fix is a new forward migration.

### 4. Migration Runner: `runner.ts`

The runner replaces the current inline migration logic in `initDb()`. It:

1. Ensures the `_migrations` table exists
2. Reads all `.sql` files from the `migrations/` directory
3. Sorts them by numeric prefix
4. For each migration not yet in `_migrations`:
   - Computes checksum
   - Executes the SQL within a transaction
   - Records it in `_migrations`
5. For already-applied migrations, verifies the checksum matches (warns on mismatch)

```typescript
// Pseudocode for runner.ts
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
  const migrationsDir = join(import.meta.dir, "migrations");
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  const migrations: Migration[] = files.map(file => {
    const version = parseInt(file.split("_")[0], 10);
    const name = file.replace(".sql", "");
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    return { version, name, sql, checksum };
  });

  // 3. Get applied migrations
  const applied = new Map<number, { name: string; checksum: string }>();
  const rows = db.prepare("SELECT version, name, checksum FROM _migrations").all();
  for (const row of rows) {
    applied.set(row.version, { name: row.name, checksum: row.checksum });
  }

  // 4. Run pending migrations
  for (const migration of migrations) {
    const existing = applied.get(migration.version);

    if (existing) {
      // Verify checksum hasn't changed
      if (existing.checksum !== migration.checksum) {
        console.warn(
          `WARNING: Migration ${migration.name} checksum mismatch. ` +
          `Applied: ${existing.checksum}, Current: ${migration.checksum}. ` +
          `Do not modify applied migrations — create a new one instead.`
        );
      }
      continue;
    }

    // Run the migration in a transaction
    console.log(`Applying migration: ${migration.name}`);
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
        [migration.version, migration.name, new Date().toISOString(), migration.checksum]
      );
    })();
  }
}
```

### 5. Changes to `db.ts`

After migration:
- Remove all `CREATE TABLE IF NOT EXISTS` blocks from `initDb()`
- Remove all try-catch `ALTER TABLE ADD COLUMN` blocks
- Remove data seeding logic (moved to `001_initial.sql`)
- Replace with a single call: `runMigrations(db)`
- Keep all query functions as-is

The `initDb()` function shrinks from ~870 lines to roughly:

```typescript
export function initDb(dbPath?: string): Database {
  if (db) return db;

  db = new Database(dbPath || "./swarm.sqlite");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  runMigrations(db);

  return db;
}
```

### 6. Handling Existing Databases

The critical question: how do existing production databases transition to the new system?

**Approach: Detect and bootstrap.**

When the runner starts and finds no `_migrations` table, it checks if the database already has tables (e.g., `SELECT count(*) FROM sqlite_master WHERE type='table'`). If tables exist, the database predates the migration system. In this case:

1. Create the `_migrations` table
2. Insert a record for `001_initial` without executing its SQL (the schema already exists)
3. Proceed to apply any migrations > 001 normally

This avoids re-running the baseline against an already-populated database.

```typescript
function bootstrapExistingDb(db: Database, initialMigration: Migration): void {
  const tableCount = db.prepare(
    "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE '_migrations'"
  ).get();

  if (tableCount.cnt > 0) {
    console.log("Existing database detected — bootstrapping migration tracking");
    db.run(
      "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
      [initialMigration.version, initialMigration.name, new Date().toISOString(), initialMigration.checksum]
    );
  }
}
```

## Implementation Plan

### Phase 1: Create migration infrastructure (non-breaking)

1. Create `src/be/migrations/` directory
2. Create `src/be/migrations/runner.ts` with the migration runner
3. Create `src/be/migrations/001_initial.sql` — the collapsed baseline containing all current schema
4. Add `_migrations` table creation to the runner
5. Add bootstrap logic for existing databases

**Risk:** None. No existing code is modified.

### Phase 2: Wire up the runner

1. Modify `initDb()` to call `runMigrations(db)` after PRAGMAs
2. Keep all existing inline migrations temporarily (belt-and-suspenders)
3. Test against:
   - Fresh database (runner creates everything from `001_initial.sql`)
   - Existing database (runner bootstraps, skips `001_initial.sql`)

**Risk:** Low. Existing migrations still run as fallback.

### Phase 3: Remove inline migrations

1. Remove all try-catch migration blocks from `initDb()`
2. Remove `CREATE TABLE IF NOT EXISTS` blocks from `initDb()`
3. Move data seeding to `001_initial.sql` if not already there
4. Update tests that call `initDb()` directly

**Risk:** Medium. This is the breaking change. Must verify all paths.

### Phase 4: Ongoing usage

For any new schema change:
1. Create `NNN_descriptive_name.sql` in `migrations/`
2. Write the forward-only SQL
3. Test against fresh DB and existing DB
4. Deploy — the runner handles the rest

## Design Decisions & Trade-offs

### Why plain SQL files, not TypeScript migrations?

- SQL files are reviewable without running code
- They can be checksummed deterministically
- They match what actually executes against SQLite
- TypeScript migrations add complexity (imports, compilation) for no benefit in our case

### Why no `down` migrations?

SQLite has very limited `ALTER TABLE` support — you cannot drop columns (before 3.35.0, and even then it's limited), modify column types, or remove constraints without table recreation. Reliable `down` migrations would require table-copy logic for most operations, making them fragile and error-prone. Forward-only is simpler and more honest.

### Why numbered prefixes instead of timestamps?

- Sequential numbers are easier to reason about ordering
- Timestamps can collide if two developers create migrations at the same time
- The repo is maintained by a small team where conflicts are unlikely
- 3-digit prefixes support 999 migrations, which is plenty

### Why `_migrations` not `schema_migrations`?

The underscore prefix visually separates infrastructure tables from application tables. It also won't collide with any future application table name.

## Testing Strategy

1. **Unit tests for the runner**: Fresh DB, existing DB bootstrap, checksum verification, out-of-order detection
2. **Integration tests**: `initDb()` with a temporary database, verify schema matches expectations
3. **Production migration test**: Take a copy of the production database, run the new `initDb()`, verify no errors and schema is correct

## Open Questions

1. **Should we add a CLI command for creating migrations?** Something like `bun run create-migration add-user-avatar` that generates the next numbered file. Nice-to-have, not required.
2. **Should the runner log to the database or just console?** Console logging is probably sufficient since migrations only run on startup.
3. **Should we enforce that `001_initial.sql` checksum matches a known value during the bootstrap?** This would catch accidental edits to the baseline, but might be overly strict.
