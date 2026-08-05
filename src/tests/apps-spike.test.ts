import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { parseAppDefinition } from "../apps/definition";
import { appIndexKey, appsNamespace, createAppRow, purgeAppRows } from "../apps/row-store";
import { deleteApp, getApp } from "../apps/store";
import { closeDb, countKv, getDb, getKv, initDb } from "../be/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-apps-spike.sqlite";
const AGENT_ID = crypto.randomUUID();
let server: Server;
let base = "";

const ideasDefinition = {
  models: {
    idea: {
      columns: {
        title: { kind: "string", required: true },
        status: { kind: "enum", enum: ["open", "in_progress", "done"], default: "open" },
        votes: { kind: "number", default: 0 },
        notes: { kind: "string" },
      },
    },
  },
  queries: {
    allIdeas: { model: "idea", sort: { column: "createdAt", dir: "desc" } },
  },
  pages: {
    main: {
      root: "root",
      elements: {
        root: { type: "Container", props: {} },
      },
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
    const handled = await handleApps(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    }
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

async function createIdeasApp(definition: unknown = ideasDefinition): Promise<string> {
  const result = await request<{ app: { id: string } }>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name: "Ideas", definition }),
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

describe("apps spike", () => {
  test("validates app definitions with normalized issue paths", async () => {
    expect(parseAppDefinition(ideasDefinition).success).toBe(true);

    const missingEnum = parseAppDefinition({
      ...ideasDefinition,
      models: { idea: { columns: { status: { kind: "enum" } } } },
    });
    expect(missingEnum).toMatchObject({
      success: false,
      issues: [{ path: "models.idea.columns.status.enum" }],
    });

    const prototypeReferences = parseAppDefinition({
      ...ideasDefinition,
      queries: {
        badModel: { model: "toString" },
        badColumn: { model: "idea", filter: { constructor: "x" } },
      },
    });
    expect(prototypeReferences).toMatchObject({ success: false });
    if (!prototypeReferences.success) {
      expect(prototypeReferences.issues.map((issue) => issue.path)).toEqual([
        "queries.badModel.model",
        "queries.badColumn.filter.constructor",
      ]);
    }

    const invalidDateDefault = parseAppDefinition({
      ...ideasDefinition,
      models: { idea: { columns: { due: { kind: "date", default: "1" } } } },
    });
    expect(invalidDateDefault).toMatchObject({
      success: false,
      issues: [{ path: "models.idea.columns.due.default" }],
    });

    const invalidDefinitions = [
      {
        ...ideasDefinition,
        models: { idea: { columns: { title: { kind: "wat" } } } },
      },
      {
        ...ideasDefinition,
        models: { idea: { columns: { status: { kind: "enum" } } } },
      },
      {
        ...ideasDefinition,
        models: { idea: { columns: { id: { kind: "string" } } } },
      },
      {
        ...ideasDefinition,
        queries: { bad: { model: "missing", filter: { title: "x" } } },
      },
      {
        ...ideasDefinition,
        queries: { bad: { model: "idea", filter: { missing: "x" } } },
      },
    ];

    for (const definition of invalidDefinitions) {
      const result = await request<{ error: string; issues: Array<{ path: string }> }>(
        "/api/apps",
        {
          method: "POST",
          body: JSON.stringify({ name: "Invalid", definition }),
        },
      );
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid app definition");
      expect(result.body.issues.length).toBeGreaterThan(0);
      expect(result.body.issues.every((issue) => typeof issue.path === "string")).toBe(true);
    }

    const appId = await createIdeasApp();
    expect((await request(`/api/apps/${appId}/models/toString/rows`)).status).toBe(404);
  });

  test("validates named-query filter values against column kinds", async () => {
    const result = await request<{
      error: string;
      issues: Array<{ path: string; message: string }>;
    }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        name: "Invalid filter",
        definition: {
          ...ideasDefinition,
          queries: { bad: { model: "idea", filter: { votes: "3" } } },
        },
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: "invalid app definition",
      issues: [
        {
          path: "queries.bad.filter.votes",
          message: "filter must be a valid number value",
        },
      ],
    });
  });

  test("preserves the record-key validation message", () => {
    const result = parseAppDefinition({
      ...ideasDefinition,
      models: {
        idea: { columns: { BadName: { kind: "string" } } },
      },
    });

    expect(result).toMatchObject({ success: false });
    if (result.success) throw new Error("definition unexpectedly passed validation");
    expect(result.issues).toContainEqual({
      path: "models.idea.columns.BadName",
      message:
        "must start with a lowercase letter and contain only letters, numbers, or underscores",
    });
    expect(result.issues.some((issue) => issue.message === "Invalid key in record")).toBe(false);
  });

  test("supports row CRUD, applies defaults, and advances updatedAt", async () => {
    const appId = await createIdeasApp();
    const created = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/idea/rows`,
      { method: "POST", body: JSON.stringify({ values: { title: "First" } }) },
    );
    expect(created.status).toBe(201);
    expect(created.body.row.status).toBe("open");
    expect(created.body.row.votes).toBe(0);

    const rowId = created.body.row.id as string;
    const patched = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/idea/rows/${rowId}`,
      { method: "PATCH", body: JSON.stringify({ values: { notes: "More detail" } }) },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.row.notes).toBe("More detail");
    expect(patched.body.row.updatedAt).not.toBe(created.body.row.updatedAt);

    const fetched = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/idea/rows/${rowId}`,
    );
    expect(fetched.body.row).toEqual(patched.body.row);

    const deleted = await request<{ ok: boolean }>(`/api/apps/${appId}/models/idea/rows/${rowId}`, {
      method: "DELETE",
    });
    expect(deleted).toEqual({ status: 200, body: { ok: true } });
  });

  test("PATCH null clears optional values and indexes but rejects required values", async () => {
    const appId = await createIdeasApp({
      ...ideasDefinition,
      models: {
        idea: {
          columns: {
            ...ideasDefinition.models.idea.columns,
            notes: { kind: "string", index: true },
          },
        },
      },
    });
    const created = await request<{ row: { id: string; notes: string } }>(
      `/api/apps/${appId}/models/idea/rows`,
      {
        method: "POST",
        body: JSON.stringify({ values: { title: "Clear me", notes: "temporary" } }),
      },
    );
    const notesIndexKey = appIndexKey("idea", "notes", "temporary", created.body.row.id);
    expect(getKv(appsNamespace(appId), notesIndexKey)).not.toBeNull();

    const cleared = await request<{ row: Record<string, unknown> }>(
      `/api/apps/${appId}/models/idea/rows/${created.body.row.id}`,
      { method: "PATCH", body: JSON.stringify({ values: { notes: null } }) },
    );
    expect(cleared.status).toBe(200);
    expect(Object.hasOwn(cleared.body.row, "notes")).toBe(false);
    expect(getKv(appsNamespace(appId), notesIndexKey)).toBeNull();

    const required = await request<{ issues: Array<{ path: string }> }>(
      `/api/apps/${appId}/models/idea/rows/${created.body.row.id}`,
      { method: "PATCH", body: JSON.stringify({ values: { title: null } }) },
    );
    expect(required.status).toBe(400);
    expect(required.body.issues).toContainEqual(expect.objectContaining({ path: "values.title" }));
  });

  test("returns machine-readable trait validation failures", async () => {
    const appId = await createIdeasApp({
      ...ideasDefinition,
      models: {
        idea: {
          columns: {
            ...ideasDefinition.models.idea.columns,
            due: { kind: "date" },
          },
        },
      },
    });
    for (const values of [
      { title: "Bad votes", votes: "many" },
      { title: "Bad status", status: "blocked" },
      { votes: 1 },
      { title: "Bad date", due: "1" },
      { title: "Prototype", toString: "not a column" },
    ]) {
      const result = await request<{ issues: Array<{ path: string; message: string }> }>(
        `/api/apps/${appId}/models/idea/rows`,
        { method: "POST", body: JSON.stringify({ values }) },
      );
      expect(result.status).toBe(400);
      expect(result.body.issues[0]?.path).toStartWith("values.");
    }
  });

  test("rewrites and removes secondary index rows", async () => {
    const appId = await createIdeasApp();
    const created = await request<{ row: { id: string } }>(`/api/apps/${appId}/models/idea/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { title: "Indexed" } }),
    });
    const rowId = created.body.row.id;
    const namespace = appsNamespace(appId);
    const openKey = appIndexKey("idea", "status", "open", rowId);
    const doneKey = appIndexKey("idea", "status", "done", rowId);
    expect(getKv(namespace, openKey)).not.toBeNull();

    await request(`/api/apps/${appId}/models/idea/rows/${rowId}`, {
      method: "PATCH",
      body: JSON.stringify({ values: { status: "done" } }),
    });
    expect(getKv(namespace, openKey)).toBeNull();
    expect(getKv(namespace, doneKey)).not.toBeNull();

    await request(`/api/apps/${appId}/models/idea/rows/${rowId}`, { method: "DELETE" });
    expect(getKv(namespace, doneKey)).toBeNull();

    const escapedDefinition = {
      ...ideasDefinition,
      models: {
        idea: {
          columns: {
            ...ideasDefinition.models.idea.columns,
            notes: { kind: "string", index: true },
            toString: { kind: "string", index: true },
          },
        },
      },
    };
    const escapedAppId = await createIdeasApp(escapedDefinition);
    const escapedValue = "tilde~and-lone-surrogate-\ud800";
    const escaped = await request<{ row: { id: string } }>(
      `/api/apps/${escapedAppId}/models/idea/rows`,
      {
        method: "POST",
        body: JSON.stringify({ values: { title: "Escaped", notes: escapedValue } }),
      },
    );
    const escapedKey = appIndexKey("idea", "notes", escapedValue, escaped.body.row.id);
    expect(escapedKey).toMatch(/^[a-zA-Z0-9._:/%-]{1,512}$/);
    expect(getKv(appsNamespace(escapedAppId), escapedKey)).not.toBeNull();
    expect(countKv(appsNamespace(escapedAppId), { prefix: "idea/idx/toString/" })).toBe(0);
  });

  test("row delete removes exactly the deleted row's computed index keys", async () => {
    const appId = await createIdeasApp({
      ...ideasDefinition,
      models: {
        idea: {
          columns: {
            ...ideasDefinition.models.idea.columns,
            notes: { kind: "string", index: true },
          },
        },
      },
    });
    const first = await request<{ row: { id: string } }>(`/api/apps/${appId}/models/idea/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { title: "First", notes: "shared" } }),
    });
    const second = await request<{ row: { id: string } }>(`/api/apps/${appId}/models/idea/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { title: "Second", notes: "shared" } }),
    });
    const namespace = appsNamespace(appId);
    expect(countKv(namespace, { prefix: "idea/idx/" })).toBe(4);

    const deleted = await request(`/api/apps/${appId}/models/idea/rows/${first.body.row.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(countKv(namespace, { prefix: "idea/idx/" })).toBe(2);
    expect(getKv(namespace, appIndexKey("idea", "status", "open", first.body.row.id))).toBeNull();
    expect(getKv(namespace, appIndexKey("idea", "notes", "shared", first.body.row.id))).toBeNull();
    expect(
      getKv(namespace, appIndexKey("idea", "status", "open", second.body.row.id)),
    ).not.toBeNull();
    expect(
      getKv(namespace, appIndexKey("idea", "notes", "shared", second.body.row.id)),
    ).not.toBeNull();
  });

  test("serializes concurrent creates without losing rows or indexes", async () => {
    const appId = await createIdeasApp();
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        request(`/api/apps/${appId}/models/idea/rows`, {
          method: "POST",
          body: JSON.stringify({ values: { title: `Idea ${index}` } }),
        }),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(countKv(appsNamespace(appId), { prefix: "idea/row/" })).toBe(30);
    expect(countKv(appsNamespace(appId), { prefix: "idea/idx/status/open/" })).toBe(30);
  });

  test("same-millisecond creates preserve creation order when sorted by createdAt", async () => {
    const appId = await createIdeasApp();
    const app = getApp(appId);
    if (!app) throw new Error("created app missing");
    const model = app.definition.models.idea!;
    const originalDateNow = Date.now;
    const fixedNow = originalDateNow();

    try {
      Date.now = () => fixedNow;
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          createAppRow(appId, "idea", model, { title: `Burst ${index}` }),
        ),
      );
    } finally {
      Date.now = originalDateNow;
    }

    const listed = await request<{ rows: Array<{ title: string; createdAt: string }> }>(
      `/api/apps/${appId}/models/idea/rows?sort=createdAt:asc`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.rows.map((row) => row.title)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Burst ${index}`),
    );
    expect(new Set(listed.body.rows.map((row) => row.createdAt)).size).toBe(20);
  });

  test("rejects empty and non-decimal numeric filters", async () => {
    const appId = await createIdeasApp();
    for (const raw of ["", "0x10"]) {
      const result = await request<{ error: string; issues: Array<{ path: string }> }>(
        `/api/apps/${appId}/models/idea/rows?filter.votes=${raw}`,
      );
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid row query");
      expect(result.body.issues).toContainEqual(expect.objectContaining({ path: "filter.votes" }));
    }
  });

  test("runs named queries with filter, sort, and limit", async () => {
    const definition = {
      ...ideasDefinition,
      queries: {
        topOpen: {
          model: "idea",
          filter: { status: "open" },
          sort: { column: "votes", dir: "desc" },
          limit: 2,
        },
      },
    };
    const appId = await createIdeasApp(definition);
    for (const values of [
      { title: "One", votes: 1 },
      { title: "Three", votes: 3, notes: "z" },
      { title: "Two", votes: 2, notes: "a" },
      { title: "Done", votes: 99, status: "done" },
    ]) {
      await request(`/api/apps/${appId}/models/idea/rows`, {
        method: "POST",
        body: JSON.stringify({ values }),
      });
    }
    const result = await request<{ rows: Array<{ title: string }> }>(
      `/api/apps/${appId}/queries/topOpen`,
    );
    expect(result.status).toBe(200);
    expect(result.body.rows.map((row) => row.title)).toEqual(["Three", "Two"]);

    const listed = await request<{ rows: Array<{ title: string }>; total: number }>(
      `/api/apps/${appId}/models/idea/rows?filter.status=open&sort=votes:desc&limit=1`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(3);
    expect(listed.body.rows.map((row) => row.title)).toEqual(["Three"]);

    const repeatedFilters = await request<{ rows: Array<{ title: string }>; total: number }>(
      `/api/apps/${appId}/models/idea/rows?filter.status=open&filter.votes=2`,
    );
    expect(repeatedFilters.body).toEqual({
      rows: [expect.objectContaining({ title: "Two" })],
      total: 1,
    });

    const missingLast = await request<{ rows: Array<{ title: string }> }>(
      `/api/apps/${appId}/models/idea/rows?filter.status=open&sort=notes:desc`,
    );
    expect(missingLast.body.rows.map((row) => row.title)).toEqual(["Three", "Two", "One"]);
    expect((await request(`/api/apps/${appId}/models/idea/rows?limit=1001`)).status).toBe(400);
  });

  test("PUT returns 404 after the app is deleted", async () => {
    const appId = await createIdeasApp();
    expect((await request(`/api/apps/${appId}`, { method: "DELETE" })).status).toBe(200);

    const result = await request(`/api/apps/${appId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Too late" }),
    });
    expect(result.status).toBe(404);
  });

  test("DELETE succeeds for an app whose stored definition is broken", async () => {
    const appId = await createIdeasApp();
    await request(`/api/apps/${appId}/models/idea/rows`, {
      method: "POST",
      body: JSON.stringify({ values: { title: "Orphaned by corruption" } }),
    });
    // Simulate a legacy/manually corrupted row: DELETE is the recovery path and
    // must not depend on the definition parsing.
    getDb().run("UPDATE apps SET definition = ? WHERE id = ?", ["{not json", appId]);

    const deleted = await request<{ ok: boolean }>(`/api/apps/${appId}`, { method: "DELETE" });
    expect(deleted).toEqual({ status: 200, body: { ok: true } });
    expect(countKv(appsNamespace(appId), {})).toBe(0);
    expect((await request(`/api/apps/${appId}`)).status).toBe(404);
  });

  test("deleting an app purges every row and index key", async () => {
    const appId = await createIdeasApp();
    await Promise.all(
      ["A", "B", "C"].map((title) =>
        request(`/api/apps/${appId}/models/idea/rows`, {
          method: "POST",
          body: JSON.stringify({ values: { title } }),
        }),
      ),
    );
    expect(countKv(appsNamespace(appId), {})).toBeGreaterThan(0);
    const deleted = await request<{ ok: boolean }>(`/api/apps/${appId}`, { method: "DELETE" });
    expect(deleted).toEqual({ status: 200, body: { ok: true } });
    expect(countKv(appsNamespace(appId), {})).toBe(0);
    expect((await request(`/api/apps/${appId}`)).status).toBe(404);
  });

  test("a mutation queued during app purge cannot recreate orphan KV rows", async () => {
    const appId = await createIdeasApp();
    const app = getApp(appId);
    if (!app) throw new Error("created app missing");
    const model = app.definition.models.idea!;
    let lateCreateOutcome: Promise<boolean> | undefined;

    await purgeAppRows(appId, ["idea"], () => {
      expect(deleteApp(appId)).toBe(true);
      lateCreateOutcome = createAppRow(appId, "idea", model, { title: "Too late" }).then(
        () => false,
        () => true,
      );
    });

    expect(lateCreateOutcome).toBeDefined();
    expect(await lateCreateOutcome).toBe(true);
    expect(countKv(appsNamespace(appId), {})).toBe(0);
  });
});
