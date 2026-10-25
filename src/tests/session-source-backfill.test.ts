import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { defaultAssetKey } from "../assets/key";
import { sessionSourceKey } from "../assets/source-key";
import * as audit from "../be/asset-key-audit";
import {
  closeDb,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
  insertTaskAttachment,
  listRecentSessions,
  upsertInboxState,
} from "../be/db";
import * as sessionMoves from "../be/db/session-moves";
import type { DbParam } from "../be/db-client";
import { runSessionSourceBackfill } from "../be/session-source-backfill";
import { chatSdkContextKey } from "../tasks/context-key";

const DONE_KEY = "session-source-keys-v1";
const CURSOR_KEY = `${DONE_KEY}:cursor`;
const BEFORE = "2026-10-21T10:30:00.000Z";
const DONE_AT = "2026-10-21T11:00:00.000Z";
const slack = { slackChannelId: "C0AR967K0KZ", slackThreadTs: "1729000000.123456" };
let owner: string;

beforeEach(async () => {
  initDb(":memory:");
  owner = (await createUser({ name: "Backfill owner" })).id;
});
afterEach(() => closeDb());

// SQL preserves pre-source-key rows, including uppercase legacy task ids.
async function seedTask(
  opts: {
    id?: string;
    key?: string;
    source?: string;
    parentTaskId?: string;
    requestedByUserId?: string | null;
    slackChannelId?: string;
    slackThreadTs?: string;
    contextKey?: string;
  } = {},
) {
  const id = opts.id ?? crypto.randomUUID();
  await getDbClient().run(
    `INSERT INTO agent_tasks
       (id, task, status, source, parentTaskId, requestedByUserId, "key",
        slackChannelId, slackThreadTs, contextKey, createdAt, lastUpdatedAt, updated_by)
     VALUES (?, 'Old session', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.source ?? "slack",
      opts.parentTaskId ?? null,
      opts.requestedByUserId === undefined ? owner : opts.requestedByUserId,
      opts.key ?? defaultAssetKey("task", id),
      opts.slackChannelId ?? null,
      opts.slackThreadTs ?? null,
      opts.contextKey ?? null,
      BEFORE,
      BEFORE,
      owner,
    ],
  );
  return (await getTaskById(id))!;
}

async function seedState(key: string) {
  return getDbClient().get<{ seededHash: string }>(
    "SELECT seededHash FROM seed_state WHERE kind = 'maintenance' AND key = ?",
    [key],
  );
}

test("moves both old defaults, whole chains and mapped files with history, without changing read or Done state", async () => {
  const roots = [
    await seedTask({ ...slack, key: "shared/" }),
    await seedTask({
      ...slack,
      slackThreadTs: "1729000000.654321",
      id: crypto.randomUUID().toUpperCase(),
    }),
  ];
  const expectedHistory: unknown[] = [];
  const tasks = roots.map((task) => ({ task, key: sessionSourceKey(task) }));
  const mappings: { id: string; key: string | null }[] = [];
  for (const [index, root] of roots.entries()) {
    const child = await seedTask({ parentTaskId: root.id, key: root.key, source: "mcp" });
    const grandchild = await seedTask({
      parentTaskId: child.id,
      key: "shared/other-child-key/",
      source: "mcp",
    });
    tasks.push(...[child, grandchild].map((task) => ({ task, key: sessionSourceKey(root) })));
    const attachment = await insertTaskAttachment({
      taskId: grandchild.id,
      kind: "agent-fs",
      name: "notes",
      path: `backfill/${grandchild.id}`,
      providerId: "agent-fs",
      providerKey: `backfill/${grandchild.id}`,
    });
    const mapping = await getDbClient().get<{ id: string; key: string }>(
      "SELECT id, key FROM asset_key_mappings WHERE source_entity_id = ?",
      [attachment.id],
    );
    expect(mapping).not.toBeNull();
    mappings.push({ id: mapping!.id, key: sessionSourceKey(root) });
    await getDbClient().run("UPDATE asset_key_mappings SET updated_by = ? WHERE id = ?", [
      owner,
      mapping!.id,
    ]);
    for (const task of [root, child, grandchild]) {
      expectedHistory.push({
        entity_type: "task",
        entity_id: task.id,
        previous_key: task.key,
        new_key: sessionSourceKey(root),
        changed_by: null,
      });
    }
    expectedHistory.push({
      entity_type: "file",
      entity_id: mapping!.id,
      previous_key: mapping!.key,
      new_key: sessionSourceKey(root),
      changed_by: null,
    });
    await upsertInboxState({
      userId: owner,
      itemType: "to_read",
      itemId: root.id,
      status: index === 0 ? "done" : "open",
      doneAt: index === 0 ? DONE_AT : undefined,
      readAt: BEFORE,
      lastReadAt: BEFORE,
    });
  }
  const inboxBefore = await getDbClient().query("SELECT * FROM inbox_item_state ORDER BY itemId");
  const sessionsBefore = await listRecentSessions({ viewer: { userId: owner, scope: "all" } });
  expect(sessionsBefore.find((s) => s.root.id === roots[0]!.id)?.readState).toBe("done");
  const historyBefore = await getDbClient().query(
    "SELECT entity_type, entity_id, previous_key, new_key, changed_by FROM asset_key_history",
  );
  const auditSpy = spyOn(audit, "auditAssetKeys");
  try {
    expect(await runSessionSourceBackfill({ batchSize: 1 })).toEqual({
      scanned: 2,
      moved: 2,
      skipped: 0,
      failed: 0,
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
  } finally {
    auditSpy.mockRestore();
  }
  for (const { task, key } of tasks) {
    const after = await getTaskById(task.id);
    expect(after?.key).toBe(key);
    expect(after?.lastUpdatedAt).toBe(task.lastUpdatedAt);
    expect(
      await getDbClient().get("SELECT updated_by FROM agent_tasks WHERE id = ?", [task.id]),
    ).toEqual({ updated_by: owner });
  }
  for (const { id, key } of mappings) {
    expect(
      await getDbClient().get("SELECT key, updated_by FROM asset_key_mappings WHERE id = ?", [id]),
    ).toEqual({ key, updated_by: owner });
  }
  const history = await getDbClient().query(
    "SELECT entity_type, entity_id, previous_key, new_key, changed_by FROM asset_key_history",
  );
  expect(history).toHaveLength(historyBefore.length + expectedHistory.length);
  expect(history).toEqual(expect.arrayContaining([...historyBefore, ...expectedHistory]));
  expect(await getDbClient().query("SELECT * FROM inbox_item_state ORDER BY itemId")).toEqual(
    inboxBefore,
  );
  const sessionsAfter = await listRecentSessions({ viewer: { userId: owner, scope: "all" } });
  for (const before of sessionsBefore) {
    expect(sessionsAfter.find((s) => s.root.id === before.root.id)?.readState).toBe(
      before.readState,
    );
  }
  expect(await seedState(DONE_KEY)).toEqual({ seededHash: "done" });
  expect(await seedState(CURSOR_KEY)).toBeNull();
});

test("preserves user keys and unsupported roots, and moves mcp and ownerless Slack roots", async () => {
  const custom = await seedTask({ ...slack, key: "shared/research/" });
  const child = await seedTask({ ...slack, parentTaskId: custom.id, key: "shared/" });
  const foreignDefault = await seedTask({ ...slack, key: defaultAssetKey("task", custom.id) });
  const teams = await seedTask({ source: "chat", contextKey: chatSdkContextKey("teams:c:t") });
  const ordinary = await seedTask({ source: "ui" });
  const missingThread = await seedTask({ slackChannelId: slack.slackChannelId });
  const mcp = await seedTask({ ...slack, source: "mcp" });
  const ownerless = await seedTask({ ...slack, requestedByUserId: null });
  expect(await runSessionSourceBackfill()).toEqual({ scanned: 3, moved: 2, skipped: 1, failed: 0 });
  for (const task of [custom, child, foreignDefault, teams, ordinary, missingThread]) {
    expect(await getTaskById(task.id)).toEqual(task);
  }
  for (const task of [mcp, ownerless]) {
    expect((await getTaskById(task.id))?.key).toBe(sessionSourceKey(task));
  }
  expect((await getTaskById(ownerless.id))?.requestedByUserId).toBeUndefined();
});

test("moves supported chat roots", async () => {
  const threads = [
    ["telegram:-1001234567890:42", "shared/telegram/-1001234567890/thread:42/"],
    ["telegram:555", "shared/telegram/555/task:00000000-0000-4000-8000-000000000001/"],
    ["discord:guild:channel:thread", "shared/discord/channel/thread:thread/"],
    ["discord:@me:dm", "shared/discord/dm/task:00000000-0000-4000-8000-000000000003/"],
    ["slack:C123:1.2", "shared/slack/c123/thread:1.2/"],
    ["slack:D123:", "shared/slack/d123/task:00000000-0000-4000-8000-000000000005/"],
  ];
  const roots = [];
  for (const [index, [thread, key]] of threads.entries()) {
    const root = await seedTask({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      source: "chat",
      contextKey: chatSdkContextKey(thread!),
    });
    roots.push({ root, key });
  }
  const invalid = await seedTask({ ...slack, slackChannelId: "x".repeat(255) });
  expect(await runSessionSourceBackfill()).toEqual({ scanned: 7, moved: 6, skipped: 1, failed: 0 });
  for (const { root, key } of roots) {
    expect((await getTaskById(root.id))?.key).toBe(key);
  }
  expect(await getTaskById(invalid.id)).toEqual(invalid);
});

test("a completed run does not scan or audit again, even if another old root appears", async () => {
  await seedTask(slack);
  await runSessionSourceBackfill();
  const before = await getDbClient().query("SELECT * FROM asset_key_history ORDER BY id");
  const later = await seedTask(slack);
  const auditSpy = spyOn(audit, "auditAssetKeys");
  try {
    expect(await runSessionSourceBackfill()).toBeNull();
    expect(auditSpy).not.toHaveBeenCalled();
  } finally {
    auditSpy.mockRestore();
  }
  expect(await getTaskById(later.id)).toEqual(later);
  expect(await getDbClient().query("SELECT * FROM asset_key_history ORDER BY id")).toEqual(before);
});

test("isolates a failed root and retries it from the start on the next run", async () => {
  const roots = [];
  for (let index = 0; index < 3; index++) {
    roots.push(await seedTask({ ...slack, id: `00000000-0000-4000-8000-00000000000${index}` }));
  }
  const move = sessionMoves.moveTaskChainKeyInTx;
  const moveSpy = spyOn(sessionMoves, "moveTaskChainKeyInTx").mockImplementationOnce(
    async (...args) => {
      await move(...args);
      throw new Error("Root move failed");
    },
  );
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await runSessionSourceBackfill({ batchSize: 1 })).toEqual({
      scanned: 3,
      moved: 2,
      skipped: 0,
      failed: 1,
    });
    expect(moveSpy).toHaveBeenCalledTimes(3);
    expect(moveSpy.mock.calls[0]?.[0]).toBe(roots[0]!.id);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain(`root=${roots[0]!.id} failed: Root move failed`);
    expect(await getTaskById(roots[0]!.id)).toEqual(roots[0]!);
    for (const root of roots.slice(1)) {
      expect((await getTaskById(root.id))?.key).toBe(sessionSourceKey(root));
    }
    expect(await getDbClient().query("SELECT id FROM asset_key_history")).toHaveLength(2);
    expect(await seedState(DONE_KEY)).toBeNull();
    expect(await seedState(CURSOR_KEY)).toBeNull();
  } finally {
    moveSpy.mockRestore();
    warn.mockRestore();
  }
  expect(await runSessionSourceBackfill()).toEqual({ scanned: 1, moved: 1, skipped: 0, failed: 0 });
  expect((await getTaskById(roots[0]!.id))?.key).toBe(sessionSourceKey(roots[0]!));
  expect(await getDbClient().query("SELECT id FROM asset_key_history")).toHaveLength(3);
  expect(await seedState(DONE_KEY)).toEqual({ seededHash: "done" });
  expect(await seedState(CURSOR_KEY)).toBeNull();
});

test("preserves a user move and includes a child created after the batch read", async () => {
  const movedByUser = await seedTask(slack);
  const root = await seedTask(slack);
  const client = getDbClient();
  const query = client.query.bind(client);
  let childId: string | undefined;
  const querySpy = spyOn(client, "query").mockImplementation(
    async <T>(sql: string, params?: DbParam[]): Promise<T[]> => {
      const rows = await query<T>(sql, params);
      if (sql.startsWith("SELECT id, slackChannelId") && rows.length > 0) {
        await client.run('UPDATE agent_tasks SET "key" = ? WHERE id = ?', [
          "shared/research/",
          movedByUser.id,
        ]);
        childId = (await seedTask({ parentTaskId: root.id, key: root.key, source: "mcp" })).id;
      }
      return rows;
    },
  );
  try {
    expect(await runSessionSourceBackfill()).toEqual({
      scanned: 2,
      moved: 1,
      skipped: 1,
      failed: 0,
    });
    expect(childId).toBeDefined();
  } finally {
    querySpy.mockRestore();
  }
  expect((await getTaskById(movedByUser.id))?.key).toBe("shared/research/");
  expect((await getTaskById(root.id))?.key).toBe(sessionSourceKey(root));
  expect((await getTaskById(childId!))?.key).toBe(sessionSourceKey(root));
});

test("a child whose parent moves after the parent read still inherits the moved key", async () => {
  const root = await seedTask(slack);
  const client = getDbClient();
  const transaction = client.transaction.bind(client);
  let backfilled = false;
  // The first transaction is the child's INSERT: the backfill commits first.
  const txSpy = spyOn(client, "transaction").mockImplementationOnce(async (fn, opts) => {
    txSpy.mockRestore();
    backfilled = true;
    expect(await runSessionSourceBackfill()).toMatchObject({ moved: 1, failed: 0 });
    return transaction(fn, opts);
  });
  let child: Awaited<ReturnType<typeof createTaskExtended>>;
  try {
    child = await createTaskExtended("Child", { parentTaskId: root.id });
  } finally {
    txSpy.mockRestore();
  }
  expect(backfilled).toBe(true);
  expect((await getTaskById(root.id))?.key).toBe(sessionSourceKey(root));
  expect(child.key).toBe(sessionSourceKey(root));
});

test("resumes after a committed cursor, including skipped roots, when afterBatch throws once", async () => {
  const roots = [
    await seedTask({
      id: "00000000-0000-4000-8000-000000000001",
      source: "chat",
      contextKey: chatSdkContextKey("teams:c:t"),
    }),
    await seedTask({ id: "00000000-0000-4000-8000-000000000002", ...slack }),
    await seedTask({ id: "00000000-0000-4000-8000-000000000003", ...slack }),
    await seedTask({ id: "00000000-0000-4000-8000-000000000004", ...slack }),
    await seedTask({ id: "00000000-0000-4000-8000-000000000005", ...slack }),
  ];
  let firstBatch: string[] = [];
  await expect(
    runSessionSourceBackfill({
      batchSize: 2,
      afterBatch: ({ ids }) => {
        firstBatch = ids;
        throw new Error("Interrupted after batch 1");
      },
    }),
  ).rejects.toThrow("Interrupted after batch 1");
  expect(firstBatch).toEqual(roots.slice(0, 2).map((r) => r.id));
  expect(await seedState(CURSOR_KEY)).toEqual({ seededHash: roots[1]!.id });
  expect(await seedState(DONE_KEY)).toBeNull();
  expect((await getTaskById(roots[1]!.id))?.key).toBe(sessionSourceKey(roots[1]!));
  expect((await getTaskById(roots[2]!.id))?.key).toBe(roots[2]!.key);
  const resumed: string[] = [];
  expect(
    await runSessionSourceBackfill({
      batchSize: 2,
      afterBatch: ({ ids }) => {
        resumed.push(...ids);
      },
    }),
  ).toEqual({ scanned: 3, moved: 3, skipped: 0, failed: 0 });
  expect(resumed).toEqual(roots.slice(2).map((r) => r.id));
  expect(await getTaskById(roots[0]!.id)).toEqual(roots[0]!);
  expect(await getDbClient().query("SELECT id FROM asset_key_history")).toHaveLength(4);
  expect(await seedState(DONE_KEY)).toEqual({ seededHash: "done" });
  expect(await seedState(CURSOR_KEY)).toBeNull();
});

test("a blocked audit warns without a marker or cursor, then retries successfully", async () => {
  const root = await seedTask(slack);
  const originalAudit = audit.auditAssetKeys;
  const auditSpy = spyOn(audit, "auditAssetKeys").mockImplementation((db) => ({
    ...originalAudit(db),
    ok: false,
    warningCount: 1,
  }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await runSessionSourceBackfill()).toBeNull();
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await seedState(DONE_KEY)).toBeNull();
    expect(await seedState(CURSOR_KEY)).toBeNull();
    expect(await getTaskById(root.id)).toEqual(root);
    expect(await getDbClient().query("SELECT id FROM asset_key_history")).toHaveLength(0);
  } finally {
    auditSpy.mockRestore();
    warn.mockRestore();
  }
  expect((await runSessionSourceBackfill())?.moved).toBe(1);
  expect(await seedState(DONE_KEY)).toEqual({ seededHash: "done" });
});

test("unexpected audit errors propagate without a marker", async () => {
  const auditSpy = spyOn(audit, "auditAssetKeys").mockImplementation(() => {
    throw new TypeError("Unexpected audit failure");
  });
  try {
    await expect(runSessionSourceBackfill()).rejects.toThrow("Unexpected audit failure");
    expect(await seedState(DONE_KEY)).toBeNull();
  } finally {
    auditSpy.mockRestore();
  }
});
