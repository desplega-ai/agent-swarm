import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

test("upgrading a database preserves the instants of pending schedule timestamps", () => {
  using db = new Database(":memory:");
  runMigrations(db);
  db.run("DELETE FROM _migrations WHERE name = '374_schedule_next_run_at_utc'");

  const utc = "2030-01-15T04:00:00.123Z";
  const timestamps = [
    ["positive", "2030-01-15T12:00:00.123+08:00", utc],
    ["negative", "2030-01-14T23:00:00.123-05:00", utc],
    ["compact", "2030-01-15T12:00:00.1239+0800", utc],
    ["utc-seconds", "2030-01-15T04:00:00Z", "2030-01-15T04:00:00.000Z"],
    ["bare", "2030-01-15 04:00:00", "2030-01-15T04:00:00.000Z"],
    ["canonical", utc, utc],
    ["cleared", null, null],
    ["invalid", "invalid date", "invalid date"],
  ] as const;
  for (const [name, nextRunAt] of timestamps) {
    db.run(
      `INSERT INTO scheduled_tasks (id, "key", name, scheduleType, taskTemplate, nextRunAt, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'one_time', 'Fixture task', ?, ?, ?)`,
      [name, `shared/schedules/${name}/`, name, nextRunAt, utc, utc],
    );
  }

  runMigrations(db);
  runMigrations(db);
  const read = db.prepare<{ nextRunAt: string | null }, [string]>(
    "SELECT nextRunAt FROM scheduled_tasks WHERE id = ?",
  );
  for (const [name, , expected] of timestamps) {
    expect(read.get(name)?.nextRunAt).toBe(expected);
  }
});
