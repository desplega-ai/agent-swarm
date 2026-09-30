// CSV and TSV parsing for the Comb table viewer (RFC 4180). No dependency.

import { fileExtension } from "./file-kinds";

/** The table viewer shows at most this many data rows. */
export const CSV_MAX_ROWS = 5_000;

export interface ParsedTable {
  /** The first record. Empty for an empty file. */
  header: string[];
  /** Records after the header, at most `maxRows`. A row can be shorter or longer than the header. */
  rows: string[][];
  /** True when the file has more than `maxRows` records after the header. */
  truncated: boolean;
}

/** Tab for `.tsv` files, comma for everything else. */
export function delimiterFor(path: string): string {
  return fileExtension(path) === "tsv" ? "\t" : ",";
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
