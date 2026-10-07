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

  test("is bounded to maxEntries", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, "v".repeat(100)]),
    );
    expect(summarizeKvShape(wide)).toHaveLength(8);
    expect(summarizeKvShape(wide, 3)).toHaveLength(3);
  });
});
