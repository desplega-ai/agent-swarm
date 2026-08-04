import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, getDb, initDb } from "../be/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-apps-spike5.sqlite";
const AGENT_ID = crypto.randomUUID();
let server: Server;
let base = "";

const definition = {
  models: {
    note: {
      columns: {
        title: { kind: "string" },
      },
    },
  },
  queries: { allNotes: { model: "note" } },
  pages: {
    main: {
      root: "root",
      elements: { root: { type: "Container", props: {} } },
    },
  },
  defaultPage: "main",
};

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleApps(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": AGENT_ID,
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createApp(input: unknown = definition, name = "Spike 5"): Promise<string> {
  const result = await request<{ app: { id: string } }>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name, definition: input }),
  });
  expect(result.status).toBe(201);
  return result.body.app.id;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps:%'");
  getDb().run("DELETE FROM apps");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("apps spike 5 lifecycle", () => {
  test("stamps schemaVersion and snapshots PUT/PATCH before storing", async () => {
    const appId = await createApp({ ...definition, schemaVersion: 99 });
    const created = await request<{ app: { definition: { schemaVersion: number } } }>(
      `/api/apps/${appId}`,
    );
    expect(created.body.app.definition.schemaVersion).toBe(1);

    const updatedDefinition = {
      ...definition,
      models: { note: { columns: { title: { kind: "string" }, body: { kind: "string" } } } },
      schemaVersion: 200,
    };
    const put = await request<{ app: { definition: { schemaVersion: number } } }>(
      `/api/apps/${appId}`,
      { method: "PUT", body: JSON.stringify({ definition: updatedDefinition }) },
    );
    expect(put.status).toBe(200);
    expect(put.body.app.definition.schemaVersion).toBe(1);

    const patch = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "patched", definition: { schemaVersion: 999 } }),
    });
    expect(patch.status).toBe(200);

    const versions = await request<{
      versions: Array<{
        version: number;
        changedByAgentId?: string;
        snapshot: { definition: { schemaVersion: number } };
      }>;
    }>(`/api/apps/${appId}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions.body.versions[0]?.changedByAgentId).toBe(AGENT_ID);
    expect(versions.body.versions[1]?.snapshot.definition.schemaVersion).toBe(1);

    const version = await request<{ version: { version: number } }>(
      `/api/apps/${appId}/versions/1`,
    );
    expect(version.status).toBe(200);
    expect(version.body.version.version).toBe(1);
  });

  test("fails closed when a snapshot cannot be written", async () => {
    const appId = await createApp();
    getDb().run(`
      CREATE TRIGGER fail_app_snapshot
      BEFORE INSERT ON app_versions
      BEGIN SELECT RAISE(FAIL, 'snapshot intentionally failed'); END;
    `);

    const result = await request(`/api/apps/${appId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "must not persist" }),
    });
    const patch = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "must not persist" }),
    });
    getDb().run("DROP TRIGGER fail_app_snapshot");

    expect(result.status).toBe(500);
    expect(patch.status).toBe(500);
    expect(
      (await request<{ app: { name: string; description?: string } }>(`/api/apps/${appId}`)).body
        .app,
    ).toMatchObject({ name: "Spike 5" });
    expect(
      (await request<{ app: { description?: string } }>(`/api/apps/${appId}`)).body.app.description,
    ).toBeUndefined();
    expect(
      getDb().query("SELECT COUNT(*) AS count FROM app_versions").get() as { count: number },
    ).toEqual({
      count: 0,
    });
  });

  test("retains raw invalid definitions in snapshots and permits PUT repair", async () => {
    const appId = await createApp();
    const brokenDefinition = { models: "not an object" };
    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run(JSON.stringify(brokenDefinition), appId);

    const broken = await request<{
      app: { definition: unknown; definitionError?: Array<{ path: string }> };
    }>(`/api/apps/${appId}`);
    expect(broken.status).toBe(200);
    expect(broken.body.app.definition).toEqual(brokenDefinition);
    expect(broken.body.app.definitionError?.length).toBeGreaterThan(0);
    expect((await request(`/api/apps/${appId}/queries/allNotes`)).status).toBe(409);
    expect(
      (
        await request(`/api/apps/${appId}/actions/anything`, {
          method: "POST",
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(409);

    const repair = await request(`/api/apps/${appId}`, {
      method: "PUT",
      body: JSON.stringify({ definition }),
    });
    expect(repair.status).toBe(200);
    const snapshot = getDb()
      .query("SELECT snapshot FROM app_versions WHERE appId = ?")
      .get(appId) as { snapshot: string };
    expect(JSON.parse(snapshot.snapshot).definition).toEqual(brokenDefinition);
  });

  test("upgrades legacy page and source bindings on reads and version snapshots", async () => {
    const appId = crypto.randomUUID();
    const legacyDefinition = {
      models: {
        note: {
          sources: { legacy: { connector: "obsolete" } },
          columns: { title: { kind: "string", source: { field: "title" } } },
        },
      },
      page: definition.pages.main,
    };
    getDb()
      .prepare(
        `INSERT INTO apps (id, name, description, definition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        appId,
        "Legacy",
        null,
        JSON.stringify(legacyDefinition),
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const read = await request<{
      app: {
        definition: {
          schemaVersion: number;
          pages: Record<string, unknown>;
          defaultPage: string;
          models: { note: Record<string, unknown> };
        };
      };
    }>(`/api/apps/${appId}`);
    expect(read.status).toBe(200);
    expect(read.body.app.definition).toMatchObject({
      schemaVersion: 1,
      defaultPage: "main",
      pages: { main: definition.pages.main },
    });
    expect(read.body.app.definition.models.note.sources).toBeUndefined();
    expect(
      (read.body.app.definition.models.note.columns as Record<string, Record<string, unknown>>)
        .title?.source,
    ).toBeUndefined();

    expect(
      (await request(`/api/apps/${appId}`, { method: "PATCH", body: JSON.stringify({}) })).status,
    ).toBe(200);
    const stored = getDb().query("SELECT definition FROM apps WHERE id = ?").get(appId) as {
      definition: string;
    };
    expect(JSON.parse(stored.definition)).toMatchObject({ schemaVersion: 1, defaultPage: "main" });

    const version = await request<{
      version: {
        snapshot: { definition: { pages: Record<string, unknown>; defaultPage: string } };
      };
    }>(`/api/apps/${appId}/versions/1`);
    expect(version.status).toBe(200);
    expect(version.body.version.snapshot.definition).toMatchObject({
      defaultPage: "main",
      pages: { main: definition.pages.main },
    });
  });

  test("rejects unknown top-level keys without accepting future definition surfaces", async () => {
    const result = await request<{ issues: Array<{ path: string; message: string }> }>(
      "/api/apps",
      {
        method: "POST",
        body: JSON.stringify({ name: "Unknown key", definition: { ...definition, element: {} } }),
      },
    );
    expect(result.status).toBe(400);
    expect(result.body.issues).toContainEqual({
      path: "element",
      message: 'unknown top-level key "element" — did you mean "elements"?',
    });

    const futureSurface = await request<{ issues: Array<{ path: string }> }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({ name: "Future surface", definition: { ...definition, elements: {} } }),
    });
    expect(futureSurface.status).toBe(400);
    expect(futureSurface.body.issues.some((issue) => issue.path === "elements")).toBe(true);

    const appId = await createApp();
    const patch = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ definition: { element: {} } }),
      },
    );
    expect(patch.status).toBe(400);
    expect(patch.body.issues).toContainEqual({
      path: "element",
      message: 'unknown top-level key "element" — did you mean "elements"?',
    });
  });
});
