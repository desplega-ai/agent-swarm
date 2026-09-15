import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("multi-task wait migration preserves legacy claims, audit fields, and current watched IDs", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY)");
    db.exec(
      await Bun.file(
        new URL("../be/migrations/150_deferred_task_waits.sql", import.meta.url),
      ).text(),
    );
    for (const status of ["pending", "fired"]) {
      db.run("INSERT INTO scheduled_tasks VALUES (?)", [status]);
      db.run(
        `INSERT INTO deferred_task_waits
         (scheduleId, taskId, eventName, status, firedBy, childTaskId, resolvedAt,
          created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, 'settled', ?, ?, ?, ?, 'created', 'updated', 'creator', 'updater')`,
        [
          status,
          `resumed-${status}`,
          status,
          status === "fired" ? "ceiling" : null,
          status === "fired" ? "child" : null,
          status === "fired" ? "resolved" : null,
        ],
      );
    }
    const before = db
      .query("SELECT * FROM deferred_task_waits ORDER BY scheduleId")
      .all() as Record<string, unknown>[];
    const sql = await Bun.file(
      new URL("../be/migrations/153_deferred_task_wait_members.sql", import.meta.url),
    ).text();
    db.transaction(() => db.exec(sql))();
    for (const { taskId, ...wait } of before) {
      expect(
        db
          .query("SELECT * FROM deferred_task_waits WHERE scheduleId = ?")
          .get(wait.scheduleId as string),
      ).toEqual({ ...wait, mode: "all" });
      expect(
        db
          .query("SELECT * FROM deferred_task_wait_members WHERE scheduleId = ?")
          .get(wait.scheduleId as string),
      ).toEqual({
        scheduleId: wait.scheduleId,
        taskId,
        created_at: "created",
        updated_at: "updated",
        created_by: "creator",
        updated_by: "updater",
      });
    }
    db.run("DELETE FROM scheduled_tasks WHERE id = 'pending'");
    expect(
      db.query("SELECT * FROM deferred_task_wait_members WHERE scheduleId = 'pending'").all(),
    ).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
