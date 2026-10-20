import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  DEFAULT_JSON_COLUMN_MAX_BYTES,
  jsonColumnMaxBytes,
  jsonColumnSizeLabel,
  type ModelDef,
  parseAppDefinition,
} from "../apps/definition";
import { AppRowValidationError, createAppRow, getAppRow, patchAppRow } from "../apps/row-store";
import { createApp, getApp } from "../apps/store";
import { closeDb, initDb } from "../be/db";
import { APPS_JSON_COLUMN_MAX_BYTES_BOUNDS, validateConfigValue } from "../be/swarm-config-guard";
import { handleApps, selectAppRows } from "../http/apps";
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
 * be pinned to the byte: `jsonOfSerializedBytes(DEFAULT_JSON_COLUMN_MAX_BYTES)` is the
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
    const exact = jsonOfSerializedBytes(DEFAULT_JSON_COLUMN_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(DEFAULT_JSON_COLUMN_MAX_BYTES);
    const accepted = await parseAppDefinition(
      defWith({ note: { columns: { payload: { kind: "json", default: exact } } } }),
      { writerIsUser: true },
    );
    expect(accepted.success).toBe(true);

    await expectDefinitionIssue(
      defWith({
        note: {
          columns: {
            payload: {
              kind: "json",
              default: jsonOfSerializedBytes(DEFAULT_JSON_COLUMN_MAX_BYTES + 1),
            },
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
        payload: jsonOfSerializedBytes(DEFAULT_JSON_COLUMN_MAX_BYTES + 1),
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
    const exact = jsonOfSerializedBytes(DEFAULT_JSON_COLUMN_MAX_BYTES);
    const created = await createAppRow(appId, "note", model, { title: "n1", payload: exact });
    expect((await getAppRow(appId, "note", created.id))?.payload).toEqual(exact);

    const error = await expectRowValidationError(
      createAppRow(appId, "note", model, {
        title: "n1",
        payload: jsonOfSerializedBytes(DEFAULT_JSON_COLUMN_MAX_BYTES + 1),
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
    const payload = { s: "é".repeat(DEFAULT_JSON_COLUMN_MAX_BYTES / 2 - 3) };
    const serialized = JSON.stringify(payload);
    expect(serialized.length).toBeLessThan(DEFAULT_JSON_COLUMN_MAX_BYTES);
    expect(Buffer.byteLength(serialized, "utf8")).toBe(DEFAULT_JSON_COLUMN_MAX_BYTES + 2);
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

describe("json column kind — shared row selector", () => {
  // The REST route and the MCP tools each reject json filters before reaching
  // the selector; this is the backstop for any caller that skips its own guard.
  test("selectAppRows rejects a filter on a json column", async () => {
    const { appId, model } = await createNoteApp();
    await createAppRow(appId, "note", model, { title: "scalar", payload: "x" });

    const error = await expectRowValidationError(
      selectAppRows(appId, "note", model, [{ column: "payload", value: "x" }]),
    );
    expect(error.issues).toEqual([
      { path: "filter.payload", message: "json columns cannot be filtered" },
    ]);

    const unfiltered = await selectAppRows(appId, "note", model, []);
    expect(unfiltered.rows.map((row) => row.payload)).toEqual(["x"]);
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

  // Bodies are sent as raw text: `JSON.parse("1e400")` is `Infinity`, which
  // `JSON.stringify` would otherwise persist as `null`, even on a required column.
  test("a row value with a non-finite number is rejected, top-level and nested", async () => {
    const appId = await createNoteAppViaApi();
    for (const body of [
      '{"values":{"title":"top","payload":1e400}}',
      '{"values":{"title":"nested","payload":{"n":[1,{"deep":-1e400}]}}}',
    ]) {
      const result = await request<{ error: string; issues: unknown[] }>(
        `/api/apps/${appId}/models/note/rows`,
        { method: "POST", body },
      );
      expect(result.status).toBe(400);
      expect(result.body.issues).toContainEqual({
        path: "values.payload",
        message: "json value contains a non-finite number",
      });
    }
    const listed = await request<{ rows: unknown[] }>(`/api/apps/${appId}/models/note/rows`);
    expect(listed.status).toBe(200);
    expect(listed.body.rows).toEqual([]);
  });

  test("a json default with a non-finite number is rejected", async () => {
    const definition = JSON.stringify(
      defWith({ note: { columns: { payload: { kind: "json", default: { n: "__NF__" } } } } }),
    ).replace('"__NF__"', "1e400");
    const result = await request<{ error: string; issues: unknown[] }>("/api/apps", {
      method: "POST",
      body: `{"name":"Json defaults","definition":${definition}}`,
    });
    expect(result.status).toBe(400);
    expect(result.body.issues).toContainEqual({
      path: "models.note.columns.payload.default",
      message: "json column default contains a non-finite number",
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

describe("json column kind — configurable size limit", () => {
  const original = process.env.APPS_JSON_COLUMN_MAX_BYTES;
  afterEach(() => {
    if (original === undefined) delete process.env.APPS_JSON_COLUMN_MAX_BYTES;
    else process.env.APPS_JSON_COLUMN_MAX_BYTES = original;
  });

  test("the default cap is 256KB and labels its messages as such", () => {
    expect(DEFAULT_JSON_COLUMN_MAX_BYTES).toBe(256 * 1024);
    expect(jsonColumnMaxBytes()).toBe(DEFAULT_JSON_COLUMN_MAX_BYTES);
    expect(jsonColumnSizeLabel(DEFAULT_JSON_COLUMN_MAX_BYTES)).toBe("256KB");
    expect(jsonColumnSizeLabel(1500)).toBe("1500 bytes");
  });

  test("APPS_JSON_COLUMN_MAX_BYTES is read at call time and relabels the limit", async () => {
    const { appId, model } = await createNoteApp();
    process.env.APPS_JSON_COLUMN_MAX_BYTES = "2048";
    expect(jsonColumnMaxBytes()).toBe(2048);

    const error = await expectRowValidationError(
      createAppRow(appId, "note", model, {
        title: "big",
        payload: jsonOfSerializedBytes(3 * 1024),
      }),
    );
    expect(error.issues).toContainEqual({
      path: "values.payload",
      message: "json value exceeds the 2KB size limit",
    });
    const small = jsonOfSerializedBytes(1024);
    const row = await createAppRow(appId, "note", model, { title: "small", payload: small });
    expect((await getAppRow(appId, "note", row.id))?.payload).toEqual(small);

    await expectDefinitionIssue(
      defWith({
        note: { columns: { payload: { kind: "json", default: jsonOfSerializedBytes(3 * 1024) } } },
      }),
      {
        path: "models.note.columns.payload.default",
        message: "json column default exceeds the 2KB size limit",
      },
    );
  });

  // The cap is an upsert-time constraint: lowering it must not turn an app
  // saved under the higher cap into one that "needs repair" on every read.
  test("lowering the cap keeps an app saved under the higher cap readable", async () => {
    process.env.APPS_JSON_COLUMN_MAX_BYTES = "4096";
    const definition = defWith({
      note: {
        columns: {
          title: { kind: "string", required: true },
          payload: { kind: "json", required: true, default: jsonOfSerializedBytes(2048) },
        },
      },
    });
    const created = await request<{ app: { id: string } }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({ name: "Json cap", definition }),
    });
    expect(created.status).toBe(201);
    const appId = created.body.app.id;
    const stored = { s: "y".repeat(2048 - 8) };
    const createdRow = await request<{ row: { id: string } }>(
      `/api/apps/${appId}/models/note/rows`,
      { method: "POST", body: JSON.stringify({ values: { title: "big", payload: stored } }) },
    );
    expect(createdRow.status).toBe(201);

    process.env.APPS_JSON_COLUMN_MAX_BYTES = "1024";
    const app = await request<{ app: { definitionError?: unknown } }>(`/api/apps/${appId}`);
    expect(app.status).toBe(200);
    expect(app.body.app.definitionError).toBeUndefined();
    const rows = await request<{ rows: Array<{ payload: unknown }> }>(
      `/api/apps/${appId}/models/note/rows`,
    );
    expect(rows.status).toBe(200);
    expect(rows.body.rows.map((row) => row.payload)).toEqual([stored]);
    expect((await getAppRow(appId, "note", createdRow.body.row.id))?.payload).toEqual(stored);

    // Writing the same definition again under the lower cap is still refused.
    const rewritten = await request<{ error: string; issues: unknown[] }>(`/api/apps/${appId}`, {
      method: "PUT",
      body: JSON.stringify({ definition }),
    });
    expect(rewritten.status).toBe(400);
    expect(rewritten.body.issues).toContainEqual({
      path: "models.note.columns.payload.default",
      message: "json column default exceeds the 1KB size limit",
    });
  });

  test("a malformed or out-of-range override falls back to the default", () => {
    const { min, max } = APPS_JSON_COLUMN_MAX_BYTES_BOUNDS;
    for (const raw of ["", "abc", "2048.5", "-2048", String(min - 1), String(max + 1)]) {
      process.env.APPS_JSON_COLUMN_MAX_BYTES = raw;
      expect(jsonColumnMaxBytes()).toBe(DEFAULT_JSON_COLUMN_MAX_BYTES);
    }
    for (const raw of [String(min), String(max)]) {
      process.env.APPS_JSON_COLUMN_MAX_BYTES = raw;
      expect(jsonColumnMaxBytes()).toBe(Number(raw));
    }
  });

  test("the config API rejects what the reader would fall back from", () => {
    const { min, max } = APPS_JSON_COLUMN_MAX_BYTES_BOUNDS;
    const key = "APPS_JSON_COLUMN_MAX_BYTES";
    expect(validateConfigValue(key, String(min))).toBeNull();
    expect(validateConfigValue(key, String(max))).toBeNull();
    expect(validateConfigValue(key, String(min - 1))).toContain(`between ${min} and ${max}`);
    expect(validateConfigValue(key, String(max + 1))).toContain(`between ${min} and ${max}`);
    expect(validateConfigValue(key, "abc")).toContain("integer");
    expect(validateConfigValue(key, "1.5")).toContain("integer");
  });
});
