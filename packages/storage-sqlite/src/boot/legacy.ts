import type { Database } from "bun:sqlite";

/**
 * Legacy-schema repairs of the SQLite engine that run on each start, after the
 * migrations. Both are no-ops on a database the migration chain created.
 */

/**
 * Old databases have CHECK(status IN ('pending','in_progress','completed','failed'))
 * on agent_tasks.status, which blocks 'cancelled', 'paused', 'offered', 'unassigned'.
 * Rebuild the table without that CHECK.
 */
export function removeLegacyTaskStatusCheck(database: Database): void {
  try {
    const taskSchemaInfo = database
      .prepare<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'",
      )
      .get();

    const schemaSql = taskSchemaInfo?.sql ?? "";
    const hasStatusCheck = /status\s+TEXT\b[^,]*\bCHECK\s*\(\s*status\s+IN\s*\(/i.test(schemaSql);
    const statusAllowsCancelled = /status\s+IN\s*\([^)]*'cancelled'/i.test(schemaSql);
    const needsStatusMigration = hasStatusCheck && !statusAllowsCancelled;

    if (needsStatusMigration) {
      console.log("[Migration] Removing restrictive CHECK constraint on agent_tasks.status");
      database.run("PRAGMA foreign_keys=off");

      // Migrations run before this compatibility guard, so a legacy table now
      // carries every current column. Rebuilding from an old hard-coded column
      // list would silently discard later fields. Derive the replacement
      // schema, copy list, indexes, and triggers from the live table instead;
      // remove only the obsolete status CHECK.
      const rebuiltSchemaSql = schemaSql
        .replace(
          /^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)(?:"agent_tasks"|agent_tasks)/i,
          "$1agent_tasks_new",
        )
        .replace(/\s+CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i, "");
      if (rebuiltSchemaSql === schemaSql || !/agent_tasks_new/i.test(rebuiltSchemaSql)) {
        throw new Error("Could not derive agent_tasks schema without legacy status CHECK");
      }
      const columns = database
        .prepare<{ name: string }, []>('PRAGMA table_info("agent_tasks")')
        .all()
        .map((column) => `"${column.name.replaceAll('"', '""')}"`)
        .join(", ");
      // Triggers on other tables that read agent_tasks (the session summary
      // recompute, migration 253) would fail the rename's schema check while
      // agent_tasks is dropped, so they are dropped and re-created too.
      const schemaObjects = database
        .prepare<{ name: string; tbl_name: string; sql: string }, []>(
          `SELECT name, tbl_name, sql FROM sqlite_master
           WHERE type IN ('index', 'trigger')
             AND sql IS NOT NULL
             AND (tbl_name = 'agent_tasks' OR (type = 'trigger' AND sql LIKE '%agent_tasks%'))
           ORDER BY type, name`,
        )
        .all();

      database
        .transaction(() => {
          database.run("DROP TABLE IF EXISTS agent_tasks_new");
          database.run(rebuiltSchemaSql);
          // Copy rowids too: agent_tasks_fts (migration 256) is keyed by them.
          database.run(
            `INSERT INTO agent_tasks_new (rowid, ${columns}) SELECT rowid, ${columns} FROM agent_tasks`,
          );
          for (const object of schemaObjects) {
            if (object.tbl_name !== "agent_tasks") database.run(`DROP TRIGGER "${object.name}"`);
          }
          database.run("DROP TABLE agent_tasks");
          database.run("ALTER TABLE agent_tasks_new RENAME TO agent_tasks");
          for (const object of schemaObjects) database.run(object.sql);
        })
        .immediate();

      database.run("PRAGMA foreign_keys=on");
      console.log("[Migration] Successfully removed CHECK constraint on agent_tasks.status");
    }
  } catch (e) {
    console.error("[Migration] Failed to update agent_tasks CHECK constraint:", e);
    try {
      database.run("PRAGMA foreign_keys=on");
    } catch (cleanupError) {
      console.error("[Migration] Failed to re-enable SQLite foreign_keys pragma:", cleanupError);
    }
    throw e;
  }
}

/** Compatibility backfill for legacy databases that predate the agent profile fields. */
export function ensureAgentProfileColumns(database: Database, columns: readonly string[]): void {
  // `PRAGMA table_info` on a nonexistent table returns an empty result set
  // rather than erroring, which used to make every column below look
  // "missing" on a table that was never created and throw `no such table:
  // agents` from the ALTER below. This is a legacy-compat shim for
  // pre-migration-system databases; runMigrations() (and its own
  // assertNotEmptyDatabase guard) is what's responsible for the `agents`
  // table existing at all, and already fails loudly if it doesn't. This
  // function must never be the thing that crashes startup instead.
  const agentsTableExists = database
    .prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'",
    )
    .get();
  if (!agentsTableExists) {
    console.warn("[Migration] agents table does not exist yet — skipping profile column backfill");
    return;
  }

  const existingColumns = new Set(
    database
      .prepare<{ name: string }, []>("PRAGMA table_info(agents)")
      .all()
      .map((row) => row.name),
  );

  for (const column of columns) {
    if (!existingColumns.has(column)) {
      try {
        database.run(`ALTER TABLE agents ADD COLUMN ${column} TEXT`);
      } catch (error) {
        console.error(`[Migration] Failed to add missing agents.${column} column`, error);
        throw error;
      }
    }
  }
}
