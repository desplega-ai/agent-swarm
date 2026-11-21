/**
 * Read codec (decision D8): driver rows become rows in the SQLite value shape,
 * so repositories, the `rowTo*` mappers and the API stay byte-equal on both
 * engines.
 *
 * Driven by the result's column metadata (type OID, table OID, attnum), never
 * by the value: a text column that holds digits stays text.
 *
 * - boolean -> 1 / 0
 * - int8, numeric -> number (bun:sqlite returns INTEGER as a JS number too)
 * - json, jsonb -> JSON text (key order is jsonb's, accepted by D8)
 * - timestamptz -> the text format the SQLite column stores
 *   (`iso-ms-z`: 2026-11-20T10:00:00.000Z, `space`: 2026-11-20 10:00:00)
 * - a result column named `_rowid` is dropped: it is the Postgres stand-in
 *   for SQLite's hidden rowid, which `SELECT *` never returns on SQLite. A
 *   repository that needs the value selects it under another name.
 */

/** The insertion-order surrogate column (see the schema notes). */
export const ROWID_COLUMN = "_rowid";

export type TimestampFormat = "iso-ms-z" | "space";

export type ResultColumn = { name: string; type: number; table: number; number: number };

/** Where the codec finds the SQLite text format of a timestamptz column. */
export interface TimestampFormats {
  /** By source column (table OID + attnum), for a selected table column. */
  byAttribute(tableOid: number, attnum: number): TimestampFormat | undefined;
  /** By result name, for an expression; undefined when the name is ambiguous or unknown. */
  byName(name: string): TimestampFormat | undefined;
}

export const OID = {
  bool: 16,
  bytea: 17,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  json: 114,
  float4: 700,
  float8: 701,
  timestamp: 1114,
  timestamptz: 1184,
  numeric: 1700,
  jsonb: 3802,
} as const;

/** `iso-ms-z` unless a lookup says otherwise: the app writes `toISOString()` text by default. */
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "iso-ms-z";

export function formatTimestamp(value: Date, format: TimestampFormat): string {
  const iso = value.toISOString();
  return format === "space" ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso;
}

type Decoder = (value: unknown) => unknown;

function decoderFor(column: ResultColumn, formats: TimestampFormats | null): Decoder | null {
  switch (column.type) {
    case OID.bool:
      return (v) => (v === null || v === undefined ? v : v ? 1 : 0);
    case OID.int8:
    case OID.numeric:
      return (v) => (v === null || v === undefined ? v : typeof v === "number" ? v : Number(v));
    case OID.json:
    case OID.jsonb:
      return (v) => (v === null || v === undefined ? v : JSON.stringify(v));
    case OID.timestamptz:
    case OID.timestamp: {
      const format =
        (column.table !== 0 ? formats?.byAttribute(column.table, column.number) : undefined) ??
        formats?.byName(column.name) ??
        DEFAULT_TIMESTAMP_FORMAT;
      return (v) => (v instanceof Date ? formatTimestamp(v, format) : v);
    }
    default:
      return null;
  }
}

/** Decode result rows in place of a copy; columns without a decoder pass through. */
export function decodeRows(
  rows: readonly Record<string, unknown>[],
  columns: readonly ResultColumn[] | undefined,
  formats: TimestampFormats | null,
): Record<string, unknown>[] {
  if (!columns || columns.length === 0 || rows.length === 0)
    return rows as Record<string, unknown>[];
  const decoders: [string, Decoder][] = [];
  let dropRowid = false;
  for (const column of columns) {
    if (column.name === ROWID_COLUMN) {
      dropRowid = true;
      continue;
    }
    const decoder = decoderFor(column, formats);
    if (decoder) decoders.push([column.name, decoder]);
  }
  if (decoders.length === 0 && !dropRowid) return rows as Record<string, unknown>[];
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    if (dropRowid) delete out[ROWID_COLUMN];
    for (const [name, decode] of decoders) out[name] = decode(row[name]);
    return out;
  });
}

/**
 * Timestamp formats from the column classification (`table.column -> format`),
 * resolved to OIDs once per database.
 */
export class ClassifiedTimestampFormats implements TimestampFormats {
  private readonly byAttr = new Map<string, TimestampFormat>();
  private readonly names = new Map<string, TimestampFormat | null>();

  constructor(entries: readonly { table: string; column: string; format: TimestampFormat }[]) {
    for (const entry of entries) {
      const known = this.names.get(entry.column);
      // A name that two tables store in different formats is ambiguous.
      this.names.set(
        entry.column,
        known === undefined || known === entry.format ? entry.format : null,
      );
    }
  }

  /** Bind the classification to this database's OIDs. */
  resolve(rows: readonly { oid: number; attnum: number; format: TimestampFormat }[]): void {
    this.byAttr.clear();
    for (const row of rows) this.byAttr.set(`${row.oid}:${row.attnum}`, row.format);
  }

  byAttribute(tableOid: number, attnum: number): TimestampFormat | undefined {
    return this.byAttr.get(`${tableOid}:${attnum}`);
  }

  byName(name: string): TimestampFormat | undefined {
    return this.names.get(name) ?? undefined;
  }
}

/** The column classification file (`src/be/migrations/postgres/column-types.json`). */
export type ColumnClassification = {
  tables: Record<string, Record<string, { class: string; format?: TimestampFormat }>>;
};

/** Timestamp formats from the classification, bound to this database's OIDs. */
export async function loadTimestampFormats(
  db: { query<T>(text: string, params?: unknown[]): Promise<T[]> },
  classification: ColumnClassification,
): Promise<ClassifiedTimestampFormats> {
  const entries: { table: string; column: string; format: TimestampFormat }[] = [];
  for (const [table, columns] of Object.entries(classification.tables)) {
    for (const [column, entry] of Object.entries(columns)) {
      if (entry.class === "timestamptz") {
        entries.push({ table, column, format: entry.format ?? "iso-ms-z" });
      }
    }
  }
  const formats = new ClassifiedTimestampFormats(entries);
  const rows = await db.query<{ oid: number; attnum: number; relname: string; attname: string }>(
    `SELECT c.oid::int AS oid, a.attnum::int AS attnum, c.relname, a.attname
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid = 'timestamptz'::regtype`,
  );
  const byKey = new Map(entries.map((e) => [`${e.table}.${e.column}`, e.format]));
  formats.resolve(
    rows.flatMap((row) => {
      const format = byKey.get(`${row.relname}.${row.attname}`);
      return format ? [{ oid: row.oid, attnum: row.attnum, format }] : [];
    }),
  );
  return formats;
}

/**
 * Decode positional rows (`.values()`): the same rules as {@link decodeRows},
 * for a result whose column names may repeat (user SQL in `db-query`).
 * A `_rowid` column stays: the user named it.
 */
export function decodeValueRows(
  rows: readonly unknown[][],
  columns: readonly ResultColumn[],
  formats: TimestampFormats | null,
): unknown[][] {
  const decoders = columns.map((column) => decoderFor(column, formats));
  return rows.map((row) =>
    row.map((value, index) => {
      const decoder = decoders[index];
      return decoder ? decoder(value) : value;
    }),
  );
}
