import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

const DB_PATH = "./test-approval-cancellation-migration.sqlite";

async function removeDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(DB_PATH + suffix).delete();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

afterEach(removeDb);

describe("migration 140 approval cancellation lifecycle", () => {
  test("upgrades existing rows without changing status, audit fields, or indexes", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);
      db.run("DELETE FROM approval_requests");
      db.run("DROP TRIGGER cancel_approval_request_after_workflow_step_cancel");
      db.run("DROP TABLE approval_requests");
      db.run(`CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        questions JSONB NOT NULL,
        workflowRunId TEXT,
        workflowRunStepId TEXT,
        sourceTaskId TEXT,
        approvers JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'timeout')),
        responses JSONB,
        resolvedBy TEXT,
        resolvedAt DATETIME,
        timeoutSeconds INTEGER,
        expiresAt DATETIME,
        notificationChannels JSONB,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT REFERENCES users(id),
        updated_by TEXT REFERENCES users(id)
      )`);
      db.run("CREATE INDEX idx_approval_requests_status ON approval_requests(status)");
      db.run("CREATE INDEX idx_approval_requests_created ON approval_requests(createdAt DESC)");
      db.run("CREATE INDEX idx_approval_requests_workflow ON approval_requests(workflowRunId)");
      db.run("CREATE INDEX idx_approval_requests_task ON approval_requests(sourceTaskId)");
      db.run(
        "CREATE INDEX idx_approval_requests_expires ON approval_requests(expiresAt) WHERE status = 'pending'",
      );
      db.run("INSERT OR IGNORE INTO users (id, name) VALUES ('user-a', 'User A')");
      db.run(`INSERT INTO approval_requests
        (id, title, questions, approvers, status, responses, resolvedBy, resolvedAt,
         notificationChannels, createdAt, updatedAt, created_by, updated_by)
        VALUES
        ('pending-row', 'Pending', '[]', '{}', 'pending', NULL, NULL, NULL,
         '[{"channel":"slack","target":"C1"}]', '2026-01-01', '2026-01-02',
         'user-a', 'user-a'),
        ('approved-row', 'Approved', '[]', '{}', 'approved', '{}', 'human', '2026-01-03',
         NULL, '2026-01-01', '2026-01-03', 'user-a', 'user-a')`);
      db.run("DELETE FROM _migrations WHERE version = 140");

      runMigrations(db);

      const rows = db
        .query<
          {
            id: string;
            status: string;
            reason: string | null;
            claims: string | null;
            createdBy: string | null;
            updatedBy: string | null;
          },
          []
        >(`SELECT id, status, resolutionReason AS reason,
                  cancellationNotificationClaims AS claims,
                  created_by AS createdBy, updated_by AS updatedBy
           FROM approval_requests ORDER BY id`)
        .all();
      expect(rows).toEqual([
        {
          id: "approved-row",
          status: "approved",
          reason: null,
          claims: null,
          createdBy: "user-a",
          updatedBy: "user-a",
        },
        {
          id: "pending-row",
          status: "pending",
          reason: null,
          claims: null,
          createdBy: "user-a",
          updatedBy: "user-a",
        },
      ]);
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_requests' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual([
        "idx_approval_requests_created",
        "idx_approval_requests_expires",
        "idx_approval_requests_status",
        "idx_approval_requests_task",
        "idx_approval_requests_workflow",
        "sqlite_autoindex_approval_requests_1",
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() =>
        db.run("UPDATE approval_requests SET status = 'cancelled' WHERE id = 'pending-row'"),
      ).not.toThrow();
      expect(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'cancel_approval_request_after_workflow_step_cancel'",
          )
          .get()?.name,
      ).toBe("cancel_approval_request_after_workflow_step_cancel");
    } finally {
      db.close();
    }
  });
});
