/**
 * KV MCP tools — unit-level coverage. Registers each tool against a fresh
 * McpServer, pulls handlers out of the SDK registry, invokes them with a
 * stubbed `requestInfo` (mirrors create-page-tool.test.ts).
 *
 * Verifies:
 *   - kv-set / kv-get round-trip on the auto-resolved agent namespace
 *   - kv-incr atomicity + 'integer' coercion
 *   - kv-list shape (entries, total, namespace)
 *   - kv-delete returns deleted flag
 *   - cross-agent write 403 (lead bypass tested too)
 *   - missing namespace + no agent header → structured error
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { summarizeKvShape } from "../kv-view";
import {
  registerKvDeleteTool,
  registerKvGetTool,
  registerKvIncrTool,
  registerKvListTool,
  registerKvSetTool,
} from "../tools/kv";
import {
  finalizeSwarmToolResult,
  MCP_RESULT_WIRE_LIMIT_BYTES,
  mcpOverflowNamespace,
  wireChannelBytes,
} from "../tools/utils";

const TEST_DB_PATH = "./test-kv-tool.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function buildServer() {
  const server = new McpServer({ name: "kv-tool-test", version: "1.0.0" });
  registerKvGetTool(server);
  registerKvSetTool(server);
  registerKvDeleteTool(server);
  registerKvIncrTool(server);
  registerKvListTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return {
    get: registered["kv-get"]!,
    set: registered["kv-set"]!,
    del: registered["kv-delete"]!,
    incr: registered["kv-incr"]!,
    list: registered["kv-list"]!,
  };
}

function meta(agentId: string | undefined, sourceTaskId?: string) {
  const headers: Record<string, string> = {};
  if (agentId !== undefined) headers["x-agent-id"] = agentId;
  if (sourceTaskId !== undefined) headers["x-source-task-id"] = sourceTaskId;
  return { sessionId: "s1", requestInfo: { headers } };
}

type StructuredResult<T> = { structuredContent: T };

let agentA: string;
let agentB: string;
let lead: string;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  const a = await createAgent({ name: "kv-tool-a", isLead: false, status: "idle" });
  const b = await createAgent({ name: "kv-tool-b", isLead: false, status: "idle" });
  const l = await createAgent({ name: "kv-tool-lead", isLead: true, status: "idle" });
  agentA = a.id;
  agentB = b.id;
  lead = l.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM kv_entries");
});

describe("kv MCP tools", () => {
  test("kv-set + kv-get round-trip on agent namespace", async () => {
    const tools = buildServer();
    const setRes = (await tools.set.handler(
      { key: "k1", value: { hello: "world" } },
      meta(agentA),
    )) as StructuredResult<{
      success: boolean;
      namespace: string;
      entry: { value: unknown; valueType: string };
    }>;
    expect(setRes.structuredContent.success).toBe(true);
    expect(setRes.structuredContent.namespace).toBe(`task:agent:${agentA}`);
    expect(setRes.structuredContent.entry.value).toEqual({ hello: "world" });

    const getRes = (await tools.get.handler({ key: "k1" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      entry: { value: unknown } | null;
    }>;
    expect(getRes.structuredContent.success).toBe(true);
    expect(getRes.structuredContent.entry?.value).toEqual({ hello: "world" });
  });

  test("kv-get returns entry=null for missing keys", async () => {
    const tools = buildServer();
    const getRes = (await tools.get.handler({ key: "nope" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      entry: unknown | null;
    }>;
    expect(getRes.structuredContent.success).toBe(true);
    expect(getRes.structuredContent.entry).toBeNull();
  });

  test("overflow retrieval hint round-trips for its owner and rejects another agent", async () => {
    const tools = buildServer();
    const blob = "private-result:".concat("x".repeat(30_000));
    const spill = await finalizeSwarmToolResult(
      "private-tool",
      { ok: true, message: "Large result.", data: { blob } },
      { agentId: agentA },
    );
    const truncation = (
      spill.structuredContent as {
        truncation: { fullValueAt: string; retrieval: string };
      }
    ).truncation;
    const namespace = mcpOverflowNamespace(agentA);
    const key = truncation.fullValueAt.replace(`kv://${namespace}/`, "");

    expect(truncation.retrieval).toContain(`"namespace":"${namespace}"`);
    // kv-get is spill-exempt: the owner gets the WHOLE stored value back in
    // one read — no recursive truncation pointer — plus the big-value nudge.
    const ownerRead = (await tools.get.handler(
      { key, namespace },
      meta(agentA),
    )) as StructuredResult<{
      success: boolean;
      entry: { value: string };
      nudge?: string;
    }>;
    expect(ownerRead.structuredContent.success).toBe(true);
    expect(ownerRead.structuredContent.entry.value).toContain('"private-result:');
    expect(ownerRead.structuredContent.entry.value.length).toBeGreaterThan(30_000);
    expect(ownerRead.structuredContent).not.toHaveProperty("truncation");
    expect(ownerRead.structuredContent.nudge).toMatch(/script/);

    const intruderRead = (await tools.get.handler(
      { key, namespace },
      meta(agentB),
    )) as StructuredResult<{ success: boolean; message: string; entry?: unknown }>;
    expect(intruderRead.structuredContent.success).toBe(false);
    expect(intruderRead.structuredContent.message).toMatch(/another agent/);
    expect(intruderRead.structuredContent.entry).toBeUndefined();

    const intruderList = (await tools.list.handler(
      { namespace },
      meta(agentB),
    )) as StructuredResult<{ success: boolean; message: string; entries?: unknown[] }>;
    expect(intruderList.structuredContent.success).toBe(false);
    expect(intruderList.structuredContent.message).toMatch(/another agent/);
    expect(intruderList.structuredContent.entries).toBeUndefined();
  });

  type ViewResult = {
    content: Array<{ type: string; text: string }>;
    structuredContent: {
      success: boolean;
      message: string;
      details?: string;
      entry?: { value?: unknown; key?: string };
      view?: {
        path: string;
        type: string;
        total?: number;
        offset?: number;
        returned?: number;
        nextOffset?: number | null;
      };
    };
  };

  test("kv-get path/offset/limit follows the spill hint to a bounded, pageable slice", async () => {
    const tools = buildServer();
    const rows = Array.from({ length: 400 }, (_, id) => ({ id, note: "r".repeat(100) }));
    const spill = await finalizeSwarmToolResult(
      "script-run",
      {
        ok: true,
        message: "Script run completed.",
        details: `result:\n${JSON.stringify({ rows }, null, 2)}`,
        data: { status: 200, data: { result: { rows } } },
      },
      { agentId: agentA },
    );
    const truncation = (
      spill.structuredContent as {
        truncation: { retrieval: string; shape: Array<{ path: string; items?: number }> };
      }
    ).truncation;
    expect(truncation.shape).toContainEqual(
      expect.objectContaining({ path: "outcome.data.data.result.rows", type: "array", items: 400 }),
    );
    // The hint is a literal, copy-pasteable call.
    const hinted = JSON.parse(
      truncation.retrieval.slice("kv-get(".length, truncation.retrieval.indexOf(") returns")),
    ) as { namespace: string; key: string; path: string; offset: number };
    expect(hinted.path).toBe("outcome.data.data.result.rows");

    const first = (await tools.get.handler(hinted, meta(agentA))) as ViewResult;
    const view = first.structuredContent.view!;
    expect(first.structuredContent.success).toBe(true);
    expect(view).toMatchObject({
      path: "outcome.data.data.result.rows",
      type: "array",
      total: 400,
    });
    expect(view.returned).toBeGreaterThan(0);
    expect(view.returned).toBeLessThan(400);
    expect(view.nextOffset).toBe(view.returned);
    expect(JSON.parse(first.structuredContent.details!)).toEqual(rows.slice(0, view.returned));
    expect(first.structuredContent.entry).not.toHaveProperty("value");
    expect(first.structuredContent.message).toContain("continue at view.nextOffset");
    expect(wireChannelBytes(first)).toBeLessThanOrEqual(MCP_RESULT_WIRE_LIMIT_BYTES);

    const next = (await tools.get.handler(
      { ...hinted, offset: view.nextOffset!, limit: 5 },
      meta(agentA),
    )) as ViewResult;
    expect(next.structuredContent.view).toMatchObject({ offset: view.nextOffset, returned: 5 });
    expect(JSON.parse(next.structuredContent.details!)).toEqual(
      rows.slice(view.nextOffset!, view.nextOffset! + 5),
    );

    const pastEnd = (await tools.get.handler(
      { ...hinted, offset: 10_000 },
      meta(agentA),
    )) as ViewResult;
    expect(pastEnd.structuredContent.success).toBe(true);
    expect(pastEnd.structuredContent.view).toMatchObject({
      total: 400,
      returned: 0,
      nextOffset: null,
    });
    expect(pastEnd.structuredContent.details).toBe("[]");

    const missing = (await tools.get.handler(
      { ...hinted, path: "outcome.data.nope" },
      meta(agentA),
    )) as ViewResult;
    expect(missing.structuredContent.success).toBe(false);
    expect(missing.structuredContent.message).toContain('no key "nope" under "outcome.data"');

    const badIndex = (await tools.get.handler(
      { ...hinted, path: "outcome.data.data.result.rows.400" },
      meta(agentA),
    )) as ViewResult;
    expect(badIndex.structuredContent.success).toBe(false);
    expect(badIndex.structuredContent.message).toContain("array of 400");

    const oneRow = (await tools.get.handler(
      { ...hinted, path: "outcome.data.data.result.rows.7" },
      meta(agentA),
    )) as ViewResult;
    expect(JSON.parse(oneRow.structuredContent.details!)).toEqual(rows[7]);
  });

  test("a wide-object spill hint pages the parent of its scalar leaves", async () => {
    const tools = buildServer();
    const wide = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, i) => [`k${i}`, 1_000_000_000.5 + i]),
    );
    const spill = await finalizeSwarmToolResult(
      "wide-tool",
      { ok: true, message: "Done.", data: wide },
      { agentId: agentA },
    );
    const { retrieval, shape } = (
      spill.structuredContent as {
        truncation: { retrieval: string; shape: Array<{ path: string; type: string }> };
      }
    ).truncation;
    expect(shape[0]).toMatchObject({ type: "number" });
    const hinted = JSON.parse(retrieval.slice("kv-get(".length, retrieval.indexOf(") returns")));
    expect(hinted).toMatchObject({ path: "outcome.data", offset: 0 });

    const page = (await tools.get.handler(hinted, meta(agentA))) as ViewResult;
    expect(page.structuredContent.success).toBe(true);
    expect(page.structuredContent.view).toMatchObject({ type: "object", total: 2_000 });
    expect(page.structuredContent.view!.returned).toBeGreaterThan(0);
  });

  test("kv-get view on a plain string pages characters and rejects a JSON path", async () => {
    const tools = buildServer();
    await tools.set.handler(
      { key: "plain", value: "hello world, not json", valueType: "string" },
      meta(agentA),
    );
    const chars = (await tools.get.handler(
      { key: "plain", offset: 6, limit: 5 },
      meta(agentA),
    )) as ViewResult;
    expect(chars.structuredContent.success).toBe(true);
    expect(chars.structuredContent.details).toBe('"world"');
    expect(chars.structuredContent.view).toMatchObject({
      type: "string",
      total: 21,
      returned: 5,
      nextOffset: 11,
    });

    await tools.set.handler(
      { key: "spaced", value: "a  \n  b", valueType: "string" },
      meta(agentA),
    );
    for (const [offset, slice] of [
      [1, "  \n  "],
      [0, "a  "],
    ] as const) {
      const exact = (await tools.get.handler(
        { key: "spaced", offset, limit: slice.length },
        meta(agentA),
      )) as ViewResult;
      expect(JSON.parse(exact.structuredContent.details!)).toBe(slice);
      expect(JSON.parse(exact.content[0]!.text.split("\n\n").at(-1)!)).toBe(slice);
    }

    const pathed = (await tools.get.handler(
      { key: "plain", path: "a" },
      meta(agentA),
    )) as ViewResult;
    expect(pathed.structuredContent.success).toBe(false);
    expect(pathed.structuredContent.message).toContain("plain string");

    await tools.set.handler({ key: "num", value: 42 }, meta(agentA));
    const scalar = (await tools.get.handler({ key: "num", offset: 1 }, meta(agentA))) as ViewResult;
    expect(scalar.structuredContent.success).toBe(false);
    expect(scalar.structuredContent.message).toContain("is a number");
  });

  test("kv-get view names a narrower path when one item alone exceeds the cap", async () => {
    const tools = buildServer();
    await tools.set.handler(
      { key: "fat-items", value: { items: [{ blob: "f".repeat(20_000) }, { id: 2 }] } },
      meta(agentA),
    );
    const res = (await tools.get.handler(
      { key: "fat-items", path: "items" },
      meta(agentA),
    )) as ViewResult;
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.view).toMatchObject({ returned: 0, nextOffset: 0, total: 2 });
    expect(res.structuredContent.message).toContain('narrow the path to "items.0"');
    expect(wireChannelBytes(res)).toBeLessThanOrEqual(MCP_RESULT_WIRE_LIMIT_BYTES);

    const narrowed = (await tools.get.handler(
      { key: "fat-items", path: "items.0.blob", limit: 100 },
      meta(agentA),
    )) as ViewResult;
    expect(JSON.parse(narrowed.structuredContent.details!)).toBe("f".repeat(100));
  });

  test("a shrunk kv-get page counts its note, so both channels stay within the cap", async () => {
    const tools = buildServer();
    const channelBytes = (res: ViewResult) => ({
      text: Buffer.byteLength(res.content.map((part) => part.text).join(""), "utf8"),
      structured: Buffer.byteLength(JSON.stringify(res.structuredContent), "utf8"),
    });
    const longKey = "k".repeat(900);
    await tools.set.handler(
      {
        key: "near-cap",
        value: {
          text: "a".repeat(20_000),
          rows: Array.from({ length: 400 }, (_, id) => ({ id, note: "r".repeat(100) })),
          [longKey]: [{ blob: "f".repeat(20_000) }],
        },
      },
      meta(agentA),
    );
    const cases = [
      { args: { path: "text" }, note: "Page shrunk" },
      { args: { path: "text", offset: 3 }, note: "Page shrunk" },
      { args: { path: "rows" }, note: "Page shrunk" },
      { args: { path: longKey }, note: `narrow the path to "${longKey}.0"` },
    ];
    for (const { args, note } of cases) {
      const res = (await tools.get.handler(
        { key: "near-cap", ...args },
        meta(agentA),
      )) as ViewResult;
      expect(res.structuredContent.success).toBe(true);
      expect(res.structuredContent.message).toContain(note);
      const bytes = channelBytes(res);
      expect(bytes.text).toBeLessThanOrEqual(MCP_RESULT_WIRE_LIMIT_BYTES);
      expect(bytes.structured).toBeLessThanOrEqual(MCP_RESULT_WIRE_LIMIT_BYTES);
    }
  });

  test("every spill shape path, long or empty-keyed, works as a kv-get path", async () => {
    const tools = buildServer();
    const rows = (n: number) =>
      Array.from({ length: n }, (_, id) => ({ id, note: "r".repeat(60) }));
    const longKey = "L".repeat(200);
    const values = {
      long: { [longKey]: rows(80), small: 1 },
      emptyRoot: { "": rows(80), small: 1 },
      emptyNested: { outer: { "": rows(80), side: rows(40) }, small: 1 },
      overMax: { ["X".repeat(1_100)]: rows(80), small: 1 },
    };
    for (const [key, value] of Object.entries(values)) {
      await tools.set.handler({ key, value: JSON.stringify(value) }, meta(agentA));
      const shape = summarizeKvShape(value);
      expect(shape.length).toBeGreaterThan(0);
      for (const entry of shape) {
        const res = (await tools.get.handler(
          { key, path: entry.path, ...(entry.items === undefined ? {} : { offset: 0 }) },
          meta(agentA),
        )) as ViewResult;
        expect(res.structuredContent.success).toBe(true);
        expect(res.structuredContent.view).toMatchObject({ path: entry.path, type: entry.type });
        if (entry.items !== undefined) {
          expect(res.structuredContent.view!.total).toBe(entry.items);
        }
      }
      if (key === "long") expect(shape[0]!.path).toBe(longKey);
    }
  });

  test("kv-incr creates + increments + reports value", async () => {
    const tools = buildServer();
    const r1 = (await tools.incr.handler({ key: "ctr", by: 5 }, meta(agentA))) as StructuredResult<{
      entry: { value: number; valueType: string };
    }>;
    expect(r1.structuredContent.entry.value).toBe(5);
    expect(r1.structuredContent.entry.valueType).toBe("integer");
    const r2 = (await tools.incr.handler({ key: "ctr" }, meta(agentA))) as StructuredResult<{
      entry: { value: number };
    }>;
    expect(r2.structuredContent.entry.value).toBe(6);
  });

  test("kv-incr returns structured error on valueType collision", async () => {
    const tools = buildServer();
    await tools.set.handler({ key: "obj", value: { n: 1 } }, meta(agentA));
    const r = (await tools.incr.handler({ key: "obj" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      message: string;
    }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/Cannot INCR/);
  });

  test("kv-list returns entries + total + namespace", async () => {
    const tools = buildServer();
    await tools.set.handler({ key: "a-1", value: 1, valueType: "integer" }, meta(agentA));
    await tools.set.handler({ key: "a-2", value: 2, valueType: "integer" }, meta(agentA));
    await tools.set.handler({ key: "b-1", value: 3, valueType: "integer" }, meta(agentA));

    const r = (await tools.list.handler({ prefix: "a-" }, meta(agentA))) as StructuredResult<{
      success: boolean;
      entries: { key: string }[];
      total: number;
      namespace: string;
    }>;
    expect(r.structuredContent.entries.map((e) => e.key)).toEqual(["a-1", "a-2"]);
    expect(r.structuredContent.total).toBe(2);
    expect(r.structuredContent.namespace).toBe(`task:agent:${agentA}`);
  });

  test("kv-delete returns deleted flag", async () => {
    const tools = buildServer();
    await tools.set.handler({ key: "del-me", value: "x", valueType: "string" }, meta(agentA));
    const r1 = (await tools.del.handler({ key: "del-me" }, meta(agentA))) as StructuredResult<{
      deleted: boolean;
    }>;
    expect(r1.structuredContent.deleted).toBe(true);
    const r2 = (await tools.del.handler({ key: "del-me" }, meta(agentA))) as StructuredResult<{
      deleted: boolean;
    }>;
    expect(r2.structuredContent.deleted).toBe(false);
  });

  test("cross-agent write is rejected for non-lead callers", async () => {
    const tools = buildServer();
    const r = (await tools.set.handler(
      { key: "k", value: 1, namespace: `task:agent:${agentB}` },
      meta(agentA),
    )) as StructuredResult<{ success: boolean; message: string }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/lead/);
  });

  test("lead can write to another agent's namespace", async () => {
    const tools = buildServer();
    const r = (await tools.set.handler(
      { key: "k", value: 1, namespace: `task:agent:${agentB}`, valueType: "integer" },
      meta(lead),
    )) as StructuredResult<{ success: boolean; namespace: string }>;
    expect(r.structuredContent.success).toBe(true);
    expect(r.structuredContent.namespace).toBe(`task:agent:${agentB}`);
  });

  test("missing agent header → namespace cannot be resolved", async () => {
    const tools = buildServer();
    const r = (await tools.get.handler({ key: "k" }, meta(undefined))) as StructuredResult<{
      success: boolean;
      message: string;
    }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/namespace/);
  });

  test("page namespace writes are rejected (MCP can't be a page)", async () => {
    const tools = buildServer();
    const r = (await tools.set.handler(
      { key: "k", value: 1, namespace: "task:page:doesntmatter" },
      meta(agentA),
    )) as StructuredResult<{ success: boolean; message: string }>;
    expect(r.structuredContent.success).toBe(false);
    expect(r.structuredContent.message).toMatch(/page-proxy/);
  });
});
