import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const BATCH_SIZE = 25;

/** Boot-only backfill: each committed batch can be safely skipped on restart. */
export function backfillScriptRunSources(db: Database): void {
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
