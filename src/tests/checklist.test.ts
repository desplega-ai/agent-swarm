import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { Readable } from "node:stream";
import {
  type ChecklistActor,
  firstOpenItem,
  listChecklist,
  markNudged,
  mutateChecklist,
  userGrantCanEditSwarm,
} from "../be/checklist";
import { closeDb, createAgent, createUser, getDb, getDbClient, initDb } from "../be/db";
import { getSessionReadState, triageSessionList } from "../be/db/session-tree";
import { deleteOAuthTokens, storeOAuthTokens, upsertOAuthApp } from "../be/db-queries/oauth";
import { runMigrations } from "../be/migrations/runner";
import { attachRole, detachRole } from "../be/rbac-roles";
import { handleChecklist } from "../http/checklist";
import { getPathSegments, parseQueryParams } from "../http/utils";
import * as chatRuntime from "../integrations/chat-sdk/runtime";
import type { ChecklistItem } from "../types";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { setRequestAuth } from "../utils/request-auth-context";

const dbPath = "./test-checklist.sqlite";
const envKeys = [
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_DISABLE",
  "SLACK_TRANSPORT",
  "RBAC_ENABLED",
  "CHAT_SDK_ADAPTERS",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let auth: HttpRequestAuth;
let userId: string;
let actor: ChecklistActor;
let healthSpy: ReturnType<typeof spyOn<typeof chatRuntime, "getChatSdkHealth">>;

async function api(method: string, path = "/api/checklist", body?: unknown, agentId?: string) {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = path;
  req.headers = {
    "content-type": "application/json",
    ...(agentId ? { "x-agent-id": agentId } : {}),
  };
  setRequestAuth(req, auth);
  let status = 200;
  let responseBody = "";
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      responseBody += chunk ?? "";
    },
  };
  await handleChecklist(req, res as never, getPathSegments(path), parseQueryParams(path), agentId);
  return {
    status,
    body: JSON.parse(responseBody) as {
      items: ChecklistItem[];
      item: ChecklistItem;
      canEditSwarm: boolean;
      error?: string;
    },
  };
}

const item = async (kind: ChecklistItem["kind"], id = userId) =>
  (await listChecklist(id)).find((entry) => entry.kind === kind)!;

async function root(key: string, read = false, owner = userId, parentTaskId: string | null = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO agent_tasks (id, task, status, source, "key", requestedByUserId, parentTaskId, createdAt, lastUpdatedAt)
     VALUES (?, 'Checklist use case', 'completed', 'ui', ?, ?, ?, ?, ?)`,
    [id, key, owner, parentTaskId, now, now],
  );
  if (read) await triageSessionList(owner, { groupKey: key }, "read");
  return id;
}

async function asset(
  table: "pages" | "workflows" | "scheduled_tasks",
  key: string,
  creator = userId,
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (table === "pages") {
    await getDbClient().run(
      `INSERT INTO pages (id, agentId, slug, title, contentType, body, "key", created_by, createdAt)
       VALUES (?, ?, ?, 'Checklist page', 'text/html', '<p>Test</p>', ?, ?, ?)`,
      [id, crypto.randomUUID(), id, key, creator, now],
    );
  } else if (table === "workflows") {
    await getDbClient().run(
      `INSERT INTO workflows (id, name, definition, "key", created_by, createdAt)
       VALUES (?, ?, '{"nodes":[]}', ?, ?, ?)`,
      [id, id, key, creator, now],
    );
  } else {
    await getDbClient().run(
      `INSERT INTO scheduled_tasks (id, name, intervalMs, taskTemplate, "key", created_by, createdAt, lastUpdatedAt)
       VALUES (?, ?, 60000, 'Test', ?, ?, ?, ?)`,
      [id, id, key, creator, now, now],
    );
  }
  return id;
}

beforeAll(() => {
  initDb(dbPath);
});

beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  process.env.SLACK_DISABLE = "true";
  process.env.RBAC_ENABLED = "true";
  await getDbClient().run("DELETE FROM checklist_items");
  await getDbClient().run("DELETE FROM oauth_authorizations");
  const user = await createUser({ name: "Checklist User" });
  userId = user.id;
  auth = { kind: "user", userId, user };
  actor = { id: userId, userId, canEditSwarm: true };
  delete process.env.CHAT_SDK_ADAPTERS;
  healthSpy = spyOn(chatRuntime, "getChatSdkHealth").mockReturnValue({});
});

afterEach(() => {
  healthSpy.mockRestore();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
});

describe("checklist defaults and signals", () => {
  test("reads merge the defaults without writing, writes store them, and changes are kept", async () => {
    await asset("pages", "shared/existing/");
    const other = await createUser({ name: "Unread checklist" });
    const run = spyOn(getDbClient(), "run");
    const transaction = spyOn(getDbClient(), "transaction");
    let results: ChecklistItem[][];
    try {
      results = await Promise.all([
        listChecklist(userId),
        listChecklist(userId),
        listChecklist(null),
        firstOpenItem(userId, true).then((first) => (first ? [first] : [])),
      ]);
      expect(run).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
      transaction.mockRestore();
    }
    expect(results[0].map((row) => row.id)).toEqual([
      "swarm:channel",
      "swarm:tool",
      `user:${userId}:use_case`,
    ]);
    expect(results[2]).toHaveLength(2);
    expect(await getDbClient().get("SELECT COUNT(*) AS n FROM checklist_items")).toEqual({ n: 0 });
    await mutateChecklist(actor, { action: "remove", id: "swarm:tool", reason: "Later" });
    expect((await item("tool")).status).toBe("removed");
    expect(await listChecklist(userId)).toHaveLength(3);
    expect((await listChecklist(other.id)).filter((row) => row.scope === "user")).toHaveLength(1);
  });

  test("migration 302 applies to a populated database and lists the defaults on its first read", async () => {
    const pageId = await asset("pages", "shared/pre-checklist/");
    await getDbClient().run("DROP TABLE checklist_items");
    await getDbClient().run("DELETE FROM _migrations WHERE version = 302");
    runMigrations(getDb());
    expect(await getDbClient().get("SELECT id FROM pages WHERE id = ?", [pageId])).toEqual({
      id: pageId,
    });
    expect(await listChecklist(userId)).toHaveLength(3);
  });

  test("Slack configuration checks the channel without checking tools", async () => {
    expect((await item("channel")).signal).toBe(false);
    process.env.SLACK_DISABLE = "false";
    process.env.SLACK_BOT_TOKEN = "xoxb-checklist-fixture";
    process.env.SLACK_APP_TOKEN = "xapp-checklist-fixture";
    expect((await item("channel")).signal).toBe(true);
    expect((await item("tool")).signal).toBe(false);
  });

  test("channel adapters require configured, enabled, healthy status and respect meta.adapter", async () => {
    const targeted = await mutateChecklist(actor, {
      action: "add",
      scope: "swarm",
      kind: "channel",
      label: "Telegram",
      meta: { adapter: "telegram" },
    });
    const slack = await mutateChecklist(actor, {
      action: "add",
      scope: "swarm",
      kind: "channel",
      label: "Slack",
      meta: { adapter: "slack" },
    });
    const ok = { status: "ok" } as chatRuntime.ChatAdapterHealth;
    const cases: [
      Record<string, unknown>,
      Record<string, chatRuntime.ChatAdapterHealth>,
      boolean,
    ][] = [
      [{}, { telegram: ok }, false], // not configured
      [{ telegram: { enabled: false } }, { telegram: ok }, false], // turned off
      [{ telegram: {} }, { telegram: { ...ok, status: "error" } }, false], // unhealthy
      [{ telegram: {} }, {}, false], // not started
      [{ telegram: {} }, { telegram: ok }, true],
    ];
    for (const [adapters, health, expected] of cases) {
      process.env.CHAT_SDK_ADAPTERS = JSON.stringify(adapters);
      healthSpy.mockReturnValue(health);
      const items = await listChecklist(userId);
      expect(items.find((row) => row.id === targeted.id)?.signal).toBe(expected);
      expect(items.find((row) => row.id === slack.id)?.signal).toBe(false);
      expect(items.find((row) => row.id === "swarm:channel")?.signal).toBe(expected);
    }
    process.env.SLACK_DISABLE = "false";
    process.env.SLACK_BOT_TOKEN = "xoxb-checklist-fixture";
    process.env.SLACK_APP_TOKEN = "xapp-checklist-fixture";
    expect((await listChecklist(userId)).find((row) => row.id === slack.id)?.signal).toBe(true);
  });

  test.each([
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "BITBUCKET_TOKEN",
  ])("tool uses the %s flag", async (key) => {
    expect((await item("tool")).signal).toBe(false);
    process.env[key] = "fixture-token";
    expect(await item("tool")).toMatchObject({ signal: true, done: true, status: "open" });
  });

  test.each(["google", "microsoft"])("tool uses stored %s OAuth tokens", async (provider) => {
    expect((await item("tool")).signal).toBe(false);
    await upsertOAuthApp(provider, {
      clientId: "fixture",
      clientSecret: "fixture-secret",
      authorizeUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      redirectUri: "https://example.com/callback",
      scopes: "test",
    });
    await storeOAuthTokens(provider, { accessToken: "checklist-fixture-token", expiresAt: null });
    expect((await item("tool")).signal).toBe(true);
    await deleteOAuthTokens(provider);
    expect((await item("tool")).signal).toBe(false);
  });

  test.each([
    "pages",
    "workflows",
    "scheduled_tasks",
  ] as const)("use_case needs a %s asset and a read root below its group", async (table) => {
    const key = `shared/checklist-${crypto.randomUUID()}/`;
    await asset(table, key);
    expect((await item("use_case")).signal).toBe(false);
    const rootId = await root(`${key}task:${crypto.randomUUID()}/`);
    expect((await item("use_case")).signal).toBe(false);
    await triageSessionList(userId, { groupKey: key }, "read");
    expect((await getSessionReadState(rootId, userId))?.readState).toBe("read");
    expect(await item("use_case")).toMatchObject({ signal: true, done: true });
    await triageSessionList(userId, { groupKey: key }, "done");
    expect((await item("use_case")).signal).toBe(false);
  });

  test("a read task alone, another user's asset, and an asset under another prefix do not count", async () => {
    const key = `shared/checklist-${crypto.randomUUID()}/`;
    await root(key, true);
    expect((await item("use_case")).signal).toBe(false);
    const other = await createUser({ name: "Other creator" });
    await asset("pages", key, other.id);
    expect((await item("use_case")).signal).toBe(false);
    await asset("pages", `${key.slice(0, -1)}-else/`);
    expect((await item("use_case")).signal).toBe(false);
  });

  test("one read group counts behind 100 newer non-group keys, and done items skip the check", async () => {
    const key = `shared/checklist-${crypto.randomUUID()}/`;
    await asset("pages", key);
    await root(`${key}task:${crypto.randomUUID()}/`, true);
    await getDbClient().run("UPDATE pages SET createdAt = '2000-01-01T00:00:00.000Z'");
    for (let i = 0; i < 101; i++) await asset("pages", `shared/page:${crypto.randomUUID()}/`);
    expect((await item("use_case")).signal).toBe(true);
    const actorItem = `user:${userId}:use_case`;
    await mutateChecklist(actor, { action: "done", id: actorItem });
    const query = spyOn(getDbClient(), "query");
    try {
      expect(await item("use_case")).toMatchObject({ status: "done", done: true, signal: null });
      // Only the checklist rows are read: no asset scan for a done use case.
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });

  test("a stored meta that is not a JSON object reads as no meta", async () => {
    for (const [index, raw] of ["{not json", "[1,2]", '"text"'].entries()) {
      await getDbClient().run(
        `INSERT INTO checklist_items (id, scope, kind, label, meta, sortOrder)
         VALUES (?, 'swarm', 'channel', 'Broken', ?, ?)`,
        [`broken-${index}`, raw, 10 + index],
      );
    }
    const response = await api("GET");
    expect(response.status).toBe(200);
    expect(
      response.body.items.filter((row) => row.id.startsWith("broken-")).map((row) => row.meta),
    ).toEqual([null, null, null]);
  });

  test("namespace roots and resource leaves do not count as group keys", async () => {
    for (const key of ["shared/", `shared/page:${crypto.randomUUID()}/`]) {
      await asset("pages", key);
      await root(key, true);
    }
    expect((await item("use_case")).signal).toBe(false);
  });
});

describe("checklist ownership and mutations", () => {
  test("a member cannot change swarm items, an admin can, and editable matches permissions", async () => {
    await detachRole(userId, "admin");
    await attachRole(userId, "requester");
    let response = await api("GET");
    expect(response.body.canEditSwarm).toBe(false);
    expect(response.body.items.map((row) => row.editable)).toEqual([false, false, true]);
    for (const action of ["remove", "restore", "done", "reorder"]) {
      expect(
        (await api("PATCH", "/api/checklist/items/swarm:channel", { action, sortOrder: 1 })).status,
      ).toBe(403);
    }
    expect(
      (
        await api("POST", "/api/checklist/items", {
          scope: "swarm",
          kind: "custom",
          label: "Denied",
        })
      ).status,
    ).toBe(403);
    await attachRole(userId, "admin");
    response = await api("PATCH", "/api/checklist/items/swarm:channel", {
      action: "remove",
      reason: "No chat needed",
    });
    expect(response.status).toBe(200);
    expect(response.body.item).toMatchObject({
      status: "removed",
      statusChangedBy: userId,
      statusChangedByName: "Checklist User",
      statusReason: "No chat needed",
      editable: true,
    });
    expect(response.body.item.statusChangedAt).toBeString();
    expect((await api("GET")).body.canEditSwarm).toBe(true);
  });

  test("remove, done and restore record the actor and reason, and preserve audit fields", async () => {
    const id = `user:${userId}:use_case`;
    await api("GET");
    for (const action of ["remove", "done"]) {
      const response = await api("PATCH", `/api/checklist/items/${id}`, {
        action,
        reason: `Reason for ${action}`,
      });
      expect(response.status).toBe(200);
      expect(response.body.item).toMatchObject({
        status: action === "remove" ? "removed" : "done",
        statusChangedBy: userId,
        statusReason: `Reason for ${action}`,
      });
    }
    const restored = await api("PATCH", `/api/checklist/items/${id}`, {
      action: "restore",
      reason: "Ignored",
    });
    expect(restored.body.item).toMatchObject({
      status: "open",
      statusReason: null,
      statusChangedBy: userId,
      done: false,
    });
    expect(
      await getDbClient().get("SELECT created_by, updated_by FROM checklist_items WHERE id = ?", [
        id,
      ]),
    ).toEqual({ created_by: userId, updated_by: userId });
  });

  test("labels and reasons are scrubbed before they are stored, and encoded ids resolve", async () => {
    const secret = `ghp_${"gH4".repeat(12)}`;
    const added = await api("POST", "/api/checklist/items", {
      scope: "user",
      kind: "custom",
      label: `Rotate ${secret}`,
    });
    expect(added.status).toBe(201);
    const id = added.body.item.id as string;
    const removed = await api("PATCH", `/api/checklist/items/${encodeURIComponent(id)}`, {
      action: "remove",
      reason: `Leaked ${secret}`,
    });
    expect(removed.status).toBe(200);
    const row = await getDbClient().get<{ label: string; statusReason: string }>(
      "SELECT label, statusReason FROM checklist_items WHERE id = ?",
      [id],
    );
    expect(row?.label).not.toContain(secret);
    expect(row?.statusReason).not.toContain(secret);
    const encoded = await api(
      "PATCH",
      `/api/checklist/items/${encodeURIComponent(`user:${userId}:use_case`)}`,
      { action: "done" },
    );
    expect(encoded.status).toBe(200);
  });

  test("other users cannot edit user items even as admins, and unknown ids return 404", async () => {
    const other = await createUser({ name: "Other owner" });
    const otherItem = `/api/checklist/items/user:${other.id}:use_case`;
    // Not stored yet: another user's default reads as unknown.
    expect((await api("PATCH", otherItem, { action: "remove" })).status).toBe(404);
    await mutateChecklist(
      { id: other.id, userId: other.id, canEditSwarm: false },
      { action: "restore", id: `user:${other.id}:use_case` },
    );
    expect((await api("PATCH", otherItem, { action: "remove" })).status).toBe(403);
    expect(
      (await api("PATCH", `/api/checklist/items/${crypto.randomUUID()}`, { action: "done" }))
        .status,
    ).toBe(404);
    expect((await api("GET")).body.items.some((row) => row.userId === other.id)).toBe(false);
  });

  test("custom items have no signal, use per-list ordering, and validate requests", async () => {
    const added = await api("POST", "/api/checklist/items", {
      scope: "user",
      kind: "custom",
      label: "Review the plan",
      href: "/sessions",
      meta: { note: "Review" },
    });
    expect(added.status).toBe(201);
    const custom = added.body.item;
    expect(custom).toMatchObject({
      userId,
      scope: "user",
      signal: null,
      done: false,
      sortOrder: 3,
      meta: { note: "Review" },
    });
    const done = await api("PATCH", `/api/checklist/items/${custom.id}`, {
      action: "done",
      reason: "Reviewed",
    });
    expect(done.body.item).toMatchObject({ done: true, signal: null, statusReason: "Reviewed" });
    const reordered = await api("PATCH", `/api/checklist/items/${custom.id}`, {
      action: "reorder",
      sortOrder: -1,
    });
    expect(reordered.body.item.sortOrder).toBe(-1);
    expect((await api("GET")).body.items[0].id).toBe(custom.id);
    expect(
      (await api("PATCH", `/api/checklist/items/${custom.id}`, { action: "reorder" })).status,
    ).toBe(400);
    expect(
      (
        await api("PATCH", `/api/checklist/items/${custom.id}`, {
          action: "done",
          reason: "x".repeat(501),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("POST", "/api/checklist/items", {
          scope: "user",
          kind: "custom",
          label: "x".repeat(201),
        })
      ).status,
    ).toBe(400);
  });

  test("a second open item for the same adapter is refused, and meta is capped", async () => {
    const telegram = {
      scope: "swarm",
      kind: "channel",
      label: "Connect Telegram",
      meta: { adapter: "telegram" },
    };
    const first = await api("POST", "/api/checklist/items", telegram);
    expect(first.status).toBe(201);
    const second = await api("POST", "/api/checklist/items", telegram);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("telegram");
    expect(
      (await api("POST", "/api/checklist/items", { ...telegram, meta: { adapter: "discord" } }))
        .status,
    ).toBe(201);
    await api("PATCH", `/api/checklist/items/${first.body.item.id}`, { action: "remove" });
    expect((await api("POST", "/api/checklist/items", telegram)).status).toBe(201);
    for (const meta of [{ adapter: 42 }, { note: "x".repeat(1100) }]) {
      expect((await api("POST", "/api/checklist/items", { ...telegram, meta })).status).toBe(400);
    }
  });

  test("with RBAC off, role rows do not decide swarm edits: the legacy policy does", async () => {
    await attachRole(userId, "admin");
    expect((await api("GET")).body.canEditSwarm).toBe(true);
    process.env.RBAC_ENABLED = "false";
    // The admin role row stays, but a user token is no Lead under the legacy policy.
    expect((await api("GET")).body.canEditSwarm).toBe(false);
    auth = { kind: "operator", fingerprint: "op:checklist" };
    expect((await api("GET")).body.canEditSwarm).toBe(true);
  });

  test("the checklist nudge honors RBAC off like the route: the Lead may edit swarm items", async () => {
    await attachRole(userId, "admin");
    expect(await userGrantCanEditSwarm(userId)).toBe(true);
    process.env.RBAC_ENABLED = "false";
    expect(await userGrantCanEditSwarm(userId)).toBeNull();
  });

  test("unstored defaults serialize the same on every read", async () => {
    const first = await listChecklist(userId);
    await Bun.sleep(5);
    expect(await listChecklist(userId)).toEqual(first);
  });

  test("operator without a user sees swarm items, but cannot create user items", async () => {
    auth = { kind: "operator", fingerprint: "op:checklist" };
    const response = await api("GET");
    expect(response.body.items).toHaveLength(2);
    expect(response.body.canEditSwarm).toBe(true);
    expect(
      (
        await api("POST", "/api/checklist/items", {
          scope: "user",
          kind: "custom",
          label: "No user",
        })
      ).status,
    ).toBe(400);
  });

  test("agent actions use the task owner and record Lead attribution", async () => {
    const agentId = crypto.randomUUID();
    await createAgent({ id: agentId, name: "Checklist Lead", isLead: true, status: "idle" });
    const taskId = await root(`shared/checklist-${crypto.randomUUID()}/`);
    await getDbClient().run(
      "UPDATE agent_tasks SET agentId = ?, status = 'in_progress' WHERE id = ?",
      [agentId, taskId],
    );
    auth = { kind: "operator", fingerprint: "op:checklist" };
    await api("GET", "/api/checklist", undefined, agentId);
    const response = await api(
      "PATCH",
      `/api/checklist/items/user:${userId}:use_case`,
      { action: "done", reason: "Lead verified" },
      agentId,
    );
    expect(response.status).toBe(200);
    expect(response.body.item).toMatchObject({
      statusChangedBy: `lead:${agentId}`,
      statusChangedByName: "Lead",
      statusReason: "Lead verified",
    });
  });

  test("non-lead agents read the checklist but cannot change it", async () => {
    const agentId = crypto.randomUUID();
    await createAgent({ id: agentId, name: "Checklist Worker", isLead: false, status: "idle" });
    const taskId = await root(`shared/checklist-${crypto.randomUUID()}/`);
    await getDbClient().run(
      "UPDATE agent_tasks SET agentId = ?, status = 'in_progress' WHERE id = ?",
      [agentId, taskId],
    );
    auth = { kind: "operator", fingerprint: "op:checklist" };
    expect((await api("GET", "/api/checklist", undefined, agentId)).status).toBe(200);
    const patch = await api(
      "PATCH",
      `/api/checklist/items/user:${userId}:use_case`,
      { action: "done" },
      agentId,
    );
    expect(patch.status).toBe(403);
    const add = await api(
      "POST",
      "/api/checklist/items",
      { scope: "user", kind: "custom", label: "Worker item" },
      agentId,
    );
    expect(add.status).toBe(403);
  });

  test("a user token with an agent header is recorded as the user, not the Lead", async () => {
    const agentId = crypto.randomUUID();
    await createAgent({ id: agentId, name: "Header Lead", isLead: true, status: "idle" });
    const response = await api(
      "PATCH",
      `/api/checklist/items/user:${userId}:use_case`,
      { action: "done" },
      agentId,
    );
    expect(response.status).toBe(200);
    expect(response.body.item.statusChangedBy).toBe(userId);
  });

  test("firstOpenItem skips done, signaled, removed, nudged and custom items, and nudge writes join transactions", async () => {
    process.env.GITHUB_TOKEN = "fixture-token";
    await listChecklist(userId);
    await mutateChecklist(actor, { action: "add", scope: "user", kind: "custom", label: "Manual" });
    expect((await firstOpenItem(userId, false))?.id).toBe(`user:${userId}:use_case`);
    expect((await firstOpenItem(userId, true))?.id).toBe("swarm:channel");
    const taskId = crypto.randomUUID();
    await expect(
      getDbClient().transaction(async () => {
        await markNudged("swarm:channel", taskId, userId);
        expect((await firstOpenItem(userId, true))?.id).toBe(`user:${userId}:use_case`);
        throw new Error("Rollback nudge");
      }),
    ).rejects.toThrow("Rollback nudge");
    expect((await firstOpenItem(userId, true))?.id).toBe("swarm:channel");
    await getDbClient().transaction(async () => {
      await markNudged("swarm:channel", taskId, userId);
    });
    expect(await item("channel")).toMatchObject({
      nudgedTaskId: taskId,
      nudgedAt: expect.any(String),
    });
    await mutateChecklist(actor, { action: "done", id: `user:${userId}:use_case` });
    expect(await firstOpenItem(userId, true)).toBeNull();
    await mutateChecklist(actor, { action: "remove", id: `user:${userId}:use_case` });
    expect(await firstOpenItem(userId, true)).toBeNull();
  });

  test("firstOpenItem advances to the next swarm item after a nudge", async () => {
    expect((await firstOpenItem(userId, true))?.id).toBe("swarm:channel");
    await markNudged("swarm:channel", crypto.randomUUID(), userId);
    expect((await firstOpenItem(userId, true))?.id).toBe("swarm:tool");
    await mutateChecklist(actor, { action: "remove", id: "swarm:tool" });
    expect((await firstOpenItem(userId, true))?.id).toBe(`user:${userId}:use_case`);
  });
});
