/** A1 references and ranges. Pure: no engine, no I/O. */

export const MAX_ROW = 1_048_576;
export const MAX_COL = 16_384;

export class A1Error extends Error {}

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

export const refOf = (row: number, col: number): string => `${colName(col)}${row}`;

export function parseCell(ref: string): { row: number; col: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  const row = m ? Number(m[2]) : 0;
  const col = m?.[1] ? colNumber(m[1]) : 0;
  if (!m || row < 1 || row > MAX_ROW || col < 1 || col > MAX_COL) {
    throw new A1Error(`bad cell reference '${ref}' (rows 1-${MAX_ROW}, columns A-XFD)`);
  }
  return { row, col };
}

export type A1Range = {
  /** Unset when the range names no tab: the caller picks the first tab. */
  tab?: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** A whole-column or whole-row range (`A:A`, `2:4`): cap it to the used range before use. */
  open: boolean;
};

const bound = (ref: string) => {
  const m = /^\$?([A-Za-z]{1,3})$/.exec(ref);
  return m?.[1] ? { col: colNumber(m[1]) } : { row: Number(/^\$?(\d{1,7})$/.exec(ref)?.[1]) };
};

/** `Tab!A1:C10`, `'My tab'!A:A`, `B2`, `3:5`. Corners may come in any order. */
export function parseRange(spec: string): A1Range {
  let tab: string | undefined;
  let rest = spec.trim();
  if (rest.startsWith("'")) {
    const m = /^'((?:[^']|'')+)'!(.+)$/.exec(rest);
    if (!m) throw new A1Error(`bad range '${spec}': a quoted tab name must be followed by '!'`);
    tab = (m[1] ?? "").replaceAll("''", "'");
    rest = m[2] ?? "";
  } else if (rest.includes("!")) {
    const i = rest.lastIndexOf("!");
    tab = rest.slice(0, i);
    rest = rest.slice(i + 1);
    if (!tab) throw new A1Error(`bad range '${spec}': empty tab name`);
  }
  const parts = rest.split(":");
  const [a = "", b = a] = parts;
  if (parts.length > 2 || !a || !b) throw new A1Error(`bad range '${spec}'`);
  try {
    const p = parseCell(a);
    const q = parseCell(b);
    return {
      tab,
      r1: Math.min(p.row, q.row),
      c1: Math.min(p.col, q.col),
      r2: Math.max(p.row, q.row),
      c2: Math.max(p.col, q.col),
      open: false,
    };
  } catch {
    // Not a cell pair: try `A:C` / `2:4` below.
  }
  if (parts.length !== 2)
    throw new A1Error(`bad range '${spec}' (expected e.g. 'Tab!A1:C10' or 'B2')`);
  const x = bound(a);
  const y = bound(b);
  if ("col" in x && "col" in y && x.col && y.col && x.col <= MAX_COL && y.col <= MAX_COL) {
    return {
      tab,
      r1: 1,
      c1: Math.min(x.col, y.col),
      r2: MAX_ROW,
      c2: Math.max(x.col, y.col),
      open: true,
    };
  }
  if ("row" in x && "row" in y && x.row && y.row && x.row <= MAX_ROW && y.row <= MAX_ROW) {
    return {
      tab,
      r1: Math.min(x.row, y.row),
      c1: 1,
      r2: Math.max(x.row, y.row),
      c2: MAX_COL,
      open: true,
    };
  }
  throw new A1Error(`bad range '${spec}' (expected e.g. 'Tab!A1:C10', 'A:A' or 'B2')`);
}

/** Clip an open range to the used extent. Returns null when nothing in the tab lies inside it. */
export function capToUsed(range: A1Range, used: { rows: number; cols: number }): A1Range | null {
  if (!range.open) return range;
  const r2 = Math.min(range.r2, used.rows);
  const c2 = Math.min(range.c2, used.cols);
  return r2 < range.r1 || c2 < range.c1 ? null : { ...range, r2, c2 };
}

export const quoteTab = (name: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`;

export function formatRange(tab: string, r: Pick<A1Range, "r1" | "c1" | "r2" | "c2">): string {
  const cells =
    r.r1 === r.r2 && r.c1 === r.c2
      ? refOf(r.r1, r.c1)
      : `${refOf(r.r1, r.c1)}:${refOf(r.r2, r.c2)}`;
  return `${quoteTab(tab)}!${cells}`;
}

export const areaOf = (r: Pick<A1Range, "r1" | "c1" | "r2" | "c2">): number =>
  (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1);

/** Throws when a block anchored in range runs past the last row or column. */
export function assertInBounds(r: Pick<A1Range, "r2" | "c2">): void {
  if (r.r2 > MAX_ROW || r.c2 > MAX_COL) {
    throw new A1Error(`the range runs past row ${MAX_ROW} or column ${colName(MAX_COL)}`);
  }
}
