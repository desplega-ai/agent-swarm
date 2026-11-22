/**
 * The SQLite head schema, as data: the migration chain applied to an empty
 * in-memory database (plus the boot-created `trg_users_default_role`), then
 * introspected. Shared by the Postgres baseline generator
 * (`generate-postgres-baseline.ts`) and `check:schema-parity`.
 *
 * Author-time only. Nothing here runs in the API server.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "../../src/be/migrations/runner";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const SQLITE_MIGRATIONS_DIR = join(REPO_ROOT, "src", "be", "migrations");
export const POSTGRES_MIGRATIONS_DIR = join(SQLITE_MIGRATIONS_DIR, "postgres");
export const COLUMN_TYPES_PATH = join(POSTGRES_MIGRATIONS_DIR, "column-types.json");
export const TRIGGERS_PART_PATH = join(POSTGRES_MIGRATIONS_DIR, "parts", "triggers.sql");

/**
 * Migration 109 creates this trigger, and every boot creates it again if it is
 * missing (`src/be/rbac-roles.ts`, `CREATE_USER_DEFAULT_ROLE_TRIGGER_SQL`, same
 * text). Applied here too so the head schema matches a booted database even if
 * a later migration drops it.
 */
export const USERS_DEFAULT_ROLE_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_users_default_role
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
  SELECT 'user', NEW.id, 'rbac-role-admin'
  WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'rbac-role-admin');
END;
`;

/** Applies the SQLite chain to a fresh in-memory database, quietly. */
export function buildSqliteHead(): Database {
  const db = new Database(":memory:");
  const saved = { log: console.log, debug: console.debug, warn: console.warn };
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  try {
    runMigrations(db);
    db.run(USERS_DEFAULT_ROLE_TRIGGER_SQL);
  } finally {
    console.log = saved.log;
    console.debug = saved.debug;
    console.warn = saved.warn;
  }
  return db;
}

// ---------------------------------------------------------------------------
// Column classification (src/be/migrations/postgres/column-types.json)
// ---------------------------------------------------------------------------

export type TimestampFormat = "iso-ms-z" | "space";
export type ColumnClass = "timestamptz" | "epoch-ms" | "boolean" | "jsonb" | "bigint" | "text";
export type ColumnTypeEntry = {
  class: ColumnClass;
  format?: TimestampFormat;
  evidence: string;
  reason?: string;
};
export type ColumnTypes = Record<string, Record<string, ColumnTypeEntry>>;

export function loadColumnTypes(): ColumnTypes {
  const raw = JSON.parse(readFileSync(COLUMN_TYPES_PATH, "utf8")) as {
    tables: ColumnTypes;
  };
  return raw.tables;
}

/** The Postgres type class of one column: the classification, else the declared type. */
export type PgClass = ColumnClass | "double" | "bytea";

export function pgClassOf(
  types: ColumnTypes,
  table: string,
  column: string,
  declared: string,
): { cls: PgClass; format?: TimestampFormat } {
  const entry = types[table]?.[column];
  const decl = declared.toUpperCase();
  if (entry) return { cls: entry.class, format: entry.format };
  if (decl === "TEXT") return { cls: "text" };
  if (decl === "REAL") return { cls: "double" };
  if (decl === "BLOB") return { cls: "bytea" };
  throw new Error(
    `column-types.json has no entry for ${table}.${column} (declared ${declared || "(none)"})`,
  );
}

export function pgTypeName(cls: PgClass): string {
  switch (cls) {
    case "timestamptz":
      // Millisecond precision, as SQLite stores and as JS Dates read back: a
      // microsecond value would never equal its own read in a CAS predicate.
      return "timestamptz(3)";
    case "epoch-ms":
    case "bigint":
      return "bigint";
    case "boolean":
      return "boolean";
    case "jsonb":
      return "jsonb";
    case "text":
      return "text";
    case "double":
      return "double precision";
    case "bytea":
      return "bytea";
  }
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export type HeadColumn = {
  name: string;
  declared: string;
  notNull: boolean;
  dflt: string | null;
  pkOrder: number; // 0 = not in the PK
};
export type HeadForeignKey = {
  columns: string[];
  parent: string;
  parentColumns: string[];
  onDelete: string;
  onUpdate: string;
};
export type HeadIndex = {
  name: string;
  unique: boolean;
  /** Each key: a plain column name or an expression in SQLite text. */
  keys: { expr: string; column: string | null; desc: boolean }[];
  where: string | null;
};
export type HeadTable = {
  name: string;
  sql: string;
  columns: HeadColumn[];
  /** Integer primary key that aliases the rowid (gets an identity on Postgres). */
  rowidAlias: string | null;
  /**
   * A rowid table with no INTEGER PRIMARY KEY alias. On Postgres it gets the
   * surrogate column `_rowid` (identity, unique index `<table>__rowid_key`):
   * code orders by rowid and the API exposes it (lead decision, M3).
   */
  surrogateRowid: boolean;
  uniques: string[][];
  checks: string[];
  foreignKeys: HeadForeignKey[];
  indexes: HeadIndex[];
};
export type HeadTrigger = { name: string; table: string; sql: string };
export type HeadView = { name: string; sql: string };
export type HeadSchema = {
  tables: HeadTable[];
  /** FTS5 virtual tables and their shadow tables: not in the Postgres baseline (M4). */
  skippedTables: string[];
  triggers: HeadTrigger[];
  views: HeadView[];
};

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };

const FTS_SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

export function introspect(db: Database): HeadSchema {
  const master = db
    .query<MasterRow, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all();
  const virtual = master
    .filter((r) => r.type === "table" && /^CREATE VIRTUAL TABLE/i.test(r.sql ?? ""))
    .map((r) => r.name);
  const isShadow = (name: string) =>
    virtual.some((v) => FTS_SHADOW_SUFFIXES.some((s) => name === `${v}${s}`));
  const skippedTables: string[] = [];
  const tables: HeadTable[] = [];
  for (const row of master) {
    if (row.type !== "table") continue;
    if (row.name === "_migrations") continue; // the runner of each engine owns it
    if (virtual.includes(row.name) || isShadow(row.name)) {
      skippedTables.push(row.name);
      continue;
    }
    tables.push(introspectTable(db, row.name, row.sql ?? "", master));
  }
  const triggers = master
    .filter((r) => r.type === "trigger")
    .map((r) => ({ name: r.name, table: r.tbl_name, sql: r.sql ?? "" }));
  const views = master
    .filter((r) => r.type === "view")
    .map((r) => ({ name: r.name, sql: r.sql ?? "" }));
  return { tables, skippedTables, triggers, views };
}

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function introspectTable(db: Database, name: string, sql: string, master: MasterRow[]): HeadTable {
  type Info = {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  };
  const columns = db
    .query<Info, []>(`PRAGMA table_info(${q(name)})`)
    .all()
    .map((c) => ({
      name: c.name,
      declared: c.type,
      notNull: c.notnull === 1,
      dflt: c.dflt_value,
      pkOrder: c.pk,
    }));
  const pkCols = columns.filter((c) => c.pkOrder > 0);
  const onlyPk = pkCols.length === 1 ? pkCols[0] : undefined;
  const rowidAlias = onlyPk && onlyPk.declared.toUpperCase() === "INTEGER" ? onlyPk.name : null;

  type IndexListRow = { name: string; unique: number; origin: string; partial: number };
  type IndexXInfo = { seqno: number; cid: number; name: string | null; desc: number; key: number };
  const uniques: string[][] = [];
  const indexes: HeadIndex[] = [];
  const indexList = db.query<IndexListRow, []>(`PRAGMA index_list(${q(name)})`).all();
  for (const idx of indexList) {
    const keys = db
      .query<IndexXInfo, []>(`PRAGMA index_xinfo(${q(idx.name)})`)
      .all()
      .filter((k) => k.key === 1)
      .sort((a, b) => a.seqno - b.seqno);
    if (idx.origin === "u") {
      uniques.push(keys.map((k) => k.name ?? "?"));
      continue;
    }
    if (idx.origin === "pk") continue;
    const indexSql = master.find((m) => m.type === "index" && m.name === idx.name)?.sql ?? "";
    const parsed = parseCreateIndex(indexSql);
    if (parsed.keys.length !== keys.length) {
      throw new Error(
        `index ${idx.name}: parsed ${parsed.keys.length} keys, pragma ${keys.length}`,
      );
    }
    indexes.push({
      name: idx.name,
      unique: idx.unique === 1,
      keys: parsed.keys.map((k, i) => ({
        expr: k.expr,
        column: keys[i]?.cid === -2 ? null : (keys[i]?.name ?? null),
        desc: keys[i]?.desc === 1,
      })),
      where: parsed.where,
    });
  }
  uniques.sort((a, b) => a.join(",").localeCompare(b.join(",")));
  indexes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  type FkRow = {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  };
  const fkRows = db.query<FkRow, []>(`PRAGMA foreign_key_list(${q(name)})`).all();
  const byId = new Map<number, FkRow[]>();
  for (const r of fkRows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const foreignKeys: HeadForeignKey[] = [...byId.values()].map((rows) => {
    rows.sort((a, b) => a.seq - b.seq);
    const first = rows[0] as FkRow;
    return {
      columns: rows.map((r) => r.from),
      parent: first.table,
      parentColumns: rows.map((r) => r.to ?? ""),
      onDelete: first.on_delete,
      onUpdate: first.on_update,
    };
  });
  foreignKeys.sort((a, b) =>
    `${a.columns.join(",")}>${a.parent}`.localeCompare(`${b.columns.join(",")}>${b.parent}`),
  );

  return {
    name,
    sql,
    columns,
    rowidAlias,
    surrogateRowid: rowidAlias === null && !/WITHOUT\s+ROWID/i.test(sql),
    uniques,
    checks: extractChecks(sql),
    foreignKeys,
    indexes,
  };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/** `s`/`e`: the token's span in the source text. */
export type Tok = { k: "str" | "qid" | "num" | "id" | "op"; v: string; s?: number; e?: number };

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const ch = sql[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= sql.length) throw new Error(`unterminated string in: ${sql.slice(i, i + 60)}`);
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            v += "'";
            j += 2;
            continue;
          }
          break;
        }
        v += sql[j];
        j++;
      }
      i = j + 1;
      out.push({ k: "str", v, s: start, e: i });
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= sql.length) throw new Error(`unterminated identifier in: ${sql.slice(i, i + 60)}`);
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            v += close;
            j += 2;
            continue;
          }
          break;
        }
        v += sql[j];
        j++;
      }
      i = j + 1;
      out.push({ k: "qid", v, s: start, e: i });
      continue;
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(sql.slice(i));
    if (num) {
      i += num[0].length;
      out.push({ k: "num", v: num[0], s: start, e: i });
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (id) {
      i += id[0].length;
      out.push({ k: "id", v: id[0], s: start, e: i });
      continue;
    }
    const op = /^(#>>|#>|->>|->|\|\||<>|!=|==|<=|>=|<<|>>|::|[-+*/%<>=(),.;&|~:])/.exec(
      sql.slice(i),
    );
    if (op) {
      i += op[0].length;
      out.push({ k: "op", v: op[0], s: start, e: i });
      continue;
    }
    throw new Error(`cannot tokenize at: ${sql.slice(i, i + 40)}`);
  }
  return out;
}

/** Index of the `)` that closes the `(` at `open`. */
export function closeParen(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.k === "op" && t.v === "(") depth++;
    if (t.k === "op" && t.v === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced parentheses");
}

/** Splits a token list on commas at depth 0. */
export function splitTopLevel(toks: Tok[]): Tok[][] {
  const parts: Tok[][] = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.k === "op" && t.v === "(") depth++;
    if (t.k === "op" && t.v === ")") depth--;
    if (depth === 0 && t.k === "op" && t.v === ",") {
      parts.push([]);
      continue;
    }
    (parts[parts.length - 1] as Tok[]).push(t);
  }
  return parts;
}

/** Renders tokens back to SQLite text (normalized spacing). */
export function renderTokens(toks: Tok[]): string {
  return toks
    .map((t) => (t.k === "str" ? `'${t.v.replaceAll("'", "''")}'` : t.k === "qid" ? q(t.v) : t.v))
    .join(" ");
}

function isWord(t: Tok | undefined, word: string): boolean {
  return t !== undefined && t.k === "id" && t.v.toUpperCase() === word;
}

/** Every CHECK expression of a CREATE TABLE statement, in source order, as SQLite text. */
export function extractChecks(createSql: string): string[] {
  const toks = tokenize(createSql);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (isWord(toks[i], "CHECK") && toks[i + 1]?.v === "(") {
      const end = closeParen(toks, i + 1);
      out.push(renderTokens(toks.slice(i + 2, end)));
      i = end;
    }
  }
  return out;
}

/**
 * The CHECK expressions as SQLite reports them in a failure message
 * (`CHECK constraint failed: <text>`): the source text between the parentheses,
 * unchanged. Same order as {@link extractChecks}.
 */
export function extractCheckSourceTexts(createSql: string): string[] {
  const toks = tokenize(createSql);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (isWord(toks[i], "CHECK") && toks[i + 1]?.v === "(") {
      const end = closeParen(toks, i + 1);
      const from = toks[i + 1]?.e ?? 0;
      const to = toks[end]?.s ?? from;
      out.push(createSql.slice(from, to).trim());
      i = end;
    }
  }
  return out;
}

export function parseCreateIndex(sql: string): {
  keys: { expr: string }[];
  where: string | null;
} {
  const toks = tokenize(sql);
  let i = toks.findIndex((t) => isWord(t, "ON"));
  if (i < 0) throw new Error(`cannot parse index: ${sql}`);
  i += 2; // ON <table>
  if (toks[i]?.v !== "(") throw new Error(`cannot parse index columns: ${sql}`);
  const end = closeParen(toks, i);
  const keys = splitTopLevel(toks.slice(i + 1, end)).map((part) => {
    const last = part[part.length - 1];
    const trimmed = isWord(last, "ASC") || isWord(last, "DESC") ? part.slice(0, -1) : part;
    return { expr: renderTokens(trimmed) };
  });
  const rest = toks.slice(end + 1).filter((t) => !(t.k === "op" && t.v === ";"));
  let where: string | null = null;
  if (rest.length > 0) {
    if (!isWord(rest[0], "WHERE")) throw new Error(`unexpected index tail: ${sql}`);
    where = renderTokens(rest.slice(1));
  }
  return { keys, where };
}

// ---------------------------------------------------------------------------
// Seeded rows
// ---------------------------------------------------------------------------

export type SeedValue = string | number | bigint | Uint8Array | null;
export type SeedTable = {
  table: string;
  columns: string[];
  rows: SeedValue[][];
  /** Columns whose value differs between two chain runs (clock or random). */
  volatile: string[];
  /** The SQLite rowid of each row, for a table with a surrogate `_rowid`; else null. */
  rowids: number[] | null;
};

/** Name of the Postgres surrogate for SQLite's rowid, and of its unique index. */
export const ROWID_COLUMN = "_rowid";
export function rowidIndexName(table: string): string {
  return `${table}__rowid_key`;
}

/** Rows the chain inserts into an empty database, in rowid (insertion) order. */
export function readSeeds(db: Database, schema: HeadSchema): SeedTable[] {
  const out: SeedTable[] = [];
  for (const t of schema.tables) {
    const hasRowid = !/WITHOUT\s+ROWID/i.test(t.sql);
    const order = hasRowid ? " ORDER BY rowid" : "";
    const select = t.surrogateRowid ? `rowid AS "__sqlite_rowid", *` : "*";
    const rows = db
      .query<Record<string, SeedValue>, []>(`SELECT ${select} FROM ${q(t.name)}${order}`)
      .all();
    if (rows.length === 0) continue;
    const columns = t.columns.map((c) => c.name);
    out.push({
      table: t.name,
      columns,
      rows: rows.map((r) => columns.map((c) => r[c] ?? null)),
      volatile: [],
      rowids: t.surrogateRowid ? rows.map((r) => Number(r.__sqlite_rowid)) : null,
    });
  }
  return out;
}

/**
 * Runs the chain twice, on two different wall-clock seconds, and marks every
 * seeded column whose value differs as volatile. Deterministic output must not
 * embed those values.
 */
export async function readSeedsWithVolatility(): Promise<{
  db: Database;
  schema: HeadSchema;
  seeds: SeedTable[];
}> {
  const first = buildSqliteHead();
  const firstSchema = introspect(first);
  const firstSeeds = readSeeds(first, firstSchema);
  first.close();
  // Cross a second boundary so datetime('now') values differ too.
  await Bun.sleep(1000 - (Date.now() % 1000) + 20);
  const db = buildSqliteHead();
  const schema = introspect(db);
  const seeds = readSeeds(db, schema);
  for (const s of seeds) {
    const other = firstSeeds.find((f) => f.table === s.table);
    if (!other || other.rows.length !== s.rows.length) {
      throw new Error(`seeded rows of ${s.table} differ in count between two chain runs`);
    }
    const volatile = new Set<string>();
    s.rows.forEach((row, r) => {
      row.forEach((v, c) => {
        if (!sameValue(v, other.rows[r]?.[c] ?? null)) volatile.add(s.columns[c] as string);
      });
    });
    s.volatile = s.columns.filter((c) => volatile.has(c));
    if (JSON.stringify(s.rowids) !== JSON.stringify(other.rowids)) {
      throw new Error(`seeded rowids of ${s.table} differ between two chain runs`);
    }
  }
  return { db, schema, seeds };
}

function sameValue(a: SeedValue, b: SeedValue): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return Buffer.from(a).equals(Buffer.from(b));
  }
  return a === b;
}

export const ISO_MS_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export const SPACE_TS = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
export const HEX32 = /^[0-9a-f]{32}$/;
