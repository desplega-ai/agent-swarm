import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import * as audit from "../be/asset-key-audit";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
  insertTaskAttachment,
  listRecentSessions,
  moveTaskChainKeyInTx,
  upsertInboxState,
} from "../be/db";
import * as sessionMoves from "../be/db/session-moves";
import { setSessionShares } from "../be/session-shares";
import * as assets from "../http/assets";
import { handleAssets } from "../http/assets";
import { SESSION_READ_DENIED } from "../http/session-access";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

let baseUrl: string;
let owner: string;
let other: string;
let agentId: string;
const server = createServer(async (req, res) => {
  try {
    const userId = req.headers["x-test-user"] as string | undefined;
    const agent = req.headers["x-agent-id"] as string | undefined;
    setRequestAuth(
      req,
      userId
        ? { kind: "user", userId }
        : agent
          ? {
              kind: "agent",
              agentId: agent,
              tokenKind: "agent",
              taskId: null,
              runtimeId: null,
              tokenId: "test-agent",
              expiresAt: "2099-01-01T00:00:00.000Z",
            }
          : { kind: "operator", fingerprint: "moves" },
    );
    const segments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    if (await handleSessions(req, res, segments, query, agent)) return;
    if (await handleAssets(req, res, segments, query, agent)) return;
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

beforeAll(async () => {
  initDb(":memory:");
  owner = (await createUser({ name: "Owner" })).id;
  other = (await createUser({ name: "Other" })).id;
  agentId = (await createAgent({ name: "Worker", isLead: false, status: "idle" })).id;
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

async function call(path: string, body: unknown, userId: string | null = owner, agent?: string) {
  const response = await fetch(`${baseUrl}/api/${path}`, {
    method: path.startsWith("assets/") ? "PATCH" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userId ? { "X-Test-User": userId } : {}),
      ...(agent ? { "X-Agent-ID": agent } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function session(key = "shared/original/", userId = owner) {
  const root = await createTaskExtended("root", { key, requestedByUserId: userId, agentId });
  const child = await createTaskExtended("child", { parentTaskId: root.id, agentId });
  const grandchild = await createTaskExtended("grandchild", { parentTaskId: child.id, agentId });
  return { root, child, grandchild };
}

async function share(root: { id: string; requestedByUserId?: string }, access: "read" | "write") {
  await setSessionShares(
    { id: root.id, requestedByUserId: root.requestedByUserId ?? null },
    { everyone: "none", users: [{ userId: owner, access }] },
    other,
  );
}

test("bulk moves every chain task and attachment mapping with history and preserves read state", async () => {
  const { root, child, grandchild } = await session();
  const attachment = await insertTaskAttachment({
    taskId: child.id,
    kind: "agent-fs",
    name: "notes",
    path: `moves/${child.id}`,
    providerId: "agent-fs",
    providerKey: `moves/${child.id}`,
  });
  await upsertInboxState({
    userId: owner,
    itemType: "to_read",
    itemId: root.id,
    status: "open",
    lastReadAt: grandchild.lastUpdatedAt,
  });
  const before = await listRecentSessions({ viewer: { userId: owner, scope: "all" } });
  const auditSpy = spyOn(audit, "auditAssetKeys");
  try {
    const result = await call("session-moves", {
      rootTaskIds: [root.id, root.id],
      groupKey: "shared/moved/",
    });
    expect(result).toEqual({ status: 200, body: { moved: [root.id], skipped: [] } });
    expect(auditSpy).toHaveBeenCalledTimes(1);
  } finally {
    auditSpy.mockRestore();
  }
  for (const task of [root, child, grandchild]) {
    const updated = await getTaskById(task.id);
    expect(updated?.key).toBe("shared/moved/");
    expect(updated?.lastUpdatedAt).toBe(task.lastUpdatedAt);
  }
  expect(
    await getDbClient().query(
      "SELECT entity_id FROM asset_key_history WHERE entity_type = 'task' AND entity_id IN (?, ?, ?)",
      [root.id, child.id, grandchild.id],
    ),
  ).toHaveLength(3);
  const mapping = await getDbClient().get<{ id: string; key: string }>(
    "SELECT id, key FROM asset_key_mappings WHERE source_entity_id = ?",
    [attachment.id],
  );
  expect(mapping?.key).toBe("shared/moved/");
  expect(
    await getDbClient().query(
      "SELECT id FROM asset_key_history WHERE entity_type = 'file' AND entity_id = ? AND new_key = 'shared/moved/'",
      [mapping!.id],
    ),
  ).toHaveLength(1);
  const after = await listRecentSessions({ viewer: { userId: owner, scope: "all" } });
  expect(after.find((s) => s.root.id === root.id)?.readState).toBe(
    before.find((s) => s.root.id === root.id)?.readState,
  );
  expect(
    (await call("session-moves", { rootTaskIds: [root.id], groupKey: "shared/moved/" })).body.moved,
  ).toEqual([]);
  expect(
    (await call("session-moves", { rootTaskIds: [root.id], groupKey: null })).body.moved,
  ).toEqual([root.id]);
  for (const id of [root.id, child.id, grandchild.id])
    expect((await getTaskById(id))?.key).toBe(`shared/task:${root.id}/`);
});

test("bulk skips missing, non-root, read-only and private roots while moving owned and write-shared roots", async () => {
  const own = await session();
  const read = await session(undefined, other);
  const write = await session(undefined, other);
  const hidden = await session(undefined, other);
  await share(read.root, "read");
  await share(write.root, "write");
  const result = await call("session-moves", {
    rootTaskIds: [
      own.root.id,
      read.root.id,
      write.root.id,
      hidden.root.id,
      own.child.id,
      "missing",
    ],
    groupKey: "shared/mixed/",
  });
  expect(result.status).toBe(200);
  expect(result.body.moved).toEqual([own.root.id, write.root.id]);
  expect(result.body.skipped.map((s: { rootTaskId: string }) => s.rootTaskId)).toEqual([
    read.root.id,
    hidden.root.id,
    own.child.id,
    "missing",
  ]);
  expect(result.body.skipped.every((s: { reason: string }) => s.reason.length > 0)).toBe(true);
  expect((await getTaskById(read.root.id))?.key).toBe(read.root.key);
});

test("personal destination authorization rejects the request before any root moves", async () => {
  const { root } = await session();
  for (const body of [
    { rootTaskIds: [root.id], groupKey: `personal/${other}/group/` },
    { from: "shared/original/", to: `personal/${other}/group/` },
  ]) {
    expect((await call(`session-moves${"from" in body ? "/prefix" : ""}`, body)).status).toBe(403);
  }
  expect((await getTaskById(root.id))?.key).toBe(root.key);
  expect(
    (await call("session-moves", { rootTaskIds: [root.id], groupKey: `personal/${owner}/group/` }))
      .status,
  ).toBe(200);
});

test("a denied descendant prevents the entire chain move and does not count as remaining", async () => {
  const denied = await session("shared/permission/");
  const allowed = await session("shared/permission/");
  const stranger = await createAgent({ name: "Stranger", isLead: false, status: "idle" });
  await getDbClient().run("UPDATE agent_tasks SET agentId = ? WHERE id = ?", [
    stranger.id,
    denied.child.id,
  ]);
  const bulk = await call(
    "session-moves",
    {
      rootTaskIds: [denied.root.id, allowed.root.id],
      groupKey: "shared/allowed/",
    },
    null,
    agentId,
  );
  expect(bulk.status).toBe(200);
  expect(bulk.body.moved).toEqual([allowed.root.id]);
  expect(bulk.body.skipped).toEqual([
    { rootTaskId: denied.root.id, reason: "Not authorized to move this task namespace" },
  ]);
  const prefix = await call(
    "session-moves/prefix",
    {
      from: "shared/permission/",
      to: "shared/allowed/",
    },
    null,
    agentId,
  );
  expect(prefix.status).toBe(200);
  expect(prefix.body.moved).toEqual([]);
  expect(prefix.body.remaining).toBe(0);
  expect(prefix.body.skipped).toHaveLength(1);
  expect((await getTaskById(denied.root.id))?.key).toBe(denied.root.key);
});

test("prefix rename preserves subgroups and skips shared sessions without exposing private roots", async () => {
  const own = await session("shared/rename/b/");
  const shared = await session("shared/rename/b/", other);
  const hidden = await session("shared/rename/b/", other);
  await share(shared.root, "write");
  const result = await call("session-moves/prefix", {
    from: "shared/rename/",
    to: "shared/renamed/",
  });
  expect(result.status).toBe(200);
  expect(result.body.moved).toEqual([own.root.id]);
  expect(result.body.skipped).toEqual([{ rootTaskId: shared.root.id, reason: expect.any(String) }]);
  expect(result.body.remaining).toBe(0);
  expect((await getTaskById(own.grandchild.id))?.key).toBe("shared/renamed/b/");
  expect((await getTaskById(hidden.root.id))?.key).toBe(hidden.root.key);
  expect(
    (await call("session-moves/prefix", { from: "shared/rename/", to: "shared/renamed/" })).body
      .moved,
  ).toEqual([]);
  expect(
    (await call("session-moves/prefix", { from: "shared/renamed/", to: null })).body.moved,
  ).toEqual([own.root.id]);
  expect((await getTaskById(own.root.id))?.key).toBe(`shared/task:${own.root.id}/`);
});

test("user prefix moves exclude ownerless roots and report only visible roots owned by others", async () => {
  for (const from of ["shared/requester/", `personal/${other}/requester/`]) {
    const own = await session(`${from}nested/`);
    const ownerless = await createTaskExtended("ownerless", { key: `${from}nested/` });
    const shared = await session(`${from}nested/`, other);
    const privateRoot = await session(`${from}nested/`, other);
    await share(shared.root, "write");
    const checked: string[] = [];
    const original = assets.canMutateTaskNamespace;
    const checks = spyOn(assets, "canMutateTaskNamespace").mockImplementation(async (...args) => {
      checked.push(args[0].id);
      return original(...args);
    });
    try {
      const result = await call("session-moves/prefix", { from, to: "shared/requester-moved/" });
      expect(result).toEqual({
        status: 200,
        body: {
          moved: [own.root.id],
          remaining: 0,
          skipped: [
            { rootTaskId: shared.root.id, reason: "Only the session owner can move this group" },
          ],
        },
      });
      expect(checked.sort()).toEqual([own.root.id, own.child.id, own.grandchild.id].sort());
      expect((await getTaskById(ownerless.id))?.key).toBe(ownerless.key);
      expect((await getTaskById(privateRoot.root.id))?.key).toBe(privateRoot.root.key);
      const deleted = await call("session-moves/prefix", { from, to: null });
      expect(deleted.body.moved).toEqual([]);
      expect(deleted.body.skipped).toHaveLength(1);
      expect((await getTaskById(ownerless.id))?.key).toBe(ownerless.key);
    } finally {
      checks.mockRestore();
    }
    const bypass = await call("session-moves/prefix", { from, to: null }, null);
    expect(bypass.status).toBe(200);
    expect(bypass.body.moved.sort()).toEqual(
      [ownerless.id, shared.root.id, privateRoot.root.id].sort(),
    );
    expect(bypass.body.skipped).toEqual([]);
  }
});

test("owned roots denied task mutation are skipped without remaining work", async () => {
  const { root } = await session("shared/owned-denied/");
  const checks = spyOn(assets, "canMutateTaskNamespace").mockResolvedValue(false);
  try {
    const result = await call("session-moves/prefix", {
      from: root.key,
      to: "shared/owned-allowed/",
    });
    expect(result).toEqual({
      status: 200,
      body: {
        moved: [],
        remaining: 0,
        skipped: [{ rootTaskId: root.id, reason: "Not authorized to move this task namespace" }],
      },
    });
  } finally {
    checks.mockRestore();
  }
});

test("prefix skips replacement keys that remain in the source group", async () => {
  const { root } = await session("shared/p/q/q/");
  const move = { from: "shared/p/q/", to: "shared/p/" };
  for (let i = 0; i < 2; i++) {
    expect(await call("session-moves/prefix", move)).toEqual({
      status: 200,
      body: {
        moved: [],
        remaining: 0,
        skipped: [{ rootTaskId: root.id, reason: "The new key stays inside the source group" }],
      },
    });
    expect((await getTaskById(root.id))?.key).toBe(root.key);
  }
});

test("bulk cannot distinguish missing roots from inaccessible roots or children", async () => {
  const hidden = await session(undefined, other);
  const own = await session();
  const result = await call("session-moves", {
    rootTaskIds: ["absent", hidden.root.id, hidden.child.id, own.child.id],
    groupKey: null,
  });
  expect(result.status).toBe(200);
  const reasons = result.body.skipped.map((row: { reason: string }) => row.reason);
  expect(reasons[0]).toBe("Session not found or not accessible");
  expect(reasons.slice(0, 3)).toEqual(Array(3).fill(reasons[0]));
  expect(reasons[3]).toBe("Task is not a session root");
});

test("unexpected move errors propagate as 500 even when their message contains blocked until", async () => {
  const { root } = await session("shared/unexpected/");
  const failure = spyOn(audit, "auditAssetKeys").mockImplementation(() => {
    throw new TypeError("unexpected blocked until failure");
  });
  try {
    for (const [path, body] of [
      ["session-moves", { rootTaskIds: [root.id], groupKey: null }],
      ["session-moves/prefix", { from: root.key, to: null }],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-User": owner },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("TypeError: unexpected blocked until failure");
    }
  } finally {
    failure.mockRestore();
  }
});

test("task chain move requires an active transaction", async () => {
  await expect(moveTaskChainKeyInTx("unknown", [], "shared/transaction/")).rejects.toThrow(
    "moveTaskChainKeyInTx requires an active transaction",
  );
});

test("unexpected prefix scan errors propagate as 500", async () => {
  const scan = spyOn(sessionMoves, "listPrefixRoots").mockRejectedValue(new Error("SQLITE_BUSY"));
  try {
    const response = await fetch(`${baseUrl}/api/session-moves/prefix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": owner },
      body: JSON.stringify({ from: "shared/unexpected/", to: null }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("SQLITE_BUSY");
  } finally {
    scan.mockRestore();
  }
});

test("prefix rejects namespace roots and destinations inside the source", async () => {
  for (const from of ["shared/", `personal/${owner}/`]) {
    expect((await call("session-moves/prefix", { from, to: null })).status).toBe(400);
  }
  for (const to of ["shared/a/", "shared/a/b/"]) {
    expect((await call("session-moves/prefix", { from: "shared/a/", to })).status).toBe(400);
  }
  expect((await call("session-moves", { rootTaskIds: [], groupKey: null })).status).toBe(400);
  expect(
    (await call("session-moves", { rootTaskIds: Array(201).fill("id"), groupKey: null })).status,
  ).toBe(400);
});

test("prefix normalizes the source before validation and suffix replacement", async () => {
  const { root } = await session("shared/canonical/b/");
  for (const from of ["SHARED/CANONICAL", "shared/ｃanonical/"]) {
    expect(
      (await call("session-moves/prefix", { from, to: "shared/canonical/nested/" })).status,
    ).toBe(400);
  }
  const result = await call("session-moves/prefix", {
    from: "SHARED/CANONICAL",
    to: "shared/normalized/",
  });
  expect(result.status).toBe(200);
  expect(result.body.moved).toEqual([root.id]);
  expect((await getTaskById(root.id))?.key).toBe("shared/normalized/b/");
});

test("prefix skips overlong results and excludes them from remaining", async () => {
  const { root } = await session(`shared/long/${"x".repeat(120)}/`);
  const result = await call("session-moves/prefix", {
    from: "shared/long/",
    to: `shared/${"y".repeat(140)}/`,
  });
  expect(result).toEqual({
    status: 200,
    body: {
      moved: [],
      skipped: [{ rootTaskId: root.id, reason: "Asset key cannot exceed 255 characters" }],
      remaining: 0,
    },
  });
});

test("prefix pages past skipped roots and reaches zero with skipped roots remaining", async () => {
  const skipped: string[] = [];
  await getDbClient().transaction(async () => {
    for (let i = 0; i < 201; i++) {
      const root = await createTaskExtended("shared", {
        key: "shared/paging/",
        requestedByUserId: other,
      });
      skipped.push(root.id);
      await share(root, "write");
    }
    for (let i = 0; i < 201; i++)
      await createTaskExtended("owned", { key: "shared/paging/", requestedByUserId: owner });
  });
  const first = await call("session-moves/prefix", { from: "shared/paging/", to: "shared/paged/" });
  expect(first.status).toBe(200);
  expect(first.body.moved).toHaveLength(200);
  expect(first.body.skipped).toHaveLength(201);
  expect(first.body.remaining).toBe(1);
  const second = await call("session-moves/prefix", {
    from: "shared/paging/",
    to: "shared/paged/",
  });
  expect(second.body.moved).toHaveLength(1);
  expect(second.body.remaining).toBe(0);
  const repeated = await call("session-moves/prefix", {
    from: "shared/paging/",
    to: "shared/paged/",
  });
  expect(repeated.body.moved).toEqual([]);
  expect(repeated.body.remaining).toBe(0);
  expect(repeated.body.skipped).toHaveLength(skipped.length);
});

test("audit warnings block all moves with the existing message and one audit per request", async () => {
  const first = await session("shared/audit/");
  const second = await session("shared/audit/");
  const originalAudit = audit.auditAssetKeys;
  const auditSpy = spyOn(audit, "auditAssetKeys").mockImplementation((db) => ({
    ...originalAudit(db),
    ok: false,
    warningCount: 1,
  }));
  const prefixScan = spyOn(sessionMoves, "listPrefixRoots");
  const sharedScan = spyOn(sessionMoves, "listSharedPrefixRoots");
  try {
    for (const body of [
      { rootTaskIds: [first.root.id, second.root.id], groupKey: "shared/blocked/" },
      { from: "shared/audit/", to: "shared/blocked/" },
    ]) {
      auditSpy.mockClear();
      const result = await call(`session-moves${"from" in body ? "/prefix" : ""}`, body);
      expect(result.status).toBe(409);
      expect(result.body.error).toBe(
        "Asset namespace moves are blocked until structural errors, unknown personal users, or provider mapping drift are repaired.",
      );
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(prefixScan).not.toHaveBeenCalled();
      expect(sharedScan).not.toHaveBeenCalled();
      expect((await getTaskById(first.root.id))?.key).toBe(first.root.key);
    }
  } finally {
    auditSpy.mockRestore();
    prefixScan.mockRestore();
    sharedScan.mockRestore();
  }
});

test("old route gives the standard denial for inaccessible sessions and 404 for missing assets", async () => {
  const { root, child } = await session(undefined, other);
  for (const cascade of [false, true]) {
    for (const id of [root.id, child.id]) {
      expect(await call(`assets/task/${id}/key`, { key: "shared/hidden/", cascade })).toEqual({
        status: 403,
        body: { error: SESSION_READ_DENIED },
      });
    }
    expect(await call("assets/task/unknown/key", { key: "shared/missing/", cascade })).toEqual({
      status: 404,
      body: { error: "Asset not found" },
    });
  }
});

test("old route denies read-only sharees with and without cascade and admits writers, owners, agents and bypass operators", async () => {
  const { root, child } = await session(undefined, other);
  await share(root, "read");
  for (const cascade of [false, true]) {
    for (const id of [root.id, child.id]) {
      const result = await call(`assets/task/${id}/key`, { key: "shared/denied/", cascade });
      expect(result).toEqual({
        status: 403,
        body: { error: "You can view this session but not move it." },
      });
    }
  }
  await share(root, "write");
  expect(
    (await call(`assets/task/${root.id}/key`, { key: "shared/writer/", cascade: true })).status,
  ).toBe(200);
  expect((await call(`assets/task/${root.id}/key`, { key: "shared/owner/" }, other)).status).toBe(
    200,
  );
  expect(
    (
      await call(
        `assets/task/${root.id}/key`,
        { key: "shared/agent/", cascade: true },
        null,
        agentId,
      )
    ).status,
  ).toBe(200);
  expect((await call(`assets/task/${root.id}/key`, { key: "shared/operator/" }, null)).status).toBe(
    200,
  );
});
