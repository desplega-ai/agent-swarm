import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

const DB_PATH = "./test-task-pull-request-backfill-migration.sqlite";

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

describe("migration 135 task pull-request attachment backfill", () => {
  test("applies fresh, backfills existing outputs, and replays idempotently", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM task_attachments").get()
          ?.count,
      ).toBe(0);
      db.run("DELETE FROM _migrations WHERE version = 135");

      const now = new Date().toISOString();
      const insertTask = db.prepare(
        `INSERT INTO agent_tasks
           (id, task, status, source, output, createdAt, lastUpdatedAt)
         VALUES (?, 'fixture', 'completed', 'api', ?, ?, ?)`,
      );
      const firstTaskId = "11111111-1111-4111-8111-111111111111";
      const secondTaskId = "22222222-2222-4222-8222-222222222222";
      const thirdTaskId = "44444444-4444-4444-8444-444444444444";
      insertTask.run(
        firstTaskId,
        "Ignore https://notgithub.com/wrong/repo/pull/88. Shipped " +
          "https://GitHub.com/desplega-ai/agent-swarm/pull/41/files and " +
          "github.com/desplega-ai/docs/pull/9). Duplicate: " +
          "https://github.com/desplega-ai/agent-swarm/pull/41#discussion",
        now,
        now,
      );
      insertTask.run(
        secondTaskId,
        "Existing https://github.com/desplega-ai/agent-swarm/pull/42. Reject " +
          "https://github.com/org/repo/tree/pull/123 and " +
          "https://github.com/org/repo/issues/1/pull/2 and " +
          "https://_github.com/org/repo/pull/3 and " +
          "https://evil.example/github.com/org/repo/pull/4 and " +
          "https://github.com/org/repo/pull/123abc",
        now,
        now,
      );
      insertTask.run(
        thirdTaskId,
        "Valid output https://github.com/desplega-ai/agent-swarm/pull/43",
        now,
        now,
      );
      const existingId = "33333333-3333-4333-8333-333333333333";
      db.run(
        `INSERT INTO task_attachments
           (id, task_id, name, kind, url, provider_id, provider_key, intent)
         VALUES (?, ?, 'Caller supplied', 'url', ?, 'url', ?, 'review')`,
        [
          existingId,
          secondTaskId,
          "http://GitHub.com/desplega-ai/agent-swarm/pull/42/files",
          "http://GitHub.com/desplega-ai/agent-swarm/pull/42/files",
        ],
      );
      db.run(
        `INSERT INTO task_attachments
           (id, task_id, name, kind, url, provider_id, provider_key, intent)
         VALUES (?, ?, 'Malformed attachment', 'url', ?, 'url', ?, 'review')`,
        [
          "55555555-5555-4555-8555-555555555555",
          thirdTaskId,
          "https://github.com/desplega-ai/agent-swarm/pull/43abc",
          "https://github.com/desplega-ai/agent-swarm/pull/43abc",
        ],
      );

      runMigrations(db);

      const rows = db
        .query<
          {
            id: string;
            taskId: string;
            name: string;
            url: string;
            providerId: string | null;
            providerKey: string | null;
            intent: string | null;
          },
          []
        >(
          `SELECT id, task_id AS taskId, name, url,
                  provider_id AS providerId, provider_key AS providerKey, intent
           FROM task_attachments
           ORDER BY task_id, url`,
        )
        .all();
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => ({ ...row, id: undefined }))).toEqual([
        {
          id: undefined,
          taskId: firstTaskId,
          name: "GitHub pull request #41",
          url: "https://github.com/desplega-ai/agent-swarm/pull/41",
          providerId: "url",
          providerKey: "https://github.com/desplega-ai/agent-swarm/pull/41",
          intent: "task-deliverable",
        },
        {
          id: undefined,
          taskId: firstTaskId,
          name: "GitHub pull request #9",
          url: "https://github.com/desplega-ai/docs/pull/9",
          providerId: "url",
          providerKey: "https://github.com/desplega-ai/docs/pull/9",
          intent: "task-deliverable",
        },
        {
          id: undefined,
          taskId: secondTaskId,
          name: "Caller supplied",
          url: "http://GitHub.com/desplega-ai/agent-swarm/pull/42/files",
          providerId: "url",
          providerKey: "http://GitHub.com/desplega-ai/agent-swarm/pull/42/files",
          intent: "review",
        },
        {
          id: undefined,
          taskId: thirdTaskId,
          name: "GitHub pull request #43",
          url: "https://github.com/desplega-ai/agent-swarm/pull/43",
          providerId: "url",
          providerKey: "https://github.com/desplega-ai/agent-swarm/pull/43",
          intent: "task-deliverable",
        },
        {
          id: undefined,
          taskId: thirdTaskId,
          name: "Malformed attachment",
          url: "https://github.com/desplega-ai/agent-swarm/pull/43abc",
          providerId: "url",
          providerKey: "https://github.com/desplega-ai/agent-swarm/pull/43abc",
          intent: "review",
        },
      ]);
      for (const row of rows) {
        expect(row.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      expect(rows.find((row) => row.taskId === secondTaskId)?.id).toBe(existingId);

      db.run("DELETE FROM _migrations WHERE version = 135");
      runMigrations(db);
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM task_attachments").get()
          ?.count,
      ).toBe(5);
    } finally {
      db.close();
    }
  });
});
