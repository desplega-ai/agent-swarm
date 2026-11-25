#!/usr/bin/env bun
/**
 * check:schema-parity (Postgres brief check 7, decision D13).
 *
 * Applies the SQLite chain (src/be/migrations/*.sql) to an empty in-memory
 * database and the Postgres chain (src/be/migrations/postgres/) to an empty
 * scratch database on the server named by STORAGE_TEST_POSTGRES_URL, then
 * compares:
 *
 *   tables, columns (order and names), type classes (column-types.json),
 *   nullability, defaults (normalized to a meaning: clock, random id, epoch
 *   clock, literal value), primary keys, foreign keys with their actions,
 *   unique constraints, indexes (keys, uniqueness, DESC, partial predicates),
 *   CHECK constraints (count, IN value sets and the normalized expression),
 *   triggers (name, table, timing, event, UPDATE OF columns), views, and every
 *   row the two chains insert into an empty database (values normalized per
 *   column class).
 *
 * Every difference gets a key (`table:agent_tasks_fts`, `trigger:x`, ...). A
 * key listed in scripts/storage-checks/schema-parity-allowlist.txt (one per
 * line, `<key> -- <reason>`) is explained; any other difference, an entry
 * without a reason, or an entry that matches nothing fails the check (exit 1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPostgresClient,
  type PostgresClient,
  runPostgresMigrations,
} from "../../packages/storage-postgres/src";
import { tableContext, VIEW_PORTS } from "../storage/generate-postgres-baseline";
import { qi, translateExpr } from "../storage/pg-translate";
import {
  type ColumnTypes,
  HEX32,
  type HeadSchema,
  type HeadTable,
  ISO_MS_Z,
  loadColumnTypes,
  POSTGRES_MIGRATIONS_DIR,
  pgClassOf,
  pgTypeName,
  ROWID_COLUMN,
  readSeedsWithVolatility,
  rowidIndexName,
  type SeedTable,
  SPACE_TS,
  tokenize,
} from "../storage/sqlite-head";

const ALLOWLIST_PATH = join(import.meta.dir, "schema-parity-allowlist.txt");

type Diff = { key: string; detail: string };

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export function readAllowlist(text: string): { entries: Map<string, string>; errors: string[] } {
  const entries = new Map<string, string>();
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(\S+)\s+--\s+(\S.*)$/.exec(line);
    if (!m) {
      errors.push(`allowlist line ${i + 1} needs "<key> -- <reason>": ${line}`);
      return;
    }
    if (entries.has(m[1] as string)) errors.push(`allowlist line ${i + 1} repeats ${m[1]}`);
    entries.set(m[1] as string, m[2] as string);
  });
  return { entries, errors };
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

const PG_TYPE_WORDS = new Set([
  "text",
  "bigint",
  "integer",
  "numeric",
  "boolean",
  "jsonb",
  "json",
  "bytea",
  "timestamptz",
  "double",
  "precision",
  "timestamp",
  "with",
  "time",
  "zone",
  "character",
  "varying",
]);

/**
 * One comparable form of an expression from either side: lower case, no
 * parentheses or identifier quotes, no casts, `= ANY (ARRAY[...])` as IN,
 * `TRIM(BOTH FROM x)` as `trim x`.
 */
export function normalizeExpr(expr: string): string {
  const toks = tokenize(expr.replaceAll("[", " ( ").replaceAll("]", " ) "));
  const words: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as (typeof toks)[number];
    if (t.k === "op" && (t.v === "(" || t.v === ")")) continue;
    if (t.k === "op" && t.v === "::") {
      while (toks[i + 1]?.k === "id" && PG_TYPE_WORDS.has((toks[i + 1]?.v ?? "").toLowerCase()))
        i++;
      continue;
    }
    if (t.k === "str") {
      words.push(`'${t.v}'`);
      continue;
    }
    if (t.k === "qid") {
      words.push(t.v.toLowerCase());
      continue;
    }
    const v = t.v.toLowerCase();
    if (v === "!=") {
      words.push("<>");
      continue;
    }
    words.push(v);
  }
  return (
    words
      .join(" ")
      .replace(/= any array /g, "in ")
      .replace(/<> all array /g, "not in ")
      .replace(/\btrim both from /g, "trim ")
      .replace(/ , /g, ",")
      // Postgres prints a one-value IN list as `=` / `<>` and adds ELSE NULL to a CASE.
      .replace(/\bnot in ('[^',]*'|true|false|-?\d+)(?= |$)/g, "<> $1")
      .replace(/(?<!\bnot) in ('[^',]*'|true|false|-?\d+)(?= |$)/g, " = $1")
      .replace(/ else null end\b/g, " end")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The Boolean structure of an expression: AND, OR and NOT nodes over atoms in
 * their `normalizeExpr` form. `normalizeExpr` drops every parenthesis, so
 * `(a AND b) OR c` and `a AND (b OR c)` print the same. This shape keeps the
 * grouping, flattens nested AND/AND and OR/OR, drops redundant parentheses and
 * sorts the operands of each node (both operators commute).
 */
export function booleanShape(expr: string): string {
  const src = expr.replaceAll("[", " ( ").replaceAll("]", " ) ");
  const toks = tokenize(src);
  let i = 0;
  const word = (n: number) => {
    const t = toks[n];
    return t && t.k === "id" ? t.v.toUpperCase() : "";
  };
  const isOp = (n: number, v: string) => toks[n]?.k === "op" && toks[n]?.v === v;
  type Node = { op: "and" | "or"; args: Node[] } | { op: "not"; arg: Node } | { atom: string };
  const render = (n: Node): string => {
    if ("atom" in n) return n.atom;
    if (n.op === "not") return `not(${render(n.arg)})`;
    return `${n.op}(${n.args.map(render).sort().join(",")})`;
  };
  const join = (op: "and" | "or", parts: Node[]): Node => {
    if (parts.length === 1) return parts[0] as Node;
    const args = parts.flatMap((p) =>
      "op" in p && p.op === op ? (p as { args: Node[] }).args : [p],
    );
    return { op, args };
  };
  // An atom: tokens up to a top-level AND / OR / `)` (BETWEEN x AND y and CASE stay whole).
  const atom = (): Node => {
    const start = i;
    let depth = 0;
    let between = false;
    let caseDepth = 0;
    while (i < toks.length) {
      if (isOp(i, "(")) depth++;
      else if (isOp(i, ")")) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0) {
        const w = word(i);
        if (w === "CASE") caseDepth++;
        else if (w === "END" && caseDepth > 0) caseDepth--;
        else if (w === "BETWEEN") between = true;
        else if (caseDepth === 0 && (w === "AND" || w === "OR")) {
          if (w === "AND" && between) between = false;
          else break;
        }
      }
      i++;
    }
    const first = toks[start];
    const last = toks[i - 1];
    const text = first && last && i > start ? src.slice(first.s, last.e) : "";
    return { atom: normalizeExpr(text) };
  };
  const primary = (): Node => {
    if (word(i) === "NOT") {
      i++;
      return { op: "not", arg: primary() };
    }
    if (isOp(i, "(")) {
      const save = i;
      i++;
      const inner = orExpr();
      if (isOp(i, ")")) {
        i++;
        const next = word(i);
        // `(x) IS NULL`, `(a + b) > 0`: the group is part of a larger atom.
        if (i >= toks.length || isOp(i, ")") || next === "AND" || next === "OR") return inner;
      }
      i = save;
    }
    return atom();
  };
  const andExpr = (): Node => {
    const parts = [primary()];
    while (word(i) === "AND") {
      i++;
      parts.push(primary());
    }
    return join("and", parts);
  };
  const orExpr = (): Node => {
    const parts = [andExpr()];
    while (word(i) === "OR") {
      i++;
      parts.push(andExpr());
    }
    return join("or", parts);
  };
  const tree = orExpr();
  return i === toks.length ? render(tree) : normalizeExpr(expr);
}

type DefaultMeaning = string | null;

/** The meaning of a SQLite default for a column of a given Postgres class. */
function sqliteDefaultMeaning(
  dflt: string | null,
  cls: string,
  rowidAlias: boolean,
): DefaultMeaning {
  if (rowidAlias) return "identity";
  if (dflt === null || /^NULL$/i.test(dflt.trim())) return null;
  const d = dflt.trim();
  if (/^strftime\('%Y-%m-%dT%H:%M:%fZ', *'now'\)$/i.test(d)) {
    return cls === "timestamptz" ? "clock" : "clock-text:iso-ms-z";
  }
  if (/^datetime\('now'\)$/i.test(d) || /^CURRENT_TIMESTAMP$/i.test(d)) {
    return cls === "timestamptz" ? "clock" : "clock-text:space";
  }
  if (/^lower\(hex\(randomblob\(16\)\)\)$/i.test(d)) return "random-hex32";
  if (/^CAST\(unixepoch\('subsec'\) \* 1000 AS INTEGER\)$/i.test(d)) return "epoch-ms-clock";
  if (/^-?\d+(\.\d+)?$/.test(d)) {
    if (cls === "boolean")
      return d === "1" ? "literal:true" : d === "0" ? "literal:false" : `?${d}`;
    return `literal:${Number(d)}`;
  }
  const s = /^'((?:[^']|'')*)'$/.exec(d);
  if (s) {
    const value = (s[1] as string).replaceAll("''", "'");
    if (cls === "jsonb") return `literal:${canonicalJson(JSON.parse(value))}`;
    return `literal:${value}`;
  }
  return `?${d}`;
}

/** The meaning of a Postgres column default (information_schema text). */
function pgDefaultMeaning(dflt: string | null, isIdentity: boolean): DefaultMeaning {
  if (isIdentity) return "identity";
  if (dflt === null || /^NULL(::\w+)?$/i.test(dflt)) return null;
  const d = dflt.trim();
  if (d === "statement_timestamp()") return "clock";
  if (d.startsWith("to_char((statement_timestamp() AT TIME ZONE 'UTC'::text)")) {
    if (d.includes(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`)) return "clock-text:iso-ms-z";
    if (d.includes("'YYYY-MM-DD HH24:MI:SS'")) return "clock-text:space";
  }
  if (d === "replace((gen_random_uuid())::text, '-'::text, ''::text)") return "random-hex32";
  if (d === "(floor((EXTRACT(epoch FROM statement_timestamp()) * (1000)::numeric)))::bigint") {
    return "epoch-ms-clock";
  }
  if (d === "true" || d === "false") return `literal:${d}`;
  if (/^-?\d+(\.\d+)?$/.test(d)) return `literal:${Number(d)}`;
  const s = /^'((?:[^']|'')*)'::(text|jsonb)$/.exec(d);
  if (s) {
    const value = (s[1] as string).replaceAll("''", "'");
    if (s[2] === "jsonb") return `literal:${canonicalJson(JSON.parse(value))}`;
    return `literal:${value}`;
  }
  return `?${d}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A seeded value normalized per class, from SQLite. */
function normSqliteValue(v: unknown, cls: string, volatile: boolean): string {
  if (v === null || v === undefined) return "null";
  if (volatile) return volatileShape(v);
  switch (cls) {
    case "boolean":
      return v === 1 ? "true" : "false";
    case "timestamptz": {
      const s = String(v);
      if (SPACE_TS.test(s)) return `${s.replace(" ", "T")}.000Z`;
      return s;
    }
    case "jsonb":
      return canonicalJson(JSON.parse(String(v)));
    case "bigint":
    case "epoch-ms":
    case "double":
      return String(Number(v));
    case "bytea":
      return Buffer.from(v as Uint8Array).toString("hex");
    default:
      return String(v);
  }
}

function normPgValue(v: unknown, cls: string, volatile: boolean): string {
  if (v === null || v === undefined) return "null";
  if (volatile) return volatileShape(v);
  switch (cls) {
    case "boolean":
      return v === true ? "true" : "false";
    case "timestamptz":
      return v instanceof Date ? v.toISOString() : String(v);
    case "jsonb":
      return canonicalJson(typeof v === "string" ? JSON.parse(v) : v);
    case "bigint":
    case "epoch-ms":
    case "double":
      return String(Number(v));
    case "bytea":
      return Buffer.from(v as Uint8Array).toString("hex");
    default:
      return String(v);
  }
}

function volatileShape(v: unknown): string {
  if (v instanceof Date) return "<clock>";
  const s = String(v);
  if (ISO_MS_Z.test(s) || SPACE_TS.test(s)) return "<clock>";
  if (HEX32.test(s)) return "<hex32>";
  if (/^\d{13}$/.test(s)) return "<epoch-ms>";
  return `<volatile:${s}>`;
}

// ---------------------------------------------------------------------------
// Postgres introspection
// ---------------------------------------------------------------------------

type PgColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
  datetime_precision: number | null;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  ordinal_position: number;
};

const PG_DATA_TYPE: Record<string, string> = {
  "timestamp with time zone": "timestamptz",
  bigint: "bigint",
  boolean: "boolean",
  jsonb: "jsonb",
  text: "text",
  "double precision": "double precision",
  bytea: "bytea",
};

type PgSchema = {
  tables: Set<string>;
  columns: Map<string, PgColumn[]>;
  pks: Map<string, string[]>;
  uniques: Map<string, string[][]>;
  fks: Map<
    string,
    { columns: string[]; parent: string; parentColumns: string[]; del: string; upd: string }[]
  >;
  checks: Map<string, string[]>;
  indexes: Map<
    string,
    { table: string; unique: boolean; keys: string[]; desc: boolean[]; where: string | null }
  >;
  triggers: Map<string, { table: string; timing: string; event: string; columns: string[] }>;
  views: Set<string>;
};

const FK_ACTION: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

async function introspectPostgres(db: PostgresClient): Promise<PgSchema> {
  const tables = new Set(
    (
      await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      )
    ).map((r) => r.table_name),
  );
  const columns = new Map<string, PgColumn[]>();
  for (const c of await db.query<PgColumn>(
    `SELECT table_name, column_name, data_type, datetime_precision, is_nullable, column_default, is_identity, ordinal_position
     FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  )) {
    columns.set(c.table_name, [...(columns.get(c.table_name) ?? []), c]);
  }
  type ConRow = {
    contype: string;
    tbl: string;
    cols: string[];
    parent: string | null;
    parent_cols: string[] | null;
    confdeltype: string;
    confupdtype: string;
    def: string;
  };
  const cons = await db.query<ConRow>(
    `SELECT c.contype, t.relname AS tbl,
       ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS cols,
       p.relname AS parent,
       ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS parent_cols,
       c.confdeltype, c.confupdtype, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace AND ns.nspname = 'public'
     LEFT JOIN pg_class p ON p.oid = c.confrelid`,
  );
  const pks = new Map<string, string[]>();
  const uniques = new Map<string, string[][]>();
  const fks: PgSchema["fks"] = new Map();
  const checks = new Map<string, string[]>();
  for (const c of cons) {
    if (c.contype === "p") pks.set(c.tbl, c.cols);
    if (c.contype === "u") uniques.set(c.tbl, [...(uniques.get(c.tbl) ?? []), c.cols]);
    if (c.contype === "f") {
      fks.set(c.tbl, [
        ...(fks.get(c.tbl) ?? []),
        {
          columns: c.cols,
          parent: c.parent ?? "",
          parentColumns: c.parent_cols ?? [],
          del: FK_ACTION[c.confdeltype] ?? c.confdeltype,
          upd: FK_ACTION[c.confupdtype] ?? c.confupdtype,
        },
      ]);
    }
    if (c.contype === "c") {
      const m = /^CHECK \((.*)\)( NOT VALID)?$/s.exec(c.def);
      checks.set(c.tbl, [...(checks.get(c.tbl) ?? []), m ? (m[1] as string) : c.def]);
    }
  }
  type IdxRow = {
    name: string;
    tbl: string;
    unique: boolean;
    nkeys: number;
    keys: string[];
    options: number[];
    pred: string | null;
  };
  const idxRows = await db.query<IdxRow>(
    `SELECT ic.relname AS name, t.relname AS tbl, i.indisunique AS unique, i.indnkeyatts AS nkeys,
       ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(1, i.indnkeyatts) k ORDER BY k)::text[] AS keys,
       ARRAY(SELECT (i.indoption::int2[])[k - 1] FROM generate_series(1, i.indnkeyatts) k ORDER BY k)::int[] AS options,
       pg_get_expr(i.indpred, i.indrelid, true) AS pred
     FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace AND ns.nspname = 'public'
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)`,
  );
  const indexes: PgSchema["indexes"] = new Map();
  for (const r of idxRows) {
    indexes.set(r.name, {
      table: r.tbl,
      unique: r.unique,
      keys: r.keys,
      desc: r.options.map((o) => (Number(o) & 1) === 1),
      where: r.pred,
    });
  }
  type TrgRow = { name: string; tbl: string; tgtype: number; cols: string[] };
  const trgRows = await db.query<TrgRow>(
    `SELECT tg.tgname AS name, t.relname AS tbl, tg.tgtype::int AS tgtype,
       ARRAY(SELECT a.attname FROM unnest(tg.tgattr::int2[]) WITH ORDINALITY k(n, i)
             JOIN pg_attribute a ON a.attrelid = tg.tgrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS cols
     FROM pg_trigger tg JOIN pg_class t ON t.oid = tg.tgrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace AND ns.nspname = 'public'
     WHERE NOT tg.tgisinternal`,
  );
  const triggers: PgSchema["triggers"] = new Map();
  for (const r of trgRows) {
    const type = Number(r.tgtype);
    const timing = type & 64 ? "INSTEAD OF" : type & 2 ? "BEFORE" : "AFTER";
    const event = type & 4 ? "INSERT" : type & 8 ? "DELETE" : type & 16 ? "UPDATE" : "?";
    triggers.set(r.name, { table: r.tbl, timing, event, columns: r.cols });
  }
  const views = new Set(
    (
      await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.views WHERE table_schema = 'public'",
      )
    ).map((r) => r.table_name),
  );
  return { tables, columns, pks, uniques, fks, checks, indexes, triggers, views };
}

// ---------------------------------------------------------------------------
// SQLite side helpers
// ---------------------------------------------------------------------------

/** `CREATE TRIGGER name <timing> <event> [OF cols] ON table`, parsed. */
function sqliteTriggerShape(sql: string): { timing: string; event: string; columns: string[] } {
  const toks = tokenize(sql);
  let i = 3; // CREATE TRIGGER [IF NOT EXISTS] name
  if (toks[2]?.v.toUpperCase() === "IF") i = 6;
  const word = (n: number) => (toks[n]?.v ?? "").toUpperCase();
  let timing = "BEFORE";
  if (word(i) === "BEFORE" || word(i) === "AFTER") {
    timing = word(i);
    i++;
  } else if (word(i) === "INSTEAD") {
    timing = "INSTEAD OF";
    i += 2;
  }
  const event = word(i);
  i++;
  const columns: string[] = [];
  if (event === "UPDATE" && word(i) === "OF") {
    i++;
    while (word(i) !== "ON") {
      const t = toks[i];
      if (t && (t.k === "id" || t.k === "qid")) columns.push(t.v);
      i++;
    }
  }
  return { timing, event, columns };
}

/** `col IN (...)` value sets of a CHECK, as `col:v1|v2` strings. */
function inValueSets(normalized: string): string[] {
  const out: string[] = [];
  for (const m of normalized.matchAll(
    /(\w+) (not )?in ((?:'[^']*'|true|false|-?\d+)(?:,(?:'[^']*'|true|false|-?\d+))*)/g,
  )) {
    const values = (m[3] as string).split(",").sort();
    out.push(`${m[1]}:${m[2] ? "not " : ""}${values.join("|")}`);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function compareSchemas(
  types: ColumnTypes,
  head: HeadSchema,
  allSqliteTables: string[],
  sqliteMigrationColumns: string[],
  seeds: SeedTable[],
  pg: PgSchema,
  pgRows: Map<string, Record<string, unknown>[]>,
): Diff[] {
  const diffs: Diff[] = [];
  const add = (key: string, detail: string) => diffs.push({ key, detail });

  // Tables (every SQLite table, the FTS5 ones included).
  for (const t of allSqliteTables)
    if (!pg.tables.has(t)) add(`table:${t}`, `${t} is missing on Postgres`);
  for (const t of pg.tables)
    if (!allSqliteTables.includes(t)) add(`table:${t}`, `${t} exists only on Postgres`);

  // The runner-owned _migrations table: same columns.
  const pgMig = (pg.columns.get("_migrations") ?? []).map((c) => c.column_name);
  if (pgMig.join(",") !== sqliteMigrationColumns.join(",")) {
    add("columns:_migrations", `SQLite (${sqliteMigrationColumns}) vs Postgres (${pgMig})`);
  }

  for (const t of head.tables) {
    if (!pg.tables.has(t.name)) continue;
    compareTable(types, t, pg, add);
  }

  // Triggers.
  for (const trg of head.triggers) {
    const p = pg.triggers.get(trg.name);
    if (!p) {
      add(`trigger:${trg.name}`, `trigger ${trg.name} on ${trg.table} is missing on Postgres`);
      continue;
    }
    const s = sqliteTriggerShape(trg.sql);
    const sShape = `${trg.table} ${s.timing} ${s.event}${s.columns.length ? ` OF ${[...s.columns].sort()}` : ""}`;
    const pShape = `${p.table} ${p.timing} ${p.event}${p.columns.length ? ` OF ${[...p.columns].sort()}` : ""}`;
    if (sShape !== pShape) add(`trigger:${trg.name}`, `SQLite ${sShape} vs Postgres ${pShape}`);
  }
  for (const name of pg.triggers.keys()) {
    if (!head.triggers.some((t) => t.name === name))
      add(`trigger:${name}`, `${name} exists only on Postgres`);
  }

  // Views.
  for (const v of head.views)
    if (!pg.views.has(v.name)) add(`view:${v.name}`, "missing on Postgres");
  for (const v of pg.views)
    if (!head.views.some((x) => x.name === v)) add(`view:${v}`, "only on Postgres");

  // Seeded rows.
  const seeded = new Set(seeds.map((s) => s.table));
  for (const s of seeds) {
    const t = head.tables.find((x) => x.name === s.table) as HeadTable;
    const classes = s.columns.map((c) => {
      const decl = t.columns.find((x) => x.name === c)?.declared ?? "";
      const { cls } = pgClassOf(types, s.table, c, decl);
      return cls === "double" ? "double" : cls;
    });
    // A surrogate table compares the SQLite rowid with `_rowid` too.
    const want = s.rows
      .map((row, r) =>
        JSON.stringify([
          ...row.map((v, i) =>
            normSqliteValue(v, classes[i] as string, s.volatile.includes(s.columns[i] as string)),
          ),
          ...(s.rowids ? [String(s.rowids[r])] : []),
        ]),
      )
      .sort();
    const got = (pgRows.get(s.table) ?? [])
      .map((row) =>
        JSON.stringify([
          ...s.columns.map((c, i) =>
            normPgValue(row[c], classes[i] as string, s.volatile.includes(c)),
          ),
          ...(s.rowids ? [String(Number(row[ROWID_COLUMN]))] : []),
        ]),
      )
      .sort();
    if (want.join("\n") !== got.join("\n")) {
      const missing = want.filter((w) => !got.includes(w)).slice(0, 2);
      const extra = got.filter((g) => !want.includes(g)).slice(0, 2);
      add(
        `rows:${s.table}`,
        `seeded rows differ (${want.length} vs ${got.length}); SQLite only: ${missing.join(" ")}; Postgres only: ${extra.join(" ")}`.slice(
          0,
          600,
        ),
      );
    }
  }
  for (const [table, rows] of pgRows) {
    if (rows.length > 0 && !seeded.has(table))
      add(`rows:${table}`, `${rows.length} rows only on Postgres`);
  }
  return diffs;
}

function compareTable(
  types: ColumnTypes,
  t: HeadTable,
  pg: PgSchema,
  add: (key: string, detail: string) => void,
): void {
  const allPgCols = pg.columns.get(t.name) ?? [];
  // The rowid surrogate (lead decision, M3): a rowid table without an INTEGER
  // PRIMARY KEY alias has `_rowid bigint GENERATED BY DEFAULT AS IDENTITY NOT
  // NULL` with a unique index `<table>__rowid_key`, and nothing else does.
  // Each correct one is reported under the single key `rowid-surrogate`; a
  // wrong or missing one under `rowid-surrogate-shape:<table>`.
  const surrogate = allPgCols.find((c) => c.column_name === ROWID_COLUMN);
  const surrogateIndex = pg.indexes.get(rowidIndexName(t.name));
  if (t.surrogateRowid) {
    const okColumn =
      surrogate !== undefined &&
      surrogate.data_type === "bigint" &&
      surrogate.is_nullable === "NO" &&
      surrogate.is_identity === "YES" &&
      surrogate.column_default === null;
    const okIndex =
      surrogateIndex !== undefined &&
      surrogateIndex.table === t.name &&
      surrogateIndex.unique &&
      surrogateIndex.where === null &&
      surrogateIndex.keys.map(normalizeExpr).join("|") === ROWID_COLUMN;
    if (okColumn && okIndex) {
      add("rowid-surrogate", `${t.name}.${ROWID_COLUMN} with ${rowidIndexName(t.name)}`);
    } else {
      add(
        `rowid-surrogate-shape:${t.name}`,
        `expected ${ROWID_COLUMN} bigint identity NOT NULL with unique index ${rowidIndexName(t.name)}; column ${JSON.stringify(surrogate ?? null)}, index ${JSON.stringify(surrogateIndex ?? null)}`,
      );
    }
  }
  const pgCols = t.surrogateRowid
    ? allPgCols.filter((c) => c.column_name !== ROWID_COLUMN)
    : allPgCols;
  const sNames = t.columns.map((c) => c.name);
  const pNames = pgCols.map((c) => c.column_name);
  for (const n of sNames)
    if (!pNames.includes(n)) add(`column:${t.name}.${n}`, "missing on Postgres");
  for (const n of pNames) if (!sNames.includes(n)) add(`column:${t.name}.${n}`, "only on Postgres");
  const common = sNames.filter((n) => pNames.includes(n));
  if (common.join(",") !== pNames.filter((n) => sNames.includes(n)).join(",")) {
    add(`column-order:${t.name}`, `SQLite (${sNames}) vs Postgres (${pNames})`);
  }
  const pk = t.columns.filter((c) => c.pkOrder > 0).map((c) => c.name);
  for (const c of t.columns) {
    const p = pgCols.find((x) => x.column_name === c.name);
    if (!p) continue;
    const { cls } = pgClassOf(types, t.name, c.name, c.declared);
    const want = pgTypeName(cls);
    const mapped = PG_DATA_TYPE[p.data_type] ?? p.data_type;
    const got = mapped === "timestamptz" ? `timestamptz(${p.datetime_precision})` : mapped;
    if (want !== got)
      add(`type:${t.name}.${c.name}`, `classified ${cls} (${want}), Postgres ${got}`);
    // A PRIMARY KEY column is NOT NULL on Postgres. SQLite accepts NULL in a
    // non-INTEGER PK column (a legacy quirk the swarm never relies on: every
    // writer supplies the key), so the SQLite side counts PK columns as NOT NULL.
    const sNotNull = c.notNull || pk.includes(c.name);
    const pNotNull = p.is_nullable === "NO";
    if (sNotNull !== pNotNull)
      add(
        `null:${t.name}.${c.name}`,
        `SQLite ${sNotNull ? "NOT NULL" : "NULL"}, Postgres ${pNotNull ? "NOT NULL" : "NULL"}`,
      );
    const sDef = sqliteDefaultMeaning(c.dflt, cls, t.rowidAlias === c.name);
    const pDef = pgDefaultMeaning(p.column_default, p.is_identity === "YES");
    if (sDef !== pDef) add(`default:${t.name}.${c.name}`, `SQLite ${sDef} vs Postgres ${pDef}`);
  }
  const pgPk = pg.pks.get(t.name) ?? [];
  const sPk = [...t.columns.filter((c) => c.pkOrder > 0)]
    .sort((a, b) => a.pkOrder - b.pkOrder)
    .map((c) => c.name);
  if (sPk.join(",") !== pgPk.join(","))
    add(`pk:${t.name}`, `SQLite (${sPk}) vs Postgres (${pgPk})`);

  const sU = t.uniques.map((u) => u.join(",")).sort();
  const pU = (pg.uniques.get(t.name) ?? []).map((u) => u.join(",")).sort();
  for (const u of sU) if (!pU.includes(u)) add(`unique:${t.name}(${u})`, "missing on Postgres");
  for (const u of pU) if (!sU.includes(u)) add(`unique:${t.name}(${u})`, "only on Postgres");

  const fkKey = (cols: string[], parent: string, pcols: string[], del: string, upd: string) =>
    `${cols}>${parent}(${pcols}) ON DELETE ${del} ON UPDATE ${upd}`;
  const sF = t.foreignKeys.map((f) => {
    const parentPk = f.parentColumns.every((c) => c === "") ? null : f.parentColumns;
    return {
      cols: f.columns,
      key: fkKey(
        f.columns,
        f.parent,
        parentPk ?? ["<pk>"],
        f.onDelete.toUpperCase(),
        f.onUpdate.toUpperCase(),
      ),
    };
  });
  const pF = (pg.fks.get(t.name) ?? []).map((f) => ({ cols: f.columns, f }));
  for (const s of sF) {
    const match = pF.find((p) => {
      const pcols = s.key.includes("(<pk>)") ? ["<pk>"] : p.f.parentColumns;
      return fkKey(p.f.columns, p.f.parent, pcols, p.f.del, p.f.upd) === s.key;
    });
    if (!match) add(`fk:${t.name}(${s.cols})`, `SQLite ${s.key} has no equal Postgres foreign key`);
  }
  if (pF.length !== sF.length)
    add(`fk-count:${t.name}`, `SQLite ${sF.length} vs Postgres ${pF.length}`);

  // CHECKs: count, IN value sets, normalized expressions.
  const ctx = tableContext(types, t);
  const sChecks = t.checks.map((c) => normalizeExpr(translateExpr(c, ctx, `${t.name} CHECK`)));
  const pChecks = (pg.checks.get(t.name) ?? []).map(normalizeExpr);
  if (sChecks.length !== pChecks.length) {
    add(`check:${t.name}`, `SQLite ${sChecks.length} CHECKs vs Postgres ${pChecks.length}`);
  } else {
    const sSets = sChecks.flatMap(inValueSets).sort();
    const pSets = pChecks.flatMap(inValueSets).sort();
    if (sSets.join(";") !== pSets.join(";"))
      add(`check:${t.name}`, `IN sets: SQLite ${sSets.join(";")} vs Postgres ${pSets.join(";")}`);
    const a = [...sChecks].sort();
    const b = [...pChecks].sort();
    a.forEach((x, i) => {
      if (x !== b[i]) add(`check:${t.name}`, `CHECK differs: SQLite "${x}" vs Postgres "${b[i]}"`);
    });
    // The flat text above cannot see a regrouping (`(a AND b) OR c` vs
    // `a AND (b OR c)`): compare the Boolean structure too.
    const sShapes = t.checks
      .map((c) => booleanShape(translateExpr(c, ctx, `${t.name} CHECK`)))
      .sort();
    const pShapes = (pg.checks.get(t.name) ?? []).map(booleanShape).sort();
    sShapes.forEach((x, i) => {
      if (x !== pShapes[i])
        add(`check:${t.name}`, `CHECK grouping differs: SQLite "${x}" vs Postgres "${pShapes[i]}"`);
    });
  }

  // Indexes.
  for (const idx of t.indexes) {
    const p = pg.indexes.get(idx.name);
    if (!p) {
      add(`index:${idx.name}`, `index on ${t.name} missing on Postgres`);
      continue;
    }
    const sKeys = idx.keys.map((k) =>
      normalizeExpr(k.column ?? translateExpr(k.expr, ctx, idx.name)),
    );
    const pKeys = p.keys.map(normalizeExpr);
    const sWhere = idx.where ? normalizeExpr(translateExpr(idx.where, ctx, idx.name)) : null;
    const pWhere = p.where ? normalizeExpr(p.where) : null;
    const sDesc = idx.keys.map((k) => k.desc).join(",");
    const pDesc = p.desc.join(",");
    if (
      p.table !== t.name ||
      p.unique !== idx.unique ||
      sKeys.join("|") !== pKeys.join("|") ||
      sDesc !== pDesc ||
      sWhere !== pWhere
    ) {
      add(
        `index:${idx.name}`,
        `SQLite ${t.name} unique=${idx.unique} (${sKeys}) desc=${sDesc} where ${sWhere} vs Postgres ${p.table} unique=${p.unique} (${pKeys}) desc=${pDesc} where ${pWhere}`,
      );
    }
  }
  for (const [name, p] of pg.indexes) {
    if (t.surrogateRowid && name === rowidIndexName(t.name)) continue;
    if (p.table === t.name && !t.indexes.some((i) => i.name === name))
      add(`index:${name}`, `only on Postgres (${t.name})`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function createScratch(
  adminUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `schema_parity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Bun.SQL(adminUrl);
  try {
    await admin.unsafe(
      `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  } finally {
    await admin.close();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const dropper = new Bun.SQL(adminUrl);
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.close();
      }
    },
  };
}

/** Rows as comparable text: column names and values, NULL kept apart from the text "null". */
function viewRowsText(rows: Record<string, unknown>[]): string {
  return JSON.stringify(
    rows
      .map((row) =>
        Object.keys(row)
          .sort()
          .map((k) => [k, row[k] === null || row[k] === undefined ? null : String(row[k])]),
      )
      .map((row) => JSON.stringify(row))
      .sort(),
  );
}

/** The differences of one Postgres view (`schema`.`name`) against SQLite's rows and its port. */
async function viewDiffs(
  pgClient: PostgresClient,
  name: string,
  schema: string,
  sqliteRows: Record<string, unknown>[],
): Promise<Diff[]> {
  const pgRows = await pgClient.query<Record<string, unknown>>(
    `SELECT * FROM ${qi(schema)}.${qi(name)}`,
  );
  const sqliteText = viewRowsText(sqliteRows);
  const pgText = viewRowsText(pgRows);
  if (sqliteText !== pgText) {
    return [
      {
        key: `view:${name}`,
        detail: `returns different rows on an empty database: SQLite ${sqliteText} vs Postgres ${pgText}`,
      },
    ];
  }
  const port = VIEW_PORTS[name];
  if (!port) return [{ key: `view:${name}`, detail: "has no Postgres port in VIEW_PORTS" }];
  // Postgres normalizes both definitions the same way: create the port in a
  // throwaway schema and compare pg_get_viewdef text.
  const definitions = await pgClient.transaction(async (tx) => {
    await tx.run("CREATE SCHEMA parity_view_port");
    await tx.run("SET LOCAL search_path TO parity_view_port, public");
    await tx.run(port.postgres);
    const row = await tx.get<{ expected: string; actual: string }>(
      `SELECT pg_get_viewdef('parity_view_port.${qi(name)}'::regclass) AS expected,
              pg_get_viewdef('${qi(schema)}.${qi(name)}'::regclass) AS actual`,
    );
    await tx.run("DROP SCHEMA parity_view_port CASCADE");
    return row;
  });
  if (definitions && definitions.expected !== definitions.actual) {
    return [
      {
        key: `view:${name}`,
        detail: `the Postgres definition differs from its port: ${definitions.actual.trim()} vs ${definitions.expected.trim()}`,
      },
    ];
  }
  return [];
}

/** A SQLite view whose definition is not the `sqlite` text of its port in VIEW_PORTS. */
function sqliteViewDiff(name: string, sql: string): Diff | null {
  const port = VIEW_PORTS[name];
  if (!port) return null;
  const flat = (text: string) => text.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  if (flat(port.sqlite) === flat(sql)) return null;
  return {
    key: `view:${name}`,
    detail: `the SQLite definition differs from the one its Postgres port was written from: ${flat(sql)} vs ${flat(port.sqlite)}`,
  };
}

/**
 * A view's name and columns can stay while its body changes. Compare what each
 * view returns on the two empty databases and its Postgres definition with the
 * hand port. A control runs every time: the same view with its rows filtered
 * out must fail, or the comparison has stopped working.
 */
async function compareViewBehavior(
  pgClient: PostgresClient,
  head: HeadSchema,
  pg: PgSchema,
  sqliteViewRows: Map<string, Record<string, unknown>[]>,
): Promise<{ diffs: Diff[]; errors: string[] }> {
  const diffs: Diff[] = [];
  const errors: string[] = [];
  for (const v of head.views) {
    if (!pg.views.has(v.name)) continue;
    // A SQLite body change can return the same rows on an empty database (a
    // view that answers only while agent_tasks is empty). The SQLite text must
    // still be the one the Postgres port was written from.
    const sqliteDiff = sqliteViewDiff(v.name, v.sql);
    if (sqliteDiff) diffs.push(sqliteDiff);
    if (!sqliteViewDiff(v.name, `${v.sql} WHERE 0`)) {
      errors.push(`view control: a changed SQLite ${v.name} was not detected`);
    }
    const rows = sqliteViewRows.get(v.name) ?? [];
    diffs.push(...(await viewDiffs(pgClient, v.name, "public", rows)));
    await pgClient.run("CREATE SCHEMA parity_view_control");
    try {
      await pgClient.run(
        `CREATE VIEW parity_view_control.${qi(v.name)} AS SELECT * FROM public.${qi(v.name)} WHERE false`,
      );
      if ((await viewDiffs(pgClient, v.name, "parity_view_control", rows)).length === 0) {
        errors.push(`view control: a changed ${v.name} (no rows) was not detected`);
      }
    } finally {
      await pgClient.run("DROP SCHEMA parity_view_control CASCADE");
    }
  }
  return { diffs, errors };
}

export async function runSchemaParity(): Promise<{
  unexplained: Diff[];
  explained: Diff[];
  errors: string[];
}> {
  const adminUrl = process.env.STORAGE_TEST_POSTGRES_URL;
  if (!adminUrl) {
    throw new Error(
      "STORAGE_TEST_POSTGRES_URL is not set (a URL to a maintenance database, for example postgres://postgres@127.0.0.1:5432/postgres)",
    );
  }
  const types = loadColumnTypes();
  const { db: sqlite, schema: head, seeds } = await readSeedsWithVolatility();
  const allSqliteTables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '_migrations' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  const sqliteMigrationColumns = sqlite
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('_migrations')")
    .all()
    .map((r) => r.name);
  // A view's name and columns can stay while its body changes: compare what
  // each view returns on the two empty databases, and the Postgres definition
  // with the hand port it was generated from.
  const sqliteViewRows = new Map<string, Record<string, unknown>[]>();
  for (const v of head.views) {
    sqliteViewRows.set(
      v.name,
      sqlite.query<Record<string, unknown>, []>(`SELECT * FROM "${v.name}"`).all(),
    );
  }
  sqlite.close();

  const scratch = await createScratch(adminUrl);
  const pgClient = createPostgresClient(scratch.url, { max: 2, rawValues: true });
  let diffs: Diff[];
  let viewErrors: string[] = [];
  try {
    await runPostgresMigrations(pgClient, {
      migrationsDir: POSTGRES_MIGRATIONS_DIR,
      log: () => {},
    });
    const pg = await introspectPostgres(pgClient);
    pg.tables.delete("_migrations");
    const pgRows = new Map<string, Record<string, unknown>[]>();
    for (const t of pg.tables) {
      pgRows.set(t, await pgClient.query<Record<string, unknown>>(`SELECT * FROM ${qi(t)}`));
    }
    diffs = compareSchemas(types, head, allSqliteTables, sqliteMigrationColumns, seeds, pg, pgRows);
    const views = await compareViewBehavior(pgClient, head, pg, sqliteViewRows);
    diffs.push(...views.diffs);
    viewErrors = views.errors;
  } finally {
    await pgClient.close();
    await scratch.drop();
  }

  const { entries, errors } = readAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
  errors.push(...viewErrors);
  const explained = diffs.filter((d) => entries.has(d.key));
  const unexplained = diffs.filter((d) => !entries.has(d.key));
  for (const key of entries.keys()) {
    if (!diffs.some((d) => d.key === key))
      errors.push(`allowlist entry ${key} matches no difference (remove it)`);
  }
  return { unexplained, explained, errors };
}

if (import.meta.main) {
  const { unexplained, explained, errors } = await runSchemaParity();
  for (const e of errors) console.error(`ERROR ${e}`);
  for (const d of unexplained) console.error(`DIFF ${d.key}: ${d.detail}`);
  console.log(
    `schema parity: ${unexplained.length} unexplained difference(s), ${explained.length} allowlisted, ${errors.length} allowlist error(s)`,
  );
  process.exit(unexplained.length > 0 || errors.length > 0 ? 1 : 0);
}
