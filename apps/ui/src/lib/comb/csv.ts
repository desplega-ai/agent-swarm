// CSV and TSV parsing for the Comb table viewer (RFC 4180). No dependency.

import { fileExtension } from "./file-kinds";

/** The table viewer shows at most this many data rows. */
export const CSV_MAX_ROWS = 5_000;

/** The table viewer shows at most this many columns. */
export const CSV_MAX_COLUMNS = 500;

export interface ParsedTable {
  /** The first record. Empty for an empty file. */
  header: string[];
  /** Records after the header, at most `maxRows`. A row can be shorter or longer than the header. */
  rows: string[][];
  /** True when the file has more than `maxRows` records after the header. */
  truncated: boolean;
}

/** Delimiters a `.csv` file can use, in tie-break order. */
const CSV_DELIMITERS = [",", ";", "\t"];

/**
 * Tab for `.tsv`. For `.csv`, the most frequent of comma, semicolon, and tab
 * outside quotes on the header line (a comma on a tie), so semicolon exports
 * parse too. Comma for everything else.
 */
export function delimiterFor(path: string, text: string): string {
  const ext = fileExtension(path);
  if (ext === "tsv") return "\t";
  if (ext !== "csv") return ",";
  const counts = new Map<string, number>();
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) break;
    else if (!inQuotes && CSV_DELIMITERS.includes(char)) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  let best = ",";
  for (const delimiter of CSV_DELIMITERS) {
    if ((counts.get(delimiter) ?? 0) > (counts.get(best) ?? 0)) best = delimiter;
  }
  return best;
}

const CELL_COLLATOR = new Intl.Collator(undefined, { numeric: true });

/** A cell's value when it is a finite number (trimmed, not empty), else null. */
function cellNumber(cell: string): number | null {
  const trimmed = cell.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Sort order for table cells. Two numbers compare by value ("-10" before
 * "-2", "1.25" before "1.5"). Anything else compares as text, with digit runs
 * by value ("file2" before "file10").
 */
export function compareCells(a: string, b: string): number {
  const x = cellNumber(a);
  const y = cellNumber(b);
  return x !== null && y !== null ? x - y : CELL_COLLATOR.compare(a, b);
}

/**
 * Parse delimited text: quoted fields, `""` escapes, delimiters and line
 * breaks inside quotes, CRLF or LF line ends, and an optional final line
 * break. Lines with no characters are skipped, and a leading UTF-8 BOM is
 * dropped. Parsing stops once it knows the table has more than `maxRows` rows.
 */
export function parseDelimited(
  text: string,
  opts: { delimiter?: string; maxRows?: number } = {},
): ParsedTable {
  const delimiter = opts.delimiter ?? ",";
  const maxRows = opts.maxRows ?? CSV_MAX_ROWS;
  // The header, `maxRows` rows, and one more row to know the table is cut.
  const limit = maxRows + 2;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  let lineEmpty = true;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < text.length && records.length < limit) {
    const char = text[i];
    if (inQuotes) {
      if (char !== '"') {
        field += char;
        i++;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 2;
      } else {
        inQuotes = false;
        i++;
      }
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (!lineEmpty) {
        record.push(field);
        records.push(record);
      }
      record = [];
      field = "";
      fieldStart = true;
      lineEmpty = true;
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    lineEmpty = false;
    if (char === delimiter) {
      record.push(field);
      field = "";
      fieldStart = true;
    } else if (char === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else {
      // A quote inside an unquoted field is kept as text.
      field += char;
      fieldStart = false;
    }
    i++;
  }
  // The last line has no line break (or a quoted field was never closed).
  if (!lineEmpty && records.length < limit) {
    record.push(field);
    records.push(record);
  }

  const [header = [], ...rest] = records;
  return { header, rows: rest.slice(0, maxRows), truncated: rest.length > maxRows };
}
