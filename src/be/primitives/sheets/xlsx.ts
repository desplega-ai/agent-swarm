import { inflateRawSync } from "node:zlib";
import type { CellObject, WorkSheet } from "xlsx";
import { ObjectsError } from "../objects";
import { colName, parseCell, refOf } from "./a1";
import { MAX_CELLS, MAX_FILE_BYTES, MAX_TABS, type SheetCell, type SheetTab } from "./format";

/**
 * xlsx <-> `swarm-sheet/1` on SheetJS CE. Import and export only: the sheet file
 * stays the source of truth. Kept: tab names and order, values, formulas, number
 * formats, column widths, merged ranges. Everything else is reported in `dropped`.
 */

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Compressed upload limit: the same 5 MiB a `.sheet.json` may hold. The service checks it before it reads the body. */
export const MAX_XLSX_BYTES = MAX_FILE_BYTES;
/** Sum of every part once inflated. A real 50,000-cell workbook is a few MiB; this stops a zip bomb. */
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024;

const notXlsx = (why: string) => new ObjectsError(`not an xlsx workbook: ${why}`);

/**
 * Names of the zip parts, after proving every part inflates to exactly its declared size
 * and that the declared sizes stay under the cap. SheetJS inflates whatever the stream holds,
 * so this runs first: a lying central directory cannot make it allocate more than the cap.
 */
function checkedZipParts(bytes: Uint8Array): Set<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new Set<string>();
  try {
    let eocd = bytes.length - 22;
    while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
    if (eocd < 0) throw notXlsx("not a zip archive (no end-of-directory record)");
    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    let inflated = 0;
    for (let n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) throw notXlsx("broken zip directory");
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const fullSize = view.getUint32(at + 24, true);
      const nameLen = view.getUint16(at + 28, true);
      const next =
        at + 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      names.add(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen)));
      inflated += fullSize;
      if (inflated > MAX_INFLATED_BYTES) {
        throw new ObjectsError(
          `the workbook inflates to more than ${MAX_INFLATED_BYTES} bytes (16 MiB); refusing it`,
        );
      }
      const start =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      let actual: number;
      if (method === 0) actual = data.length;
      else if (method === 8)
        actual = inflateRawSync(data, { maxOutputLength: Math.max(fullSize, 1) }).length;
      else throw notXlsx(`unsupported zip compression method ${method}`);
      if (actual !== fullSize) throw notXlsx("a zip part does not match its declared size");
      at = next;
    }
  } catch (error) {
    if (error instanceof ObjectsError) throw error;
    // RangeError (read past the end), zlib errors (bad stream, output past the declared size).
    throw notXlsx(`corrupt zip archive (${(error as Error).message})`);
  }
  return names;
}

// SheetJS already drops `_xlfn.` when it reads a formula; it leaves `_xlws.` (the sort/filter family) in place.
const XLWS = /_xlws\./g;

/** Functions Excel stores with an `_xlfn.` prefix (`_xlfn._xlws.` for the two that sort or filter). Without it Excel shows #NAME?. */
const XLFN_FUNCTIONS = [
  "CONCAT",
  "IFNA",
  "IFS",
  "MAXIFS",
  "MINIFS",
  "SEQUENCE",
  "STDEV.P",
  "STDEV.S",
  "SWITCH",
  "TEXTJOIN",
  "UNIQUE",
  "VAR.P",
  "VAR.S",
  "XLOOKUP",
  "XMATCH",
];
const XLWS_FUNCTIONS = ["FILTER", "SORT"];
const prefixFunctions = (formula: string, names: string[], prefix: string) =>
  names.reduce(
    (f, name) =>
      f.replace(new RegExp(`(?<![\\w.])${name.replace(".", "\\.")}\\(`, "gi"), `${prefix}${name}(`),
    formula,
  );

// shortcut: a fixed list of post-2007 functions; add a name here when Excel shows #NAME? for one we export.
const toXlsxFormula = (formula: string) =>
  prefixFunctions(
    prefixFunctions(formula.slice(1), XLFN_FUNCTIONS, "_xlfn."),
    XLWS_FUNCTIONS,
    "_xlfn._xlws.",
  );

const ERROR_CODES: Record<string, number> = {
  "#NULL!": 0,
  "#DIV/0!": 7,
  "#VALUE!": 15,
  "#REF!": 23,
  "#NAME?": 29,
  "#NUM!": 36,
  "#N/A": 42,
};

type Zip = Record<string, { content?: string | Uint8Array } | undefined>;

/** Features of the file that a `swarm-sheet/1` workbook does not carry, read from the zip parts. */
function lostFeatures(names: Set<string>, files: Zip, definedNames: boolean): string[] {
  const found = new Set<string>();
  const text = (name: string) => {
    const content = files[name]?.content;
    return typeof content === "string" ? content : content ? new TextDecoder().decode(content) : "";
  };
  const has = (prefix: string) => [...names].some((name) => name.startsWith(prefix));
  if (has("xl/charts/")) found.add("charts");
  if (has("xl/media/")) found.add("images");
  if (has("xl/comments") || has("xl/threadedComments")) found.add("comments");
  if (has("xl/pivot")) found.add("pivot tables");
  if (has("xl/tables/")) found.add("Excel tables");
  if (names.has("xl/vbaProject.bin")) found.add("macros");
  for (const name of names) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    const xml = text(name);
    if (xml.includes("<conditionalFormatting")) found.add("conditional formatting");
    if (xml.includes("<dataValidation")) found.add("data validation");
    if (xml.includes("<autoFilter")) found.add("autofilter");
    if (xml.includes("<hyperlink ")) found.add("hyperlinks");
    if (xml.includes("<sheetProtection")) found.add("sheet protection");
    if (/<pane [^>]*state="frozen"/.test(xml)) found.add("frozen panes");
  }
  const styles = text("xl/styles.xml");
  if (
    /<patternFill patternType="solid"/.test(styles) ||
    /<font>(?:(?!<\/font>).)*<b\/>/s.test(styles) ||
    /<(left|right|top|bottom) style="/.test(styles)
  ) {
    found.add("cell styling (fills, bold, borders)");
  }
  if (definedNames) found.add("defined names");
  return [...found];
}

/** Parse an xlsx into tabs. The engine recomputes every formula afterwards, so cached results are not kept. */
export async function parseXlsx(
  bytes: Uint8Array,
): Promise<{ tabs: SheetTab[]; dropped: string[] }> {
  const names = checkedZipParts(bytes);
  if (!names.has("xl/workbook.xml")) throw notXlsx("the archive has no xl/workbook.xml");
  const XLSX = await import("xlsx");
  // shortcut: SheetJS parses on the API thread; the file, inflated and cell caps bound it (50,000 cells parse in about 0.2 s). Move it to the engine worker if imports ever stall the API.
  let wb: ReturnType<typeof XLSX.read>;
  try {
    // sheetStubs keeps a formula cell that has no cached value.
    wb = XLSX.read(bytes, {
      type: "array",
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
      sheetStubs: true,
      bookFiles: true,
    });
  } catch (error) {
    throw notXlsx((error as Error).message);
  }
  if (wb.SheetNames.length > MAX_TABS) {
    throw new ObjectsError(
      `the workbook has ${wb.SheetNames.length} tabs; the limit is ${MAX_TABS}`,
    );
  }
  const dropped = new Set<string>();
  let cellTotal = 0;
  const tabs = wb.SheetNames.map((name): SheetTab => {
    const ws = wb.Sheets[name] as WorkSheet;
    const cells: Record<string, SheetCell> = {};
    for (const [ref, entry] of Object.entries(ws)) {
      if (ref.startsWith("!")) continue;
      const cell = entry as CellObject;
      const out: SheetCell = {};
      if (typeof cell.f === "string" && cell.f !== "") {
        // A multi-cell array formula would spill over its own cached cells: keep the values.
        if (cell.F?.includes(":")) dropped.add("array formulas (kept as values)");
        else out.f = `=${cell.f.replace(XLWS, "")}`;
      }
      if (out.f === undefined) {
        if (cell.t === "n" || cell.t === "s") out.v = cell.v as number | string;
        else if (cell.t === "b") out.v = !!cell.v;
        else if (cell.t === "e") {
          out.v = cell.w ?? "#VALUE!";
          dropped.add("error constants (kept as text)");
        }
      }
      // A stub with no formula and no value is an empty styled cell.
      if (out.f === undefined && out.v === undefined) continue;
      if (typeof cell.z === "string" && cell.z !== "General") out.nf = cell.z;
      cells[ref] = out;
      if (++cellTotal > MAX_CELLS) {
        throw new ObjectsError(
          `the workbook has more than ${MAX_CELLS} cells; the limit is ${MAX_CELLS}`,
        );
      }
    }
    const tab: SheetTab = { name, cells };
    const widths: Record<string, number> = {};
    (ws["!cols"] ?? []).forEach((col, i) => {
      const px = col?.wpx ?? (col?.wch ? Math.round(col.wch * 7 + 5) : 0);
      if (px) widths[colName(i + 1)] = px;
    });
    if (Object.keys(widths).length) tab.colWidths = widths;
    if (ws["!merges"]?.length)
      tab.merges = ws["!merges"].map((range) => XLSX.utils.encode_range(range));
    return tab;
  });
  const definedNames = !!wb.Workbook?.Names?.some((n) => !String(n.Name).startsWith("_xlnm"));
  for (const feature of lostFeatures(names, (wb as { files?: Zip }).files ?? {}, definedNames)) {
    dropped.add(feature);
  }
  return { tabs, dropped: [...dropped] };
}

/** Build an xlsx from a workbook's tabs. Formulas keep their cached result. */
export async function buildXlsx(
  tabs: SheetTab[],
): Promise<{ bytes: Uint8Array; dropped: string[] }> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const dropped = new Set<string>();
  for (const tab of tabs) {
    const ws: WorkSheet = {};
    let rows = 0;
    let cols = 0;
    for (const [ref, c] of Object.entries(tab.cells)) {
      const at = parseCell(ref);
      rows = Math.max(rows, at.row);
      cols = Math.max(cols, at.col);
      let cell: CellObject;
      if (c.e) {
        const text = String(c.v);
        cell = { t: "e", v: ERROR_CODES[text] ?? ERROR_CODES["#VALUE!"], w: text };
      } else if (typeof c.v === "number") cell = { t: "n", v: c.v };
      else if (typeof c.v === "boolean") cell = { t: "b", v: c.v };
      else if (typeof c.v === "string") cell = { t: "s", v: c.v };
      else cell = { t: "z" };
      if (c.f) cell.f = toXlsxFormula(c.f);
      if (c.nf) cell.z = c.nf;
      if (c.s) dropped.add("spilled array cells (written as values; the anchor keeps its formula)");
      ws[ref] = cell;
    }
    ws["!ref"] = rows ? `A1:${refOf(rows, cols)}` : "A1";
    if (tab.colWidths) {
      ws["!cols"] = Array.from({ length: cols }, (_, i) => {
        const px = tab.colWidths?.[colName(i + 1)];
        return px ? { wpx: px } : {};
      });
    }
    if (tab.merges) ws["!merges"] = tab.merges.map((range) => XLSX.utils.decode_range(range));
    // SheetJS CE cannot write the pane element.
    if (tab.freezeRows) dropped.add("frozen panes");
    try {
      XLSX.utils.book_append_sheet(wb, ws, tab.name);
    } catch (error) {
      // A hand-edited file can hold a tab name Excel forbids.
      throw new ObjectsError(`cannot export tab '${tab.name}': ${(error as Error).message}`);
    }
  }
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
  return { bytes: new Uint8Array(out), dropped: [...dropped] };
}
