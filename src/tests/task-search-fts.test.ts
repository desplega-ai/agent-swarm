import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createTaskExtended,
  deleteTask,
  getAllTasks,
  getDb,
  getDbClient,
  getTasksCount,
  initDb,
  updateTaskTitle,
} from "../be/db";
import { appendDraftTaskText } from "../be/db/tasks/draft-text";
import {
  backfillTaskSearchIndex,
  buildTaskFtsMatch,
  startTaskSearchBackfill,
  stopTaskSearchBackfill,
  TASK_FTS_COMPLETE,
} from "../be/db/tasks/search-index";

const TEST_DB_PATH = `./test-task-search-fts-${process.pid}.sqlite`;
const REBUILD_DB_PATH = `./test-task-search-fts-rebuild-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(path + suffix).catch(() => {});
}

async function found(search: string): Promise<string[]> {
  const tasks = await getAllTasks({ search, limit: 1000 });
  expect(await getTasksCount({ search })).toBe(tasks.length);
  return tasks.map((task) => task.task).sort();
}

async function newTask(text: string): Promise<string> {
  return (await createTaskExtended(text, {})).id;
}

// FTS5's own check that an external-content index matches its content table.
async function expectIndexInSync(): Promise<void> {
  await getDbClient().run(
    "INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('integrity-check')",
  );
}

async function indexedThrough(): Promise<number> {
  return (await getDbClient().get<{ indexedThrough: number }>(
    "SELECT indexedThrough FROM agent_tasks_fts_state WHERE id = 1",
  ))!.indexedThrough;
}

// What bun:sqlite throws when another connection holds the write lock.
function busyError(): Error {
  return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

async function clearTasks(): Promise<void> {
  const client = getDbClient();
  await client.run("PRAGMA foreign_keys = OFF");
  await client.run("DELETE FROM agent_tasks");
  await client.run("PRAGMA foreign_keys = ON");
}

describe("task search over agent_tasks_fts", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  beforeEach(clearTasks);

  test("a fresh DB starts with a complete index", async () => {
    expect(await indexedThrough()).toBe(TASK_FTS_COMPLETE);
  });

  test("matches whole tokens, with a prefix match on the last one", async () => {
    await newTask("Update the rulebook for reviewers");
    await newTask("Fix PR #2443 and 24430");
    await newTask("Bump to 12443");

    expect(await found("rulebook")).toEqual(["Update the rulebook for reviewers"]);
    expect(await found("rule")).toEqual(["Update the rulebook for reviewers"]);
    expect(await found("RULEBOOK")).toEqual(["Update the rulebook for reviewers"]);
    // A substring inside a token no longer matches.
    expect(await found("ulebo")).toEqual([]);
    // Digits inside a longer token: the accepted loss.
    expect(await found("2443")).toEqual(["Fix PR #2443 and 24430"]);
    expect(await found("443")).toEqual([]);
  });

  test("matches the input as a phrase, across punctuation", async () => {
    await newTask("Run the Heartbeat Checklist now");
    await newTask("taskType heartbeat-checklist");
    await newTask("checklist before heartbeat");

    expect(await found("heartbeat checklist")).toEqual([
      "Run the Heartbeat Checklist now",
      "taskType heartbeat-checklist",
    ]);
    // Only the last token is a prefix.
    expect(await found("heart checklist")).toEqual([]);
    expect(await found("the heartbeat check")).toEqual(["Run the Heartbeat Checklist now"]);
  });

  test("matches the title", async () => {
    const id = await newTask("body text");
    await updateTaskTitle(id, "Deploy landing page");
    expect(await found("landing")).toEqual(["body text"]);
  });

  test("matches a task id by prefix only", async () => {
    const id = await newTask("find me by id");
    await newTask("another task");

    expect(await found(id.slice(0, 8))).toEqual(["find me by id"]);
    expect(await found(id)).toEqual(["find me by id"]);
    expect(await found(id.toUpperCase())).toEqual(["find me by id"]);
    expect(await found(id.slice(9, 18))).toEqual([]);
  });

  test("% and _ are not wildcards, and operators are plain text", async () => {
    await newTask("aXb and fooxbar");
    await newTask("snake foo_bar here");
    await newTask('he said "ship it" NOT later');

    expect(await found("a%b")).toEqual([]);
    expect(await found("foo_bar")).toEqual(["snake foo_bar here"]);
    expect(await found("%")).toEqual([]);
    expect(await found("   ")).toEqual([]);
    expect(await found('"ship it"')).toEqual(['he said "ship it" NOT later']);
    expect(await found("NOT later")).toEqual(['he said "ship it" NOT later']);
    expect(await found("task:ship OR x*")).toEqual([]);
    expect(buildTaskFtsMatch('say "hi"')).toBe('"say ""hi"""*');
    expect(buildTaskFtsMatch("%_")).toBeNull();
  });

  test("pages and counts a candidate set larger than the rowid list", async () => {
    await getDbClient().transaction(async (tx) => {
      for (let i = 0; i < 520; i++) {
        await tx.run(
          `INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt)
           VALUES (?, ?, 'completed', 'api', ?, ?)`,
          [
            `bulk-${i}`,
            `landing page variant ${i}`,
            "2026-10-01T00:00:00.000Z",
            new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
          ],
        );
      }
    });
    await newTask("unrelated");

    const page = await getAllTasks({ search: "landing", limit: 25 });
    expect(page.map((task) => task.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `bulk-${519 - i}`),
    );
    expect(await getTasksCount({ search: "landing" })).toBe(520);
    expect(await getTasksCount({ search: "page variant 51" })).toBe(11);
  });

  test("triggers keep the index in sync on insert, update, delete and the draft append", async () => {
    const id = await newTask("original prompt alpha");
    expect(await found("alpha")).toEqual(["original prompt alpha"]);

    await getDbClient().run("UPDATE agent_tasks SET task = ? WHERE id = ?", [
      "rewritten prompt beta",
      id,
    ]);
    expect(await found("alpha")).toEqual([]);
    expect(await found("beta")).toEqual(["rewritten prompt beta"]);

    await updateTaskTitle(id, "titled gamma");
    expect(await found("gamma")).toEqual(["rewritten prompt beta"]);
    await updateTaskTitle(id, "titled delta");
    expect(await found("gamma")).toEqual([]);

    await getDbClient().run("UPDATE agent_tasks SET status = 'draft' WHERE id = ?", [id]);
    expect(await appendDraftTaskText(id, "voice note epsilon")).toBe(true);
    expect(await found("epsilon")).toEqual(["rewritten prompt beta\n\nvoice note epsilon"]);

    // An update that does not touch task or title leaves the index alone.
    await getDbClient().run("UPDATE agent_tasks SET status = 'pending' WHERE id = ?", [id]);
    await expectIndexInSync();

    expect(await deleteTask(id)).toBe(true);
    expect(await found("epsilon")).toEqual([]);
    expect(await found("beta")).toEqual([]);
    await expectIndexInSync();
  });

  test("searches by LIKE until the backfill completes, and writes during it stay in sync", async () => {
    const client = getDbClient();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await newTask(`backlog item number${i}`));
    // Simulate an upgraded DB: rows exist, the backfill has not run.
    await client.run("INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('delete-all')");
    await client.run("UPDATE agent_tasks_fts_state SET indexedThrough = 0 WHERE id = 1");

    // LIKE semantics: a substring matches.
    expect(await found("acklo")).toHaveLength(7);

    // Index the first three rows, as an interrupted backfill would.
    const third = (await client.get<{ rid: number }>(
      "SELECT rowid AS rid FROM agent_tasks WHERE id = ?",
      [ids[2]],
    ))!.rid;
    await client.run(
      "INSERT INTO agent_tasks_fts(rowid, task, title) SELECT rowid, task, title FROM agent_tasks WHERE rowid <= ?",
      [third],
    );
    await client.run("UPDATE agent_tasks_fts_state SET indexedThrough = ? WHERE id = 1", [third]);

    // Writes on both sides of the mark, and a new row.
    await client.run("UPDATE agent_tasks SET task = 'covered edit' WHERE id = ?", [ids[0]]);
    await client.run("UPDATE agent_tasks SET task = 'uncovered edit' WHERE id = ?", [ids[5]]);
    await deleteTask(ids[1]!);
    await deleteTask(ids[6]!);
    await newTask("arrived mid backfill");

    const result = await backfillTaskSearchIndex(2);
    expect(result.indexed).toBe(4);
    expect(await indexedThrough()).toBe(TASK_FTS_COMPLETE);
    await expectIndexInSync();

    expect(await found("acklo")).toEqual([]);
    expect(await found("backlog")).toHaveLength(3);
    expect(await found("edit")).toEqual(["covered edit", "uncovered edit"]);
    expect(await found("arrived")).toEqual(["arrived mid backfill"]);
    expect(await backfillTaskSearchIndex(2)).toMatchObject({ indexed: 0 });
  });

  test("a batch that hits SQLITE_BUSY rolls back and is retried exactly once", async () => {
    const client = getDbClient();
    for (let i = 0; i < 7; i++) await newTask(`busy item number${i}`);
    await client.run("INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('delete-all')");
    await client.run("UPDATE agent_tasks_fts_state SET indexedThrough = 0 WHERE id = 1");

    // The second batch writes its rows, then fails like a COMMIT that lost
    // the write lock to another process: the whole batch rolls back.
    const transaction = client.transaction.bind(client);
    let calls = 0;
    const spy = spyOn(client, "transaction").mockImplementation((fn, opts) => {
      calls += 1;
      const call = calls;
      return transaction(async (tx) => {
        const result = await fn(tx);
        if (call === 2) throw busyError();
        return result;
      }, opts);
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await backfillTaskSearchIndex(2, { yieldMs: 0, retryBackoffMs: [1] });
      expect(result.indexed).toBe(7);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect(calls).toBe(5);
    expect(await indexedThrough()).toBe(TASK_FTS_COMPLETE);
    await expectIndexInSync();
    expect(await found("busy")).toHaveLength(7);
  });

  test("waits while the WAL is over its cap, at most walMaxWaitMs per batch", async () => {
    const client = getDbClient();
    for (let i = 0; i < 4; i++) await newTask(`paced item number${i}`);
    await client.run("INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('delete-all')");
    await client.run("UPDATE agent_tasks_fts_state SET indexedThrough = 0 WHERE id = 1");

    const GB = 1024 ** 3;
    const transaction = client.transaction.bind(client);
    const events: string[] = [];
    const spy = spyOn(client, "transaction").mockImplementation((fn, opts) => {
      events.push("batch");
      return transaction(fn, opts);
    });
    // Read 1 sets the cap from a small WAL. Before batch 1 the WAL is over it
    // twice, then drops. Before batch 2 it stays over it: the wait times out.
    const sizes = [0, GB, GB, 0];
    let reads = 0;
    const walBytes = () => {
      const size = sizes[reads] ?? GB;
      reads += 1;
      if (size > 0) events.push("wal-high");
      return size;
    };
    try {
      const result = await backfillTaskSearchIndex(2, {
        yieldMs: 0,
        walBytes,
        walPollMs: 1,
        walMaxWaitMs: 3,
      });
      expect(result.indexed).toBe(4);
    } finally {
      spy.mockRestore();
    }
    expect(events.slice(0, 7)).toEqual([
      "wal-high",
      "wal-high",
      "batch",
      "wal-high",
      "wal-high",
      "wal-high",
      "batch",
    ]);
    expect(await indexedThrough()).toBe(TASK_FTS_COMPLETE);
    await expectIndexInSync();
  });

  test("a run that gives up resumes from the watermark until the index is complete", async () => {
    const client = getDbClient();
    for (let i = 0; i < 5; i++) await newTask(`stuck item number${i}`);
    await client.run("INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('delete-all')");
    await client.run("UPDATE agent_tasks_fts_state SET indexedThrough = 0 WHERE id = 1");

    // Batch 1 commits. Then two BUSY failures end the first run, and the
    // resumed run first hits a non-BUSY error, which is retried as well.
    const transaction = client.transaction.bind(client);
    let calls = 0;
    const spy = spyOn(client, "transaction").mockImplementation((fn, opts) => {
      calls += 1;
      if (calls === 2 || calls === 3) return Promise.reject(busyError());
      if (calls === 4) return Promise.reject(new Error("disk I/O error"));
      return transaction(fn, opts);
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const opts = { batchSize: 2, yieldMs: 0, retryBackoffMs: [1], maxRetries: 1, resumeMs: 20 };
      await startTaskSearchBackfill(opts);
      expect(calls).toBe(3);
      expect(await indexedThrough()).toBeGreaterThan(0);
      expect(await indexedThrough()).toBeLessThan(TASK_FTS_COMPLETE);
      expect(String(error.mock.calls[0]?.[0])).toContain("resuming in 20ms");

      const deadline = Date.now() + 5_000;
      while ((await indexedThrough()) < TASK_FTS_COMPLETE && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      await stopTaskSearchBackfill();
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
    expect(await indexedThrough()).toBe(TASK_FTS_COMPLETE);
    await expectIndexInSync();
    expect(await found("stuck")).toHaveLength(5);
  });

  test("stopTaskSearchBackfill cancels a pending resume", async () => {
    const client = getDbClient();
    await newTask("never resumed");
    await client.run("INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('delete-all')");
    await client.run("UPDATE agent_tasks_fts_state SET indexedThrough = 0 WHERE id = 1");

    let calls = 0;
    const spy = spyOn(client, "transaction").mockImplementation(() => {
      calls += 1;
      return Promise.reject(busyError());
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await startTaskSearchBackfill({ maxRetries: 0, resumeMs: 30 });
      await stopTaskSearchBackfill();
      await Bun.sleep(80);
    } finally {
      spy.mockRestore();
      error.mockRestore();
    }
    expect(calls).toBe(1);
    expect(await indexedThrough()).toBe(0);
    await startTaskSearchBackfill();
    expect(await indexedThrough()).toBe(TASK_FTS_COMPLETE);
  });

  test("stopTaskSearchBackfill cuts a busy-retry wait short", async () => {
    const client = getDbClient();
    await newTask("waiting item");
    await client.run("INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('delete-all')");
    await client.run("UPDATE agent_tasks_fts_state SET indexedThrough = 0 WHERE id = 1");

    let calls = 0;
    const spy = spyOn(client, "transaction").mockImplementation(() => {
      calls += 1;
      return Promise.reject(busyError());
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The default backoff waits a full second before the first retry.
      const running = startTaskSearchBackfill();
      while (calls === 0) await Bun.sleep(1);
      const stoppedAt = performance.now();
      await stopTaskSearchBackfill();
      expect(performance.now() - stoppedAt).toBeLessThan(500);
      await running;
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect(calls).toBe(1);
    expect(await indexedThrough()).toBe(0);
    // The next start resumes.
    await startTaskSearchBackfill();
    expect(await indexedThrough()).toBe(TASK_FTS_COMPLETE);
  });
});

describe("agent_tasks rebuild in runtime.ts", () => {
  // The rebuild runs in initDb's cold path, which the preload's in-memory
  // migration template skips; open a real file instead.
  const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
  let template: Uint8Array | undefined;

  beforeAll(() => {
    template = globals.__testMigrationTemplate;
    globals.__testMigrationTemplate = undefined;
  });

  afterAll(async () => {
    closeDb();
    globals.__testMigrationTemplate = template;
    await removeDbFiles(REBUILD_DB_PATH);
  });

  test("keeps rowids and the index triggers", async () => {
    closeDb();
    await removeDbFiles(REBUILD_DB_PATH);
    initDb(REBUILD_DB_PATH);
    const first = await newTask("first survivor");
    const gone = await newTask("deleted middle");
    const last = await newTask("last survivor");
    await deleteTask(gone);

    // Swap in the legacy status CHECK that makes initDb rebuild agent_tasks.
    // The fixture copies rowids, so the gap left by the delete survives it.
    const db = getDb();
    db.run("UPDATE agent_tasks SET status = 'pending'");
    const schema = db
      .prepare<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'",
      )
      .get()!.sql;
    const legacy = schema
      .replace(/^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)(?:"agent_tasks"|agent_tasks)/i, "$1legacy")
      .replace(
        /status TEXT NOT NULL DEFAULT 'pending'/,
        "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed'))",
      );
    expect(legacy).not.toBe(schema);
    const columns = db
      .prepare<{ name: string }, []>('PRAGMA table_info("agent_tasks")')
      .all()
      .map((column) => `"${column.name}"`)
      .join(", ");
    const objects = db
      .prepare<{ name: string; tbl_name: string; sql: string }, []>(
        `SELECT name, tbl_name, sql FROM sqlite_master
         WHERE type IN ('index', 'trigger') AND sql IS NOT NULL
           AND (tbl_name = 'agent_tasks' OR (type = 'trigger' AND sql LIKE '%agent_tasks%'))`,
      )
      .all();
    db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => {
      db.run(legacy);
      db.run(`INSERT INTO legacy (rowid, ${columns}) SELECT rowid, ${columns} FROM agent_tasks`);
      for (const object of objects) {
        if (object.tbl_name !== "agent_tasks") db.run(`DROP TRIGGER "${object.name}"`);
      }
      db.run("DROP TABLE agent_tasks");
      db.run("ALTER TABLE legacy RENAME TO agent_tasks");
      for (const object of objects) db.run(object.sql);
    }).immediate();
    db.run("PRAGMA foreign_keys = ON");
    closeDb();

    initDb(REBUILD_DB_PATH);
    const rebuilt = getDb()
      .prepare<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'",
      )
      .get()!.sql;
    expect(rebuilt).not.toContain("CHECK(status IN");
    await expectIndexInSync();
    expect(await found("survivor")).toEqual(["first survivor", "last survivor"]);

    await getDbClient().run("UPDATE agent_tasks SET task = 'renamed survivor' WHERE id = ?", [
      last,
    ]);
    await deleteTask(first);
    await newTask("born after rebuild");
    await expectIndexInSync();
    expect(await found("survivor")).toEqual(["renamed survivor"]);
    expect(await found("born")).toEqual(["born after rebuild"]);
  });
});
