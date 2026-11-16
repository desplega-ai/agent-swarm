import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const BATCH_SIZE = 25;

function hasScriptRunSourceSchema(db: Database): boolean {
  const schema = db
    .prepare<{ ready: number }, []>(`SELECT
    EXISTS (SELECT 1 FROM pragma_table_info('script_runs') WHERE name = 'sourceHash')
    AND (SELECT count(*) FROM pragma_table_info('script_run_sources')
         WHERE name IN ('hash', 'source')) = 2 AS ready`)
    .get();
  return Boolean(schema?.ready);
}

/** The API must have the schema its run readers and writers use. */
export function assertScriptRunSourceSchema(db: Database): void {
  if (!hasScriptRunSourceSchema(db)) {
    throw new Error(
      "[migrations] Required script-run source schema is missing. " +
        "Ensure MIGRATIONS_DIR includes 342_script_run_sources.sql and run migrations before starting the API.",
    );
  }
}

/** Boot-only backfill: each committed batch can be safely skipped on restart. */
export function backfillScriptRunSources(db: Database): void {
  // The generic migration runner also handles partial historical schemas.
  if (!hasScriptRunSourceSchema(db)) return;
  const pending = db.prepare<{ id: string; source: string }, []>(
    `SELECT id, source FROM script_runs WHERE sourceHash IS NULL LIMIT ${BATCH_SIZE}`,
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO script_run_sources (hash, source) VALUES (?, ?)",
  );
  const update = db.prepare("UPDATE script_runs SET sourceHash = ?, source = '' WHERE id = ?");

  const batch = db.transaction(() => {
    const rows = pending.all();
    for (const row of rows) {
      const hash = createHash("sha256").update(row.source, "utf8").digest("hex");
      insert.run(hash, row.source);
      update.run(hash, row.id);
    }
    return rows.length;
  });

  while (batch.immediate() === BATCH_SIZE) {
    // Release the write lock between batches; the NULL index is the watermark.
  }
}
