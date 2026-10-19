import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AnySchema,
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import * as rowStore from "../apps/row-store";
import { type AppRecord, createApp } from "../apps/store";
import { closeDb, createAgent, initDb } from "../be/db";
import { typecheckScript } from "../be/scripts/typecheck";
import { handleCore } from "../http/core";
import { handleMcpBridge } from "../http/mcp-bridge";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { LEGACY_POLICY, type LegacyRule } from "../rbac";
import { runScript } from "../scripts-runtime/loader";
import { registerAppRowTools } from "../tools/app-rows";
import { markScriptSdkRequestOrigin } from "../tools/utils";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const dbPath = `/private/tmp/test-app-row-tools-${process.pid}.sqlite`;
const agentId = crypto.randomUUID();
const apiKey = "example-app-row-tools-key";
const previousKey = process.env.AGENT_SWARM_API_KEY;
const definition: AppRecord["definition"] = {
  schemaVersion: 1,
  models: {
    note: {
      columns: {
        title: { kind: "string" },
        rank: { kind: "number" },
        active: { kind: "boolean" },
        state: { kind: "enum", enum: ["open", "closed"] },
        externalId: { kind: "string" },
        projected: { kind: "string", source: { of: "external", field: "title" } },
      },
      sources: { external: { connector: "swarm-tasks", joinKey: "externalId", config: {} } },
    },
  },
  pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
  defaultPage: "main",
};

type ToolResult = {
  isError?: boolean;
  structuredContent: {
    message: string;
    row: import("../apps/row-store").AppRow;
    rows: import("../apps/row-store").AppRow[];
    total: number;
    deleted?: number;
    ok?: boolean;
  };
};
type RegisteredTool = {
  inputSchema: AnySchema;
  handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
};
let tools: Record<string, RegisteredTool>;
let appId: string;

async function removeDb() {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(dbPath + suffix).catch(() => undefined);
}

beforeAll(async () => {
  process.env.AGENT_SWARM_API_KEY = apiKey;
  await removeDb();
  initDb(dbPath);
  await createAgent({ id: agentId, name: "row-tool-agent", isLead: false, status: "idle" });
  appId = (await createApp({ name: "Row tools", definition })).id;
  const server = new McpServer({ name: "app-row-tools", version: "1.0.0" });
  registerAppRowTools(server);
  tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
});

afterAll(async () => {
  closeDb();
  await removeDb();
  if (previousKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = previousKey;
});

async function call(
  name: string,
  input: Record<string, unknown>,
  id: string | undefined = agentId,
) {
  const tool = tools[name]!;
  const schema = normalizeObjectSchema(tool.inputSchema) ?? tool.inputSchema;
  const args = { appId, model: "note", ...input };
  const parsed = await safeParseAsync(schema, args);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error));
  // Exercise the registrar with the same trusted origin marker as the script bridge.
  return tool.handler(
    parsed.data,
    markScriptSdkRequestOrigin({
      sessionId: "app-row-tools",
      requestInfo: { headers: id ? { "x-agent-id": id } : {} },
    }),
  );
}

test("creates, gets, filters, sorts, limits, patches, and deletes flat rows with agent provenance", async () => {
  const result = await call("app-row-create", {
    values: { title: "single", rank: 1, active: true },
  });
  expect(result.isError).not.toBe(true);
  const row = result.structuredContent.row;
  expect(row).toMatchObject({
    title: "single",
    rank: 1,
    createdBy: `agent:${agentId}`,
    updatedBy: `agent:${agentId}`,
  });
  expect(row.values).toBeUndefined();
  expect((await call("app-row-get", { rowId: row.id })).structuredContent.row).toEqual(row);
  const patched = await call("app-row-patch", { rowId: row.id, values: { title: "patched" } });
  expect(patched.structuredContent.row).toMatchObject({
    title: "patched",
    createdBy: row.createdBy,
    updatedBy: row.createdBy,
  });
  await call("app-rows-create", {
    rows: [
      { title: "bulk", rank: 2, active: true },
      { title: "bulk", rank: 3, active: false },
      { title: "bulk", rank: 4, active: true },
    ],
  });
  const listed = await call("app-rows-list", {
    equals: { title: "bulk", active: true },
    sort: "rank:desc",
    limit: 1,
  });
  expect(listed.structuredContent.total).toBe(2);
  expect(listed.structuredContent.rows).toHaveLength(1);
  expect(listed.structuredContent.rows[0].rank).toBe(4);
  const systemFilter = await call("app-rows-list", {
    equals: { id: row.id, createdBy: `agent:${agentId}` },
    sort: "createdAt:asc",
  });
  expect(systemFilter.structuredContent.total).toBe(1);
  expect((await call("app-row-delete", { rowId: row.id })).structuredContent).toMatchObject({
    ok: true,
  });
  expect((await call("app-row-get", { rowId: row.id })).isError).toBe(true);
  expect(
    (await call("app-rows-delete", { equals: { title: "bulk" }, limit: 2 })).structuredContent,
  ).toMatchObject({ deleted: 2 });
  expect(
    (await call("app-rows-delete", { equals: { title: "bulk" } })).structuredContent,
  ).toMatchObject({
    deleted: 1,
  });
});

test("null in values clears an optional column on create, bulk create, and patch", async () => {
  const created = await call("app-row-create", { values: { title: "null-create", rank: null } });
  expect(created.isError).not.toBe(true);
  expect(created.structuredContent.row.rank).toBeNull();
  const bulk = await call("app-rows-create", {
    rows: [{ title: "null-bulk", rank: null, state: null }],
  });
  expect(bulk.isError).not.toBe(true);
  expect(bulk.structuredContent.rows[0]).toMatchObject({ rank: null, state: null });
  const row = (await call("app-row-create", { values: { title: "null-patch", rank: 5 } }))
    .structuredContent.row;
  const patched = await call("app-row-patch", { rowId: row.id, values: { rank: null } });
  expect(patched.isError).not.toBe(true);
  expect(Object.hasOwn(patched.structuredContent.row, "rank")).toBe(false);
  expect(
    Object.hasOwn((await call("app-row-get", { rowId: row.id })).structuredContent.row, "rank"),
  ).toBe(false);
});

test("app-rows-delete skips a row patched out of the filter after the select", async () => {
  const row = (await call("app-row-create", { values: { title: "delete" } })).structuredContent.row;
  const original = rowStore.listAppRows;
  // The select sees the row as "delete"; the patch lands before the per-row delete lock.
  const spy = spyOn(rowStore, "listAppRows").mockImplementation(async (...args) => {
    const rows = await original(...args);
    await rowStore.patchAppRow(appId, "note", definition.models.note!, row.id, { title: "keep" });
    return rows;
  });
  let result: ToolResult;
  try {
    result = await call("app-rows-delete", { equals: { title: "delete" } });
  } finally {
    spy.mockRestore();
  }
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.deleted).toBe(0);
  expect((await call("app-row-get", { rowId: row.id })).structuredContent.row.title).toBe("keep");
  await call("app-row-delete", { rowId: row.id });
});

test("rejects invalid filters, sorts, values, source projections, join keys, and missing agents", async () => {
  for (const values of [
    { projected: "blocked" },
    { externalId: "blocked" },
    { state: "invalid" },
    { rank: "wrong" },
    { createdBy: "forged" },
  ]) {
    expect((await call("app-row-create", { values })).isError).toBe(true);
  }
  for (const equals of [{ missing: "x" }, { active: 1 }, { rank: "1" }]) {
    expect((await call("app-rows-list", { equals })).isError).toBe(true);
  }
  expect((await call("app-rows-list", { sort: "rank:sideways" })).isError).toBe(true);
  expect((await call("app-rows-list", {}, "")).isError).toBe(true);
});

test("enforces row, bulk, filter, and limit caps before writing", async () => {
  await expect(
    call("app-rows-create", { rows: Array.from({ length: 501 }, () => ({ title: "too-many" })) }),
  ).rejects.toThrow();
  await expect(call("app-rows-create", { rows: [] })).rejects.toThrow();
  await expect(call("app-rows-delete", {})).rejects.toThrow();
  await expect(call("app-rows-delete", { equals: {} })).rejects.toThrow();
  await expect(call("app-rows-list", { limit: 1001 })).rejects.toThrow();
  const oversized = "x".repeat(1024 * 1024);
  expect((await call("app-row-create", { values: { title: oversized } })).isError).toBe(true);
  expect((await call("app-rows-create", { rows: [{ title: oversized }] })).isError).toBe(true);
  expect(
    (
      await call("app-rows-create", {
        rows: Array.from({ length: 20 }, () => ({ title: "x".repeat(600_000) })),
      })
    ).isError,
  ).toBe(true);
  const row = (await call("app-row-create", { values: { title: "cap-patch" } })).structuredContent
    .row;
  expect(
    (await call("app-row-patch", { rowId: row.id, values: { title: oversized } })).isError,
  ).toBe(true);
  expect((await call("app-row-get", { rowId: row.id })).structuredContent.row.title).toBe(
    "cap-patch",
  );
  expect(
    (await call("app-rows-list", { equals: { title: "too-many" } })).structuredContent.total,
  ).toBe(0);
});

test("denies a principal without app.use for every row operation", async () => {
  const policy = LEGACY_POLICY as unknown as Record<"app.use", LegacyRule>;
  const original = policy["app.use"];
  policy["app.use"] = {
    name: "deny-row-tools",
    denyReason: "denied row tools",
    evaluate: () => false,
  };
  try {
    for (const [name, input] of [
      ["app-rows-list", {}],
      ["app-row-get", { rowId: "missing" }],
      ["app-row-create", { values: { title: "denied" } }],
      ["app-rows-create", { rows: [{ title: "denied" }] }],
      ["app-row-patch", { rowId: "missing", values: { title: "denied" } }],
      ["app-row-delete", { rowId: "missing" }],
      ["app-rows-delete", { equals: { title: "denied" } }],
    ] as const)
      expect((await call(name, input)).isError).toBe(true);
  } finally {
    policy["app.use"] = original;
  }
});

test("saved scripts can typecheck all seven row methods and cannot invoke actions", async () => {
  const valid = await typecheckScript(`
    import type { ScriptContext } from "swarm-sdk";
    export default async function(args: unknown, ctx: ScriptContext) {
      const base = { appId: "app", model: "note" };
      await ctx.swarm.app_row_create({ ...base, values: { title: "test" } });
      await ctx.swarm.app_rows_create({ ...base, rows: [{ title: "test" }] });
      await ctx.swarm.app_rows_list({ ...base, equals: { title: "test" }, sort: "createdAt:desc", limit: 1 });
      await ctx.swarm.app_row_get({ ...base, rowId: "row" });
      await ctx.swarm.app_row_patch({ ...base, rowId: "row", values: { title: "changed", rank: null } });
      await ctx.swarm.app_row_delete({ ...base, rowId: "row" });
      await ctx.swarm.app_rows_delete({ ...base, equals: { title: "test" } });
    }
  `);
  expect(valid).toEqual({ ok: true });
  const invalid = await typecheckScript(`
    import type { ScriptContext } from "swarm-sdk";
    export default async function(args: unknown, ctx: ScriptContext) {
      await ctx.swarm.app_action_run({ appId: "app", action: "write" });
    }
  `);
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.diagnostics.join("\n")).toContain("app_action_run");
});

test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
  "a saved script creates and lists rows through ctx.swarm",
  async () => {
    const server = createHttpServer(async (req, res) => {
      const id = req.headers["x-agent-id"] as string | undefined;
      if (await handleCore(req, res, id, apiKey)) return;
      if (
        await handleMcpBridge(
          req,
          res,
          getPathSegments(req.url ?? ""),
          parseQueryParams(req.url ?? ""),
          id,
        )
      )
        return;
      res.writeHead(404).end();
    });
    try {
      const port = await listenOnFreePort(server);
      const script = await import("../be/scripts/db").then(({ upsertScriptByName }) =>
        upsertScriptByName({
          name: "row_tools_sdk",
          scope: "agent",
          scopeId: agentId,
          agentId,
          source: `export default async function(args, ctx) {
        const created = await ctx.swarm.app_row_create({ appId: args.appId, model: "note", values: { title: "script-sdk", rank: 1 } });
        const listed = await ctx.swarm.app_rows_list({ appId: args.appId, model: "note", equals: { title: "script-sdk" } });
        const rowId = (created?.data ?? created).row.id;
        const cleared = await ctx.swarm.app_row_patch({ appId: args.appId, model: "note", rowId, values: { rank: null } });
        return { created: created?.data ?? created, listed: listed?.data ?? listed, cleared: cleared?.data ?? cleared };
      }`,
          description: "SDK row fixture",
          intent: "Verify row tools through the script SDK",
          signatureJson: "{}",
          typeChecked: true,
          embeddingMode: "skip",
        }),
      );
      const output = await runScript({
        source: script.script.source,
        args: { appId },
        agentId,
        mcpBaseUrl: `http://localhost:${port}`,
      });
      expect(output.error).toBeUndefined();
      expect(output.runtimeError).toBeUndefined();
      expect(output.result).toMatchObject({
        created: { row: { createdBy: `agent:${agentId}` } },
        listed: { total: 1, rows: [{ title: "script-sdk" }] },
        cleared: { row: { title: "script-sdk" } },
      });
      const cleared = (output.result as { cleared: { row: Record<string, unknown> } }).cleared.row;
      expect(Object.hasOwn(cleared, "rank")).toBe(false);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
