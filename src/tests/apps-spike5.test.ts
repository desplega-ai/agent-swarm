import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseAppDefinition } from "../apps/definition";
import {
  appIndexKey,
  appsNamespace,
  createAppRow,
  getAppRow,
  listAppRows,
  withMutationLock,
} from "../apps/row-store";
import { migrateAppSchema, withAppDefinitionLock } from "../apps/schema-migrate";
import { getApp, updateApp } from "../apps/store";
import { closeDb, countKv, createAgent, getDb, getKv, initDb, upsertKv } from "../be/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerAppDiffTool } from "../tools/app-diff";
import { registerAppHistoryTool } from "../tools/app-history";
import { registerAppPatchTool } from "../tools/app-patch";
import { registerAppRollbackTool } from "../tools/app-rollback";
import { registerAppUpsertTool } from "../tools/app-upsert";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

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

const migrationDefinition = {
  ...definition,
  models: {
    note: {
      columns: {
        title: { kind: "string", index: true },
        status: { kind: "enum", enum: ["open", "urgent"] },
      },
    },
  },
};

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StructuredResult<T> = {
  isError?: boolean;
  structuredContent: T;
};

function registeredTools(
  registrars: Array<(server: McpServer) => void>,
): Record<string, RegisteredTool> {
  const toolServer = new McpServer({ name: "apps-spike5-test", version: "1.0.0" });
  for (const register of registrars) register(toolServer);
  return (toolServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function toolMeta() {
  return {
    sessionId: "apps-spike5",
    requestInfo: { headers: { "x-agent-id": AGENT_ID } },
  };
}

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

async function createRow(
  appId: string,
  values: Record<string, unknown>,
): Promise<{ id: string; createdAt: string; updatedAt: string; updatedBy?: string }> {
  const result = await request<{
    row: { id: string; createdAt: string; updatedAt: string; updatedBy?: string };
  }>(`/api/apps/${appId}/models/note/rows`, {
    method: "POST",
    body: JSON.stringify({ values }),
  });
  expect(result.status).toBe(201);
  return result.body.row;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  createAgent({ id: AGENT_ID, name: "apps-spike5-worker", isLead: false, status: "idle" });
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

  test("rolls back a hidden column losslessly and snapshots the pre-rollback state", async () => {
    const appId = await createApp();
    const row = await createRow(appId, { title: "Preserved" });
    const hidden = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: { kind: "string", hidden: true } } } } },
      }),
    });
    expect(hidden.status).toBe(200);
    expect(getAppRow(appId, "note", row.id)?.title).toBe("Preserved");

    const rolledBack = await request<{
      app: {
        definition: { models: { note: { columns: { title: { hidden?: boolean } } } } };
      };
      migration: { scanned: number };
    }>(`/api/apps/${appId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body.app.definition.models.note.columns.title.hidden).toBeUndefined();
    expect(rolledBack.body.migration.scanned).toBe(1);
    expect(getAppRow(appId, "note", row.id)?.title).toBe("Preserved");

    const versions = await request<{
      versions: Array<{ version: number; snapshot: { definition: { models: unknown } } }>;
    }>(`/api/apps/${appId}/versions`);
    expect(versions.body.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions.body.versions[0]?.snapshot.definition).toMatchObject({
      models: { note: { columns: { title: { hidden: true } } } },
    });
  });

  test("requires a migration directive for lossy rollback and succeeds when retried", async () => {
    const appId = await createApp();
    const row = await createRow(appId, { title: "12" });
    const changed = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: { kind: "number" } } } } },
        migration: { title: { coerce: true } },
      }),
    });
    expect(changed.status).toBe(200);
    expect(getAppRow(appId, "note", row.id)?.title).toBe(12);

    const rejected = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}/rollback`,
      { method: "POST", body: JSON.stringify({ version: 1 }) },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.issues).toContainEqual(
      expect.objectContaining({ path: "models.note.columns.title" }),
    );
    expect(getApp(appId)?.definition.models.note?.columns.title?.kind).toBe("number");

    const restored = await request<{ migration: { coerced: number } }>(
      `/api/apps/${appId}/rollback`,
      {
        method: "POST",
        body: JSON.stringify({ version: 1, migration: { title: { coerce: true } } }),
      },
    );
    expect(restored.status).toBe(200);
    expect(restored.body.migration.coerced).toBe(1);
    expect(getAppRow(appId, "note", row.id)?.title).toBe("12");
  });

  test("rolls back a definitionError app while preserving rows and reporting orphans", async () => {
    const appId = await createApp();
    const created = await createRow(appId, { title: "Repair me" });
    const initialWrite = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "creates the good snapshot" }),
    });
    expect(initialWrite.status).toBe(200);
    const row = getAppRow(appId, "note", created.id)!;
    upsertKv({
      namespace: appsNamespace(appId),
      key: `note/row/${created.id}`,
      value: { ...row, legacyPayload: "keep" },
      valueType: "json",
    });
    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run(JSON.stringify({ models: "broken" }), appId);

    const restored = await request<{
      app: { definitionError?: unknown; definition: { models: { note: unknown } } };
      migration: { orphanFields: string[] };
    }>(`/api/apps/${appId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(restored.status).toBe(200);
    expect(restored.body.app.definitionError).toBeUndefined();
    expect(restored.body.app.definition.models.note).toBeDefined();
    expect(restored.body.migration.orphanFields).toEqual(["legacyPayload"]);
    expect(getAppRow(appId, "note", created.id)).toMatchObject({
      title: "Repair me",
      legacyPayload: "keep",
    });
  });

  test("rejects an invalid target snapshot with non-migration remediation and no writes", async () => {
    const appId = await createApp();
    const before = getApp(appId);
    const invalidSnapshotDefinition = structuredClone(definition) as any;
    invalidSnapshotDefinition.pages.main.elements.root = {
      type: "Table",
      props: {
        data: { $state: "/queries/allNotes/data" },
        columns: [{ key: "missing" }],
      },
    };
    getDb()
      .prepare(
        `INSERT INTO app_versions (id, appId, version, snapshot, changedByAgentId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        appId,
        1,
        JSON.stringify({
          name: "Broken snapshot",
          description: null,
          definition: invalidSnapshotDefinition,
        }),
        AGENT_ID,
        new Date().toISOString(),
      );
    const expectedMessage =
      "target snapshot v1's definition is invalid under current validation; migration directives cannot fix it — choose a different version with app-history";

    const rejected = await request<{
      error: string;
      issues: Array<{ path: string; message: string }>;
    }>(`/api/apps/${appId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe(expectedMessage);
    expect(rejected.body.issues).toContainEqual(
      expect.objectContaining({ path: "pages.main.elements.root.props.columns.0.key" }),
    );

    const tools = registeredTools([registerAppRollbackTool]);
    const toolRejected = (await tools["app-rollback"]!.handler(
      { appId, version: 1, migration: { missing: { purge: true } } },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      message: string;
      issues: Array<{ path: string; message: string }>;
    }>;
    expect(toolRejected.isError).toBe(true);
    expect(toolRejected.structuredContent.message).toBe(expectedMessage);
    expect(toolRejected.structuredContent.issues).toEqual(rejected.body.issues);

    expect(getApp(appId)).toEqual(before);
    expect(
      getDb().query("SELECT COUNT(*) AS count FROM app_versions WHERE appId = ?").get(appId) as {
        count: number;
      },
    ).toEqual({ count: 1 });
  });

  test("round-trips app history, diff, and rollback tools including snapshot failure", async () => {
    const appId = await createApp();
    const tools = registeredTools([
      registerAppHistoryTool,
      registerAppDiffTool,
      registerAppRollbackTool,
    ]);
    const changed = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { body: { kind: "string" } } } } },
      }),
    });
    expect(changed.status).toBe(200);

    const history = (await tools["app-history"]!.handler(
      { appId },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      versions: Array<{ version: number }>;
      details: string;
    }>;
    expect(history.structuredContent.success).toBe(true);
    expect(history.structuredContent.versions.map((version) => version.version)).toEqual([1]);
    expect(history.structuredContent.details).toContain("note (1 columns)");

    const diff = (await tools["app-diff"]!.handler(
      { appId, from: 1 },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      diff: string;
    }>;
    expect(diff.structuredContent.success).toBe(true);
    expect(diff.structuredContent.diff).toContain('+        "body": {');

    const rolledBack = (await tools["app-rollback"]!.handler(
      { appId, version: 1 },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; app: { name: string } }>;
    expect(rolledBack.structuredContent.success).toBe(true);
    expect(rolledBack.structuredContent.app.name).toBe("Spike 5");

    const cleanDiff = (await tools["app-diff"]!.handler(
      { appId, from: 1 },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      diff: string;
    }>;
    expect(cleanDiff.structuredContent.diff).toBe("(no differences)");

    getDb().run(`
      CREATE TRIGGER fail_rollback_snapshot
      BEFORE INSERT ON app_versions
      BEGIN SELECT RAISE(FAIL, 'snapshot intentionally failed'); END;
    `);
    const failed = (await tools["app-rollback"]!.handler(
      { appId, version: 2 },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; message: string }>;
    getDb().run("DROP TRIGGER fail_rollback_snapshot");
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent.message).toStartWith("Failed to snapshot app");
    expect(getApp(appId)?.name).toBe("Spike 5");
  });

  test("diffs two explicit historical app versions with unambiguous output labels", async () => {
    const appId = await createApp();
    expect(
      (
        await request(`/api/apps/${appId}`, {
          method: "PATCH",
          body: JSON.stringify({
            definition: { models: { note: { columns: { body: { kind: "string" } } } } },
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/apps/${appId}`, {
          method: "PATCH",
          body: JSON.stringify({
            definition: { models: { note: { columns: { category: { kind: "string" } } } } },
          }),
        })
      ).status,
    ).toBe(200);

    const tools = registeredTools([registerAppDiffTool]);
    const historicalDiff = (await tools["app-diff"]!.handler(
      { appId, from: 1, to: 2 },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      fromLabel: string;
      toLabel: string;
      diff: string;
    }>;
    expect(historicalDiff.isError).not.toBe(true);
    expect(historicalDiff.structuredContent).toMatchObject({
      success: true,
      fromLabel: "v1",
      toLabel: "v2",
    });
    expect(historicalDiff.structuredContent.diff).toContain("--- v1");
    expect(historicalDiff.structuredContent.diff).toContain("+++ v2");
    expect(historicalDiff.structuredContent.diff).toContain('+        "body": {');
    expect(historicalDiff.structuredContent.diff).not.toContain("CURRENT");
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

  test("rejects unknown top-level keys while accepting the userConfig definition surface", async () => {
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

    const userConfigSurface = await request("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        name: "Future surface",
        definition: { ...definition, userConfig: {} },
      }),
    });
    expect(userConfigSurface.status).toBe(201);

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

  test("hides and unhides columns without rewriting rows and blocks hidden use or name reuse", async () => {
    const appId = await createApp(migrationDefinition);
    const row = await createRow(appId, { title: "Keep me", status: "open" });
    const namespace = appsNamespace(appId);
    const rowKey = `note/row/${row.id}`;
    const rawBefore = getDb()
      .prepare<{ value: string }, [string, string]>(
        "SELECT value FROM kv_entries WHERE namespace = ? AND key = ?",
      )
      .get(namespace, rowKey)!.value;

    const hidden = await request<{
      migration: { scanned: number; idxRebuilt: number };
    }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            note: {
              columns: { title: { kind: "string", index: true, hidden: true } },
            },
          },
        },
      }),
    });
    expect(hidden.status).toBe(200);
    expect(hidden.body.migration).toMatchObject({ scanned: 1, idxRebuilt: 1 });
    expect(
      getDb()
        .prepare<{ value: string }, [string, string]>(
          "SELECT value FROM kv_entries WHERE namespace = ? AND key = ?",
        )
        .get(namespace, rowKey)!.value,
    ).toBe(rawBefore);
    expect(getKv(namespace, appIndexKey("note", "title", "Keep me", row.id))).toBeNull();

    expect(
      (await request(`/api/apps/${appId}/models/note/rows?filter.title=Keep%20me`)).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/apps/${appId}/models/note/rows/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ values: { title: "No" } }),
        })
      ).status,
    ).toBe(400);

    const reused = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: { models: { note: { columns: { title: { kind: "number" } } } } },
        }),
      },
    );
    expect(reused.status).toBe(400);
    expect(reused.body.issues).toContainEqual({
      path: "models.note.columns.title",
      message:
        "name is held by hidden column — unhide it exactly, or remove it with migration.title {purge:true}",
    });

    const unhidden = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: { note: { columns: { title: { kind: "string", index: true } } } },
        },
      }),
    });
    expect(unhidden.status).toBe(200);
    expect(getKv(namespace, appIndexKey("note", "title", "Keep me", row.id))).not.toBeNull();
    expect(
      getDb()
        .prepare<{ value: string }, [string, string]>(
          "SELECT value FROM kv_entries WHERE namespace = ? AND key = ?",
        )
        .get(namespace, rowKey)!.value,
    ).toBe(rawBefore);
  });

  test("removes a populated hidden column with one purge-backed patch", async () => {
    const appId = await createApp(migrationDefinition);
    const row = await createRow(appId, { title: "Remove me", status: "open" });
    const namespace = appsNamespace(appId);
    const hidden = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            note: { columns: { title: { kind: "string", index: true, hidden: true } } },
          },
        },
      }),
    });
    expect(hidden.status).toBe(200);

    const removed = await request<{ migration: { purgedValues: number; idxRebuilt: number } }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: { models: { note: { columns: { title: null } } } },
          migration: { title: { purge: true } },
        }),
      },
    );

    expect(removed.status).toBe(200);
    expect(removed.body.migration).toMatchObject({ purgedValues: 1, idxRebuilt: 1 });
    expect(getAppRow(appId, "note", row.id)).not.toHaveProperty("title");
    expect(countKv(namespace, { prefix: "note/idx/title/" })).toBe(0);
    expect(getApp(appId)?.definition.models.note?.columns).not.toHaveProperty("title");

    const emptyAppId = await createApp({
      ...migrationDefinition,
      models: {
        note: {
          columns: {
            ...migrationDefinition.models.note.columns,
            title: { kind: "string", index: true, hidden: true },
          },
        },
      },
    });
    const emptyRemoval = await request(`/api/apps/${emptyAppId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: null } } } },
      }),
    });
    expect(emptyRemoval.status).toBe(200);
  });

  test("rejects hidden fields across inferable page bindings while keeping system fields display-only", () => {
    const candidate = structuredClone(migrationDefinition) as any;
    candidate.models.note.columns.secret = { kind: "string", hidden: true };
    candidate.pages.main = {
      root: "root",
      elements: {
        root: {
          type: "Stack",
          props: {},
          children: ["direct", "table", "detail", "form"],
        },
        direct: {
          type: "Text",
          props: { content: { $state: "/queries/allNotes/data/0/secret" } },
        },
        table: {
          type: "Table",
          props: {
            data: { $state: "/queries/allNotes/data" },
            columns: [{ key: "secret" }, { key: "id" }],
            filters: { secret: "hidden" },
            rowActions: [
              {
                label: "Update",
                actions: [
                  {
                    action: "app.mutate",
                    params: {
                      model: "note",
                      op: "update",
                      rowId: { $row: "secret" },
                      values: { title: { $row: "secret" } },
                    },
                  },
                ],
              },
            ],
          },
        },
        detail: {
          type: "DetailList",
          props: {
            data: { $state: "/queries/allNotes/data/0" },
            fields: [{ key: "secret" }, { key: "id" }],
          },
        },
        form: {
          type: "Form",
          props: {
            id: "editNote",
            fields: [{ name: "secret" }, { name: "id" }, { name: "title" }],
            onSubmit: [
              {
                action: "app.mutate",
                params: {
                  model: "note",
                  op: "create",
                  values: { $form: "" },
                },
              },
            ],
          },
        },
      },
    };

    const parsed = parseAppDefinition(candidate);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.issues.map((item) => item.path);
    expect(paths).toContain("pages.main.elements.direct.props.content");
    expect(paths).toContain("pages.main.elements.table.props.columns.0.key");
    expect(paths).not.toContain("pages.main.elements.table.props.columns.1.key");
    expect(paths).toContain("pages.main.elements.table.props.filters.secret");
    expect(paths).toContain(
      "pages.main.elements.table.props.rowActions.0.actions.0.params.rowId.$row",
    );
    expect(paths).toContain(
      "pages.main.elements.table.props.rowActions.0.actions.0.params.values.title.$row",
    );
    expect(paths).toContain("pages.main.elements.detail.props.fields.0.key");
    expect(paths).not.toContain("pages.main.elements.detail.props.fields.1.key");
    expect(paths).toContain("pages.main.elements.form.props.fields.0.name");
    expect(paths).toContain("pages.main.elements.form.props.fields.1.name");
    expect(paths).not.toContain("pages.main.elements.form.props.fields.2.name");
  });

  test("rejects missing required values on unhide but keeps satisfied unhide metadata-only", async () => {
    const hiddenRequiredDefinition = {
      ...migrationDefinition,
      models: {
        note: {
          columns: {
            ...migrationDefinition.models.note.columns,
            category: {
              kind: "string",
              required: true,
              default: "general",
              hidden: true,
            },
          },
        },
      },
    };
    const appId = await createApp(hiddenRequiredDefinition);
    const created = await createRow(appId, { title: "No hidden value", status: "open" });
    const rejected = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: {
            models: {
              note: {
                columns: {
                  category: { kind: "string", required: true, default: "general" },
                },
              },
            },
          },
        }),
      },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.issues).toContainEqual({
      path: "models.note.columns.category",
      message:
        "unhiding required column would leave 1 row without a value — provide migration.category {set: ...} or unhide without required",
    });
    expect(getAppRow(appId, "note", created.id)).not.toHaveProperty("category");
    expect(getApp(appId)?.definition.models.note?.columns.category?.hidden).toBe(true);

    const satisfiedDefinition = structuredClone(hiddenRequiredDefinition);
    satisfiedDefinition.models.note.columns.category.hidden = false;
    const satisfiedAppId = await createApp(satisfiedDefinition);
    const satisfied = await createRow(satisfiedAppId, {
      title: "Has hidden value",
      status: "open",
      category: "assigned",
    });
    const namespace = appsNamespace(satisfiedAppId);
    const storedKey = `note/row/${satisfied.id}`;
    const rawBefore = getDb()
      .prepare<{ value: string }, [string, string]>(
        "SELECT value FROM kv_entries WHERE namespace = ? AND key = ?",
      )
      .get(namespace, storedKey)!.value;

    const hidden = await request(`/api/apps/${satisfiedAppId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            note: {
              columns: {
                category: {
                  kind: "string",
                  required: true,
                  default: "general",
                  hidden: true,
                },
              },
            },
          },
        },
      }),
    });
    expect(hidden.status).toBe(200);

    const unhidden = await request<{ migration: { backfilled: number } }>(
      `/api/apps/${satisfiedAppId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: {
            models: {
              note: {
                columns: {
                  category: { kind: "string", required: true, default: "general" },
                },
              },
            },
          },
        }),
      },
    );
    expect(unhidden.status).toBe(200);
    expect(unhidden.body.migration.backfilled).toBe(0);
    expect(
      getDb()
        .prepare<{ value: string }, [string, string]>(
          "SELECT value FROM kv_entries WHERE namespace = ? AND key = ?",
        )
        .get(namespace, storedKey)!.value,
    ).toBe(rawBefore);
  });

  test("rejects system-field directives without treating system fields as orphans", async () => {
    const appId = await createApp(migrationDefinition);
    await createRow(appId, { title: "System owned", status: "open" });

    const result = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ migration: { id: { purge: true } } }),
      },
    );

    expect(result.status).toBe(400);
    expect(result.body.issues).toContainEqual({
      path: "migration.id",
      message: 'system field "id" cannot be migrated or purged',
    });
  });

  test("applies flat directives only to changed target models, not visible same-name siblings", async () => {
    const initial = {
      ...definition,
      models: {
        note: { columns: { flag: { kind: "string" } } },
        ticket: { columns: { priority: { kind: "string" } } },
      },
      queries: { allNotes: { model: "note" } },
    };
    const appId = await createApp(initial);
    const note = await createRow(appId, { flag: "urgent" });
    const ticketResult = await request<{ row: { id: string } }>(
      `/api/apps/${appId}/models/ticket/rows`,
      {
        method: "POST",
        body: JSON.stringify({ values: { priority: "leave-alone" } }),
      },
    );
    expect(ticketResult.status).toBe(201);

    const applied = await request<{ migration: { mapped: number } }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            note: {
              columns: { priority: { kind: "string", required: true } },
            },
          },
        },
        migration: { priority: { from: "flag", else: "none" } },
      }),
    });

    expect(applied.status).toBe(200);
    expect(applied.body.migration.mapped).toBe(1);
    expect(getAppRow(appId, "note", note.id)?.priority).toBe("urgent");
    expect(getAppRow(appId, "ticket", ticketResult.body.row.id)?.priority).toBe("leave-alone");
  });

  test("rejects from chains but uses else for absent and target-incompatible sources", async () => {
    const appId = await createApp({
      ...definition,
      models: { note: { columns: { flag: { kind: "string" } } } },
    });
    const absent = await createRow(appId, {});
    const incompatible = await createRow(appId, { flag: "not-a-number" });

    const chained = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: {
            models: {
              note: {
                columns: {
                  priority: { kind: "string" },
                  flag: { kind: "string", hidden: true },
                },
              },
            },
          },
          migration: {
            priority: { from: "flag", else: "none" },
            flag: { purge: true },
          },
        }),
      },
    );
    expect(chained.status).toBe(400);
    expect(chained.body.issues).toContainEqual({
      path: "migration.priority.from",
      message: 'from chains are not supported: source column "flag" also has a migration directive',
    });

    const applied = await request<{ migration: { elsed: number; mapped: number } }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: {
            models: {
              note: { columns: { score: { kind: "number", required: true } } },
            },
          },
          migration: { score: { from: "flag", else: 7 } },
        }),
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.migration).toMatchObject({ elsed: 2, mapped: 0 });
    expect(getAppRow(appId, "note", absent.id)?.score).toBe(7);
    expect(getAppRow(appId, "note", incompatible.id)?.score).toBe(7);
  });

  test("migration scans every row and removes every stale index entry beyond the list cap", async () => {
    const appId = await createApp(migrationDefinition);
    const namespace = appsNamespace(appId);
    const total = 100_001;
    const db = getDb();
    db.run(
      `WITH RECURSIVE seq(value) AS (
         SELECT 0 UNION ALL SELECT value + 1 FROM seq WHERE value < ${total - 1}
       )
       INSERT INTO kv_entries (namespace, key, value, value_type)
       SELECT '${namespace}',
              'note/row/bulk-' || printf('%06d', value),
              '{"id":"bulk-' || printf('%06d', value) || '","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","title":"bulk","status":"open"}',
              'json'
       FROM seq`,
    );
    db.run(
      `WITH RECURSIVE seq(value) AS (
         SELECT 0 UNION ALL SELECT value + 1 FROM seq WHERE value < ${total - 1}
       )
       INSERT INTO kv_entries (namespace, key, value, value_type)
       SELECT '${namespace}',
              'note/idx/title/bulk/bulk-' || printf('%06d', value),
              '"1"',
              'json'
       FROM seq`,
    );

    expect(listAppRows(appId, "note")).toHaveLength(100_000);
    const hidden = await request<{ migration: { scanned: number } }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            note: { columns: { title: { kind: "string", index: true, hidden: true } } },
          },
        },
      }),
    });
    expect(hidden.status).toBe(200);
    expect(hidden.body.migration.scanned).toBe(total);
    expect(
      db
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM kv_entries WHERE namespace = ? AND key LIKE 'note/idx/title/%'",
        )
        .get(namespace)!.count,
    ).toBe(0);
  }, 60_000); // inserts + scans 200k kv rows; >10 s on a loaded 4-core CI runner under --parallel=4

  test("hard-deletes only empty columns unless purge is explicit and preserves timestamps", async () => {
    const appId = await createApp({
      ...migrationDefinition,
      models: {
        note: {
          columns: {
            ...migrationDefinition.models.note.columns,
            empty: { kind: "string" },
          },
        },
      },
    });
    const created = await createRow(appId, { title: "Destroy explicitly", status: "urgent" });

    const emptyDelete = await request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { empty: null } } } },
      }),
    });
    expect(emptyDelete.status).toBe(200);

    const versionsBefore = getDb()
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM app_versions WHERE appId = ?",
      )
      .get(appId)!.count;
    const rejected = await request<{ issues: Array<{ message: string }> }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: null } } } },
      }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.issues.some((issue) => issue.message.includes("1 row"))).toBe(true);
    expect(
      getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM app_versions WHERE appId = ?",
        )
        .get(appId)!.count,
    ).toBe(versionsBefore);

    const purged = await request<{
      migration: { purgedValues: number; idxRebuilt: number };
    }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: null } } } },
        migration: { title: { purge: true } },
      }),
    });
    expect(purged.status).toBe(200);
    expect(purged.body.migration).toMatchObject({ purgedValues: 1, idxRebuilt: 1 });
    const stored = getAppRow(appId, "note", created.id)!;
    expect(stored).not.toHaveProperty("title");
    expect(stored.updatedAt).toBe(created.updatedAt);
    expect(stored.updatedBy).toBe(created.updatedBy);
    expect(countKv(appsNamespace(appId), { prefix: "note/idx/title/" })).toBe(0);
  });

  test("dry-runs kind changes with counts then coerces with else without touching freshness", async () => {
    const appId = await createApp(migrationDefinition);
    const numeric = await createRow(appId, { title: "12", status: "open" });
    const invalid = await createRow(appId, { title: "not-a-number", status: "open" });
    const absent = await createRow(appId, { status: "open" });

    const dryRun = await request<{ issues: Array<{ message: string }> }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: { kind: "number" } } } } },
      }),
    });
    expect(dryRun.status).toBe(400);
    expect(dryRun.body.issues.some((issue) => issue.message.includes('1 row holds "12"'))).toBe(
      true,
    );
    expect(
      dryRun.body.issues.some((issue) => issue.message.includes('1 row holds "not-a-number"')),
    ).toBe(true);

    const withoutElse = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: { models: { note: { columns: { title: { kind: "number" } } } } },
          migration: { title: { coerce: true } },
        }),
      },
    );
    expect(withoutElse.status).toBe(400);
    expect(withoutElse.body.issues).toContainEqual({
      path: "migration.title",
      message:
        '1 row cannot migrate "not-a-number" in models.note.columns.title — provide an else value',
    });
    expect(getAppRow(appId, "note", absent.id)).not.toHaveProperty("title");

    const invalidElse = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: { models: { note: { columns: { title: { kind: "number" } } } } },
          migration: { title: { coerce: true, else: "fallback" } },
        }),
      },
    );
    expect(invalidElse.status).toBe(400);
    expect(
      invalidElse.body.issues.some((issue) =>
        issue.message.includes(
          'provided else value "fallback" is invalid for models.note.columns.title',
        ),
      ),
    ).toBe(true);

    const applied = await request<{
      migration: { coerced: number; elsed: number; scanned: number };
    }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: { kind: "number" } } } } },
        migration: { title: { coerce: true, else: null } },
      }),
    });
    expect(applied.status).toBe(200);
    expect(applied.body.migration).toMatchObject({ coerced: 1, elsed: 1, scanned: 3 });
    expect(getAppRow(appId, "note", numeric.id)).toMatchObject({
      title: 12,
      updatedAt: numeric.updatedAt,
      updatedBy: numeric.updatedBy,
    });
    const invalidStored = getAppRow(appId, "note", invalid.id)!;
    expect(invalidStored).not.toHaveProperty("title");
    expect(invalidStored.updatedAt).toBe(invalid.updatedAt);
    expect(invalidStored.updatedBy).toBe(invalid.updatedBy);
  });

  test("coerce to a required column fills missing rows from else or fails loudly", async () => {
    const appId = await createApp(migrationDefinition);
    const present = await createRow(appId, { title: "12", status: "open" });
    const absent = await createRow(appId, { status: "open" });
    const requiredNumber = {
      models: { note: { columns: { title: { kind: "number", required: true } } } },
    };

    // Without else the missing row must surface as unresolved, not be skipped.
    const withoutElse = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: requiredNumber,
          migration: { title: { coerce: true } },
        }),
      },
    );
    expect(withoutElse.status).toBe(400);
    expect(
      withoutElse.body.issues.some(
        (issue) => issue.path === "migration.title" && issue.message.includes("provide an else"),
      ),
    ).toBe(true);
    expect(getAppRow(appId, "note", absent.id)).not.toHaveProperty("title");

    // With else the missing row is filled, so required holds on every row.
    const applied = await request<{
      migration: { coerced: number; elsed: number; scanned: number };
    }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: requiredNumber,
        migration: { title: { coerce: true, else: 0 } },
      }),
    });
    expect(applied.status).toBe(200);
    expect(applied.body.migration).toMatchObject({ coerced: 1, elsed: 1, scanned: 2 });
    expect(getAppRow(appId, "note", present.id)).toMatchObject({ title: 12 });
    expect(getAppRow(appId, "note", absent.id)).toMatchObject({ title: 0 });

    // An optional target still leaves absent rows absent (no materialized else).
    const optionalApp = await createApp(migrationDefinition);
    const optionalAbsent = await createRow(optionalApp, { status: "open" });
    const optionalApplied = await request<{ migration: { elsed: number } }>(
      `/api/apps/${optionalApp}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: { models: { note: { columns: { title: { kind: "number" } } } } },
          migration: { title: { coerce: true, else: 0 } },
        }),
      },
    );
    expect(optionalApplied.status).toBe(200);
    expect(optionalApplied.body.migration.elsed).toBe(0);
    expect(getAppRow(optionalApp, "note", optionalAbsent.id)).not.toHaveProperty("title");
  });

  test("accepts migration directives through HTTP PUT", async () => {
    const appId = await createApp(migrationDefinition);
    const row = await createRow(appId, { title: "42", status: "open" });
    const nextDefinition = structuredClone(migrationDefinition) as any;
    nextDefinition.models.note.columns.title = { kind: "number" };

    const result = await request<{ migration: { coerced: number; scanned: number } }>(
      `/api/apps/${appId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          definition: nextDefinition,
          migration: { title: { coerce: true } },
        }),
      },
    );

    expect(result.status).toBe(200);
    expect(result.body.migration).toMatchObject({ coerced: 1, scanned: 1 });
    expect(getAppRow(appId, "note", row.id)?.title).toBe(42);
    expect(getApp(appId)?.definition.models.note?.columns.title?.kind).toBe("number");
  });

  test("maps a narrowed enum from itself and rebuilds its index", async () => {
    const appId = await createApp(migrationDefinition);
    const urgent = await createRow(appId, { title: "Urgent", status: "urgent" });
    const open = await createRow(appId, { title: "Open", status: "open" });
    const namespace = appsNamespace(appId);

    const applied = await request<{ migration: { mapped: number; idxRebuilt: number } }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: {
            models: {
              note: { columns: { status: { kind: "enum", enum: ["open", "high"] } } },
            },
          },
          migration: {
            status: { from: "status", map: { open: "open", urgent: "high" } },
          },
        }),
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.migration).toMatchObject({ mapped: 2, idxRebuilt: 1 });
    expect(getAppRow(appId, "note", urgent.id)?.status).toBe("high");
    expect(getAppRow(appId, "note", open.id)?.status).toBe("open");
    expect(getKv(namespace, appIndexKey("note", "status", "urgent", urgent.id))).toBeNull();
    expect(getKv(namespace, appIndexKey("note", "status", "high", urgent.id))).not.toBeNull();
  });

  test("auto-backfills required defaults and reports preserved orphan fields", async () => {
    const appId = await createApp(migrationDefinition);
    const created = await createRow(appId, { title: "Existing", status: "open" });
    const row = getAppRow(appId, "note", created.id)!;
    upsertKv({
      namespace: appsNamespace(appId),
      key: `note/row/${created.id}`,
      value: { ...row, legacyPayload: "preserve" },
      valueType: "json",
    });

    const applied = await request<{
      migration: { backfilled: number; orphanFields: string[] };
    }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: {
            note: {
              columns: { category: { kind: "string", required: true, default: "general" } },
            },
          },
        },
      }),
    });
    expect(applied.status).toBe(200);
    expect(applied.body.migration).toMatchObject({
      backfilled: 1,
      orphanFields: ["legacyPayload"],
    });
    expect(getAppRow(appId, "note", created.id)).toMatchObject({
      category: "general",
      legacyPayload: "preserve",
      updatedAt: created.updatedAt,
      updatedBy: created.updatedBy,
    });
  });

  test("applies set directives end-to-end on a changed column", async () => {
    const appId = await createApp(migrationDefinition);
    const first = await createRow(appId, { title: "First", status: "open" });
    const second = await createRow(appId, { title: "Second", status: "urgent" });

    const applied = await request<{ migration: { backfilled: number } }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: { note: { columns: { title: { kind: "string", required: true } } } },
        },
        migration: { title: { set: "Replaced" } },
      }),
    });

    expect(applied.status).toBe(200);
    expect(applied.body.migration.backfilled).toBe(2);
    expect(getAppRow(appId, "note", first.id)?.title).toBe("Replaced");
    expect(getAppRow(appId, "note", second.id)?.title).toBe("Replaced");
  });

  test("caps distinct-value issues and orphan-field reports", async () => {
    const appId = await createApp(migrationDefinition);
    for (let index = 0; index < 12; index += 1) {
      await createRow(appId, { title: `bad-${index}`, status: "open" });
    }
    await createRow(appId, { title: "bad-0", status: "open" });
    await createRow(appId, { title: "bad-0", status: "open" });

    const dryRun = await request<{ issues: Array<{ message: string }> }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: { kind: "number" } } } } },
      }),
    });
    expect(dryRun.status).toBe(400);
    expect(
      dryRun.body.issues.some((issue) =>
        issue.message.includes("and 2 more distinct values across 2 rows"),
      ),
    ).toBe(true);

    const coerced = await request<{ issues: Array<{ message: string }> }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { title: { kind: "number" } } } } },
        migration: { title: { coerce: true } },
      }),
    });
    expect(coerced.status).toBe(400);
    expect(
      coerced.body.issues.some((issue) =>
        issue.message.includes("and 2 more distinct values across 2 rows"),
      ),
    ).toBe(true);

    const orphanAppId = await createApp(migrationDefinition);
    const orphanRow = await createRow(orphanAppId, { title: "Orphans", status: "open" });
    const stored = getAppRow(orphanAppId, "note", orphanRow.id)!;
    const legacyFields = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [`legacy${String(index).padStart(3, "0")}`, index]),
    );
    upsertKv({
      namespace: appsNamespace(orphanAppId),
      key: `note/row/${orphanRow.id}`,
      value: { ...stored, ...legacyFields },
      valueType: "json",
    });
    const reported = await request<{ migration: { orphanFields: string[] } }>(
      `/api/apps/${orphanAppId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: { models: { note: { columns: { category: { kind: "string" } } } } },
        }),
      },
    );
    expect(reported.status).toBe(200);
    expect(reported.body.migration.orphanFields).toHaveLength(100);
    expect(reported.body.migration.orphanFields.at(-1)).toBe("…and 6 more");
  });

  test("validates from sources even when the target model has no rows", async () => {
    const appId = await createApp(migrationDefinition);
    const result = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          definition: { models: { note: { columns: { category: { kind: "string" } } } } },
          migration: { category: { from: "missingSource" } },
        }),
      },
    );

    expect(result.status).toBe(400);
    expect(result.body.issues).toContainEqual({
      path: "migration.category.from",
      message: 'source column "missingSource" does not exist in models.note',
    });
  });

  test("repairs an unparseable definition without implicit backfill and still gates required adds", async () => {
    const appId = await createApp(migrationDefinition);
    const created = await createRow(appId, { title: "Existing", status: "open" });
    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run(JSON.stringify({ models: "broken" }), appId);

    const repairedDefinition = {
      ...migrationDefinition,
      models: {
        note: {
          columns: {
            ...migrationDefinition.models.note.columns,
            category: { kind: "string", required: true, default: "general" },
          },
        },
      },
    };
    const implicit = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      {
        method: "PUT",
        body: JSON.stringify({ definition: repairedDefinition }),
      },
    );
    expect(implicit.status).toBe(400);
    expect(implicit.body.issues).toContainEqual({
      path: "models.note.columns.category",
      message: expect.stringContaining(
        "required column is missing on 1 row while repairing an unparseable definition",
      ),
    });
    expect(getAppRow(appId, "note", created.id)).not.toHaveProperty("category");

    const repaired = await request<{ migration: { backfilled: number } }>(`/api/apps/${appId}`, {
      method: "PUT",
      body: JSON.stringify({
        definition: repairedDefinition,
        migration: { category: { set: "assigned" } },
      }),
    });
    expect(repaired.status).toBe(200);
    expect(repaired.body.migration.backfilled).toBe(1);
    expect(getAppRow(appId, "note", created.id)?.category).toBe("assigned");

    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run(JSON.stringify({ models: "broken again" }), appId);
    const requiredWithoutDefault = structuredClone(repairedDefinition);
    requiredWithoutDefault.models.note.columns.owner = { kind: "string", required: true } as never;
    const rejected = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${appId}`,
      { method: "PUT", body: JSON.stringify({ definition: requiredWithoutDefault }) },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.issues).toContainEqual({
      path: "models.note.columns.owner",
      message: expect.stringContaining("required column is missing on 1 row"),
    });
  });

  test("serializes schema migration ahead of a queued row create", async () => {
    const appId = await createApp(migrationDefinition);
    const existing = getApp(appId)!;
    const nextDefinition = structuredClone(migrationDefinition);
    nextDefinition.models.note.columns.category = {
      kind: "string",
      required: true,
      default: "queued",
    } as never;

    let releaseLock!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withMutationLock(appId, "note", async () => {
      markLocked();
      await release;
    });
    await locked;

    const migrating = withAppDefinitionLock(appId, () =>
      migrateAppSchema({
        appId,
        previousDefinition: existing.definition,
        nextDefinition: nextDefinition as never,
        snapshot: () => {},
        writeDefinition: () => updateApp(appId, { definition: nextDefinition as never }),
      }),
    );
    await Bun.sleep(0);
    const creating = createAppRow(
      appId,
      "note",
      existing.definition.models.note!,
      { title: "Queued", status: "open" },
      { actor: `agent:${AGENT_ID}` },
    );
    releaseLock();
    await blocker;
    await migrating;
    const created = await creating;
    expect(created.category).toBe("queued");
  });

  test("serializes concurrent definition patches without losing either update", async () => {
    const appId = await createApp(migrationDefinition);
    const row = await createRow(appId, { title: "true", status: "open" });

    let releaseModel!: () => void;
    let markModelLocked!: () => void;
    const modelLocked = new Promise<void>((resolve) => {
      markModelLocked = resolve;
    });
    const modelRelease = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const modelBlocker = withMutationLock(appId, "note", async () => {
      markModelLocked();
      await modelRelease;
    });
    await modelLocked;

    let releaseDefinition!: () => void;
    let markDefinitionLocked!: () => void;
    const definitionLocked = new Promise<void>((resolve) => {
      markDefinitionLocked = resolve;
    });
    const definitionRelease = new Promise<void>((resolve) => {
      releaseDefinition = resolve;
    });
    // External sentinel barrier: production code reaches it only through
    // withAppDefinitionLock, before attempting the blocked model lock.
    const definitionBlocker = withMutationLock(appId, "__definition__", async () => {
      markDefinitionLocked();
      await definitionRelease;
    });
    await definitionLocked;

    let schemaSettled = false;
    const schemaPatch = request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: {
          models: { note: { columns: { title: { kind: "boolean", index: true } } } },
        },
        migration: { title: { coerce: true } },
      }),
    }).finally(() => {
      schemaSettled = true;
    });
    await Bun.sleep(10);

    let pageSettled = false;
    const pagePatch = request(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: { pages: { main: { title: "Concurrent title" } } } }),
    }).finally(() => {
      pageSettled = true;
    });
    await Bun.sleep(20);
    expect(schemaSettled).toBe(false);
    expect(pageSettled).toBe(false);

    releaseDefinition();
    await definitionBlocker;
    await Bun.sleep(10);
    releaseModel();
    await modelBlocker;
    const [schemaResult, pageResult] = await Promise.all([schemaPatch, pagePatch]);
    expect(schemaResult.status).toBe(200);
    expect(pageResult.status).toBe(200);

    const stored = getApp(appId)!;
    expect(stored.definition.models.note?.columns.title?.kind).toBe("boolean");
    expect(stored.definition.pages.main?.title).toBe("Concurrent title");
    expect(getAppRow(appId, "note", row.id)?.title).toBe(true);
    const namespace = appsNamespace(appId);
    expect(getKv(namespace, appIndexKey("note", "title", true, row.id))).not.toBeNull();
    expect(countKv(namespace, { prefix: "note/idx/title/" })).toBe(1);
  });

  test("returns migration reports through app-patch and app-upsert", async () => {
    const appId = await createApp(migrationDefinition);
    const row = await createRow(appId, { title: "12", status: "open" });
    const tools = registeredTools([registerAppPatchTool, registerAppUpsertTool]);

    const patched = (await tools["app-patch"]!.handler(
      {
        appId,
        definition: {
          models: {
            note: { columns: { title: { kind: "number" } } },
          },
        },
        migration: { title: { coerce: true } },
      },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      migration: { scanned: number; coerced: number };
    }>;
    expect(patched.isError).not.toBe(true);
    expect(patched.structuredContent.migration.scanned).toBe(1);
    expect(patched.structuredContent.migration.coerced).toBe(1);
    expect(getAppRow(appId, "note", row.id)?.title).toBe(12);

    const upserted = (await tools["app-upsert"]!.handler(
      {
        appId,
        name: "MCP",
        definition: migrationDefinition,
        migration: { title: { coerce: true } },
      },
      toolMeta(),
    )) as StructuredResult<{
      success: boolean;
      migration: { coerced: number; idxRebuilt: number };
      details: string;
    }>;
    expect(upserted.isError).not.toBe(true);
    expect(upserted.structuredContent.migration.coerced).toBe(1);
    expect(upserted.structuredContent.migration.idxRebuilt).toBe(1);
    expect(upserted.structuredContent.details).toBe(`App: /apps/${appId}`);
    expect(getAppRow(appId, "note", row.id)?.title).toBe("12");

    const withoutAppId = (await tools["app-upsert"]!.handler(
      {
        name: "No migration target",
        definition: migrationDefinition,
        migration: { title: { coerce: true } },
      },
      toolMeta(),
    )) as StructuredResult<{ success: boolean; message: string }>;
    expect(withoutAppId.isError).toBe(true);
    expect(withoutAppId.structuredContent.message).toContain("migration requires appId");
  });

  test("returns scrubbed actionable details for unexpected MCP migration failures", async () => {
    const appId = await createApp(migrationDefinition);
    const row = await createRow(appId, { title: "MCP failure", status: "open" });
    const namespace = appsNamespace(appId);
    const secret = "phase2-migration-secret-value";
    process.env.SPIKE5_MIGRATION_SECRET = secret;
    refreshSecretScrubberCache();
    getDb().run(`
      CREATE TRIGGER fail_schema_migration
      BEFORE DELETE ON kv_entries
      WHEN OLD.namespace = '${namespace}' AND OLD.key LIKE 'note/idx/title/%'
      BEGIN SELECT RAISE(FAIL, '${secret}'); END
    `);

    try {
      const tools = registeredTools([registerAppPatchTool, registerAppUpsertTool]);
      const nextDefinition = structuredClone(migrationDefinition) as any;
      nextDefinition.models.note.columns.title.hidden = true;

      for (const [toolName, input] of [
        [
          "app-patch",
          {
            appId,
            definition: {
              models: {
                note: {
                  columns: { title: { kind: "string", index: true, hidden: true } },
                },
              },
            },
          },
        ],
        ["app-upsert", { appId, name: "MCP failure", definition: nextDefinition }],
      ] as const) {
        const result = (await tools[toolName]!.handler(input, toolMeta())) as StructuredResult<{
          success: boolean;
          details?: string;
        }>;
        expect(result.isError).toBe(true);
        expect(result.structuredContent.details).toContain("SQLiteError");
        expect(result.structuredContent.details).toContain("[REDACTED:SPIKE5_MIGRATION_SECRET]");
        expect(result.structuredContent.details).not.toContain(secret);
      }
      expect(getAppRow(appId, "note", row.id)?.title).toBe("MCP failure");
      expect(getApp(appId)?.definition.models.note?.columns.title?.hidden).not.toBe(true);
    } finally {
      getDb().run("DROP TRIGGER IF EXISTS fail_schema_migration");
      delete process.env.SPIKE5_MIGRATION_SECRET;
      refreshSecretScrubberCache();
    }
  });
});
