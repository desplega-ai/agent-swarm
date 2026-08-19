import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

const DB_PATH = "./test-user-attribution-migration.sqlite";

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

describe("migration 127 user attribution backfill", () => {
  test("repairs supported roots and descendants without overwriting or guessing owners", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);
      db.run("DELETE FROM _migrations WHERE version = 127");

      const now = new Date().toISOString();
      db.run(
        "INSERT INTO users (id, name) VALUES ('user-a', 'User A'), ('user-b', 'User B'), ('user-c', 'User C')",
      );
      db.run(
        "INSERT INTO user_external_ids (kind, externalId, userId) VALUES ('slack', 'U_A', 'user-a')",
      );
      db.run(
        `INSERT INTO scheduled_tasks
         (id, name, taskTemplate, intervalMs, createdAt, lastUpdatedAt, created_by)
       VALUES
         ('schedule-owned', 'Owned schedule', 'work', 60000, ?, ?, 'user-a'),
         ('schedule-ownerless', 'Ownerless schedule', 'work', 60000, ?, ?, NULL),
         ('schedule-conflict', 'Conflicting schedule', 'work', 60000, ?, ?, 'user-b')`,
        [now, now, now, now, now, now],
      );
      db.run(
        `INSERT INTO workflows (id, name, definition, triggers, created_by)
       VALUES
         ('workflow-owned', 'Owned workflow', '{"nodes":[]}', '[]', 'user-a'),
         ('workflow-ownerless', 'Ownerless workflow', '{"nodes":[]}', '[]', NULL),
         ('workflow-conflict', 'Conflicting workflow', '{"nodes":[]}', '[]', 'user-c')`,
      );
      db.run(
        `INSERT INTO workflow_runs (id, workflowId)
       VALUES
         ('run-owned', 'workflow-owned'),
         ('run-ownerless', 'workflow-ownerless'),
         ('run-conflict', 'workflow-conflict')`,
      );

      const insertTask = db.prepare<
        unknown,
        [
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string,
        ]
      >(
        `INSERT INTO agent_tasks
         (id, parentTaskId, slackUserId, scheduleId, workflowRunId,
          requestedByUserId, taskType, tags, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixture', 'completed', 'api', '${now}', '${now}')`,
      );
      const task = (
        id: string,
        options: {
          parent?: string;
          slack?: string;
          schedule?: string;
          run?: string;
          user?: string;
          type?: string;
          tags?: string;
        } = {},
      ) =>
        insertTask.run(
          id,
          options.parent ?? null,
          options.slack ?? null,
          options.schedule ?? null,
          options.run ?? null,
          options.user ?? null,
          options.type ?? null,
          options.tags ?? "[]",
        );

      task("slack-root", { slack: "U_A" });
      task("schedule-root", { schedule: "schedule-owned" });
      task("workflow-root", { run: "run-owned" });
      task("unknown-slack", { slack: "U_UNKNOWN" });
      task("ownerless-schedule", { schedule: "schedule-ownerless" });
      task("ownerless-workflow", { run: "run-ownerless" });
      task("existing", { slack: "U_A", user: "user-b" });
      task("ordered-precedence", {
        slack: "U_A",
        schedule: "schedule-conflict",
        run: "run-conflict",
      });
      task("child", { parent: "slack-root" });
      task("grandchild", { parent: "child" });
      task("handoff", { parent: "slack-root", user: "user-b" });
      task("handoff-child", { parent: "handoff", slack: "U_A" });
      task("heartbeat", { parent: "slack-root", slack: "U_A", type: "heartbeat-checklist" });
      task("boot-triage", {
        parent: "slack-root",
        schedule: "schedule-owned",
        type: "boot-triage",
      });
      task("legacy-heartbeat", { parent: "slack-root", run: "run-owned", tags: '["heartbeat"]' });

      runMigrations(db);

      const rows = () =>
        Object.fromEntries(
          db
            .query<{ id: string; userId: string | null }, []>(
              "SELECT id, requestedByUserId AS userId FROM agent_tasks WHERE task = 'fixture' ORDER BY id",
            )
            .all()
            .map((row) => [row.id, row.userId]),
        );
      const expected = {
        "boot-triage": null,
        child: "user-a",
        existing: "user-b",
        grandchild: "user-a",
        handoff: "user-b",
        "handoff-child": "user-b",
        heartbeat: null,
        "legacy-heartbeat": null,
        "ownerless-schedule": null,
        "ownerless-workflow": null,
        "ordered-precedence": "user-a",
        "schedule-root": "user-a",
        "slack-root": "user-a",
        "unknown-slack": null,
        "workflow-root": "user-a",
      };
      expect(rows()).toEqual(expected);

      db.run("DELETE FROM _migrations WHERE version = 127");
      runMigrations(db);
      expect(rows()).toEqual(expected);
    } finally {
      db.close();
    }
  });
});

describe("migration 136 requester provenance backfill", () => {
  test("marks matching descendant requesters as inherited", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      db.run(`CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        parentTaskId TEXT,
        requestedByUserId TEXT,
        taskType TEXT,
        tags TEXT,
        created_by TEXT
      )`);
      db.run(`INSERT INTO agent_tasks
        (id, parentTaskId, requestedByUserId, taskType, tags, created_by) VALUES
        ('root', NULL, 'user-a', 'heartbeat-checklist', '[]', NULL),
        ('child', 'root', 'user-a', NULL, '[]', NULL),
        ('grandchild', 'child', 'user-a', NULL, '[]', NULL),
        ('handoff', 'root', 'user-b', NULL, '[]', NULL),
        ('handoff-child', 'handoff', 'user-b', NULL, '[]', NULL),
        ('same-user-handoff', 'root', 'user-a', NULL, '[]', 'user-a'),
        ('same-user-handoff-child', 'same-user-handoff', 'user-a', NULL, '[]', NULL),
        ('unattributed-child', 'root', NULL, NULL, '[]', NULL),
        ('ordinary-root', NULL, 'user-a', NULL, '[]', NULL),
        ('ordinary-child', 'ordinary-root', 'user-a', NULL, '[]', NULL)`);

      const migration = await Bun.file(
        new URL("../be/migrations/136_task_requester_provenance.sql", import.meta.url),
      ).text();
      db.exec(migration);

      const rows = db
        .query<{ id: string; inherited: number }, []>(
          "SELECT id, requestedByUserIdInherited AS inherited FROM agent_tasks ORDER BY id",
        )
        .all();
      expect(Object.fromEntries(rows.map((row) => [row.id, row.inherited]))).toEqual({
        child: 1,
        grandchild: 1,
        handoff: 0,
        "handoff-child": 0,
        "ordinary-child": 0,
        "ordinary-root": 0,
        root: 0,
        "same-user-handoff": 0,
        "same-user-handoff-child": 0,
        "unattributed-child": 0,
      });
    } finally {
      db.close();
    }
  });
});
