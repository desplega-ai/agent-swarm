import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { MAX_JSON_COLUMN_BYTES, type ModelDef, parseAppDefinition } from "../apps/definition";
import { AppRowValidationError, createAppRow, getAppRow, patchAppRow } from "../apps/row-store";
import { createApp, getApp } from "../apps/store";
import { closeDb, initDb } from "../be/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = `/private/tmp/test-apps-json-column-${process.pid}.sqlite`;
const AGENT_ID = crypto.randomUUID();
let server: Server;
let base = "";

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

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  server = createTestServer();
  const port = await listenOnFreePort(server, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
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

// Minimal valid definition wrapper — mirrors the shape used in apps-spike.test.ts.
function defWith(models: Record<string, unknown>): Record<string, unknown> {
  return {
    models,
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
}

const NOTE_COLUMNS = {
  title: { kind: "string", required: true },
  payload: { kind: "json", required: true },
};

/**
 * `{"s":"<ascii>"}` serializes to (body length + 8) bytes, so the boundary can
 * be pinned to the byte: `jsonOfSerializedBytes(MAX_JSON_COLUMN_BYTES)` is the
 * largest value a json column accepts.
 */
function jsonOfSerializedBytes(bytes: number): { s: string } {
  return { s: "x".repeat(bytes - 8) };
}

async function expectDefinitionIssue(
  definition: Record<string, unknown>,
  issue: { path: string; message: unknown },
): Promise<void> {
  const result = await parseAppDefinition(definition, { writerIsUser: true });
  expect(result).toMatchObject({ success: false });
  if (result.success) throw new Error("definition unexpectedly passed validation");
  expect(result.issues).toContainEqual(issue);
}

describe("json column kind — definition schema", () => {
  test("accepts kind: json with required and object default", async () => {
    const result = await parseAppDefinition(
      defWith({
        note: {
          columns: {
            title: { kind: "string", required: true },
            payload: { kind: "json", required: true, default: { tags: [], pinned: false } },
          },
        },
      }),
      { writerIsUser: true },
    );
    expect(result.success).toBe(true);
  });

  test("still rejects object defaults on scalar columns", async () => {
    await expectDefinitionIssue(
      defWith({ note: { columns: { title: { kind: "string", default: { x: 1 } } } } }),
      {
        path: "models.note.columns.title.default",
        message: "default must be a valid string value",
      },
    );
  });

  test("json default: exactly 256KB serialized passes, one byte more fails", async () => {
    const exact = jsonOfSerializedBytes(MAX_JSON_COLUMN_BYTES);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(MAX_JSON_COLUMN_BYTES);
    const accepted = await parseAppDefinition(
      defWith({ note: { columns: { payload: { kind: "json", default: exact } } } }),
      { writerIsUser: true },
    );
    expect(accepted.success).toBe(true);

    await expectDefinitionIssue(
      defWith({
        note: {
          columns: {
            payload: { kind: "json", default: jsonOfSerializedBytes(MAX_JSON_COLUMN_BYTES + 1) },
          },
        },
      }),
      {
        path: "models.note.columns.payload.default",
        message: "json column default exceeds the 256KB size limit",
      },
    );
  });

  test("rejects index: true on a json column", async () => {
    await expectDefinitionIssue(
      defWith({ note: { columns: { payload: { kind: "json", index: true } } } }),
      { path: "models.note.columns.payload.index", message: "json columns cannot be indexed" },
    );
  });

  test("rejects enum values on a json column", async () => {
    await expectDefinitionIssue(
      defWith({ note: { columns: { payload: { kind: "json", enum: ["a"] } } } }),
      {
        path: "models.note.columns.payload.enum",
        message: "enum values are only allowed for enum columns",
      },
    );
  });

  test("rejects a named-query filter on a json column", async () => {
    await expectDefinitionIssue(
      {
        ...defWith({ note: { columns: { payload: { kind: "json" } } } }),
        queries: { bad: { model: "note", filter: { payload: "x" } } },
      },
      { path: "queries.bad.filter.payload", message: "json columns cannot be filtered" },
    );
  });

  test("rejects a named-query sort on a json column", async () => {
    await expectDefinitionIssue(
      {
        ...defWith({ note: { columns: { payload: { kind: "json" } } } }),
        queries: { bad: { model: "note", sort: { column: "payload", dir: "asc" } } },
      },
      { path: "queries.bad.sort.column", message: "json columns cannot be sorted" },
    );
  });

  test("rejects json kind in user config fields", async () => {
    await expectDefinitionIssue(
      {
        ...defWith({ note: { columns: { payload: { kind: "json" } } } }),
        userConfig: { pref: { kind: "json" } },
      },
      { path: "userConfig.pref.kind", message: expect.stringContaining("Invalid option") },
    );
  });

  test("rejects json kind in element props", async () => {
    await expectDefinitionIssue(
      {
        ...defWith({ note: { columns: { payload: { kind: "json" } } } }),
        elements: {
          card: {
            mode: "pure",
            props: { payload: { kind: "json" } },
            root: "root",
            elements: { root: { type: "Container", props: {} } },
          },
        },
      },
      {
        path: "elements.card.props.payload.kind",
        message: expect.stringContaining("Invalid option"),
      },
    );
  });
});

async function createNoteApp(
  columns: Record<string, unknown> = NOTE_COLUMNS,
): Promise<{ appId: string; model: ModelDef }> {
  const parsed = await parseAppDefinition(defWith({ note: { columns } }), {
    writerIsUser: true,
  });
  if (!parsed.success) {
    throw new Error(`test definition failed validation: ${JSON.stringify(parsed.issues)}`);
  }
  const app = await createApp({
    name: `Json notes ${crypto.randomUUID()}`,
    definition: parsed.definition,
  });
  const model = parsed.definition.models.note;
  if (!model) throw new Error("note model missing from parsed definition");
  return { appId: app.id, model };
}

async function expectRowValidationError(promise: Promise<unknown>): Promise<AppRowValidationError> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof AppRowValidationError)) {
    throw new Error("expected the row write to reject with AppRowValidationError");
  }
  return error;
}

describe("json column kind — row mutations", () => {
  test("createAppRow accepts a nested object and returns it intact", async () => {
    const { appId, model } = await createNoteApp();
    const payload = { tags: ["a", "b"], meta: { depth: { n: 1, ok: true, none: null } } };
    const created = await createAppRow(appId, "note", model, { title: "n1", payload });
    const fetched = await getAppRow(appId, "note", created.id);
    if (!fetched) throw new Error("row missing after create");
    expect(fetched.payload).toEqual(payload);
  });

  test("a top-level array and scalars are valid json values", async () => {
    const { appId, model } = await createNoteApp();
    for (const payload of [[1, "two", { three: null }], 42, "text", false]) {
      const created = await createAppRow(appId, "note", model, { title: "n", payload });
      expect((await getAppRow(appId, "note", created.id))?.payload).toEqual(payload);
    }
  });

  test("null is accepted on a non-required json column", async () => {
    const { appId, model } = await createNoteApp({
      title: { kind: "string", required: true },
      payload: { kind: "json" },
    });
    // Same contract as every other kind: an explicit null is stored, an omitted column is absent.
    const created = await createAppRow(appId, "note", model, { title: "n", payload: null });
    expect((await getAppRow(appId, "note", created.id))?.payload).toBeNull();
    const omitted = await createAppRow(appId, "note", model, { title: "n" });
    expect((await getAppRow(appId, "note", omitted.id))?.payload).toBeUndefined();
  });

  test("patchAppRow replaces a json value and can clear a non-required one", async () => {
    const { appId, model } = await createNoteApp({
      title: { kind: "string", required: true },
      payload: { kind: "json" },
    });
    const created = await createAppRow(appId, "note", model, { title: "n", payload: { v: 1 } });
    await patchAppRow(appId, "note", model, created.id, { payload: [{ v: 2 }] });
    expect((await getAppRow(appId, "note", created.id))?.payload).toEqual([{ v: 2 }]);
    await patchAppRow(appId, "note", model, created.id, { payload: null });
    expect((await getAppRow(appId, "note", created.id))?.payload).toBeUndefined();
    const error = await expectRowValidationError(
      patchAppRow(appId, "note", model, created.id, {
        payload: jsonOfSerializedBytes(MAX_JSON_COLUMN_BYTES + 1),
      }),
    );
    expect(error.issues).toContainEqual({
      path: "values.payload",
      message: "json value exceeds the 256KB size limit",
    });
  });

  test("rejects non-JSON-serializable values", async () => {
    const { appId, model } = await createNoteApp();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const error = await expectRowValidationError(
      createAppRow(appId, "note", model, { title: "n1", payload: circular }),
    );
    expect(error.issues).toContainEqual({
      path: "values.payload",
      message: "must be a valid json value",
    });
  });

  test("row value: exactly 256KB serialized passes, one byte more fails", async () => {
    const { appId, model } = await createNoteApp();
    const exact = jsonOfSerializedBytes(MAX_JSON_COLUMN_BYTES);
    const created = await createAppRow(appId, "note", model, { title: "n1", payload: exact });
    expect((await getAppRow(appId, "note", created.id))?.payload).toEqual(exact);

    const error = await expectRowValidationError(
      createAppRow(appId, "note", model, {
        title: "n1",
        payload: jsonOfSerializedBytes(MAX_JSON_COLUMN_BYTES + 1),
      }),
    );
    expect(error.issues).toContainEqual({
      path: "values.payload",
      message: "json value exceeds the 256KB size limit",
    });
  });

  test("the cap counts UTF-8 bytes, not characters", async () => {
    const { appId, model } = await createNoteApp();
    // "é" is one character but two UTF-8 bytes: fewer characters than the cap, more bytes.
    const payload = { s: "é".repeat(MAX_JSON_COLUMN_BYTES / 2 - 3) };
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThan(MAX_JSON_COLUMN_BYTES);
    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_JSON_COLUMN_BYTES + 2);
    const error = await expectRowValidationError(
      createAppRow(appId, "note", model, { title: "n1", payload }),
    );
    expect(error.issues).toContainEqual({
      path: "values.payload",
      message: "json value exceeds the 256KB size limit",
    });
  });

  test("required json column enforced on create", async () => {
    const { appId, model } = await createNoteApp();
    const error = await expectRowValidationError(
      createAppRow(appId, "note", model, { title: "n1" }),
    );
    expect(error.issues).toContainEqual({
      path: "values.payload",
      message: "required column is missing",
    });
  });
});

describe("json column kind — REST runtime", () => {
  async function createNoteAppViaApi(): Promise<string> {
    const result = await request<{ app: { id: string } }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        name: "Json notes",
        definition: defWith({ note: { columns: NOTE_COLUMNS } }),
      }),
    });
    expect(result.status).toBe(201);
    return result.body.app.id;
  }

  test("filter.<col> on a json column is rejected", async () => {
    const appId = await createNoteAppViaApi();
    const result = await request<{ error: string; issues: unknown[] }>(
      `/api/apps/${appId}/models/note/rows?filter.payload=x`,
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid row query");
    expect(result.body.issues).toContainEqual({
      path: "filter.payload",
      message: "json columns cannot be filtered",
    });
  });

  test("sort on a json column is rejected", async () => {
    const appId = await createNoteAppViaApi();
    const result = await request<{ error: string; issues: unknown[] }>(
      `/api/apps/${appId}/models/note/rows?sort=payload:asc`,
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: "invalid sort",
      issues: [{ path: "sort", message: "json columns cannot be sorted" }],
    });
  });

  test("migration.<col>.set backfills an object into a new json column", async () => {
    const appId = await createNoteAppViaApi();
    const app = await getApp(appId);
    const model = app?.definition.models.note;
    if (!model) throw new Error("note model missing");
    const row = await createAppRow(appId, "note", model, { title: "n1", payload: { v: 1 } });

    const meta = { tags: ["x"], nested: { n: 1 } };
    const applied = await request<{ migration: { backfilled: number } }>(`/api/apps/${appId}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { models: { note: { columns: { meta: { kind: "json", required: true } } } } },
        migration: { meta: { set: meta } },
      }),
    });
    expect(applied).toMatchObject({ status: 200, body: { migration: { backfilled: 1 } } });
    expect((await getAppRow(appId, "note", row.id))?.meta).toEqual(meta);
  });
});
