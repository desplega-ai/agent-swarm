/**
 * Pure helpers for the sheet view: A1 names, the visible window, what a cell
 * shows and edits as, and how typed or pasted text becomes a `sheet-ops` value.
 * The server (src/be/primitives/sheets) owns the format and every recalc.
 */

export type SheetValue = number | string | boolean | null;
/** One `swarm-sheet/1` cell: `v` value, `f` formula, `e` error, `t` formatted text. */
export type SheetCell = { v?: SheetValue; f?: string; e?: boolean; t?: string };
export type SheetTab = { name: string; cells: Record<string, SheetCell> };

export function colName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function colNumber(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

export function parseCell(ref: string): { row: number; col: number } | null {
  const m = CELL.exec(ref.trim());
  return m?.[1] && m[2] ? { row: Number(m[2]), col: colNumber(m[1]) } : null;
}

export type SheetWindow = { r1: number; c1: number; r2: number; c2: number };

/** `B2:D10`, `Tab!B2:D10` or `'My tab'!B2`. Null when it does not parse. */
export function parseRange(spec: string): { tab?: string; window: SheetWindow } | null {
  const m = /^(?:'((?:[^']|'')+)'!|([^'!]+)!)?([^!:]+)(?::([^!:]+))?$/.exec(spec.trim());
  if (!m?.[3]) return null;
  const a = parseCell(m[3]);
  const b = parseCell(m[4] ?? m[3]);
  if (!a || !b) return null;
  const tab = m[1]?.replaceAll("''", "'") ?? m[2];
  return {
    ...(tab ? { tab } : {}),
    window: {
      r1: Math.min(a.row, b.row),
      c1: Math.min(a.col, b.col),
      r2: Math.max(a.row, b.row),
      c2: Math.max(a.col, b.col),
    },
  };
}

/** Rows and columns to show: the used extent plus room to type, at least 20 x 8. */
export function defaultWindow(tab: SheetTab): SheetWindow {
  let rows = 0;
  let cols = 0;
  for (const ref of Object.keys(tab.cells)) {
    const cell = parseCell(ref);
    if (!cell) continue;
    rows = Math.max(rows, cell.row);
    cols = Math.max(cols, cell.col);
  }
  return { r1: 1, c1: 1, r2: Math.max(20, rows + 10), c2: Math.max(8, cols + 2) };
}

/** A tab-qualified range for `sheet-ops`; the server reads `'…'` with `''` as an apostrophe. */
export const qualify = (tab: string, ref: string): string =>
  `'${tab.replaceAll("'", "''")}'!${ref}`;

/** What the cell shows: the formatted text, else the cached value. */
export function displayOf(cell: SheetCell | undefined): string {
  if (!cell) return "";
  if (cell.t !== undefined) return cell.t;
  const v = cell.v;
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

/** Text that `parseInput` would not read back as the same string. */
const AMBIGUOUS = /^(=|'|[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$|true$|false$)/i;

/** What the editor opens with: the formula, else the value as a person would retype it. */
export function inputOf(cell: SheetCell | undefined): string {
  if (!cell) return "";
  if (cell.f) return cell.f;
  const v = cell.v;
  if (typeof v === "string") return AMBIGUOUS.test(v.trim()) ? `'${v}` : v;
  return displayOf({ v });
}

/**
 * Typed text to a `sheet-ops` value: "" clears, `=…` is a formula, numbers and
 * TRUE/FALSE are constants, a leading `'` forces text (`'=` stays for the server).
 */
export function parseInput(text: string): SheetValue {
  if (text === "") return null;
  if (text.startsWith("'=")) return text;
  if (text.startsWith("'")) return text.slice(1);
  if (text.length > 1 && text.startsWith("=")) return text;
  const trimmed = text.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  return text;
}

/** Clipboard TSV to a rectangle of values, padded with nulls. Empty text gives no rows. */
export function parseTsv(text: string): SheetValue[][] {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return [];
  const rows = lines.map((line) => line.split("\t").map(parseInput));
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array<SheetValue>(width - row.length).fill(null)]);
}
