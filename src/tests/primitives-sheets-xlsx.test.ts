import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { ObjectsError } from "../be/primitives/objects";
import { sheetEngine } from "../be/primitives/sheets/engine";
import { MAX_CELLS, MAX_TABS, type SheetTab } from "../be/primitives/sheets/format";
import {
  createSheet,
  exportSheetXlsx,
  getSheet,
  getSheetRange,
  importSheetXlsx,
  listSheets,
} from "../be/primitives/sheets/service";
import {
  buildXlsx,
  MAX_INFLATED_BYTES,
  MAX_XLSX_BYTES,
  parseXlsx,
} from "../be/primitives/sheets/xlsx";

const fixture = async (name: string) =>
  new Uint8Array(
    await Bun.file(new URL(`./fixtures/sheets/${name}`, import.meta.url)).arrayBuffer(),
  );

const OWN_KEY = "af_own_xlsx_key";
const ORG = "org-xlsx";
const DRIVE = "drive-xlsx";

// In-memory agent-fs that keeps raw bytes: GET/PUT with If-None-Match and If-Match.
const files = new Map<string, { body: Uint8Array; version: number }>();
let extraHeaders: Record<string, string> = {};

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
    const current = files.get(path);
    if (req.method === "GET") {
      if (!current) return new Response("not found", { status: 404 });
      return new Response(current.body, {
        headers: { "x-agent-fs-version": String(current.version), ...extraHeaders },
      });
    }
    if (req.headers.get("if-none-match") === "*" && current) {
      return new Response("exists", { status: 409 });
    }
    const ifMatch = req.headers.get("if-match");
    if (ifMatch && String(current?.version) !== ifMatch) {
      return new Response("version mismatch", { status: 409 });
    }
    const version = (current?.version ?? 0) + 1;
    files.set(path, { body: new Uint8Array(await req.arrayBuffer()), version });
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
  extraHeaders = {};
  await getDbClient().run("DELETE FROM primitive_objects");
});

const put = (path: string, body: Uint8Array) => files.set(path, { body, version: 1 });
const workbook = (tabs: Record<string, XLSX.WorkSheet>) => {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of Object.entries(tabs)) XLSX.utils.book_append_sheet(wb, ws, name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
};
const grid = (rows: number, cols: number) =>
  XLSX.utils.aoa_to_sheet(
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1)),
  );

/** Set the declared uncompressed size of the zip part `name` in its central directory entry. */
function declareSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < out.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(i + 28, true);
    if (new TextDecoder().decode(out.subarray(i + 46, i + 46 + nameLen)) === name) {
      view.setUint32(i + 24, size, true);
    }
  }
  return out;
}

/** Every formula cell of the xlsx with the result cached in the file. */
function cachedFormulas(bytes: Uint8Array): Map<string, number | string | boolean> {
  const wb = XLSX.read(bytes, { type: "array", cellFormula: true });
  const found = new Map<string, number | string | boolean>();
  for (const name of wb.SheetNames) {
    for (const [ref, cell] of Object.entries(wb.Sheets[name] ?? {})) {
      if (!ref.startsWith("!") && (cell as XLSX.CellObject).f) {
        found.set(`${name}!${ref}`, (cell as XLSX.CellObject).v as number | string | boolean);
      }
    }
  }
  return found;
}

describe("parseXlsx", () => {
  test("the tracker workbook: 120 of 120 recomputed formulas match the file's cached values", async () => {
    const bytes = await fixture("tracker-export.xlsx");
    const { tabs, dropped } = await parseXlsx(bytes);
    expect(tabs.map((t) => t.name)).toEqual(["Tasks", "Summary"]);
    expect(dropped).toEqual([]);
    const cached = cachedFormulas(bytes);
    expect(cached.size).toBe(120);
    const { cells } = await sheetEngine().recalc(tabs, [], { maxCells: MAX_CELLS });
    let matching = 0;
    for (const [key, want] of cached) {
      const [tab, ref] = key.split("!") as [string, string];
      const cell = cells[tabs.findIndex((t) => t.name === tab)]?.[ref];
      expect(cell?.f).toBeDefined();
      const got = cell?.v;
      const same =
        typeof want === "number" && typeof got === "number"
          ? Math.abs(want - got) <= 1e-9 * Math.max(1, Math.abs(want))
          : want === got;
      if (same) matching++;
      else console.log("mismatch", key, want, got);
    }
    expect(matching).toBe(120);
  });

  test("the rich workbook keeps formulas that have no cached value, formats, widths and merges, and names what it drops", async () => {
    const { tabs, dropped } = await parseXlsx(await fixture("rich-budget.xlsx"));
    const budget = tabs[0] as SheetTab;
    // `<f>D3-C3</f><v />`: a formula with no cached value survives (sheetStubs).
    expect(Object.values(budget.cells).filter((c) => c.f).length).toBe(14);
    expect(budget.cells.E3?.f).toBe("=D3-C3");
    expect(budget.cells.C3).toEqual({ v: 12000, nf: '"$"#,##0.00' });
    expect(budget.merges).toEqual(["A1:E1"]);
    expect(budget.colWidths).toEqual({ A: 132, C: 84 });
    expect(tabs[1]?.cells.B3).toEqual({ v: "007", nf: "@" });
    expect(dropped.sort()).toEqual(
      [
        "autofilter",
        "cell styling (fills, bold, borders)",
        "charts",
        "comments",
        "conditional formatting",
        "data validation",
        "defined names",
        "frozen panes",
        "hyperlinks",
      ].sort(),
    );
    // The engine accepts what the parser produced, including a `@` text format.
    const { cells } = await sheetEngine().recalc(tabs, [], { maxCells: MAX_CELLS });
    expect(cells[0]?.E3?.v).toBe(-750);
    expect(cells[1]?.B3?.v).toBe("007");
  });

  test("strips the _xlws prefix Excel writes and keeps a multi-cell array formula as values", async () => {
    const ws = XLSX.utils.aoa_to_sheet([[1, 2, 3]]);
    ws.D1 = { t: "n", v: 6, f: "_xlfn.IFS(A1=1,B1+C1)+_xlfn._xlws.SORT(A1:C1)" };
    ws.A3 = { t: "n", v: 7, f: "A1+6", F: "A3:A4" };
    ws["!ref"] = "A1:D4";
    const { tabs, dropped } = await parseXlsx(workbook({ Data: ws }));
    expect(tabs[0]?.cells.D1?.f).toBe("=IFS(A1=1,B1+C1)+SORT(A1:C1)");
    expect(tabs[0]?.cells.A3).toEqual({ v: 7 });
    expect(dropped).toEqual(["array formulas (kept as values)"]);
  });

  test("an error constant becomes text and is named", async () => {
    const ws = XLSX.utils.aoa_to_sheet([[1]]);
    ws.B1 = { t: "e", v: 42, w: "#N/A" };
    ws["!ref"] = "A1:B1";
    const { tabs, dropped } = await parseXlsx(workbook({ Data: ws }));
    expect(tabs[0]?.cells.B1).toEqual({ v: "#N/A" });
    expect(dropped).toContain("error constants (kept as text)");
  });

  test("refuses what is not an xlsx", async () => {
    const reason = async (bytes: Uint8Array) =>
      parseXlsx(bytes).then(
        () => "accepted",
        (error: unknown) => (error instanceof ObjectsError ? error.message : String(error)),
      );
    expect(await reason(new TextEncoder().encode("a,b\n1,2\n"))).toContain("not a zip");
    expect(await reason(new Uint8Array())).toContain("not an xlsx");
    const ods = new Uint8Array(
      XLSX.write(
        (() => {
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, grid(1, 1), "S");
          return wb;
        })(),
        { type: "array", bookType: "ods" },
      ),
    );
    expect(await reason(ods)).toContain("no xl/workbook.xml");
    const good = await fixture("tracker-export.xlsx");
    expect(await reason(good.subarray(0, good.length - 40))).toContain("not an xlsx");
  });

  test("refuses a zip bomb by its declared size, and a directory that lies about it", async () => {
    const good = await fixture("tracker-export.xlsx");
    const declared = declareSize(good, "xl/worksheets/sheet1.xml", MAX_INFLATED_BYTES + 1);
    await expect(parseXlsx(declared)).rejects.toThrow("inflates to more than");
    // Declares 10 bytes, the stream holds far more: the bounded inflate refuses before SheetJS runs.
    const lying = declareSize(good, "xl/worksheets/sheet1.xml", 10);
    await expect(parseXlsx(lying)).rejects.toThrow(/corrupt zip archive|does not match/);
  });

  test("refuses over the tab and cell limits", async () => {
    const tabs = Object.fromEntries(
      Array.from({ length: MAX_TABS + 1 }, (_, i) => [`T${i + 1}`, grid(1, 1)]),
    );
    await expect(parseXlsx(workbook(tabs))).rejects.toThrow(`the limit is ${MAX_TABS}`);
    await expect(parseXlsx(workbook({ Big: grid(501, 100) }))).rejects.toThrow(
      `the limit is ${MAX_CELLS}`,
    );
  });
});

describe("buildXlsx", () => {
  const tabs: SheetTab[] = [
    {
      name: "Data",
      colWidths: { A: 120 },
      merges: ["A1:B1"],
      freezeRows: 1,
      cells: {
        A1: { v: "Title" },
        A2: { v: 3, nf: "0.00" },
        B2: { f: "=IFS(A2>1,A2*2,TRUE,0)", v: 6 },
        C2: { f: "=1/0", v: "#DIV/0!", e: true },
        D2: { f: "=SEQUENCE(2)", v: 1 },
        D3: { v: 2, s: "D2" },
        E2: { v: true },
      },
    },
    { name: "Empty", cells: {} },
  ];

  test("writes values, cached results, formats, widths and merges, and names what it drops", async () => {
    const { bytes, dropped } = await buildXlsx(tabs);
    expect(dropped.sort()).toEqual([
      "frozen panes",
      "spilled array cells (written as values; the anchor keeps its formula)",
    ]);
    const wb = XLSX.read(bytes, {
      type: "array",
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
      bookFiles: true,
    });
    expect(wb.SheetNames).toEqual(["Data", "Empty"]);
    const ws = wb.Sheets.Data as XLSX.WorkSheet;
    expect(ws.A2).toMatchObject({ t: "n", v: 3, z: "0.00" });
    // Excel needs the prefix on functions newer than 2007, or it shows #NAME?.
    const xml = String(
      (wb as { files?: Record<string, { content: unknown }> }).files?.["xl/worksheets/sheet1.xml"]
        ?.content,
    );
    expect(xml).toContain("<f>_xlfn.IFS(A2&gt;1,A2*2,TRUE,0)</f>");
    expect(xml).toContain("<f>_xlfn.SEQUENCE(2)</f>");
    expect(ws.B2?.v).toBe(6);
    expect(ws.C2).toMatchObject({ t: "e", w: "#DIV/0!" });
    expect(ws.D3).toMatchObject({ t: "n", v: 2 });
    expect(ws.E2).toMatchObject({ t: "b", v: true });
    expect(ws["!merges"]?.length).toBe(1);
    expect(ws["!cols"]?.[0]?.wpx).toBe(120);
  });

  test("refuses a hand-edited tab name Excel forbids", async () => {
    await expect(buildXlsx([{ name: "a:b", cells: {} }])).rejects.toThrow(
      "cannot export tab 'a:b'",
    );
  });

  test("parse reads back what build wrote", async () => {
    const { bytes } = await buildXlsx(tabs);
    const back = await parseXlsx(bytes);
    expect(back.tabs.map((t) => t.name)).toEqual(["Data", "Empty"]);
    const data = back.tabs[0] as SheetTab;
    expect(data.cells.B2?.f).toBe("=IFS(A2>1,A2*2,TRUE,0)");
    expect(data.cells.A2).toEqual({ v: 3, nf: "0.00" });
    expect(data.colWidths).toEqual({ A: 120 });
    expect(data.merges).toEqual(["A1:B1"]);
  });
});

describe("importSheetXlsx and exportSheetXlsx", () => {
  test("round trip: tabs, values and the formula count survive import, export and re-import", async () => {
    put("in/tracker.xlsx", await fixture("tracker-export.xlsx"));
    const imported = await importSheetXlsx({
      agentId,
      sourcePath: "/in/tracker.xlsx",
      path: "out/tracker.sheet.json",
      title: "Tracker",
    });
    expect(imported.dropped).toEqual([]);
    expect(imported.object).toMatchObject({ kind: "sheet", path: "out/tracker.sheet.json" });
    expect(imported.link).toContain("out/tracker.sheet.json");

    const first = await getSheet({ agentId, id: imported.object.id });
    expect(first.tabs.map((t) => t.name)).toEqual(["Tasks", "Summary"]);
    const formulas = (id: string, tab: string, range: string) =>
      getSheetRange({ agentId, id, range: `${tab}!${range}`, formulas: true });

    const exported = await exportSheetXlsx({
      agentId,
      id: imported.object.id,
      targetPath: "/out/tracker-copy.xlsx",
    });
    expect(exported).toMatchObject({ path: "out/tracker-copy.xlsx", dropped: [] });
    expect(exported.link).toContain("out/tracker-copy.xlsx");
    expect(files.get("out/tracker-copy.xlsx")?.body.length).toBeGreaterThan(1000);

    const again = await importSheetXlsx({
      agentId,
      sourcePath: "out/tracker-copy.xlsx",
      path: "out/tracker-2.sheet.json",
    });
    const second = await getSheet({ agentId, id: again.object.id });
    expect(second.tabs.map((t) => [t.name, t.rows, t.cols])).toEqual(
      first.tabs.map((t) => [t.name, t.rows, t.cols]),
    );
    const count = (grids: Array<Array<string | number | boolean | null>>) =>
      grids.flat().filter((cell) => typeof cell === "string" && cell.startsWith("=")).length;
    let total = 0;
    for (const tab of first.tabs) {
      const range = `A1:${String.fromCharCode(64 + tab.cols)}${tab.rows}`;
      const a = await formulas(imported.object.id, tab.name, range);
      const b = await formulas(again.object.id, tab.name, range);
      expect(b.values).toEqual(a.values);
      expect(b.formulas).toEqual(a.formulas);
      total += count(a.formulas ?? []);
    }
    expect(total).toBe(120);
    // The exported file's cached values are the engine's, so a spreadsheet app sees the same numbers.
    expect(cachedFormulas(files.get("out/tracker-copy.xlsx")?.body as Uint8Array).size).toBe(120);
  });

  test("a refused import leaves nothing behind", async () => {
    put("in/notes.xlsx", new TextEncoder().encode("hello"));
    put("in/huge.xlsx", workbook({ Big: grid(501, 100) }));
    put(
      "in/many.xlsx",
      workbook(
        Object.fromEntries(
          Array.from({ length: MAX_TABS + 1 }, (_, i) => [`T${i + 1}`, grid(1, 1)]),
        ),
      ),
    );
    put("in/data.csv", new TextEncoder().encode("a,b"));
    const refuse = (sourcePath: string, path = "x.sheet.json") =>
      importSheetXlsx({ agentId, sourcePath, path }).then(
        () => "accepted",
        (error: unknown) => (error instanceof ObjectsError ? error.message : String(error)),
      );
    expect(await refuse("in/notes.xlsx")).toContain("not an xlsx workbook");
    expect(await refuse("in/huge.xlsx")).toContain(`the limit is ${MAX_CELLS}`);
    expect(await refuse("in/many.xlsx")).toContain(`the limit is ${MAX_TABS}`);
    expect(await refuse("in/data.csv")).toContain("must end in .xlsx");
    expect(await refuse("in/missing.xlsx")).toContain("no file at 'in/missing.xlsx'");
    expect(await refuse("in/notes.xlsx", "x.json")).toContain(".sheet.json");
    expect((await listSheets({ agentId })).total).toBe(0);
    expect([...files.keys()].some((p) => p.endsWith(".sheet.json"))).toBe(false);
  });

  test("refuses a file over the size limit by its content-length, before reading it", async () => {
    put("in/big.xlsx", new Uint8Array(MAX_XLSX_BYTES + 1));
    await expect(
      importSheetXlsx({ agentId, sourcePath: "in/big.xlsx", path: "big.sheet.json" }),
    ).rejects.toThrow("5 MiB");
  });

  test("an import is create-only; an export is create-only unless overwrite", async () => {
    put("in/tracker.xlsx", await fixture("tracker-export.xlsx"));
    const args = { agentId, sourcePath: "in/tracker.xlsx", path: "t.sheet.json" };
    const { object } = await importSheetXlsx(args);
    await expect(importSheetXlsx(args)).rejects.toThrow("already exists");
    await exportSheetXlsx({ agentId, id: object.id, targetPath: "e.xlsx" });
    await expect(exportSheetXlsx({ agentId, id: object.id, targetPath: "e.xlsx" })).rejects.toThrow(
      "pass overwrite: true",
    );
    const before = files.get("e.xlsx")?.version ?? 0;
    await exportSheetXlsx({ agentId, id: object.id, targetPath: "e.xlsx", overwrite: true });
    expect(files.get("e.xlsx")?.version).toBe(before + 1);
    await expect(exportSheetXlsx({ agentId, id: object.id, targetPath: "e.csv" })).rejects.toThrow(
      "must end in .xlsx",
    );
  });

  test("an export of an unknown id or of a board is refused", async () => {
    await expect(exportSheetXlsx({ agentId, id: "nope", targetPath: "e.xlsx" })).rejects.toThrow(
      "no object",
    );
    expect(files.has("e.xlsx")).toBe(false);
    const sheet = (await createSheet({ agentId, path: "s.sheet.json" })).object;
    const exported = await exportSheetXlsx({ agentId, id: sheet.id, targetPath: "empty.xlsx" });
    expect(exported.dropped).toEqual([]);
    expect((await parseXlsx(files.get("empty.xlsx")?.body as Uint8Array)).tabs[0]?.name).toBe(
      "Sheet1",
    );
  });
});
