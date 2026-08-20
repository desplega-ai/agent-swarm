import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";
import { extractGitHubPullRequestUrls } from "../utils/github-pull-request";

const DB_PATH = "./test-task-pull-request-backfill-migration.sqlite";
const ECMASCRIPT_WHITESPACE_CODE_POINTS = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12288, 65279,
];

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
      const vcsOnlyTaskId = "66666666-6666-4666-8666-666666666666";
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
      insertTask.run(vcsOnlyTaskId, "Completed through the historical VCS path", now, now);
      db.run(
        `UPDATE agent_tasks
         SET vcsProvider = 'github', vcsRepo = 'desplega-ai/agent-swarm',
             vcsNumber = 44, vcsUrl = 'https://github.com/desplega-ai/agent-swarm/pull/44'
         WHERE id = ?`,
        [vcsOnlyTaskId],
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
            capabilities: Record<string, unknown> | null;
            intent: string | null;
          },
          []
        >(
          `SELECT id, task_id AS taskId, name, url,
                  provider_id AS providerId, provider_key AS providerKey,
                  json(capabilities) AS capabilities, intent
           FROM task_attachments
           ORDER BY task_id, url`,
        )
        .all();
      expect(rows).toHaveLength(6);
      expect(
        rows.map((row) => ({
          ...row,
          id: undefined,
          capabilities: row.capabilities ? JSON.parse(String(row.capabilities)) : null,
        })),
      ).toEqual([
        {
          id: undefined,
          taskId: firstTaskId,
          name: "GitHub pull request #41",
          url: "https://github.com/desplega-ai/agent-swarm/pull/41",
          providerId: "github",
          providerKey: "https://github.com/desplega-ai/agent-swarm/pull/41",
          capabilities: {
            _agentSwarmGeneratedBy: "task-pull-request-recorder",
          },
          intent: "task-deliverable",
        },
        {
          id: undefined,
          taskId: firstTaskId,
          name: "GitHub pull request #9",
          url: "https://github.com/desplega-ai/docs/pull/9",
          providerId: "github",
          providerKey: "https://github.com/desplega-ai/docs/pull/9",
          capabilities: {
            _agentSwarmGeneratedBy: "task-pull-request-recorder",
          },
          intent: "task-deliverable",
        },
        {
          id: undefined,
          taskId: secondTaskId,
          name: "Caller supplied",
          url: "http://GitHub.com/desplega-ai/agent-swarm/pull/42/files",
          providerId: "url",
          providerKey: "http://GitHub.com/desplega-ai/agent-swarm/pull/42/files",
          capabilities: null,
          intent: "review",
        },
        {
          id: undefined,
          taskId: thirdTaskId,
          name: "GitHub pull request #43",
          url: "https://github.com/desplega-ai/agent-swarm/pull/43",
          providerId: "github",
          providerKey: "https://github.com/desplega-ai/agent-swarm/pull/43",
          capabilities: {
            _agentSwarmGeneratedBy: "task-pull-request-recorder",
          },
          intent: "task-deliverable",
        },
        {
          id: undefined,
          taskId: thirdTaskId,
          name: "Malformed attachment",
          url: "https://github.com/desplega-ai/agent-swarm/pull/43abc",
          providerId: "url",
          providerKey: "https://github.com/desplega-ai/agent-swarm/pull/43abc",
          capabilities: null,
          intent: "review",
        },
        {
          id: undefined,
          taskId: vcsOnlyTaskId,
          name: "GitHub pull request #44",
          url: "https://github.com/desplega-ai/agent-swarm/pull/44",
          providerId: "github",
          providerKey: "https://github.com/desplega-ai/agent-swarm/pull/44",
          capabilities: {
            _agentSwarmGeneratedBy: "task-pull-request-recorder",
          },
          intent: "task-deliverable",
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
      ).toBe(6);
    } finally {
      db.close();
    }
  });

  test("deduplicates caller URLs ending in ECMAScript whitespace", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);
      db.run("DELETE FROM _migrations WHERE version = 135");
      const now = new Date().toISOString();
      const whitespaceCodePoints = [11, 12, 160];

      whitespaceCodePoints.forEach((codePoint, index) => {
        const suffix = String(index + 1).padStart(12, "0");
        const taskId = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
        const canonicalUrl = `https://github.com/owner/repo/pull/${index + 1}`;
        db.run(
          `INSERT INTO agent_tasks
             (id, task, status, source, output, createdAt, lastUpdatedAt)
           VALUES (?, 'fixture', 'completed', 'api', ?, ?, ?)`,
          [taskId, `Shipped ${canonicalUrl}`, now, now],
        );
        db.run(
          `INSERT INTO task_attachments (id, task_id, name, kind, url)
           VALUES (?, ?, 'Caller supplied', 'url', ?)`,
          [
            `cccccccc-cccc-4ccc-8ccc-${suffix}`,
            taskId,
            `${canonicalUrl}${String.fromCodePoint(codePoint)}`,
          ],
        );
      });

      runMigrations(db);

      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM task_attachments").get()
          ?.count,
      ).toBe(whitespaceCodePoints.length);
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM task_attachments WHERE capabilities IS NOT NULL",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("matches the TypeScript extractor across host and token boundaries", async () => {
    await removeDb();
    const db = new Database(DB_PATH, { create: true });
    try {
      runMigrations(db);
      db.run("DELETE FROM _migrations WHERE version = 135");
      const fixtures = [
        "https://evil.example/?next=github.com/o/r/pull/8",
        "xhttps://github.com/o/r/pull/1",
        "https://github.com/o/r/pull/8/files",
        "github.com/o/r/pull/8",
        "Shipped https://github.com/o/r/pull/8, with follow-up prose.",
        "https://notgithub.com/o/r/pull/8",
        "https://_github.com/o/r/pull/8",
        "https://evil.example/github.com/o/r/pull/8",
        "https://github.com/o/r/pull/123abc",
        "https://github.com/o/r/pull/123.foo",
        "https://github.com/o/r/pull/123,abc",
        "https://github.com/o/./pull/1",
        "https://github.com/../r/pull/1",
        ...ECMASCRIPT_WHITESPACE_CODE_POINTS.map(
          (codePoint) => `done${String.fromCodePoint(codePoint)}https://github.com/o/r/pull/8`,
        ),
      ];
      const now = new Date().toISOString();
      const insertTask = db.prepare(
        `INSERT INTO agent_tasks
           (id, task, status, source, output, createdAt, lastUpdatedAt)
         VALUES (?, 'fixture', 'completed', 'api', ?, ?, ?)`,
      );
      fixtures.forEach((fixture, index) => {
        const suffix = String(index + 1).padStart(12, "0");
        insertTask.run(`aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`, fixture, now, now);
      });

      runMigrations(db);

      fixtures.forEach((fixture, index) => {
        const suffix = String(index + 1).padStart(12, "0");
        const taskId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
        const count = db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM task_attachments WHERE task_id = ?",
          )
          .get(taskId)?.count;
        expect(Boolean(count)).toBe(extractGitHubPullRequestUrls(fixture).length > 0);
      });
    } finally {
      db.close();
    }
  });
});
