import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

const DB_PATH = "./test-approval-auto-cancellation-migration.sqlite";

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

type Row = {
  id: string;
  status: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
};

function readRows(db: Database): Row[] {
  return db
    .query<Row, []>(
      "SELECT id, status, resolvedBy, resolvedAt, resolutionReason FROM approval_requests ORDER BY id",
    )
    .all();
}

describe("migration 166 approval auto-cancellation index", () => {
  test("adds the pending-created index and leaves the schema and rows intact", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);
      // Roll the database back to the state before migration 166.
      db.run("DROP INDEX idx_approval_requests_pending_created");
      db.run("DELETE FROM _migrations WHERE version = 166");
      db.run(`INSERT INTO approval_requests
        (id, title, questions, approvers, status, resolvedBy, resolvedAt, resolutionReason,
         expiresAt, createdAt, updatedAt)
        VALUES
        ('a-pending', 'Pending', '[]', '{}', 'pending', NULL, NULL, NULL,
         NULL, '2026-01-01', '2026-01-01'),
        ('b-cancelled', 'Cancelled', '[]', '{}', 'cancelled', NULL, '2026-01-03', 'run cancelled',
         NULL, '2026-01-01', '2026-01-03'),
        ('c-timeout', 'Timeout', '[]', '{}', 'timeout', NULL, '2026-01-04', NULL,
         '2026-01-02', '2026-01-01', '2026-01-04')`);
      const before = readRows(db);

      runMigrations(db);

      expect(readRows(db)).toEqual(before);
      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_requests'",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_approval_requests_pending_created",
          "idx_approval_requests_status",
          "idx_approval_requests_created",
          "idx_approval_requests_workflow",
          "idx_approval_requests_task",
          "idx_approval_requests_expires",
        ]),
      );

      const tableSql = db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'",
        )
        .get()?.sql;
      expect(tableSql).toContain("'cancelled'");
      expect(tableSql).toContain("'timeout'");

      const insert = (id: string, status: string) =>
        db.run(
          `INSERT INTO approval_requests (id, title, questions, approvers, status)
           VALUES (?, 't', '[]', '{}', ?)`,
          [id, status],
        );
      expect(() => insert("d-cancelled", "cancelled")).not.toThrow();
      expect(() => insert("e-timeout", "timeout")).not.toThrow();
      expect(() => insert("f-expired", "expired")).toThrow(/CHECK/);

      // Later migrations may land on top, so assert 166 was re-applied rather
      // than that it is the newest one.
      const applied = db
        .query<{ version: number }, []>("SELECT version FROM _migrations WHERE version = 166")
        .get();
      expect(applied?.version).toBe(166);
    } finally {
      db.close();
    }
  });
});
