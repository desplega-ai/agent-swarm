import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import {
  ensureObjectWebhook,
  ensureObjectWebhooksForKnownDrives,
} from "../be/primitives/object-webhooks";
import {
  applyFileChange,
  createObject,
  listObjects,
  reindexObjects,
} from "../be/primitives/objects";
import { handleObjectWebhooks } from "../http/object-webhooks";
import { listenOnFreePort } from "./test-net";

const OWN_KEY = "af_own_agent_key_webhooks";
const SERVICE_KEY = "af_service_key_webhooks";
const ORG = "org-hooks";
const DRIVE = "drive-hooks";
const BASE = "https://swarm.example.test";
const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;

// In-memory agent-fs: raw GET/PUT with versions, glob, stat, and webhook ops.
const files = new Map<string, { body: string; version: number }>();
const hooks: Array<{ id: string; url: string; eventTypes: string[] }> = [];
const calls: Array<{ op: string; bearer: string; body: Record<string, unknown> }> = [];
let downloads = 0;
let webhooksSupported = true;
let globGate: Promise<void> | null = null;

const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const bearer = req.headers.get("authorization") ?? "";
    if (bearer !== `Bearer ${OWN_KEY}` && bearer !== `Bearer ${SERVICE_KEY}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const raw = url.pathname.match(/^\/orgs\/[^/]+\/drives\/[^/]+\/files\/(.+)\/raw$/);
    if (raw) {
      const path = decodeURIComponent(raw[1] ?? "");
      const current = files.get(path);
      if (req.method === "GET") {
        downloads += 1;
        if (!current) return new Response("not found", { status: 404 });
        return new Response(current.body, {
          headers: { "x-agent-fs-version": String(current.version) },
        });
      }
      if (req.headers.get("if-none-match") === "*" && current) {
        return new Response("exists", { status: 409 });
      }
      const ifMatch = req.headers.get("if-match");
      if (ifMatch && String(current?.version) !== ifMatch) {
        return new Response("version mismatch", { status: 409 });
      }
      const version = (current?.version ?? 0) + 1;
      files.set(path, { body: await req.text(), version });
      return Response.json(
        { path, version },
        { headers: { "x-agent-fs-version": String(version) } },
      );
    }
    if (url.pathname === `/orgs/${ORG}/ops`) {
      const body = (await req.json()) as Record<string, unknown> & { op: string };
      calls.push({ op: body.op, bearer, body });
      if (body.op === "glob") {
        if (globGate) await globGate;
        const suffix = String(body.pattern).replace("**/*", "");
        const matches = [...files.keys()]
          .filter((p) => p.endsWith(suffix))
          .map((p) => ({ path: `/${p}`, size: 1 }));
        return Response.json({ matches });
      }
      if (body.op === "stat") {
        const current = files.get(String(body.path).replace(/^\/+/, ""));
        if (!current) return new Response("not found", { status: 404 });
        return Response.json({ path: body.path, currentVersion: current.version });
      }
      if (body.op.startsWith("webhook-") && !webhooksSupported) {
        return Response.json({ error: `unknown op ${body.op}` }, { status: 400 });
      }
      if (body.op === "webhook-list") return Response.json({ webhooks: hooks });
      if (body.op === "webhook-create") {
        const hook = {
          id: crypto.randomUUID(),
          url: String(body.url),
          eventTypes: body.eventTypes as string[],
        };
        hooks.push(hook);
        return Response.json({ ...hook, secret: SECRET });
      }
      if (body.op === "webhook-update") {
        const hook = hooks.find((h) => h.id === body.id);
        if (!hook) return Response.json({ error: "not found" }, { status: 404 });
        hook.url = String(body.url);
        return Response.json({ ...hook, ...(body.rotateSecret ? { secret: SECRET } : {}) });
      }
      return new Response("bad op", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
});

let receiver: Server;
let receiverUrl = "";
const agentId = crypto.randomUUID();
const savedEnv = {
  API_AGENT_FS_API_KEY: process.env.API_AGENT_FS_API_KEY,
  PUBLIC_MCP_BASE_URL: process.env.PUBLIC_MCP_BASE_URL,
};

function restoreEnv(name: keyof typeof savedEnv) {
  if (savedEnv[name] === undefined) delete process.env[name];
  else process.env[name] = savedEnv[name];
}

beforeAll(async () => {
  initDb(":memory:");
  process.env.API_AGENT_FS_API_KEY = SERVICE_KEY;
  const global = { scope: "global" as const, scopeId: null, isSecret: false };
  await upsertSwarmConfig({
    ...global,
    key: "AGENT_FS_API_URL",
    value: `http://127.0.0.1:${fake.port}`,
  });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_ORG_ID", value: ORG });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_DRIVE_ID", value: DRIVE });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: "AGENT_FS_API_KEY",
    value: OWN_KEY,
    isSecret: true,
  });
  receiver = createServer((req, res) => {
    const segments = (req.url ?? "").split("?")[0]!.split("/").filter(Boolean);
    void handleObjectWebhooks(req, res, segments).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  receiverUrl = `http://127.0.0.1:${await listenOnFreePort(receiver)}`;
});

afterAll(() => {
  fake.stop(true);
  receiver.close();
  closeDb();
  restoreEnv("API_AGENT_FS_API_KEY");
  restoreEnv("PUBLIC_MCP_BASE_URL");
});

beforeEach(async () => {
  process.env.PUBLIC_MCP_BASE_URL = BASE;
  files.clear();
  hooks.length = 0;
  calls.length = 0;
  downloads = 0;
  webhooksSupported = true;
  globGate = null;
  await getDbClient().run("DELETE FROM primitive_objects");
  await getDbClient().run("DELETE FROM agent_fs_object_webhooks");
});

const opCount = (op: string) => calls.filter((c) => c.op === op).length;

/** Register the drive hook, then create a board (its own background ensure is then a no-op). */
async function boardWithHook(path: string) {
  expect((await ensureObjectWebhook(ORG, DRIVE)).status).toBe("registered");
  const object = await createObject({ agentId, kind: "board", path });
  const row = await getDbClient().get<{ id: string }>("SELECT id FROM agent_fs_object_webhooks");
  return { object, hookId: row!.id };
}

function sign(id: string, timestamp: number, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

async function deliver(
  hookId: string,
  data: Record<string, unknown>,
  opts: { type?: string; timestamp?: number; secret?: string; deliveryId?: string } = {},
) {
  const body = JSON.stringify({
    type: opts.type ?? "file.changed",
    timestamp: new Date().toISOString(),
    data: { orgId: ORG, driveId: DRIVE, ...data },
  });
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const deliveryId = opts.deliveryId ?? crypto.randomUUID();
  const response = await fetch(`${receiverUrl}/api/objects/agent-fs-webhook/${hookId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": deliveryId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign(deliveryId, timestamp, body, opts.secret),
    },
    body,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("ensureObjectWebhook", () => {
  test("registers one drive hook with the service key, then is a no-op", async () => {
    expect((await ensureObjectWebhook(ORG, DRIVE)).status).toBe("registered");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.eventTypes).toEqual(["file.changed"]);
    expect(hooks[0]?.url).toStartWith(`${BASE}/api/objects/agent-fs-webhook/`);
    expect(calls.every((c) => c.bearer === `Bearer ${SERVICE_KEY}`)).toBe(true);
    calls.length = 0;
    expect((await ensureObjectWebhook(ORG, DRIVE)).status).toBe("active");
    expect(calls).toHaveLength(0);
  });

  test("concurrent calls (two replicas, one drive) create exactly one hook", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureObjectWebhook(ORG, DRIVE)),
    );
    expect(opCount("webhook-create")).toBe(1);
    expect(hooks).toHaveLength(1);
    expect(results.filter((r) => r.status === "registered")).toHaveLength(1);
  });

  test("a lost row reuses the swarm hook already on the drive", async () => {
    await ensureObjectWebhook(ORG, DRIVE);
    await getDbClient().run("DELETE FROM agent_fs_object_webhooks");
    expect((await ensureObjectWebhook(ORG, DRIVE)).status).toBe("registered");
    expect(opCount("webhook-create")).toBe(1);
    expect(calls.find((c) => c.op === "webhook-update")?.body.rotateSecret).toBe(true);
    const row = await getDbClient().get<{ id: string }>("SELECT id FROM agent_fs_object_webhooks");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.url).toBe(`${BASE}/api/objects/agent-fs-webhook/${row?.id}`);
  });

  test("skips a drive outside the swarm's agent-fs org", async () => {
    expect(await ensureObjectWebhook("other-org", DRIVE)).toMatchObject({ status: "skipped" });
    expect(calls).toHaveLength(0);
  });

  test("an agent-fs without webhooks fails once, then waits out the retry window", async () => {
    webhooksSupported = false;
    const first = await ensureObjectWebhook(ORG, DRIVE);
    expect(first.status).toBe("failed");
    expect(first.reason).toContain("HTTP 400");
    calls.length = 0;
    expect((await ensureObjectWebhook(ORG, DRIVE)).status).toBe("busy");
    expect(calls).toHaveLength(0);
  });

  test("an unreachable agent-fs fails without throwing", async () => {
    await upsertSwarmConfig({
      scope: "global",
      scopeId: null,
      isSecret: false,
      key: "AGENT_FS_API_URL",
      value: "http://127.0.0.1:1",
    });
    try {
      expect((await ensureObjectWebhook(ORG, DRIVE)).status).toBe("failed");
      expect(await ensureObjectWebhooksForKnownDrives()).toEqual([]);
    } finally {
      await upsertSwarmConfig({
        scope: "global",
        scopeId: null,
        isSecret: false,
        key: "AGENT_FS_API_URL",
        value: `http://127.0.0.1:${fake.port}`,
      });
    }
  });
});

describe("file.changed receiver", () => {
  test("rejects a bad signature, an unknown receiver and an old timestamp", async () => {
    const { hookId, object } = await boardWithHook("boards/sig.excalidraw");
    const data = { path: `/${object.path}`, version: 2, operation: "edit" };
    const wrongSecret = `whsec_${Buffer.from("x".repeat(32)).toString("base64")}`;
    expect((await deliver(hookId, data, { secret: wrongSecret })).status).toBe(401);
    expect((await deliver("not-a-hook", data)).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await deliver(hookId, data, { timestamp: old })).status).toBe(401);
    const row = await getDbClient().get<{ fileVersion: number }>(
      "SELECT fileVersion FROM primitive_objects WHERE id = ?",
      [object.id],
    );
    expect(row?.fileVersion).toBe(1);
  });

  test("an edit reads the file once and bumps the version; a replay or a late event is a no-op", async () => {
    const { hookId, object } = await boardWithHook("boards/edit.excalidraw");
    // agent-fs applies the change before it sends the event.
    const stored = files.get(object.path);
    if (stored) files.set(object.path, { ...stored, version: 3 });
    const edit = { path: `/${object.path}`, version: 3, operation: "edit" };
    expect((await deliver(hookId, edit)).json).toMatchObject({ action: "updated", id: object.id });
    expect((await deliver(hookId, edit)).json).toMatchObject({
      action: "ignored",
      reason: "stale event",
    });
    const late = { path: `/${object.path}`, version: 2, operation: "delete" };
    expect((await deliver(hookId, late)).json).toMatchObject({ action: "ignored" });
    const listed = await listObjects({ agentId });
    expect(listed.objects.map((o) => [o.id, o.fileVersion])).toEqual([[object.id, 3]]);
    expect(downloads).toBe(1);
  });

  test("a delete and an older edit delivered together leave the row at the newer event", async () => {
    // agent-fs sends a delivery batch concurrently, so both events read the row before either writes.
    const board = (id: string, version: number) => ({
      download: async () =>
        new Response(JSON.stringify({ type: "excalidraw", elements: [], swarm: { id } }), {
          headers: { "x-agent-fs-version": String(version) },
        }),
      exists: async () => true,
    });
    const wrong: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `race-${i}`;
      const now = new Date().toISOString();
      await getDbClient().run(
        `INSERT INTO primitive_objects
           (id, kind, orgId, driveId, path, title, fileVersion, ownerAgentId, createdAt, updatedAt)
         VALUES (?, 'board', 'org-race', 'drive-race', ?, NULL, 3, NULL, ?, ?)`,
        [id, `boards/race-${i}.excalidraw`, now, now],
      );
      const change = {
        orgId: "org-race",
        driveId: "drive-race",
        path: `/boards/race-${i}.excalidraw`,
      };
      await Promise.all([
        applyFileChange({ ...change, version: 5, operation: "delete" }, board(id, 5)),
        applyFileChange({ ...change, version: 4, operation: "edit" }, board(id, 4)),
      ]);
      const row = await getDbClient().get<{ deletedAt: string | null; fileVersion: number }>(
        "SELECT deletedAt, fileVersion FROM primitive_objects WHERE id = ?",
        [id],
      );
      if (row?.deletedAt === null || row?.fileVersion !== 5) wrong.push(id);
    }
    expect(wrong).toEqual([]);
  });

  test("two events that restore one path together keep the newer file version", async () => {
    const board = (id: string, version: number) => ({
      download: async () =>
        new Response(JSON.stringify({ type: "excalidraw", elements: [], swarm: { id } }), {
          headers: { "x-agent-fs-version": String(version) },
        }),
      // No row holds the id elsewhere; the restored file itself is on the drive.
      exists: async (path: string) => path.startsWith("boards/restore-race-"),
    });
    const wrong: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `restore-race-${i}`;
      const change = {
        orgId: "org-race",
        driveId: "drive-race",
        path: `/boards/restore-race-${i}.excalidraw`,
        operation: "edit",
      };
      await Promise.all([
        applyFileChange({ ...change, version: 5 }, board(id, 5)),
        applyFileChange({ ...change, version: 4 }, board(id, 4)),
      ]);
      const row = await getDbClient().get<{ fileVersion: number }>(
        "SELECT fileVersion FROM primitive_objects WHERE id = ?",
        [id],
      );
      if (row?.fileVersion !== 5) wrong.push(id);
    }
    expect(wrong).toEqual([]);
  });

  test("an edit on the old path racing a move does not stamp its version on the moved row", async () => {
    const id = "move-race";
    const oldPath = "boards/move-old.excalidraw";
    const newPath = "boards/move-new.excalidraw";
    const now = new Date().toISOString();
    await getDbClient().run(
      `INSERT INTO primitive_objects
         (id, kind, orgId, driveId, path, title, fileVersion, ownerAgentId, createdAt, updatedAt)
       VALUES (?, 'board', 'org-race', 'drive-race', ?, NULL, 3, NULL, ?, ?)`,
      [id, oldPath, now, now],
    );
    // The edit read the row at the old path; its write lands after the move repointed the row.
    let moveDone = () => {};
    const afterMove = new Promise<void>((resolve) => {
      moveDone = resolve;
    });
    const reader = (version: number, gate?: Promise<void>) => ({
      download: async () => {
        await gate;
        return new Response(JSON.stringify({ type: "excalidraw", elements: [], swarm: { id } }), {
          headers: { "x-agent-fs-version": String(version) },
        });
      },
      exists: async (path: string) => path === newPath,
    });
    const change = { orgId: "org-race", driveId: "drive-race" };
    await Promise.all([
      applyFileChange(
        { ...change, path: oldPath, version: 4, operation: "edit" },
        reader(4, afterMove),
      ),
      applyFileChange({ ...change, path: newPath, version: 1, operation: "write" }, reader(1)).then(
        moveDone,
      ),
    ]);
    // Versions count per path: the new path's delete at v2 must land.
    const deleted = await applyFileChange(
      { ...change, path: newPath, version: 2, operation: "delete" },
      reader(2),
    );
    expect(deleted).toMatchObject({ action: "tombstoned", id });
    const row = await getDbClient().get<{ path: string; fileVersion: number }>(
      "SELECT path, fileVersion FROM primitive_objects WHERE id = ?",
      [id],
    );
    expect(row).toEqual({ path: newPath, fileVersion: 2 });
  });

  test("a delete that races the first restore of a path leaves no live row", async () => {
    const id = "first-restore";
    // The restore read the file just before agent-fs deleted it; the delete then finds no row.
    let deleteDone = () => {};
    const afterDelete = new Promise<void>((resolve) => {
      deleteDone = resolve;
    });
    const reader = {
      download: async () => {
        await afterDelete;
        return new Response(JSON.stringify({ type: "excalidraw", elements: [], swarm: { id } }), {
          headers: { "x-agent-fs-version": "4" },
        });
      },
      exists: async () => false,
    };
    const change = {
      orgId: "org-race",
      driveId: "drive-race",
      path: "/boards/first-restore.excalidraw",
    };
    const [restored] = await Promise.all([
      applyFileChange({ ...change, version: 4, operation: "write" }, reader),
      applyFileChange({ ...change, version: 5, operation: "delete" }, reader).then(deleteDone),
    ]);
    expect(restored).toMatchObject({ action: "tombstoned", id });
    const row = await getDbClient().get<{ deletedAt: string | null }>(
      "SELECT deletedAt FROM primitive_objects WHERE id = ?",
      [id],
    );
    expect(row?.deletedAt).not.toBeNull();
  });

  test("an edit that drops the embedded id leaves the file for object-reindex to adopt", async () => {
    const { hookId, object } = await boardWithHook("boards/heal.excalidraw");
    // A stock Excalidraw save writes the scene without the swarm block.
    files.set(object.path, {
      body: JSON.stringify({ type: "excalidraw", elements: [] }),
      version: 2,
    });
    const event = await deliver(hookId, { path: `/${object.path}`, version: 2, operation: "edit" });
    expect(event.json).toMatchObject({ action: "updated", id: object.id });
    const report = await reindexObjects({ agentId });
    expect(report.adopted).toEqual([object.path]);
    expect(JSON.parse(files.get(object.path)?.body ?? "{}").swarm?.id).toBe(object.id);
  });

  test("a delete tombstones the row and hides it; a later write brings it back", async () => {
    const { hookId, object } = await boardWithHook("boards/del.excalidraw");
    const deleted = await deliver(hookId, {
      path: `/${object.path}`,
      version: 2,
      operation: "delete",
    });
    expect(deleted.json).toMatchObject({ action: "tombstoned", id: object.id });
    expect((await listObjects({ agentId })).total).toBe(0);
    const revert = { path: `/${object.path}`, version: 3, operation: "revert" };
    expect((await deliver(hookId, revert)).json).toMatchObject({ action: "updated" });
    expect((await listObjects({ agentId })).objects[0]?.deletedAt).toBeNull();
  });

  test("a move repoints the row by the id embedded in the file", async () => {
    const { hookId, object } = await boardWithHook("boards/old.excalidraw");
    const moved = files.get(object.path)!;
    files.delete(object.path);
    files.set("boards/new.excalidraw", { body: moved.body, version: 1 });
    const event = { path: "/boards/new.excalidraw", version: 1, operation: "write" };
    expect((await deliver(hookId, event)).json).toMatchObject({ action: "moved", id: object.id });
    const listed = await listObjects({ agentId });
    expect(listed.objects.map((o) => [o.id, o.path])).toEqual([
      [object.id, "boards/new.excalidraw"],
    ]);
    expect(calls.filter((c) => c.op === "glob")).toHaveLength(0);
  });

  test("a copy, a file without an id and a non-object path are left alone", async () => {
    const { hookId, object } = await boardWithHook("boards/src.excalidraw");
    files.set("boards/copy.excalidraw", { body: files.get(object.path)!.body, version: 1 });
    files.set("boards/bare.excalidraw", {
      body: JSON.stringify({ type: "excalidraw" }),
      version: 1,
    });
    const copy = await deliver(hookId, {
      path: "/boards/copy.excalidraw",
      version: 1,
      operation: "write",
    });
    expect(copy.json).toMatchObject({ action: "ignored" });
    expect(String(copy.json.reason)).toContain("copy of boards/src.excalidraw");
    const bare = await deliver(hookId, {
      path: "/boards/bare.excalidraw",
      version: 1,
      operation: "write",
    });
    expect(String(bare.json.reason)).toContain("object-reindex adopts it");
    const notes = await deliver(hookId, { path: "/notes/a.md", version: 4, operation: "edit" });
    expect(notes.json).toMatchObject({ action: "ignored", reason: "not an object path" });
    const ping = await deliver(hookId, {}, { type: "ping" });
    expect(ping.json).toMatchObject({ action: "ignored" });
    expect((await listObjects({ agentId })).total).toBe(1);
    // The webhook path never writes to agent-fs.
    expect(files.get("boards/bare.excalidraw")?.version).toBe(1);
  });

  test("an agent-fs read failure answers 503 so agent-fs retries", async () => {
    const { hookId } = await boardWithHook("boards/x.excalidraw");
    files.set("boards/fresh.excalidraw", { body: "{}", version: 1 });
    process.env.API_AGENT_FS_API_KEY = "af_wrong_key";
    await upsertSwarmConfig({
      scope: "global",
      scopeId: null,
      isSecret: false,
      key: "API_AGENT_FS_API_KEY",
      value: "af_wrong_key",
    });
    try {
      const event = { path: "/boards/fresh.excalidraw", version: 1, operation: "write" };
      expect((await deliver(hookId, event)).status).toBe(503);
    } finally {
      process.env.API_AGENT_FS_API_KEY = SERVICE_KEY;
      await upsertSwarmConfig({
        scope: "global",
        scopeId: null,
        isSecret: false,
        key: "API_AGENT_FS_API_KEY",
        value: SERVICE_KEY,
      });
    }
  });
});

describe("object-reindex bounds", () => {
  test("unchanged files are checked by version, not re-read", async () => {
    await createObject({ agentId, kind: "board", path: "boards/a.excalidraw" });
    await createObject({ agentId, kind: "board", path: "boards/b.excalidraw" });
    downloads = 0;
    const report = await reindexObjects({ agentId });
    expect(report).toMatchObject({ scanned: 2, unchanged: 2, truncated: false, cutBy: null });
    expect(downloads).toBe(0);
    expect(opCount("stat")).toBe(2);
  });

  test("one call reads at most 50 changed files; the next call finishes", async () => {
    for (let i = 0; i < 60; i++) {
      files.set(`bulk/${i}.excalidraw`, {
        body: JSON.stringify({ type: "excalidraw" }),
        version: 1,
      });
    }
    const first = await reindexObjects({ agentId });
    expect(first).toMatchObject({ truncated: true, cutBy: "reads" });
    expect(first.adopted).toHaveLength(50);
    expect(downloads).toBe(50);
    const second = await reindexObjects({ agentId });
    expect(second).toMatchObject({ truncated: false, unchanged: 50 });
    expect(second.adopted).toHaveLength(10);
    expect((await listObjects({ agentId, limit: 200 })).total).toBe(60);
  });

  test("a byte budget stops reading once spent; the next call continues", async () => {
    const body = JSON.stringify({ type: "excalidraw", elements: [], pad: "x".repeat(100) });
    for (let i = 0; i < 3; i++) files.set(`big/${i}.excalidraw`, { body, version: 1 });
    const first = await reindexObjects({ agentId, limits: { bytes: body.length + 1 } });
    expect(first).toMatchObject({ truncated: true, cutBy: "bytes", missing: [] });
    expect(first.adopted).toHaveLength(2);
    expect(downloads).toBe(2);
    const second = await reindexObjects({ agentId });
    expect(second).toMatchObject({ truncated: false, cutBy: null, unchanged: 2 });
    expect(second.adopted).toHaveLength(1);
  });

  test("a spent time budget stops the pass before the next file", async () => {
    await createObject({ agentId, kind: "board", path: "boards/a.excalidraw" });
    calls.length = 0;
    downloads = 0;
    const report = await reindexObjects({ agentId, limits: { ms: 0 } });
    expect(report).toMatchObject({ scanned: 0, truncated: true, cutBy: "time", missing: [] });
    expect(opCount("stat")).toBe(0);
    expect(downloads).toBe(0);
  });

  test("a second reindex on the same drive is refused while one runs", async () => {
    let open = () => {};
    globGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const running = reindexObjects({ agentId });
    await Bun.sleep(20);
    await expect(reindexObjects({ agentId })).rejects.toThrow("already running");
    open();
    await running;
  });

  test("an unreachable agent-fs is a clear provider error, not a crash", async () => {
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "AGENT_FS_API_URL",
      value: "http://127.0.0.1:1",
      isSecret: false,
    });
    try {
      await expect(
        createObject({ agentId, kind: "board", path: "boards/down.excalidraw" }),
      ).rejects.toThrow("agent-fs is unreachable");
    } finally {
      await getDbClient().run(
        "DELETE FROM swarm_config WHERE scope = 'agent' AND scopeId = ? AND key = 'AGENT_FS_API_URL'",
        [agentId],
      );
    }
  });
});
