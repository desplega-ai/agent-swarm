import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import {
  createObject,
  getObject,
  listObjects,
  NO_AGENT_FS_IDENTITY,
  reindexObjects,
} from "../be/primitives/objects";

const OWN_KEY = "af_own_agent_key";
const SERVICE_KEY = "af_service_key";
const ORG = "org-prim";
const DRIVE = "drive-prim";

// In-memory agent-fs: raw PUT/GET with If-None-Match / If-Match, and the glob op.
const files = new Map<string, { body: string; version: number }>();
const bearers: string[] = [];
let failNextWriteWith409 = false;

const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    bearers.push(req.headers.get("authorization") ?? "");
    if (req.headers.get("authorization") !== `Bearer ${OWN_KEY}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const raw = url.pathname.match(/^\/orgs\/([^/]+)\/drives\/([^/]+)\/files\/(.+)\/raw$/);
    if (raw) {
      const path = decodeURIComponent(raw[3] ?? "");
      const current = files.get(path);
      if (req.method === "GET") {
        if (!current) return new Response("not found", { status: 404 });
        return new Response(current.body, {
          headers: { "x-agent-fs-version": String(current.version) },
        });
      }
      const ifMatch = req.headers.get("if-match");
      if (req.headers.get("if-none-match") === "*" && current) {
        return new Response("exists", { status: 409 });
      }
      if (ifMatch && (failNextWriteWith409 || String(current?.version) !== ifMatch)) {
        failNextWriteWith409 = false;
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
      const body = (await req.json()) as { op: string; pattern: string };
      if (body.op !== "glob") return new Response("bad op", { status: 400 });
      const suffix = body.pattern.replace("**/*", "");
      const matches = [...files.keys()]
        .filter((p) => p.endsWith(suffix))
        .map((p) => ({ path: `/${p}`, size: 1 }));
      return Response.json({ matches });
    }
    return new Response("not found", { status: 404 });
  },
});

const agentId = crypto.randomUUID();
const keylessAgentId = crypto.randomUUID();
const savedServiceKey = process.env.API_AGENT_FS_API_KEY;
const savedPublicBase = process.env.PUBLIC_MCP_BASE_URL;

beforeAll(async () => {
  initDb(":memory:");
  // The service key is configured too: the objects path must never use it.
  process.env.API_AGENT_FS_API_KEY = SERVICE_KEY;
  // Webhook registration (which does use the service key) needs an https base
  // URL; keep it off here. primitives-object-webhooks.test.ts covers it.
  process.env.PUBLIC_MCP_BASE_URL = "http://localhost:3013";
  const global = { scope: "global" as const, scopeId: null, isSecret: false };
  await upsertSwarmConfig({
    ...global,
    key: "AGENT_FS_API_URL",
    value: `http://127.0.0.1:${fake.port}`,
  });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_ORG_ID", value: ORG });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_DRIVE_ID", value: DRIVE });
  await upsertSwarmConfig({
    ...global,
    key: "AGENT_FS_API_KEY",
    value: SERVICE_KEY,
    isSecret: true,
  });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: "AGENT_FS_API_KEY",
    value: OWN_KEY,
    isSecret: true,
  });
});

afterAll(() => {
  fake.stop(true);
  closeDb();
  if (savedServiceKey === undefined) delete process.env.API_AGENT_FS_API_KEY;
  else process.env.API_AGENT_FS_API_KEY = savedServiceKey;
  if (savedPublicBase === undefined) delete process.env.PUBLIC_MCP_BASE_URL;
  else process.env.PUBLIC_MCP_BASE_URL = savedPublicBase;
});

beforeEach(async () => {
  files.clear();
  bearers.length = 0;
  await getDbClient().run("DELETE FROM primitive_objects");
});

const fileJson = (path: string) => JSON.parse(files.get(path)?.body ?? "null");

describe("primitive objects", () => {
  test("create writes an empty board with the id embedded, as the agent's own identity", async () => {
    const object = await createObject({
      agentId,
      kind: "board",
      path: "/boards/a.excalidraw",
      title: "A",
    });
    expect(object.path).toBe("boards/a.excalidraw");
    expect(object.fileVersion).toBe(1);
    expect(object.link).toBe(
      `https://live.agent-fs.dev/file/~/${ORG}/${DRIVE}/boards/a.excalidraw`,
    );
    expect(fileJson("boards/a.excalidraw")).toMatchObject({
      type: "excalidraw",
      elements: [],
      swarm: { id: object.id, kind: "board", title: "A" },
    });
    expect(bearers.length).toBeGreaterThan(0);
    expect(bearers.every((b) => b === `Bearer ${OWN_KEY}`)).toBe(true);
  });

  test("create is create-only and validates kind and suffix", async () => {
    await createObject({ agentId, kind: "board", path: "b.excalidraw" });
    await expect(createObject({ agentId, kind: "board", path: "b.excalidraw" })).rejects.toThrow(
      "already exists",
    );
    await expect(createObject({ agentId, kind: "board", path: "b.json" })).rejects.toThrow(
      "must end with '.excalidraw'",
    );
    await expect(createObject({ agentId, kind: "sheet", path: "b.excalidraw" })).rejects.toThrow(
      "unknown kind",
    );
    await expect(createObject({ agentId, kind: "board", path: "../x.excalidraw" })).rejects.toThrow(
      "invalid path",
    );
  });

  test("an agent without its own key is refused, even with a global key set", async () => {
    await expect(
      createObject({ agentId: keylessAgentId, kind: "board", path: "c.excalidraw" }),
    ).rejects.toThrow(NO_AGENT_FS_IDENTITY);
    await expect(listObjects({ agentId: undefined })).rejects.toThrow(NO_AGENT_FS_IDENTITY);
    expect(bearers).toEqual([]);
  });

  test("get by id and path, with content, and reports a missing file", async () => {
    const created = await createObject({ agentId, kind: "board", path: "d.excalidraw" });
    const byPath = await getObject({ agentId, path: "/d.excalidraw", includeContent: true });
    expect(byPath.object.id).toBe(created.id);
    expect(byPath.content).toMatchObject({ type: "excalidraw" });
    files.delete("d.excalidraw");
    const gone = await getObject({ agentId, id: created.id });
    expect(gone.missing).toBe(true);
    await expect(getObject({ agentId, id: "nope" })).rejects.toThrow("no object");
  });

  test("list is scoped to the caller's drive and filters by prefix", async () => {
    await createObject({ agentId, kind: "board", path: "x/one.excalidraw" });
    await createObject({ agentId, kind: "board", path: "y/two.excalidraw" });
    await getDbClient().run(
      `INSERT INTO primitive_objects (id, kind, orgId, driveId, path, createdAt, updatedAt)
       VALUES ('other', 'board', 'org-other', 'drive-other', 'x/three.excalidraw', 'now', 'now')`,
    );
    expect((await listObjects({ agentId })).total).toBe(2);
    const x = await listObjects({ agentId, kind: "board", prefix: "/x/" });
    expect(x.objects.map((o) => o.path)).toEqual(["x/one.excalidraw"]);
  });

  test("reindex restores every id after the table is wiped", async () => {
    const a = await createObject({ agentId, kind: "board", path: "r/a.excalidraw" });
    const b = await createObject({ agentId, kind: "board", path: "r/b.excalidraw" });
    await getDbClient().run("DELETE FROM primitive_objects");
    const report = await reindexObjects({ agentId });
    expect(report).toMatchObject({ scanned: 2, adopted: [], missing: [], conflicts: [] });
    expect(report.restored.sort()).toEqual(["r/a.excalidraw", "r/b.excalidraw"]);
    expect((await getObject({ agentId, path: "r/a.excalidraw" })).object.id).toBe(a.id);
    expect((await getObject({ agentId, path: "r/b.excalidraw" })).object.id).toBe(b.id);
  });

  test("reindex adopts a stock Excalidraw save at a known path with the same id", async () => {
    const a = await createObject({ agentId, kind: "board", path: "s.excalidraw" });
    // Stock Excalidraw writes only type/version/source/elements/appState/files.
    files.set("s.excalidraw", {
      body: JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "excalidraw",
        elements: [{}],
      }),
      version: 2,
    });
    const report = await reindexObjects({ agentId, kind: "board" });
    expect(report.adopted).toEqual(["s.excalidraw"]);
    expect(fileJson("s.excalidraw")).toMatchObject({ elements: [{}], swarm: { id: a.id } });
    expect((await getObject({ agentId, path: "s.excalidraw" })).object).toMatchObject({
      id: a.id,
      fileVersion: 3,
    });
  });

  test("reindex gives a copied file a new id and keeps the original's", async () => {
    const a = await createObject({ agentId, kind: "board", path: "orig.excalidraw" });
    files.set("copy.excalidraw", { body: files.get("orig.excalidraw")?.body ?? "", version: 1 });
    const report = await reindexObjects({ agentId });
    expect(report.adopted).toEqual(["copy.excalidraw"]);
    const copy = (await getObject({ agentId, path: "copy.excalidraw" })).object;
    expect(copy.id).not.toBe(a.id);
    expect((await getObject({ agentId, path: "orig.excalidraw" })).object.id).toBe(a.id);
    expect(fileJson("copy.excalidraw").swarm.id).toBe(copy.id);
  });

  test("reindex follows a moved file, reports a missing one and a write-back conflict", async () => {
    const moved = await createObject({ agentId, kind: "board", path: "old.excalidraw" });
    const gone = await createObject({ agentId, kind: "board", path: "gone.excalidraw" });
    files.set("new.excalidraw", files.get("old.excalidraw") ?? { body: "", version: 1 });
    files.delete("old.excalidraw");
    files.delete("gone.excalidraw");
    files.set("raced.excalidraw", { body: JSON.stringify({ type: "excalidraw" }), version: 4 });
    files.set("broken.excalidraw", { body: "{not json", version: 1 });
    failNextWriteWith409 = true;
    const report = await reindexObjects({ agentId });
    expect(report.missing).toEqual([gone.path]);
    expect(report.conflicts.map((c) => c.path).sort()).toEqual([
      "broken.excalidraw",
      "raced.excalidraw",
    ]);
    expect((await getObject({ agentId, id: moved.id })).object.path).toBe("new.excalidraw");
    expect((await listObjects({ agentId })).total).toBe(2);
  });
});
