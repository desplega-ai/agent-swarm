import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

const MIGRATION = "src/be/migrations/318_superseded_workflow_cut_backfill.sql";
const CUT = "superseded_workflow_task";

test("migration 318 moves cuts the workflow carried on without to superseded, once", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE workflow_run_steps (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        failureReason TEXT,
        workflowRunId TEXT,
        workflowRunStepId TEXT,
        lastUpdatedAt TEXT
      );
      INSERT INTO workflow_run_steps VALUES
        ('s-completed', 'completed'), ('s-failed', 'failed'), ('s-waiting', 'waiting');
    `);
    const insert = db.prepare(
      "INSERT INTO agent_tasks VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
    );
    const rows: [string, string, string | null, string | null, string | null][] = [
      ["retried", "failed", CUT, "run", null],
      ["absorbed", "failed", CUT, "run", "s-completed"],
      ["step-failed", "failed", CUT, "run", "s-failed"],
      ["step-waiting", "failed", CUT, "run", "s-waiting"],
      ["run-deleted", "failed", CUT, null, null],
      ["real-failure", "failed", "agent crashed", "run", "s-completed"],
      ["already", "superseded", CUT, "run", null],
    ];
    for (const row of rows) insert.run(...row);

    const sql = await Bun.file(MIGRATION).text();
    db.exec(sql);

    const status = () =>
      Object.fromEntries(
        db
          .query<{ id: string; status: string }, []>("SELECT id, status FROM agent_tasks")
          .all()
          .map((r) => [r.id, r.status]),
      );
    expect(status()).toEqual({
      retried: "superseded",
      absorbed: "superseded",
      "step-failed": "failed",
      "step-waiting": "failed",
      "run-deleted": "failed",
      "real-failure": "failed",
      already: "superseded",
    });
    const kept = db
      .query<{ failureReason: string }, []>(
        "SELECT failureReason FROM agent_tasks WHERE id IN ('retried', 'absorbed')",
      )
      .all();
    expect(kept.every((r) => r.failureReason === CUT)).toBe(true);
    const untouched = db
      .query<{ lastUpdatedAt: string }, []>(
        "SELECT lastUpdatedAt FROM agent_tasks WHERE id = 'already'",
      )
      .get();
    expect(untouched?.lastUpdatedAt).toBe("2026-01-01T00:00:00.000Z");

    // Idempotent: a second run matches nothing.
    expect(db.run(sql).changes).toBe(0);
  } finally {
    db.close();
  }
});
