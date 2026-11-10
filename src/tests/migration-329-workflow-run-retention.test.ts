import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("retention indexes migrate existing rows without changing history", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT, finishedAt TEXT);
      CREATE TABLE approval_requests (id TEXT PRIMARY KEY, workflowRunStepId TEXT);
      INSERT INTO workflow_runs VALUES ('old', 'completed', '2020-01-01'), ('live', 'waiting', NULL);
      INSERT INTO approval_requests VALUES ('approval', 'step');
    `);
    const sql = await Bun.file("src/be/migrations/329_workflow_run_retention.sql").text();
    db.exec(sql);
    db.exec(sql);
    expect(db.query("SELECT * FROM workflow_runs ORDER BY id").all()).toEqual([
      { id: "live", status: "waiting", finishedAt: null },
      { id: "old", status: "completed", finishedAt: "2020-01-01" },
    ]);
    expect(db.query("SELECT * FROM approval_requests").all()).toEqual([
      { id: "approval", workflowRunStepId: "step" },
    ]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name LIKE 'idx_%' ORDER BY name").all(),
    ).toEqual([
      { name: "idx_approval_requests_workflow_step" },
      { name: "idx_workflow_runs_retention" },
    ]);
  } finally {
    db.close();
  }
});
