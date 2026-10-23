import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDb, createTaskExtended, createUser, getDb, getDbClient, initDb } from "../be/db";
import { setSessionShares } from "../be/session-shares";

const day = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();

beforeAll(() => {
  initDb(":memory:");
});
afterAll(() => {
  closeDb();
});

async function root(requestedByUserId: string | undefined, activity: string, status = "completed") {
  const task = await createTaskExtended("Cleanup test", { key: "shared/", requestedByUserId });
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ?, status = ? WHERE id = ?", [
    activity,
    status,
    task.id,
  ]);
  return task;
}

async function row(
  userId: string,
  itemId: string,
  status: string,
  lastReadAt: string | null = null,
  { snoozeUntil = "2999-01-01T00:00:00.000Z", lastUpdatedAt = ago(20) } = {},
) {
  await getDbClient().run(
    `INSERT INTO inbox_item_state (userId, itemType, itemId, status, snoozeUntil, lastReadAt, lastUpdatedAt)
    VALUES (?, 'to_read', ?, ?, ?, ?, ?)`,
    [userId, itemId, status, status === "snoozed" ? snoozeUntil : null, lastReadAt, lastUpdatedAt],
  );
}

async function states(): Promise<Record<string, string>> {
  const rows = await getDbClient().query<{ userId: string; itemId: string; status: string }>(
    "SELECT userId, itemId, status FROM inbox_item_state ORDER BY userId, itemId",
  );
  return Object.fromEntries(rows.map((r) => [`${r.userId}:${r.itemId}`, r.status]));
}

test("migration 237 moves quiet, read sessions to Done for every viewer, once", async () => {
  const owner = await createUser({ name: "Owner" });
  const other = await createUser({ name: "Other" });
  const third = await createUser({ name: "Third" });

  const quiet = await root(owner.id, ago(30));
  const recent = await root(owner.id, ago(1));
  // A quiet root whose child moved yesterday is not quiet.
  const busyChain = await root(owner.id, ago(30));
  const child = await createTaskExtended("Child", { parentTaskId: busyChain.id });
  await getDbClient().run(
    "UPDATE agent_tasks SET lastUpdatedAt = ?, status = 'completed' WHERE id = ?",
    [ago(1), child.id],
  );
  // Quiet but not finished, or waiting on an approval: both stay in the Inbox.
  const stuck = await root(owner.id, ago(30), "in_progress");
  const failed = await root(owner.id, ago(30), "failed");
  const awaiting = await root(owner.id, ago(30));
  await getDbClient().run(
    `INSERT INTO approval_requests (id, sourceTaskId, title, questions, approvers, status)
    VALUES (?, ?, 'Approve deploy', '[]', '{}', 'pending')`,
    [crypto.randomUUID(), awaiting.id],
  );
  // Open rows: read up to the newest activity, or unread (cursor before it).
  const openRead = await root(owner.id, ago(30));
  await row(owner.id, openRead.id, "open", ago(25));
  const openUnread = await root(owner.id, ago(30));
  await row(owner.id, openUnread.id, "open", "1970-01-01T00:00:00.000Z");
  // Open rows with no cursor: the row's own time is the cursor.
  const openNoCursor = await root(owner.id, ago(30));
  await row(owner.id, openNoCursor.id, "open");
  const openNoCursorOld = await root(owner.id, ago(30));
  await row(owner.id, openNoCursorOld.id, "open", null, { lastUpdatedAt: ago(40) });
  // Snoozed (also past its wake time, which reads as unread) and dismissed rows keep their state.
  const snoozed = await root(owner.id, ago(30));
  await row(owner.id, snoozed.id, "snoozed");
  const woken = await root(owner.id, ago(30));
  await row(owner.id, woken.id, "snoozed", null, { snoozeUntil: ago(10) });
  const dismissed = await root(owner.id, ago(30));
  await row(owner.id, dismissed.id, "dismissed");
  // Shares: one user, and everyone.
  const sharedDirect = await root(other.id, ago(30));
  await setSessionShares(
    { id: sharedDirect.id, requestedByUserId: other.id },
    { everyone: "none", users: [{ userId: owner.id, access: "read" }] },
    other.id,
  );
  const sharedAll = await root(other.id, ago(30));
  await setSessionShares(
    { id: sharedAll.id, requestedByUserId: other.id },
    { everyone: "read", users: [] },
    other.id,
  );
  // Ownerless roots are not in the tree.
  const ownerless = await root(undefined, ago(30));

  const sql = await Bun.file("src/be/migrations/237_session_inbox_cleanup.sql").text();
  getDb().exec(sql);
  const after = await states();
  expect(after).toEqual({
    [`${owner.id}:${quiet.id}`]: "done",
    [`${owner.id}:${failed.id}`]: "done",
    [`${owner.id}:${openRead.id}`]: "done",
    [`${owner.id}:${openUnread.id}`]: "open",
    [`${owner.id}:${openNoCursor.id}`]: "done",
    [`${owner.id}:${openNoCursorOld.id}`]: "open",
    [`${owner.id}:${snoozed.id}`]: "snoozed",
    [`${owner.id}:${woken.id}`]: "snoozed",
    [`${owner.id}:${dismissed.id}`]: "dismissed",
    [`${owner.id}:${sharedDirect.id}`]: "done",
    [`${owner.id}:${sharedAll.id}`]: "done",
    [`${other.id}:${sharedDirect.id}`]: "done",
    [`${other.id}:${sharedAll.id}`]: "done",
    [`${third.id}:${sharedAll.id}`]: "done",
  });
  for (const id of [recent.id, busyChain.id, ownerless.id, stuck.id, awaiting.id]) {
    expect(Object.keys(after).some((key) => key.endsWith(`:${id}`))).toBe(false);
  }
  // Every timestamp it writes is ISO, so the read rule compares it with task times.
  const written = await getDbClient().get<{ doneAt: string; lastUpdatedAt: string }>(
    "SELECT doneAt, lastUpdatedAt FROM inbox_item_state WHERE itemId = ?",
    [quiet.id],
  );
  expect(written?.doneAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(written?.lastUpdatedAt).toBe(written?.doneAt);

  // A second run changes nothing.
  getDb().exec(sql);
  expect(await states()).toEqual(after);
  expect(getDb().query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
});
