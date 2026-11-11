import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { createObject, getObject, listObjects, reindexObjects } from "../be/primitives/objects";
import {
  areaOf,
  capToUsed,
  formatRange,
  MAX_COL,
  MAX_ROW,
  parseCell,
  parseRange,
} from "../be/primitives/sheets/a1";
import { MAX_ENGINE_CALLS, SheetEngine } from "../be/primitives/sheets/engine";
import {
  constantInput,
  emptySheet,
  MAX_CELLS,
  type SheetDoc,
  SheetDocSchema,
} from "../be/primitives/sheets/format";
import {
  addSheetTab,
  appendSheetRows,
  clearSheetRange,
  createSheet,
  getSheet,
  getSheetRange,
  listSheets,
  setSheetRange,
} from "../be/primitives/sheets/service";

const OWN_KEY = "af_own_sheet_key";
const ORG = "org-sheets";
const DRIVE = "drive-sheets";

// In-memory agent-fs: raw PUT/GET with If-None-Match / If-Match. `beforeWrite` lets a test play the other writer.
const files = new Map<string, { body: string; version: number }>();
let beforeWrite: ((path: string) => void) | undefined;
let writes = 0;

const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("authorization") !== `Bearer ${OWN_KEY}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const raw = url.pathname.match(/^\/orgs\/([^/]+)\/drives\/([^/]+)\/files\/(.+)\/raw$/);
    if (!raw) {
      if (url.pathname === `/orgs/${ORG}/ops`) {
        const matches = [...files.keys()]
          .filter((p) => p.endsWith(".sheet.json"))
          .map((p) => ({ path: `/${p}`, size: 1 }));
        return Response.json({ matches });
      }
      return new Response("not found", { status: 404 });
    }
    const path = decodeURIComponent(raw[3] ?? "");
    if (req.method === "GET") {
      const current = files.get(path);
      if (!current) return new Response("not found", { status: 404 });
      return new Response(current.body, {
        headers: { "x-agent-fs-version": String(current.version) },
      });
    }
    writes += 1;
    beforeWrite?.(path);
    const current = files.get(path);
    const ifMatch = req.headers.get("if-match");
    if (req.headers.get("if-none-match") === "*" && current)
      return new Response("exists", { status: 409 });
    if (ifMatch && String(current?.version) !== ifMatch)
      return new Response("version mismatch", { status: 409 });
    const version = (current?.version ?? 0) + 1;
    files.set(path, { body: await req.text(), version });
    return Response.json({ path, version }, { headers: { "x-agent-fs-version": String(version) } });
  },
});

const agentId = crypto.randomUUID();

beforeAll(async () => {
  initDb(":memory:");
  const global = { scope: "global" as const, scopeId: null, isSecret: false };
  await upsertSwarmConfig({
    ...global,
    key: "AGENT_FS_API_URL",
    value: `http://127.0.0.1:${fake.port}`,
  });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_ORG_ID", value: ORG });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_DRIVE_ID", value: DRIVE });
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
});

beforeEach(async () => {
  files.clear();
  beforeWrite = undefined;
  writes = 0;
  await getDbClient().run("DELETE FROM primitive_objects");
});

const doc = (path: string): SheetDoc =>
  SheetDocSchema.parse(JSON.parse(files.get(path)?.body ?? "null"));
const make = async (path = "t.sheet.json") => (await createSheet({ agentId, path })).object;

describe("a1", () => {
  test("parses cells, ranges, quoted tabs and open ranges", () => {
    expect(parseCell("$B$2")).toEqual({ row: 2, col: 2 });
    expect(parseCell(`XFD${MAX_ROW}`)).toEqual({ row: MAX_ROW, col: MAX_COL });
    expect(parseRange("Tasks!C3:A1")).toMatchObject({
      tab: "Tasks",
      r1: 1,
      c1: 1,
      r2: 3,
      c2: 3,
      open: false,
    });
    expect(parseRange("'It''s a tab'!B2")).toMatchObject({
      tab: "It's a tab",
      r1: 2,
      r2: 2,
      c1: 2,
    });
    expect(parseRange("'a!b'!A1").tab).toBe("a!b");
    expect(parseRange("A1:B2").tab).toBeUndefined();
    const col = parseRange("'My tab'!A:A");
    expect(col).toMatchObject({ tab: "My tab", c1: 1, c2: 1, r1: 1, open: true });
    expect(parseRange("2:4")).toMatchObject({ r1: 2, r2: 4, c1: 1, open: true });
    expect(capToUsed(col, { rows: 7, cols: 3 })).toMatchObject({ r2: 7, c2: 1 });
    expect(capToUsed(parseRange("D:D"), { rows: 7, cols: 3 })).toBeNull();
    expect(formatRange("My tab", { r1: 1, c1: 1, r2: 3, c2: 2 })).toBe("'My tab'!A1:B3");
    expect(areaOf({ r1: 1, c1: 1, r2: 100, c2: 100 })).toBe(10_000);
  });

  test("rejects bad references", () => {
    for (const bad of [
      "",
      "A",
      "A0",
      "ZZZZ1",
      `A${MAX_ROW + 1}`,
      "A1:B2:C3",
      "'x'A1",
      "!A1",
      "1:A",
      "A1:",
    ]) {
      expect(() => parseRange(bad), bad).toThrow();
    }
  });
});

describe("format", () => {
  test("empty sheet validates and text that looks typed gets the text prefix", () => {
    expect(SheetDocSchema.safeParse(emptySheet("id1", "T")).success).toBe(true);
    expect(
      SheetDocSchema.safeParse({ ...emptySheet("id1"), format: "swarm-sheet/2" }).success,
    ).toBe(false);
    expect(SheetDocSchema.safeParse({ ...emptySheet("id1"), tabs: [] }).success).toBe(false);
    expect(constantInput("007")).toBe("'007");
    expect(constantInput("=x")).toBe("'=x");
    expect(constantInput("plain")).toBe("plain");
    expect(constantInput(true)).toBe("TRUE");
    expect(constantInput(null)).toBe("");
  });
});

describe("sheet engine", () => {
  test("a 10k-cell workbook evaluates under the timeout", async () => {
    const engine = new SheetEngine();
    try {
      const cells: SheetDoc["tabs"][number]["cells"] = {};
      for (let r = 1; r <= 5000; r++) {
        cells[`A${r}`] = { v: r };
        cells[`B${r}`] = { f: `=A${r}*2`, v: 0 };
      }
      const started = performance.now();
      const out = await engine.recalc(
        [{ name: "S", cells }],
        [{ tab: "S", row: 1, col: 3, input: "=SUM(B1:B5000)" }],
        {
          maxCells: MAX_CELLS,
        },
      );
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(out.cells[0]?.C1).toEqual({ f: "=SUM(B1:B5000)", v: 25_005_000 });
      expect(out.cells[0]?.B5000).toEqual({ f: "=A5000*2", v: 10_000 });
    } finally {
      engine.stop();
    }
  }, 20_000);

  test("a call that outruns its timeout is killed and the next call gets a fresh worker", async () => {
    const engine = new SheetEngine();
    try {
      const cells: SheetDoc["tabs"][number]["cells"] = {};
      for (let r = 1; r <= 3000; r++) cells[`A${r}`] = { v: r };
      const tabs = [{ name: "S", cells }];
      await expect(engine.recalc(tabs, [], { maxCells: MAX_CELLS, timeoutMs: 1 })).rejects.toThrow(
        "timed out",
      );
      const out = await engine.recalc(
        tabs,
        [{ tab: "S", row: 1, col: 2, input: "=SUM(A1:A3000)" }],
        {
          maxCells: MAX_CELLS,
        },
      );
      expect(out.cells[0]?.B1?.v).toBe(4_501_500);
    } finally {
      engine.stop();
    }
  }, 20_000);

  test("the queue is bounded per caller and in total, and oversized input is refused before queueing", async () => {
    const engine = new SheetEngine();
    try {
      const tabs = [{ name: "S", cells: {} }];
      const call = (caller: string) => engine.recalc(tabs, [], { maxCells: MAX_CELLS, caller });
      const first = [call("a"), call("a")];
      await expect(call("a")).rejects.toThrow("busy");
      const others = Array.from({ length: MAX_ENGINE_CALLS - 2 }, (_, i) => call(`b${i}`));
      await expect(call("c")).rejects.toThrow("busy");
      await Promise.all([...first, ...others]);
      // Slots free up once the calls settle.
      await call("a");
      await expect(
        engine.recalc([{ name: "S", cells: { A1: { v: 1 }, A2: { v: 2 } } }], [], { maxCells: 1 }),
      ).rejects.toThrow("the limit is 1");
    } finally {
      engine.stop();
    }
  }, 20_000);

  test("a spill past the cell cap is refused, not materialised", async () => {
    const engine = new SheetEngine();
    try {
      await expect(
        engine.recalc(
          [{ name: "S", cells: {} }],
          [{ tab: "S", row: 1, col: 1, input: "=SEQUENCE(1000000)" }],
          {
            maxCells: 100,
          },
        ),
      ).rejects.toThrow("exceed 100 cells");
    } finally {
      engine.stop();
    }
  });
});

describe("sheet service", () => {
  test("create writes an empty Sheet1 with the id embedded, and tabs with seeded rows recompute", async () => {
    const plain = await createSheet({ agentId, path: "/qa/plain.sheet.json", title: "Plain" });
    expect(plain.object.path).toBe("qa/plain.sheet.json");
    expect(plain.link).toBe(`https://live.agent-fs.dev/file/~/${ORG}/${DRIVE}/qa/plain.sheet.json`);
    expect(doc("qa/plain.sheet.json")).toMatchObject({
      format: "swarm-sheet/1",
      swarm: { id: plain.object.id, kind: "sheet", title: "Plain" },
      tabs: [{ name: "Sheet1", cells: {} }],
    });

    const seeded = await createSheet({
      agentId,
      path: "seeded.sheet.json",
      tabs: [
        {
          name: "Data",
          rows: [
            [1, 2],
            [3, "=A2*10"],
          ],
        },
        { name: "Notes" },
      ],
    });
    expect(doc("seeded.sheet.json").tabs.map((t) => t.name)).toEqual(["Data", "Notes"]);
    expect(doc("seeded.sheet.json").tabs[0]?.cells.B2).toEqual({ f: "=A2*10", v: 30 });
    expect(seeded.object.fileVersion).toBe(2);
  });

  test("create refuses a bad tab list before writing anything", async () => {
    for (const tabs of [
      [{ name: "a" }, { name: "A" }],
      [{ name: "bad/name" }],
      [],
      Array.from({ length: 21 }, (_, i) => ({ name: `t${i}` })),
    ]) {
      await expect(createSheet({ agentId, path: "x.sheet.json", tabs })).rejects.toThrow();
    }
    expect(files.size).toBe(0);
    await expect(createSheet({ agentId, path: "x.json" })).rejects.toThrow(".sheet.json");
  });

  test("setRange recomputes formulas and getRange returns the new value and the formula", async () => {
    const { id } = await make();
    const written = await setSheetRange({
      agentId,
      id,
      range: "Sheet1!B2:C3",
      values: [
        [1, "=B2*2"],
        [2, "=B3*2"],
      ],
    });
    expect(written).toMatchObject({
      range: "Sheet1!B2:C3",
      changed: 4,
      recalculated: 0,
      version: 2,
    });
    const read = await getSheetRange({ agentId, id, range: "B2:C3", formulas: true });
    expect(read.values).toEqual([
      [1, 2],
      [2, 4],
    ]);
    expect(read.formulas).toEqual([
      [1, "=B2*2"],
      [2, "=B3*2"],
    ]);
    // A later write moves the dependents outside the written range.
    const next = await setSheetRange({ agentId, id, range: "B2", values: [[10]] });
    expect(next).toMatchObject({ changed: 1, recalculated: 1, version: 3 });
    expect((await getSheetRange({ agentId, id, range: "C2" })).values).toEqual([[20]]);
    expect(doc("t.sheet.json").tabs[0]?.cells.C2).toEqual({ f: "=B2*2", v: 20 });
  });

  test("an identical write changes nothing and does not bump the version", async () => {
    const { id } = await make();
    await setSheetRange({ agentId, id, range: "A1", values: [[5]] });
    const again = await setSheetRange({ agentId, id, range: "A1", values: [[5]] });
    expect(again).toMatchObject({ changed: 0, recalculated: 0, version: 2 });
    expect(writes).toBe(2);
  });

  test("text stays text, '= escapes a literal, null clears, errors read back as their text", async () => {
    const { id } = await make();
    await setSheetRange({
      agentId,
      id,
      range: "A1:A6",
      values: [["007"], ["'=not a formula"], ["=1/0"], [true], ["plain"], ["x"]],
    });
    await setSheetRange({ agentId, id, range: "A6", values: [[null]] });
    const read = await getSheetRange({ agentId, id, range: "A1:A6" });
    expect(read.values).toEqual([
      ["007"],
      ["=not a formula"],
      ["#DIV/0!"],
      [true],
      ["plain"],
      [null],
    ]);
    expect(doc("t.sheet.json").tabs[0]?.cells.A3).toEqual({ f: "=1/0", v: "#DIV/0!", e: true });
  });

  test("a spilled range is visible to getRange and goes with its anchor", async () => {
    const { id } = await make();
    await setSheetRange({ agentId, id, range: "D2", values: [["=SEQUENCE(3)"]] });
    expect((await getSheetRange({ agentId, id, range: "D2:D4" })).values).toEqual([[1], [2], [3]]);
    expect(doc("t.sheet.json").tabs[0]?.cells.D3).toEqual({ v: 2, s: "D2" });
    // Reading a spill child: cleared via the anchor, children are not separate writes.
    const cleared = await clearSheetRange({ agentId, id, range: "D2:D4" });
    expect(cleared.cleared).toBe(1);
    expect((await getSheetRange({ agentId, id, range: "D2:D4" })).values).toEqual([
      [null],
      [null],
      [null],
    ]);
  });

  test("appendRows lands below the used rows, clearRange caps a whole column, addTab inserts after", async () => {
    const { id } = await make();
    await setSheetRange({ agentId, id, range: "A1:B1", values: [["task", "n"]] });
    const appended = await appendSheetRows({
      agentId,
      id,
      tab: "Sheet1",
      rows: [
        ["a", 1],
        ["b", "=B2+1"],
      ],
    });
    expect(appended).toMatchObject({ range: "Sheet1!A2:B3", version: 3 });
    expect((await getSheetRange({ agentId, id, range: "A1:B3" })).values).toEqual([
      ["task", "n"],
      ["a", 1],
      ["b", 2],
    ]);

    const cleared = await clearSheetRange({ agentId, id, range: "Sheet1!B:B" });
    expect(cleared).toMatchObject({ range: "Sheet1!B1:B3", cleared: 3 });
    expect((await getSheetRange({ agentId, id, range: "A:B" })).values).toEqual([
      ["task"],
      ["a"],
      ["b"],
    ]);
    expect(await clearSheetRange({ agentId, id, range: "Z:Z" })).toMatchObject({ cleared: 0 });

    await addSheetTab({ agentId, id, name: "Second" });
    const tabs = await addSheetTab({ agentId, id, name: "Middle", after: "Sheet1" });
    expect(tabs.tabs).toEqual(["Sheet1", "Middle", "Second"]);
    expect((await getSheet({ agentId, id })).tabs).toEqual([
      { name: "Sheet1", rows: 3, cols: 1, freezeRows: 0 },
      { name: "Middle", rows: 0, cols: 0, freezeRows: 0 },
      { name: "Second", rows: 0, cols: 0, freezeRows: 0 },
    ]);
  });

  test("formulas reach across tabs and 'quoted' tab names resolve", async () => {
    const { id } = await make();
    await addSheetTab({ agentId, id, name: "My tab" });
    await setSheetRange({ agentId, id, range: "'My tab'!A1", values: [[21]] });
    await setSheetRange({ agentId, id, range: "Sheet1!A1", values: [["='My tab'!A1*2"]] });
    expect((await getSheetRange({ agentId, id, range: "A1" })).values).toEqual([[42]]);
    expect((await getSheetRange({ agentId, id, range: "'my tab'!A1" })).range).toBe("'My tab'!A1");
  });

  test("a 409 re-reads and re-applies: edits to different cells merge", async () => {
    const { id } = await make();
    let intruded = false;
    beforeWrite = (path) => {
      if (intruded) return;
      intruded = true;
      const current = files.get(path);
      const other = JSON.parse(current?.body ?? "{}");
      other.tabs[0].cells.A1 = { v: "theirs" };
      files.set(path, { body: JSON.stringify(other), version: (current?.version ?? 0) + 1 });
    };
    const out = await setSheetRange({ agentId, id, range: "B1", values: [["mine"]] });
    expect(writes).toBe(3); // create, the raced write, the retry
    expect(out.version).toBe(3);
    expect((await getSheetRange({ agentId, id, range: "A1:B1" })).values).toEqual([
      ["theirs", "mine"],
    ]);
  });

  test("the same cell written by both sides: the retrying writer wins", async () => {
    const { id } = await make();
    let intruded = false;
    beforeWrite = (path) => {
      if (intruded) return;
      intruded = true;
      const current = files.get(path);
      const other = JSON.parse(current?.body ?? "{}");
      other.tabs[0].cells.A1 = { v: "theirs" };
      files.set(path, { body: JSON.stringify(other), version: (current?.version ?? 0) + 1 });
    };
    await setSheetRange({ agentId, id, range: "A1", values: [["mine"]] });
    expect((await getSheetRange({ agentId, id, range: "A1" })).values).toEqual([["mine"]]);
  });

  test("the 4th conflict refuses with 'concurrent writers' and leaves the file as the other writer had it", async () => {
    const { id } = await make();
    beforeWrite = (path) => {
      const current = files.get(path);
      files.set(path, { body: current?.body ?? "", version: (current?.version ?? 0) + 1 });
    };
    const before = writes;
    await expect(setSheetRange({ agentId, id, range: "A1", values: [[1]] })).rejects.toThrow(
      "concurrent writers",
    );
    expect(writes - before).toBe(4);
    expect(doc("t.sheet.json").tabs[0]?.cells.A1).toBeUndefined();
  });

  test("limits refuse: range size, rectangle, tabs, cells per workbook, file size", async () => {
    const { id } = await make();
    const big = (rows: number, cols: number) =>
      Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1));
    await expect(getSheetRange({ agentId, id, range: "A1:CW101" })).rejects.toThrow(
      "10000 per call",
    );
    await expect(
      setSheetRange({ agentId, id, range: "A1", values: big(101, 100) }),
    ).rejects.toThrow("10000 per call");
    await expect(
      appendSheetRows({ agentId, id, tab: "Sheet1", rows: big(101, 100) }),
    ).rejects.toThrow("10000 per call");
    await expect(
      setSheetRange({ agentId, id, range: "A1:B2", values: [[1, 2, 3]] }),
    ).rejects.toThrow("values is 1x3 but the range is 2x2");
    await expect(
      setSheetRange({ agentId, id, range: "A1", values: [[1, 2], [3]] }),
    ).rejects.toThrow("rectangle");
    await expect(setSheetRange({ agentId, id, range: "A:A", values: [[1]] })).rejects.toThrow(
      "bounded",
    );
    await expect(
      setSheetRange({ agentId, id, range: `A${MAX_ROW}`, values: [[1], [2]] }),
    ).rejects.toThrow("runs past");
    for (let i = 2; i <= 20; i++) await addSheetTab({ agentId, id, name: `t${i}` });
    await expect(addSheetTab({ agentId, id, name: "t21" })).rejects.toThrow("at most 20 tabs");

    // 50,000 cells per workbook: five full 10,000-cell writes fit, a sixth does not.
    for (let i = 0; i < 5; i++) {
      await setSheetRange({ agentId, id, range: `t${i + 2}!A1`, values: big(100, 100) });
    }
    await expect(setSheetRange({ agentId, id, range: "t7!A1", values: [[1]] })).rejects.toThrow(
      "exceed 50000 cells",
    );
    expect(Object.keys(doc("t.sheet.json").tabs[1]?.cells ?? {}).length).toBe(10_000);

    // 5 MiB per file.
    const { id: heavy } = await make("heavy.sheet.json");
    const blob = "x".repeat(1_200_000);
    await expect(
      setSheetRange({
        agentId,
        id: heavy,
        range: "A1:A5",
        values: [[blob], [blob], [blob], [blob], [blob]],
      }),
    ).rejects.toThrow("5 MiB");
  }, 60_000);

  test("refusals: unknown id, wrong kind, bad range, unknown tab, hand-broken file", async () => {
    const { id } = await make();
    await expect(getSheet({ agentId, id: "nope" })).rejects.toThrow("no object");
    await expect(getSheet({ agentId })).rejects.toThrow("pass `id` or `path`");
    await expect(getSheetRange({ agentId, id, range: "not a range" })).rejects.toThrow("bad range");
    await expect(getSheetRange({ agentId, id, range: "Nope!A1" })).rejects.toThrow("no tab 'Nope'");
    await expect(appendSheetRows({ agentId, id, tab: "Nope", rows: [[1]] })).rejects.toThrow(
      "no tab",
    );
    await expect(addSheetTab({ agentId, id, name: "Sheet1" })).rejects.toThrow("already exists");
    await expect(addSheetTab({ agentId, id, name: "a:b" })).rejects.toThrow("invalid tab name");
    await expect(addSheetTab({ agentId, id, name: "x", after: "Nope" })).rejects.toThrow("no tab");

    const board = await createObject({ agentId, kind: "board", path: "b.excalidraw" });
    await expect(getSheet({ agentId, id: board.id })).rejects.toThrow("is a board, not a sheet");

    files.set("t.sheet.json", { body: JSON.stringify({ format: "swarm-sheet/9" }), version: 9 });
    await expect(getSheet({ agentId, id })).rejects.toThrow("not a valid swarm-sheet/1");
    files.delete("t.sheet.json");
    await expect(getSheet({ agentId, id })).rejects.toThrow("missing on the drive");
  });

  test("list returns only sheets, and reindex restores a sheet id after the table is wiped", async () => {
    const a = await make("one.sheet.json");
    await createObject({ agentId, kind: "board", path: "b.excalidraw" });
    expect((await listSheets({ agentId })).objects.map((o) => o.id)).toEqual([a.id]);
    await getDbClient().run("DELETE FROM primitive_objects");
    const report = await reindexObjects({ agentId, kind: "sheet" });
    expect(report).toMatchObject({ scanned: 1, restored: ["one.sheet.json"] });
    expect((await getObject({ agentId, path: "one.sheet.json" })).object.id).toBe(a.id);
    expect((await listObjects({ agentId, kind: "sheet" })).total).toBe(1);
  });
});
