import { describe, expect, test } from "bun:test";
import { resolveKvView, sliceKvTarget, summarizeKvShape } from "../kv-view";

describe("resolveKvView", () => {
  const stored = JSON.stringify({ a: { rows: [{ id: 0 }, { id: 1 }, { id: 2 }] }, s: "abcdef" });

  test("a JSON string resolves dot paths, numeric segments index arrays", () => {
    expect(resolveKvView(stored, { path: "a.rows.1.id" })).toEqual({
      ok: true,
      value: 1,
      view: { path: "a.rows.1.id", type: "number" },
    });
    expect(resolveKvView(stored, { path: "a.rows", offset: 1, limit: 1 })).toMatchObject({
      ok: true,
      value: [{ id: 1 }],
      view: { total: 3, offset: 1, returned: 1, nextOffset: 2 },
    });
  });

  test("objects page by key, strings by character", () => {
    expect(resolveKvView({ x: 1, y: 2, z: 3 }, { offset: 1, limit: 1 })).toMatchObject({
      value: { y: 2 },
      view: { type: "object", total: 3, nextOffset: 2 },
    });
    expect(resolveKvView(stored, { path: "s", offset: 2, limit: 3 })).toMatchObject({
      value: "cde",
      view: { type: "string", returned: 3, nextOffset: 5 },
    });
  });

  test("out-of-range offsets return an empty page with the real total", () => {
    expect(resolveKvView(stored, { path: "a.rows", offset: 99 })).toMatchObject({
      ok: true,
      value: [],
      view: { total: 3, offset: 99, returned: 0, nextOffset: null },
    });
  });

  test("missing keys, bad indices, empty segments and scalar paging are errors", () => {
    expect(resolveKvView(stored, { path: "a.nope" })).toEqual({
      ok: false,
      error: 'path "a.nope" not found: no key "nope" under "a"',
    });
    expect(resolveKvView(stored, { path: "a.rows.3" })).toMatchObject({ ok: false });
    expect(resolveKvView(stored, { path: "a.rows.-1" })).toMatchObject({ ok: false });
    expect(resolveKvView(stored, { path: "a..rows" })).toMatchObject({ ok: false });
    expect(resolveKvView(stored, { path: "a.rows.0.id.x" })).toMatchObject({ ok: false });
    expect(resolveKvView(42, { offset: 1 })).toMatchObject({ ok: false });
  });

  test("a non-JSON string rejects a path but pages its characters", () => {
    expect(resolveKvView("plain {not json", { path: "a" })).toMatchObject({ ok: false });
    expect(resolveKvView("plain {not json", { offset: 6, limit: 5 })).toMatchObject({
      ok: true,
      value: "{not ",
    });
    // A string holding a JSON scalar stays a plain string.
    expect(resolveKvView('"quoted"', { offset: 1, limit: 6 })).toMatchObject({ value: "quoted" });
  });

  test("a string page never ends on a lone high surrogate", () => {
    const sliced = sliceKvTarget("a🙂b", 0, 2);
    expect(sliced).toMatchObject({ value: "a", returned: 1, nextOffset: 1 });
  });

  test("limit 1 on an astral character returns the whole pair and advances", () => {
    const text = "🙂🙃x";
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null && seen.length < 10) {
      const page = sliceKvTarget(text, offset, 1)!;
      expect(page.returned).toBeGreaterThan(0);
      seen.push(page.value as string);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(["🙂", "🙃", "x"]);
  });
});

describe("summarizeKvShape", () => {
  test("expands the dominant object down to where the bulk lives", () => {
    const rows = Array.from({ length: 300 }, (_, id) => ({ id, note: "x".repeat(50) }));
    const shape = summarizeKvShape({
      version: 1,
      toolName: "script-run",
      outcome: { ok: true, message: "done", data: { status: 200, data: { result: { rows } } } },
    });
    expect(shape[0]).toMatchObject({
      path: "outcome.data.data.result.rows",
      type: "array",
      items: 300,
    });
    expect(shape[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify(rows)));
    // Crumbs under 1% of the value are left out.
    expect(shape.map((entry) => entry.path)).not.toContain("version");
  });

  test("escapes keys with dots so every shape path resolves", () => {
    const rows = Array.from({ length: 50 }, (_, id) => ({ id, note: "x".repeat(50) }));
    const value = { "rows.v2": rows, "a\\b": { "c.d": "y".repeat(2_000) } };
    const shape = summarizeKvShape(value);
    expect(shape.map((entry) => entry.path)).toEqual(["rows\\.v2", "a\\\\b.c\\.d"]);
    for (const entry of shape) {
      expect(resolveKvView(value, { path: entry.path, offset: 0 })).toMatchObject({
        ok: true,
        view: { path: entry.path, type: entry.type, total: entry.items },
      });
    }
  });

  test("keeps long paths exact and replaces unaddressable ones with their nearest ancestor", () => {
    const rows = Array.from({ length: 80 }, (_, id) => ({ id, note: "x".repeat(60) }));
    const longKey = "L".repeat(200);
    expect(summarizeKvShape({ [longKey]: rows })[0]).toMatchObject({ path: longKey, items: 80 });
    // An empty key has no path syntax: its parent object stands in.
    expect(summarizeKvShape({ "": rows, small: 1 })[0]).toMatchObject({
      path: "",
      type: "object",
      items: 2,
    });
    expect(summarizeKvShape({ outer: { "": rows, side: [1] } })[0]).toMatchObject({
      path: "outer",
      type: "object",
    });
    // Longer than kv-get's path limit: the root stands in.
    expect(summarizeKvShape({ ["X".repeat(1_100)]: rows })[0]).toMatchObject({ path: "" });
  });

  test("is bounded by total path bytes", () => {
    const value = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`${i}`.repeat(600), "v".repeat(1_000)]),
    );
    const shape = summarizeKvShape(value);
    const pathBytes = shape.reduce((sum, entry) => sum + JSON.stringify(entry.path).length, 0);
    expect(pathBytes).toBeLessThanOrEqual(2_048);
    expect(shape.filter((entry) => entry.path.length === 600)).toHaveLength(3);
    expect(shape.at(-1)).toMatchObject({ path: "", type: "object", items: 8 });
  });

  test("is bounded to maxEntries", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, "v".repeat(100)]),
    );
    expect(summarizeKvShape(wide)).toHaveLength(8);
    expect(summarizeKvShape(wide, 3)).toHaveLength(3);
  });
});
