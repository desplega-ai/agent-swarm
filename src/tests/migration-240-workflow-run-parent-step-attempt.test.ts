import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("migration 240 hands each legacy child to the attempt that owns it now", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflowId TEXT, status TEXT)");
    db.exec(
      `CREATE TABLE workflow_run_steps (
         id TEXT PRIMARY KEY, status TEXT, retryCount INTEGER NOT NULL DEFAULT 0, nextRetryAt TEXT
       )`,
    );
    db.exec(await Bun.file("src/be/migrations/203_workflow_run_parent_step.sql").text());
    const step = db.query(
      "INSERT INTO workflow_run_steps (id, status, retryCount, nextRetryAt) VALUES (?, ?, ?, ?)",
    );
    // Created on attempt 1 (attempt 0 failed before any child existed) and parked.
    step.run("parked-retry", "waiting", 1, null);
    // Its child failed; attempt 2 is queued and must start a new child.
    step.run("queued-retry", "failed", 2, "2030-01-01T00:00:00.000Z");
    step.run("first-attempt", "completed", 0, null);
    step.run("exhausted", "failed", 3, null);
    const run = db.query(
      "INSERT INTO workflow_runs (id, workflowId, status, parentStepId) VALUES (?, 'wf', ?, ?)",
    );
    run.run("child-parked", "waiting", "parked-retry");
    run.run("child-queued", "failed", "queued-retry");
    run.run("child-first", "completed", "first-attempt");
    run.run("child-exhausted", "failed", "exhausted");
    run.run("child-orphan", "completed", "missing-step");
    run.run("top-level", "completed", null);

    db.exec(await Bun.file("src/be/migrations/240_workflow_run_parent_step_attempt.sql").text());

    expect(
      db.prepare("SELECT id, parentStepAttempt AS attempt FROM workflow_runs ORDER BY id").all(),
    ).toEqual([
      { id: "child-exhausted", attempt: 3 },
      { id: "child-first", attempt: 0 },
      { id: "child-orphan", attempt: 0 },
      { id: "child-parked", attempt: 1 },
      { id: "child-queued", attempt: 1 },
      { id: "top-level", attempt: 0 },
    ]);
    // One child per attempt: a second child for the parked attempt is rejected,
    // one for the queued attempt is the new invocation.
    const insert = db.query(
      "INSERT INTO workflow_runs (id, workflowId, status, parentStepId, parentStepAttempt) VALUES (?, 'wf', 'running', ?, ?)",
    );
    expect(() => insert.run("dup", "parked-retry", 1)).toThrow();
    insert.run("next", "queued-retry", 2);
  } finally {
    db.close();
  }
});
