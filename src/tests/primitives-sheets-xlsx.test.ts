import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { ObjectsError } from "../be/primitives/objects";
import { sheetEngine } from "../be/primitives/sheets/engine";
import { MAX_CELLS, MAX_TABS, type SheetTab } from "../be/primitives/sheets/format";
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

const workbook = (tabs: Record<string, XLSX.WorkSheet>) => {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of Object.entries(tabs)) XLSX.utils.book_append_sheet(wb, ws, name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
};
const grid = (rows: number, cols: number) =>
  XLSX.utils.aoa_to_sheet(
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1)),
  );

/** Declare the uncompressed size of the zip part `name` in its central directory entry and its local header. */
function declareSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < out.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(i + 28, true);
    if (new TextDecoder().decode(out.subarray(i + 46, i + 46 + nameLen)) === name) {
      view.setUint32(i + 24, size, true);
      view.setUint32(view.getUint32(i + 42, true) + 22, size, true);
    }
  }
  return out;
}

type ZipHeader = { method: number; csz: number; usz: number; name: string; extra: Uint8Array };
type ZipPart = {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  usz?: number;
  /** Header fields to write differently into the central directory entry or the local header. */
  cd?: Partial<ZipHeader>;
  local?: Partial<ZipHeader>;
};

/** A zip with every header field under the test's control, to build archives whose headers disagree. */
function zip(
  parts: ZipPart[],
  end: { disk?: number; entriesDisk?: number; entries?: number; gap?: number } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let at = 0;
  const push = (
    to: Uint8Array[],
    build: (view: DataView) => void,
    size: number,
    ...tail: Uint8Array[]
  ) => {
    const head = new Uint8Array(size);
    build(new DataView(head.buffer));
    to.push(head, ...tail);
    return head.length + tail.reduce((n, t) => n + t.length, 0);
  };
  const text = (value: string) => new TextEncoder().encode(value);
  for (const part of parts) {
    const method = part.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(part.data)) : part.data;
    const base: ZipHeader = {
      method,
      csz: body.length,
      usz: part.usz ?? part.data.length,
      name: part.name,
      extra: new Uint8Array(),
    };
    const local = { ...base, ...part.local };
    const cd = { ...base, ...part.cd };
    const offset = at;
    at += push(
      chunks,
      (v) => {
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(8, local.method, true);
        v.setUint32(18, local.csz, true);
        v.setUint32(22, local.usz, true);
        v.setUint16(26, text(local.name).length, true);
        v.setUint16(28, local.extra.length, true);
      },
      30,
      text(local.name),
      local.extra,
      body,
    );
    push(
      dir,
      (v) => {
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(10, cd.method, true);
        v.setUint32(20, cd.csz, true);
        v.setUint32(24, cd.usz, true);
        v.setUint16(28, text(cd.name).length, true);
        v.setUint16(30, cd.extra.length, true);
        v.setUint32(42, offset, true);
      },
      46,
      text(cd.name),
      cd.extra,
    );
  }
  const dirSize = dir.reduce((n, d) => n + d.length, 0);
  const gap = new Uint8Array(end.gap ?? 0);
  push(
    dir,
    (v) => {
      v.setUint32(0, 0x06054b50, true);
      v.setUint16(4, end.disk ?? 0, true);
      v.setUint16(8, end.entriesDisk ?? parts.length, true);
      v.setUint16(10, end.entries ?? parts.length, true);
      v.setUint32(12, dirSize, true);
      v.setUint32(16, at, true);
    },
    22,
  );
  return new Uint8Array(
    Buffer.concat([...chunks, ...dir.slice(0, -1), gap, dir.at(-1) as Uint8Array]),
  );
}

/** Zip64 extra field: an 8-byte uncompressed size, then an 8-byte compressed size. */
const zip64Extra = (usz: number, csz: number) => {
  const extra = new Uint8Array(20);
  const view = new DataView(extra.buffer);
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, 16, true);
  view.setBigUint64(4, BigInt(usz), true);
  view.setBigUint64(12, BigInt(csz), true);
  return extra;
};

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

  describe("dropped-feature detection stays linear on a hostile archive", () => {
    // Rebuild a workbook with `edit` applied to one part's text, through the header-exact zip helper.
    const patched = (part: string, edit: (xml: string) => string): Uint8Array => {
      const wb = XLSX.read(workbook({ Data: XLSX.utils.aoa_to_sheet([[42]]) }), {
        type: "array",
        bookFiles: true,
      });
      // `mt` marks the zip parts; the other entry is SheetJS's internal compound-file stub.
      const parts = Object.entries(
        (wb as { files: Record<string, { content: Uint8Array; mt?: unknown }> }).files,
      ).filter(([, file]) => file.mt);
      return zip(
        parts.map(([name, { content }]) => ({
          name,
          data:
            name === part
              ? new TextEncoder().encode(edit(new TextDecoder().decode(content)))
              : content,
        })),
      );
    };
    const SHEET = "xl/worksheets/sheet1.xml";
    const STYLES = "xl/styles.xml";
    const before = (tag: string, insert: string) => (xml: string) => xml.replace(tag, insert + tag);
    // 32k tokens are 192 KB of XML: nowhere near any cap, and about 6 s on the old regexes.
    const comment = (token: string) => `<!--${token.repeat(32_000)}-->`;
    const timed = async (bytes: Uint8Array) => {
      const start = performance.now();
      const result = await parseXlsx(bytes);
      return { ...result, ms: performance.now() - start };
    };

    test("32k unclosed <pane tokens in a comment parse in well under a second and still read the data", async () => {
      const { tabs, dropped, ms } = await timed(
        patched(SHEET, before("</worksheet>", comment("<pane "))),
      );
      expect(tabs[0]?.cells.A1).toEqual({ v: 42 });
      expect(dropped).not.toContain("frozen panes");
      expect(ms).toBeLessThan(1000);
    });

    test("32k unclosed <font> tokens in a comment parse in well under a second and still read the data", async () => {
      const { tabs, dropped, ms } = await timed(
        patched(STYLES, before("</styleSheet>", comment("<font>"))),
      );
      expect(tabs[0]?.cells.A1).toEqual({ v: 42 });
      expect(dropped).not.toContain("cell styling (fills, bold, borders)");
      expect(ms).toBeLessThan(1000);
    });

    test("a real frozen pane and a real bold font are still named after the hostile run", async () => {
      const pane =
        '<sheetViews><sheetView><pane state="frozen" ySplit="1"/></sheetView></sheetViews>';
      const frozen = await timed(
        patched(SHEET, before("</worksheet>", `${comment("<pane ")}${pane}`)),
      );
      expect(frozen.dropped).toContain("frozen panes");
      expect(frozen.ms).toBeLessThan(1000);
      const bold = await timed(
        patched(STYLES, before("</styleSheet>", `${comment("<font>")}<font><b/></font>`)),
      );
      expect(bold.dropped).toContain("cell styling (fills, bold, borders)");
      expect(bold.ms).toBeLessThan(1000);
    });

    test("a pane that is not frozen, and a font that is not bold, are not reported", async () => {
      const plain = await parseXlsx(
        patched(
          SHEET,
          before("</worksheet>", '<pane xSplit="1"/><pane ySplit="1" state="split"/>'),
        ),
      );
      expect(plain.dropped).not.toContain("frozen panes");
      const font = await parseXlsx(
        patched(STYLES, before("</styleSheet>", "<font><i/></font><font><sz/></font>")),
      );
      expect(font.dropped).not.toContain("cell styling (fills, bold, borders)");
    });
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

  test("strips the _xlfn and _xlws prefixes outside quotes only, so a string or sheet name that spells one survives", async () => {
    const ws = XLSX.utils.aoa_to_sheet([[1]]);
    ws.B1 = { t: "s", v: "x", f: 'IF(TRUE,"_xlfn.IFS(","_xlws.SORT(""_xlfn.")&\'_xlws.Tab\'!A1' };
    ws["!ref"] = "A1:B1";
    const { tabs } = await parseXlsx(workbook({ Data: ws }));
    expect(tabs[0]?.cells.B1?.f).toBe(
      '=IF(TRUE,"_xlfn.IFS(","_xlws.SORT(""_xlfn.")&\'_xlws.Tab\'!A1',
    );
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
    // Declares 10 bytes in both headers, the stream holds far more: the bounded inflate refuses before SheetJS runs.
    const lying = declareSize(good, "xl/worksheets/sheet1.xml", 10);
    await expect(parseXlsx(lying)).rejects.toThrow(/corrupt zip archive|does not match/);
  });

  test("refuses a 17 MiB part hidden behind mismatched end-of-directory counts (SheetJS reads the per-disk count)", async () => {
    // tracker-export.xlsx with xl/workbook.xml first and a 17 MiB deflated padding.bin: per-disk count 12, total 1.
    const bomb = await fixture("eocd-count-mismatch.xlsx");
    expect(bomb.length).toBeLessThan(MAX_XLSX_BYTES);
    await expect(parseXlsx(bomb)).rejects.toThrow("inconsistent or ZIP64 counts");
  });

  // Every way the archive can read differently to the checker and to SheetJS, which trusts the local
  // headers, the per-disk entry count and ZIP64 extras. Each one must be refused before SheetJS runs.
  const workbookXml = new TextEncoder().encode("<workbook/>");
  const padding = new Uint8Array(MAX_INFLATED_BYTES + 1024 * 1024).fill(120);
  const small = { name: "xl/workbook.xml", data: workbookXml };
  const bombPart = { name: "padding.bin", data: padding };
  const disagreements: [string, Uint8Array, string][] = [
    [
      "per-disk count above the total",
      zip([small, bombPart], { entries: 1 }),
      "inconsistent or ZIP64 counts",
    ],
    [
      "total count above the per-disk count",
      zip([small, bombPart], { entriesDisk: 1 }),
      "inconsistent or ZIP64 counts",
    ],
    ["a split-disk end record", zip([small], { disk: 1 }), "inconsistent or ZIP64 counts"],
    [
      "bytes between the directory and the end record",
      zip([small], { gap: 8 }),
      "does not end at the end record",
    ],
    [
      "local method deflate, directory says stored",
      zip([
        {
          ...small,
          data: padding,
          cd: { method: 0, usz: 100, csz: 100 },
          local: { usz: 100, csz: 100 },
        },
      ]),
      "local header disagrees",
    ],
    [
      "local name differs from the directory name",
      zip([{ ...small, local: { name: "xl/other.xml" } }]),
      "local header disagrees",
    ],
    [
      "local uncompressed size, the buffer SheetJS allocates, above the directory's",
      zip([{ ...small, local: { usz: 2 ** 31 } }]),
      "local header disagrees",
    ],
    [
      "local compressed size above the directory's",
      zip([{ ...small, local: { csz: 2 ** 31 } }]),
      "local header disagrees",
    ],
    [
      "a ZIP64 extra field in the directory",
      zip([{ ...small, cd: { extra: zip64Extra(2 ** 33, 1) } }]),
      "ZIP64 sizes",
    ],
    [
      "a ZIP64 extra field in the local header",
      zip([{ ...small, local: { extra: zip64Extra(2 ** 33, 1) } }]),
      "local header disagrees",
    ],
  ];
  test.each(disagreements)("refuses an archive with %s", async (_why, bytes, message) => {
    await expect(parseXlsx(bytes)).rejects.toThrow(message);
  });

  test("the archive builder writes a zip the checker accepts when the headers agree", async () => {
    // Control: the refusals above come from the disagreement, not from the builder's output.
    await expect(parseXlsx(zip([small, bombPart]))).rejects.toThrow("inflates to more than");
    const ok = zip([small, { name: "xl/media/a.png", data: padding.subarray(0, 100) }]);
    const outcome = await parseXlsx(ok).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    expect(outcome).not.toMatch(/disagrees|inconsistent|ZIP64|does not end/);
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

  // A function name inside a string literal or a quoted sheet name is text, not a call: only real calls get the prefix.
  test("prefixes function calls but never text inside string literals or quoted sheet names", async () => {
    const formulas = {
      A1: ['=IF(TRUE,"IFS(","SORT(")', "<f>IF(TRUE,&quot;IFS(&quot;,&quot;SORT(&quot;)</f>"],
      A2: [
        '=IFS(TRUE,"IFS(")&SORT("a")',
        "<f>_xlfn.IFS(TRUE,&quot;IFS(&quot;)&amp;_xlfn._xlws.SORT(&quot;a&quot;)</f>",
      ],
      A3: [
        '=IF(A1="say ""IFS("" now",SEQUENCE(2),"x")',
        "<f>IF(A1=&quot;say &quot;&quot;IFS(&quot;&quot; now&quot;,_xlfn.SEQUENCE(2),&quot;x&quot;)</f>",
      ],
      A4: [
        "=SORT('SORT(''s'!A1:A3)",
        "<f>_xlfn._xlws.SORT(&apos;SORT(&apos;&apos;s&apos;!A1:A3)</f>",
      ],
    };
    const cells = Object.fromEntries(
      Object.entries(formulas).map(([ref, [f]]) => [ref, { f: f as string, v: "IFS(" }]),
    );
    const { bytes } = await buildXlsx([{ name: "Data", cells }]);
    const wb = XLSX.read(bytes, { type: "array", bookFiles: true });
    const xml = String(
      (wb as { files?: Record<string, { content: unknown }> }).files?.["xl/worksheets/sheet1.xml"]
        ?.content,
    );
    for (const [, expected] of Object.values(formulas)) expect(xml).toContain(expected as string);
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
