import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getAllTasks, getDb, getDbClient, initDb } from "../be/db";
import { readableSessionCondition } from "../be/db/tasks/read";

const TEST_DB_PATH = "./test-tasks-readable-row.sqlite";
const AT = "2026-10-01T00:00:00.000Z";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

async function task(
  id: string,
  opts: { parent?: string; owner?: string; scheduleId?: string } = {},
): Promise<void> {
  await getDbClient().run(
    `INSERT INTO agent_tasks (id, task, status, source, parentTaskId, requestedByUserId, scheduleId,
       createdAt, lastUpdatedAt)
     VALUES (?, ?, 'completed', 'api', ?, ?, ?, ?, ?)`,
    [id, `task ${id}`, opts.parent ?? null, opts.owner ?? null, opts.scheduleId ?? null, AT, AT],
  );
}

describe("readableSessionRowCondition", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    for (const id of ["u1", "u2", "u3"]) {
      await getDbClient().run(
        "INSERT INTO users (id, name, role, status, createdAt, lastUpdatedAt) VALUES (?, ?, 'member', 'active', ?, ?)",
        [id, id, AT, AT],
      );
    }
    // u1's session, three deep.
    await task("a", { owner: "u1" });
    await task("a1", { parent: "a", owner: "u1" });
    await task("a2", { parent: "a1" });
    // u2's session, with a child that names u1.
    await task("b", { owner: "u2" });
    await task("b1", { parent: "b", owner: "u1" });
    // u2's schedule run: everyone reads it.
    await task("c", { owner: "u2", scheduleId: "schedule-1" });
    await task("c1", { parent: "c" });
    // u2's session shared with u1, and one shared with everyone.
    await task("d", { owner: "u2" });
    await task("d1", { parent: "d" });
    await task("e", { owner: "u2" });
    await getDbClient().run(
      `INSERT INTO session_shares (id, rootTaskId, userId, access, createdAt)
       VALUES ('share-d', 'd', 'u1', 'read', ?), ('share-e', 'e', NULL, 'read', ?)`,
      [AT, AT],
    );
    // A revoked share hides again.
    await task("f", { owner: "u2" });
    await getDbClient().run(
      `INSERT INTO session_shares (id, rootTaskId, userId, access, createdAt, revokedAt)
       VALUES ('share-f', 'f', 'u1', 'read', ?, ?)`,
      [AT, AT],
    );
    // A session nobody owns.
    await task("g");
    await task("g1", { parent: "g", owner: "u2" });
    // Orphan subtrees: the top's parent is gone, so the top is the root.
    await task("h", { owner: "u2" });
    await task("h1", { parent: "h" });
    await task("h2", { parent: "h1", owner: "u1" });
    await task("i", { owner: "u1" });
    await task("i1", { parent: "i", owner: "u2" });
    await task("i2", { parent: "i1" });
    // Chains deeper than the walk's hop limit fall back to the set form.
    for (const [root, owner] of [
      ["deep-u1", "u1"],
      ["deep-u2", "u2"],
    ] as const) {
      await task(root, { owner });
      let parent: string = root;
      for (let i = 1; i <= 70; i++) {
        await task(`${root}-${i}`, { parent });
        parent = `${root}-${i}`;
      }
    }
    getDb().run("PRAGMA foreign_keys = OFF");
    getDb().run("DELETE FROM agent_tasks WHERE id IN ('h', 'i')");
    getDb().run("PRAGMA foreign_keys = ON");
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  for (const userId of ["u1", "u2", "u3", null]) {
    test(`the page shows the rows the set form shows, for ${userId ?? "a guest"}`, async () => {
      const set = readableSessionCondition(userId);
      const expected = (
        await getDbClient().query<{ id: string }>(
          `SELECT id FROM agent_tasks WHERE ${set.sql} ORDER BY id`,
          set.params,
        )
      ).map((row) => row.id);
      const page = await getAllTasks({ readableBy: { userId }, limit: 1000 });
      expect(page.map((t) => t.id).sort()).toEqual(expected);
    });
  }

  test("u1 sees exactly the expected sessions", async () => {
    const page = await getAllTasks({ readableBy: { userId: "u1" }, limit: 1000 });
    const deep = Array.from({ length: 70 }, (_, i) => `deep-u1-${i + 1}`);
    expect(page.map((t) => t.id).sort()).toEqual(
      [
        "a",
        "a1",
        "a2",
        "c",
        "c1",
        "d",
        "d1",
        "e",
        "g",
        "g1",
        "h1",
        "h2",
        "deep-u1",
        ...deep,
      ].sort(),
    );
  });

  test("the page walks up from each row it reads", async () => {
    const query = spyOn(getDbClient(), "query");
    let sql = "";
    let params: unknown[] = [];
    try {
      await getAllTasks({ status: "completed", readableBy: { userId: "u1" } });
      [sql, params = []] = query.mock.calls.find(([s]) => s.includes("WITH page AS"))! as [
        string,
        unknown[]?,
      ];
    } finally {
      query.mockRestore();
    }
    const plan = getDb()
      .query<{ detail: string }, any[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as any[]))
      .map((row) => row.detail)
      .join("\n");
    // The walk is a correlated lookup per row. The set form appears only as
    // the fallback branch, which SQLite builds when a walk finds no root.
    expect(plan).toContain("CORRELATED SCALAR SUBQUERY");
    expect(plan).toContain("SEARCH u USING INDEX sqlite_autoindex_agent_tasks_1 (id=?)");
    expect(plan).toContain("SEARCH p USING INDEX sqlite_autoindex_agent_tasks_1 (id=?)");
  });
});
