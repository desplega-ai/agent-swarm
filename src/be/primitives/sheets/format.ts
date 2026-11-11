import * as z from "zod";
import { A1Error, parseCell } from "./a1";

/**
 * `swarm-sheet/1`: a workbook as one `.sheet.json` file. Cells are a sparse
 * A1-keyed map per tab holding the cached result next to the formula, so a read
 * never needs the engine. Fields: `v` value, `f` formula, `e` error flag, `nf`
 * number format, `t` formatted text (only with `nf`), `s` spill anchor (the cell
 * holds a cached spilled value, the formula lives at the anchor).
 */
export const SHEET_FORMAT = "swarm-sheet/1";

export const MAX_TABS = 20;
export const MAX_CELLS = 50_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_RANGE_CELLS = 10_000;

const CellSchema = z.looseObject({
  v: z.union([z.number(), z.string(), z.boolean(), z.null()]).optional(),
  f: z.string().startsWith("=").optional(),
  e: z.boolean().optional(),
  nf: z.string().optional(),
  t: z.string().optional(),
  s: z.string().optional(),
});

const TabSchema = z.looseObject({
  name: z.string().min(1),
  colWidths: z.record(z.string(), z.number()).optional(),
  freezeRows: z.number().int().nonnegative().optional(),
  merges: z.array(z.string()).optional(),
  cells: z.record(
    z.string().refine((ref) => {
      try {
        parseCell(ref);
        return true;
      } catch {
        return false;
      }
    }, "cell keys are A1 references"),
    CellSchema,
  ),
});

export const SheetDocSchema = z.looseObject({
  format: z.literal(SHEET_FORMAT),
  swarm: z.looseObject({
    id: z.string().min(1),
    kind: z.literal("sheet"),
    title: z.string().optional(),
  }),
  tabs: z.array(TabSchema).min(1).max(MAX_TABS),
});

export type SheetCell = z.infer<typeof CellSchema>;
export type SheetTab = z.infer<typeof TabSchema>;
export type SheetDoc = z.infer<typeof SheetDocSchema>;

export const cellCount = (doc: Pick<SheetDoc, "tabs">): number =>
  doc.tabs.reduce((n, tab) => n + Object.keys(tab.cells).length, 0);

/** Excel's tab-name rules: 1-31 characters, none of `[]:*?/\`, no edge apostrophes. */
export function checkTabName(name: string): string {
  if (name.length < 1 || name.length > 31 || /[[\]:*?/\\]/.test(name) || /^'|'$/.test(name)) {
    throw new A1Error(
      `invalid tab name '${name}': 1-31 characters, none of []:*?/\\ , no leading or trailing apostrophe`,
    );
  }
  return name;
}

export function newTab(name: string): SheetTab {
  return { name: checkTabName(name), cells: {} };
}

/** The file `object-create` writes for kind `sheet`: one empty `Sheet1`. */
export const emptySheet = (id: string, title?: string): SheetDoc => ({
  format: SHEET_FORMAT,
  swarm: { id, kind: "sheet", ...(title ? { title } : {}) },
  tabs: [newTab("Sheet1")],
});

/** Used extent of a tab: the last row and column holding a cell (0 when empty). */
export function usedExtent(tab: SheetTab): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const ref of Object.keys(tab.cells)) {
    const { row, col } = parseCell(ref);
    if (row > rows) rows = row;
    if (col > cols) cols = col;
  }
  return { rows, cols };
}

/** What a person would type to store this constant. A string that would parse as a number, boolean or formula gets the `'` text prefix. */
export function constantInput(v: SheetCell["v"] | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return /^(=|'|[+-]?[\d.]|true$|false$|#)/i.test(v) ? `'${v}` : v;
}
