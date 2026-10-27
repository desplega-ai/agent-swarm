import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAssetKey } from "../assets/key";
import {
  closeDb,
  createSteeringMessage,
  createUser,
  getDbClient,
  initDb,
  updateTaskProgress,
  upsertInboxState,
} from "../be/db";
import { findSessionSummaryDrift } from "../be/db/session-summaries";
import { sessionSummaryQuery } from "../be/db/session-tree";
import { deleteTask } from "../be/db/tasks/write";

const dbPath = join(tmpdir(), `session-summaries-${process.pid}-${Date.now()}.sqlite`);
const MIGRATION = join(import.meta.dir, "../be/migrations/253_session_summaries.sql");
const BASE = Date.parse("2026-10-01T00:00:00.000Z");
let users: string[] = [];

// mulberry32, so a failure replays with the same operations.
let seed = 0x2520_1028;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
// Random, not monotonic: writes move timestamps both ways.
const at = () => new Date(BASE + Math.floor(rand() * 20 * 86_400_000)).toISOString();

const client = () => getDbClient();
const taskIds = async () =>
  (await client().query<{ id: string }>("SELECT id FROM agent_tasks ORDER BY id")).map((r) => r.id);
const rootIds = async () =>
  (
    await client().query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE parentTaskId IS NULL ORDER BY id",
    )
  ).map((r) => r.id);

async function insertTask(opts: { parentTaskId?: string | null; id?: string } = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const createdAt = at();
  const requester = rand() < 0.7 ? pick(users) : null;
  await client().run(
    `INSERT INTO agent_tasks (id, "key", task, status, source, parentTaskId, requestedByUserId,
      requestedByUserIdInherited, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      defaultAssetKey("task", id),
      `task ${id}`,
      pick(["pending", "in_progress", "completed", "failed"]),
      pick(["ui", "slack", "mcp", "system", "schedule", "workflow", "api"]),
      opts.parentTaskId ?? null,
      requester,
      requester && rand() < 0.5 ? 1 : 0,
      createdAt,
      at(),
    ],
  );
  return id;
}

const OPS: Record<string, () => Promise<unknown>> = {
  async root() {
    await insertTask();
  },
  async child() {
    const ids = await taskIds();
    if (ids.length) await insertTask({ parentTaskId: pick(ids) });
  },
  async danglingChild() {
    await insertTask({ parentTaskId: crypto.randomUUID() });
  },
  async progress() {
    const ids = await taskIds();
    if (ids.length) await updateTaskProgress(pick(ids), "working");
  },
  async status() {
    const ids = await taskIds();
    if (!ids.length) return;
    await client().run("UPDATE agent_tasks SET status = ?, lastUpdatedAt = ? WHERE id = ?", [
      pick(["completed", "failed", "cancelled", "in_progress"]),
      at(),
      pick(ids),
    ]);
  },
  async statusOnly() {
    const ids = await taskIds();
    if (!ids.length) return;
    await client().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [
      pick(["completed", "failed"]),
      pick(ids),
    ]);
  },
  async moveRootKey() {
    const roots = await rootIds();
    if (!roots.length) return;
    await client().run(`UPDATE agent_tasks SET "key" = ? WHERE id = ?`, [
      defaultAssetKey("task", crypto.randomUUID()),
      pick(roots),
    ]);
  },
  async requester() {
    const ids = await taskIds();
    if (!ids.length) return;
    await client().run(
      "UPDATE agent_tasks SET requestedByUserId = ?, requestedByUserIdInherited = ?, source = ? WHERE id = ?",
      [pick([null, ...users]), rand() < 0.5 ? 1 : 0, pick(["ui", "mcp", "slack"]), pick(ids)],
    );
  },
  async steer() {
    const ids = await taskIds();
    if (!ids.length) return;
    const user = rand() < 0.7;
    const message = await createSteeringMessage({
      taskId: pick(ids),
      body: "steer",
      mode: pick(["steer", "queue"] as const),
      source: "ui",
      createdByKind: user ? "user" : "agent",
      createdByUserId: user ? pick(users) : undefined,
    });
    await client().run("UPDATE task_steering_messages SET created_at = ? WHERE id = ?", [
      at(),
      message.id,
    ]);
  },
  async steerCancel() {
    const row = await client().get<{ id: string }>(
      "SELECT id FROM task_steering_messages WHERE status != 'cancelled' ORDER BY random() LIMIT 1",
    );
    if (row)
      await client().run("UPDATE task_steering_messages SET status = 'cancelled' WHERE id = ?", [
        row.id,
      ]);
  },
  async steerDelivered() {
    const row = await client().get<{ id: string }>(
      "SELECT id FROM task_steering_messages WHERE status = 'pending' ORDER BY random() LIMIT 1",
    );
    if (row)
      await client().run("UPDATE task_steering_messages SET status = 'delivered' WHERE id = ?", [
        row.id,
      ]);
  },
  async steerDelete() {
    await client().run(
      "DELETE FROM task_steering_messages WHERE id = (SELECT id FROM task_steering_messages ORDER BY random() LIMIT 1)",
    );
  },
  async approval() {
    const ids = await taskIds();
    if (!ids.length) return;
    await client().run(
      `INSERT INTO approval_requests (id, title, questions, approvers, status, sourceTaskId, createdAt)
       VALUES (?, 'ok?', '[]', '{}', 'pending', ?, ?)`,
      [crypto.randomUUID(), pick(ids), at()],
    );
  },
  async approvalResolve() {
    await client().run(
      `UPDATE approval_requests SET status = ? WHERE id = (
        SELECT id FROM approval_requests WHERE status = 'pending' ORDER BY random() LIMIT 1)`,
      [pick(["approved", "rejected", "timeout"])],
    );
  },
  async approvalDelete() {
    await client().run(
      "DELETE FROM approval_requests WHERE id = (SELECT id FROM approval_requests ORDER BY random() LIMIT 1)",
    );
  },
  async deleteTask() {
    const ids = await taskIds();
    if (ids.length > 10) await deleteTask(pick(ids));
  },
  async doneMark() {
    const roots = await rootIds();
    if (!roots.length) return;
    await upsertInboxState({
      userId: users[0]!,
      itemType: "to_read",
      itemId: pick(roots),
      status: "done",
    });
    await client().run(
      `UPDATE inbox_item_state SET lastUpdatedAt = ? WHERE userId = ? AND itemType = 'to_read' AND status = 'done'
        AND itemId = (SELECT itemId FROM inbox_item_state WHERE userId = ? ORDER BY lastUpdatedAt DESC LIMIT 1)`,
      [at(), users[0]!, users[0]!],
    );
  },
};

// Weighted toward the common writes: inserts and progress.
const SCHEDULE = [
  ...Array(6).fill("root"),
  ...Array(10).fill("child"),
  ...Array(6).fill("progress"),
  ...Array(3).fill("status"),
  ...Object.keys(OPS),
] as string[];

/** Each Done-marked root's read state from the chain walk equals the stored rule. */
async function expectReopensDoneMatches() {
  const viewer = users[0]!;
  const legacy = sessionSummaryQuery({ viewer: { userId: viewer, scope: "all" } });
  const rows = await client().query<{ root_id: string; readState: string; stored: string }>(
    `SELECT a.root_id, a.readState,
      CASE WHEN s.lastHumanAt > d.lastUpdatedAt THEN 'unread' ELSE 'done' END AS stored
    FROM (${legacy.sql}) a
    JOIN inbox_item_state d ON d.userId = ? AND d.itemType = 'to_read' AND d.itemId = a.root_id AND d.status = 'done'
    JOIN session_summaries s ON s.rootId = a.root_id`,
    [...legacy.params, viewer],
  );
  for (const row of rows)
    expect({ root: row.root_id, state: row.stored }).toEqual({
      root: row.root_id,
      state: row.readState,
    });
  return rows.length;
}

beforeAll(async () => {
  initDb(dbPath);
  users = [];
  for (let i = 0; i < 3; i++) users.push((await createUser({ name: `summary user ${i}` })).id);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {}
  }
});

describe("session_summaries", () => {
  test("500 random writes keep the summaries equal to the chain walk", async () => {
    const counts: Record<string, number> = {};
    // The most chains, human events and pending approvals any checkpoint compared.
    const seen = { chains: 0, humans: 0, pending: 0 };
    let doneChecks = 0;
    for (let i = 1; i <= 500; i++) {
      const op = pick(SCHEDULE);
      counts[op] = (counts[op] ?? 0) + 1;
      await OPS[op]!();
      if (i % 50 === 0) {
        expect({ after: i, drift: await findSessionSummaryDrift() }).toEqual({
          after: i,
          drift: [],
        });
        doneChecks += await expectReopensDoneMatches();
        const shape = (await client().get<typeof seen>(
          `SELECT SUM(chainCount > 2) AS chains, SUM(lastHumanAt IS NOT NULL) AS humans,
            SUM(pendingApprovalCount > 0) AS pending FROM session_summaries`,
        ))!;
        for (const key of Object.keys(seen) as (keyof typeof seen)[])
          seen[key] = Math.max(seen[key], shape[key] ?? 0);
      }
    }
    // Every operation ran, and the checks compared real chains and Done marks.
    for (const op of Object.keys(OPS)) expect(counts[op] ?? 0).toBeGreaterThan(0);
    expect(seen.chains).toBeGreaterThan(5);
    expect(seen.humans).toBeGreaterThan(5);
    expect(seen.pending).toBeGreaterThan(0);
    expect(doneChecks).toBeGreaterThan(0);
  }, 60_000);

  test("the drift check reports a corrupted summary and member (positive control)", async () => {
    const root = await insertTask();
    const child = await insertTask({ parentTaskId: root });
    expect(await findSessionSummaryDrift()).toEqual([]);

    await client().run(
      "UPDATE session_summaries SET chainCount = chainCount + 5, lastHumanAt = 'x' WHERE rootId = ?",
      [root],
    );
    await client().run("DELETE FROM session_members WHERE taskId = ?", [child]);
    const drift = await findSessionSummaryDrift();
    expect(drift.map((d) => `${d.rootId}:${d.field}`).sort()).toEqual(
      [`${root}:chainCount`, `${root}:lastHumanAt`, `${root}:member`].sort(),
    );

    await client().run("INSERT INTO session_members (taskId, rootId) VALUES (?, ?)", [child, root]);
    await client().run("INSERT INTO session_summary_recompute (rootId) VALUES (?)", [root]);
    expect(await findSessionSummaryDrift()).toEqual([]);
  });

  test("deleting a mid-chain task drops its descendants from the session", async () => {
    const root = await insertTask();
    const mid = await insertTask({ parentTaskId: root });
    const leaf = await insertTask({ parentTaskId: mid });
    await insertTask({ parentTaskId: leaf });
    const sibling = await insertTask({ parentTaskId: root });

    expect(await deleteTask(mid)).toBe(true);
    const members = await client().query<{ taskId: string }>(
      "SELECT taskId FROM session_members WHERE rootId = ? ORDER BY taskId",
      [root],
    );
    expect(members.map((m) => m.taskId)).toEqual([root, sibling].sort());
    const summary = await client().get<{ chainCount: number }>(
      "SELECT chainCount FROM session_summaries WHERE rootId = ?",
      [root],
    );
    expect(summary!.chainCount).toBe(2);
    expect(await findSessionSummaryDrift()).toEqual([]);

    expect(await deleteTask(root)).toBe(true);
    const left = await client().get<{ members: number; summaries: number }>(
      `SELECT (SELECT COUNT(*) FROM session_members WHERE rootId = ?) AS members,
        (SELECT COUNT(*) FROM session_summaries WHERE rootId = ?) AS summaries`,
      [root, root],
    );
    expect(left).toEqual({ members: 0, summaries: 0 });
  });

  test("deleting a task whose steering cascades leaves no half-recomputed summary", async () => {
    // The steering FK cascade fires its trigger while the task row is already gone.
    const steer = (taskId: string) =>
      createSteeringMessage({
        taskId,
        body: "steer",
        mode: "steer",
        source: "ui",
        createdByKind: "user",
        createdByUserId: users[0]!,
      });
    const single = await insertTask();
    await steer(single);
    expect(await deleteTask(single)).toBe(true);

    const root = await insertTask();
    const child = await insertTask({ parentTaskId: root });
    await steer(root);
    await steer(child);
    await client().run("DELETE FROM agent_tasks WHERE id IN (?, ?)", [child, root]);
    expect(await findSessionSummaryDrift()).toEqual([]);
  });

  test("changing parentTaskId aborts", async () => {
    const root = await insertTask();
    const other = await insertTask();
    const child = await insertTask({ parentTaskId: root });
    await expect(
      client().run("UPDATE agent_tasks SET parentTaskId = ? WHERE id = ?", [other, child]),
    ).rejects.toThrow(/parentTaskId is immutable/);
    // Rewriting the same value is not a change.
    await client().run("UPDATE agent_tasks SET parentTaskId = ? WHERE id = ?", [root, child]);
  });

  test("the migration backfill rebuilds the same summaries", async () => {
    const before = await client().query<Record<string, unknown>>(
      "SELECT * FROM session_summaries ORDER BY rootId",
    );
    expect(before.length).toBeGreaterThan(20);
    const sql = await Bun.file(MIGRATION).text();
    const backfill = sql.slice(sql.indexOf("-- Backfill:"));
    expect(backfill).toContain("INSERT INTO session_members");
    await client().transaction(async (tx) => {
      await tx.run("DELETE FROM session_summaries");
      await tx.run("DELETE FROM session_members");
      for (const statement of backfill
        .split(/;\s*\n/)
        .filter((s) => s.replace(/--.*$/gm, "").trim()))
        await tx.run(statement);
    });
    expect(await findSessionSummaryDrift()).toEqual([]);
    const after = await client().query<Record<string, unknown>>(
      "SELECT * FROM session_summaries ORDER BY rootId",
    );
    // latestStatus may differ only where two chain tasks tie on the newest timestamp.
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map(({ latestStatus: _, ...row }) => row);
    expect(strip(after)).toEqual(strip(before));
  });
});
