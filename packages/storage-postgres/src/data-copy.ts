import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CopyCell,
  CopyProblem,
  CopyReport,
  CopySource,
  CopyTable,
  CopyTableReport,
} from "@desplega/storage";
import { PROCESS_LOCK_KEY } from "./boot";
import { ROWID_COLUMN } from "./codec";
import { loadPostgresMigrations, runPostgresMigrations } from "./migrations";

/**
 * Copy a SQLite database into an empty Postgres database at the same migration
 * head (decision D11). One transaction: a refused value, a foreign key that
 * fails at COMMIT, or any other error leaves the target as it was.
 *
 * Steps (D11 numbering): the source is opened read-only by the caller (1); a
 * target with any table is refused (2); user triggers are off during the copy (3);
 * each value is converted to the type of its target column (4); a value the
 * target cannot store is reported, never dropped (5); the vector table is built
 * from the copied embeddings, full text needs no rebuild because it is an
 * expression index (6); identity sequences restart past the copied keys (7);
 * row counts and checksums of normalized values are compared per table (8); the
 * caller exits non-zero when `ok` is false (9).
 */

export type PostgresCopyOptions = {
  /** Postgres URL of the target database. */
  url: string;
  /** The Postgres migration chain (`src/be/migrations/postgres`). */
  migrationsDir: string;
  /** Embedding size of the vector table (EMBEDDING_DIMENSIONS of the API). */
  embeddingDimensions: number;
  /** Rows per INSERT statement (bounded by the 65,535 parameter limit). */
  batchSize?: number;
  /** Stored bytes per INSERT statement. A larger single row still goes alone. */
  batchBytes?: number;
  /** Problems kept in the report (all are counted). */
  maxProblems?: number;
  log?: (line: string) => void;
};

type TargetColumn = {
  name: string;
  /** `format_type` text, used as the cast of each parameter. */
  type: string;
  /** `pg_type.typname`, which picks the conversion. */
  typname: string;
  notNull: boolean;
  identity: boolean;
  generated: boolean;
};

type TargetTable = { name: string; columns: TargetColumn[]; hasUserTriggers: boolean };

type Conn = {
  unsafe(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  release(): void;
};

const MAX_PARAMS = 60_000;
/**
 * Stored bytes per INSERT statement. Rows of several megabytes (a page version,
 * a task output) would otherwise put 500 of them in one statement: gigabytes in
 * this process and in the Postgres backend, and a message near the 1 GB limit.
 */
const DEFAULT_BATCH_BYTES = 16 * 1024 * 1024;
const TABLE_ORDER_KEY = ROWID_COLUMN;

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Tables the migration chain writes rows into: the only ones a fresh target may hold rows in. */
export function chainSeededTables(migrationsDir: string): Set<string> {
  const seeded = new Set<string>();
  for (const migration of loadPostgresMigrations(migrationsDir)) {
    for (const match of migration.sql.matchAll(/INSERT\s+INTO\s+"?([A-Za-z0-9_]+)"?/gi)) {
      if (match[1]) seeded.add(match[1]);
    }
  }
  return seeded;
}

/**
 * What the target holds. The copy writes only into a database with no tables:
 * it runs the chain itself, so every seed row in the target is one the chain
 * just wrote. A database an API (or a restore) already migrated may hold edited
 * seed rows (a renamed channel, a retitled starter widget), and no check on the
 * migrated target can tell every edit apart from what the chain wrote: a later
 * migration that rewrites an edited row hides the edit. Such a target is refused
 * before anything is written. After the chain runs, the same function reads the
 * head (`requireEmpty: false`).
 */
async function inspectTarget(
  conn: Conn,
  chainHead: number | null,
  requireEmpty: boolean,
): Promise<{ head: number | null; error?: string }> {
  const tables = (
    await conn.unsafe(`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`)
  ).map((r) => String(r.name));
  if (tables.length === 0) return { head: null };
  const named = tables.slice(0, 10).join(", ");
  if (!tables.includes("_migrations")) {
    return {
      head: null,
      error: `the target database holds tables but no _migrations history (${named}). Copy into an empty database only.`,
    };
  }
  // Another tool's `_migrations` (for example `id`, `name`) is not this chain's history.
  const required = ["version", "name", "applied_at", "checksum"];
  const present = new Set(
    (
      await conn.unsafe(
        `SELECT attname FROM pg_attribute
          WHERE attrelid = to_regclass('_migrations') AND attnum > 0 AND NOT attisdropped`,
      )
    ).map((r) => String(r.attname)),
  );
  const absent = required.filter((column) => !present.has(column));
  if (absent.length > 0) {
    return {
      head: null,
      error: `the target's _migrations table is not this build's migration history (no column ${absent.join(", ")}). Copy into an empty database only.`,
    };
  }
  const headRow = await conn.unsafe("SELECT MAX(version)::bigint AS v FROM _migrations");
  const head = headRow[0]?.v === null || headRow[0]?.v === undefined ? null : Number(headRow[0].v);
  if (!requireEmpty) return { head };
  if (head !== chainHead) {
    return {
      head,
      error:
        `the target database is at migration ${head}, this build at ${chainHead}. ` +
        "The copy runs the migrations itself: copy into a new, empty database. Nothing was written.",
    };
  }
  return {
    head,
    error:
      `the target database already holds tables (${named}). The copy runs the migrations itself ` +
      "and needs a database with no tables: a migrated database may hold edited seed rows the copy " +
      "would replace. Copy into a new, empty database, and do not start an API on it first. Nothing was written.",
  };
}

/** The reserved copy session as the pool the migration runner reserves from. */
function onConnection(conn: Conn) {
  return {
    reserve: async () => ({
      unsafe: (text: string, params?: unknown[]) => conn.unsafe(text, params),
      release: () => {},
    }),
  } as unknown as Parameters<typeof runPostgresMigrations>[0];
}

async function readTargetTables(conn: Conn): Promise<Map<string, TargetTable>> {
  const rows = await conn.unsafe(`
    SELECT c.relname AS "table", a.attname AS "column",
           format_type(a.atttypid, a.atttypmod) AS "type", t.typname AS "typname",
           a.attnotnull AS "notNull", a.attidentity <> '' AS "identity",
           a.attgenerated <> '' AS "generated"
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`);
  const triggers = await conn.unsafe(`
    SELECT DISTINCT c.relname AS "table"
      FROM pg_trigger g
      JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND NOT g.tgisinternal`);
  const withTriggers = new Set(triggers.map((r) => String(r.table)));
  const tables = new Map<string, TargetTable>();
  for (const row of rows) {
    const name = String(row.table);
    let table = tables.get(name);
    if (!table) {
      table = { name, columns: [], hasUserTriggers: withTriggers.has(name) };
      tables.set(name, table);
    }
    table.columns.push({
      name: String(row.column),
      type: String(row.type),
      typname: String(row.typname),
      notNull: row.notNull === true,
      identity: row.identity === true,
      generated: row.generated === true,
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Value conversion (D11 steps 4 and 5)

type Converted = { ok: true; value: string | null } | { ok: false; reason: string };

// ignoreBOM keeps a leading U+FEFF: it is part of the stored value, not a byte order mark.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function decodeText(bytes: Uint8Array): Converted {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { ok: false, reason: "invalid UTF-8" };
  }
  if (text.includes("\u0000")) return { ok: false, reason: "NUL byte in text" };
  return { ok: true, value: text };
}

// A high surrogate with no low surrogate after it, or a low one with no high one before it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why Postgres refuses a string of a parsed JSON value, or null. JSON.parse takes
 * both escapes; `jsonb` refuses "\u0000" and a surrogate escape with no partner
 * (text cut in the middle of an emoji), and that error names no row.
 */
function jsonStringProblem(value: unknown): string | null {
  if (typeof value === "string") {
    if (value.includes("\u0000")) return "JSON holds a \\u0000 character";
    if (LONE_SURROGATE.test(value))
      return "JSON holds an unpaired surrogate escape (\\ud800 to \\udfff)";
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = jsonStringProblem(item);
      if (problem) return problem;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const problem = jsonStringProblem(key) ?? jsonStringProblem(item);
      if (problem) return problem;
    }
  }
  return null;
}

/** SQLite timestamp text to an ISO instant; text with no zone is UTC, as SQLite reads it. */
function timestampText(text: string): string | null {
  const match = ISO_TIMESTAMP.exec(text.trim());
  if (!match) return null;
  const zone = match[3] ?? "Z";
  const time = match[2]?.length === 5 ? `${match[2]}:00` : match[2];
  const iso = `${match[1]}T${time}${zone}`;
  // Date.parse rolls February 30 over to March 2; Postgres refuses it. Check the
  // calendar day first, so the report names the row instead of failing the batch.
  const [year, month, day] = (match[1] as string).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  // Postgres has no year 0 (1 BC), and Date.UTC maps years 0-99 to 1900-1999.
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const monthEnd = new Date(Date.UTC(2000, month, 0));
  monthEnd.setUTCFullYear(year, month, 0);
  if (day > monthEnd.getUTCDate()) return null;
  // Postgres takes a UTC offset up to 15:59; JavaScript takes up to 23:59.
  const offset = /^[+-](\d{2}):?(\d{2})?$/.exec(zone);
  if (offset && (Number(offset[1]) > 15 || Number(offset[2] ?? 0) > 59)) return null;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function cellText(cell: CopyCell): Converted {
  switch (cell.kind) {
    case "null":
      return { ok: true, value: null };
    case "integer":
    case "real":
      return { ok: true, value: String(cell.value) };
    default:
      return decodeText(cell.bytes);
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Convert one SQLite value to the text form of its Postgres column type. */
export function convertCell(cell: CopyCell, column: TargetColumn): Converted {
  if (cell.kind === "null") {
    return column.notNull
      ? { ok: false, reason: "NULL in a NOT NULL column" }
      : { ok: true, value: null };
  }
  switch (column.typname) {
    case "bool":
      if (cell.kind === "integer" && (cell.value === 0n || cell.value === 1n))
        return { ok: true, value: cell.value === 1n ? "true" : "false" };
      return { ok: false, reason: `not a flag (0 or 1): ${describe(cell)}` };
    case "int2":
    case "int4":
    case "int8":
      if (cell.kind === "integer") return { ok: true, value: cell.value.toString() };
      if (cell.kind === "real" && Number.isInteger(cell.value))
        return { ok: true, value: BigInt(cell.value).toString() };
      return { ok: false, reason: `not an integer: ${describe(cell)}` };
    case "float4":
    case "float8":
    case "numeric":
      if (cell.kind === "integer" || cell.kind === "real")
        return { ok: true, value: String(cell.value) };
      return { ok: false, reason: `not a number: ${describe(cell)}` };
    case "json":
    case "jsonb": {
      const text = cellText(cell);
      if (!text.ok || text.value === null) return text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.value);
      } catch {
        return { ok: false, reason: `invalid JSON: ${text.value.slice(0, 60)}` };
      }
      const refused = jsonStringProblem(parsed);
      return refused ? { ok: false, reason: refused } : text;
    }
    case "timestamptz":
    case "timestamp": {
      if (cell.kind !== "text") return { ok: false, reason: `not a timestamp: ${describe(cell)}` };
      const text = decodeText(cell.bytes);
      if (!text.ok || text.value === null) return text;
      const iso = timestampText(text.value);
      return iso === null
        ? { ok: false, reason: `invalid timestamp: ${text.value.slice(0, 60)}` }
        : { ok: true, value: iso };
    }
    case "bytea":
      if (cell.kind === "blob" || cell.kind === "text")
        return { ok: true, value: `\\x${hex(cell.bytes)}` };
      return { ok: false, reason: `not bytes: ${describe(cell)}` };
    case "text":
    case "varchar":
    case "bpchar":
      return cellText(cell);
    default:
      return { ok: false, reason: `no conversion to Postgres type ${column.type}` };
  }
}

function describe(cell: CopyCell): string {
  switch (cell.kind) {
    case "integer":
    case "real":
      return `${cell.kind} ${cell.value}`;
    case "text": {
      const text = decodeText(cell.bytes);
      return `text ${text.ok ? JSON.stringify(text.value?.slice(0, 40)) : "(invalid UTF-8)"}`;
    }
    case "blob":
      return `blob of ${cell.bytes.length} bytes`;
    default:
      return cell.kind;
  }
}

// ---------------------------------------------------------------------------
// Checksums (D11 step 8): the same normal form from the converted source text
// and from the text Postgres returns.

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeValue(typname: string, value: string | null): string | null {
  if (value === null) return null;
  switch (typname) {
    case "bool":
      return value === "true" || value === "t" ? "t" : "f";
    case "int2":
    case "int4":
    case "int8":
      return BigInt(value).toString();
    case "float4":
      return String(Math.fround(Number(value)));
    case "float8":
    case "numeric":
      return String(Number(value));
    case "json":
    case "jsonb":
      return canonicalJson(JSON.parse(value));
    case "timestamptz":
    case "timestamp":
      // Source: an ISO instant. Target: epoch milliseconds as text (see targetExpression).
      return /^-?\d+$/.test(value) ? value : String(Date.parse(value));
    case "bytea":
      return value.replace(/^\\x/, "").toLowerCase();
    default:
      return value;
  }
}

/** The SELECT expression whose text `normalizeValue` reads on the target side. */
function targetExpression(column: TargetColumn): string {
  const col = quote(column.name);
  switch (column.typname) {
    case "timestamptz":
    case "timestamp":
      return `floor(extract(epoch from ${col}) * 1000)::bigint::text`;
    case "bytea":
      return `encode(${col}, 'hex')`;
    default:
      return `${col}::text`;
  }
}

/**
 * Order-free checksum of a table in constant memory: the SHA-256 of each row,
 * added lane by lane (eight 32-bit sums). Two tables compare equal when they
 * hold the same rows, each the same number of times, in any order. A table of
 * 10 million rows needs no list of row hashes and no sort.
 */
class TableChecksum {
  private readonly lanes = new Uint32Array(8);
  private rows = 0;
  add(values: (string | null)[]): void {
    const hash = createHash("sha256").update(JSON.stringify(values)).digest();
    for (let lane = 0; lane < 8; lane++) {
      this.lanes[lane] = ((this.lanes[lane] as number) + hash.readUInt32BE(lane * 4)) >>> 0;
    }
    this.rows++;
  }
  get count(): number {
    return this.rows;
  }
  digest(): string {
    return Array.from(this.lanes, (lane) => lane.toString(16).padStart(8, "0")).join("");
  }
}

/**
 * Migrations the copy runs again after it writes the rows (`after-copy.json` in the
 * chain directory). The chain runs on the empty target before the copy, so a
 * migration that rewrites seeded rows into Postgres SQL (the starter dashboard,
 * 370) is overwritten by the SQLite rows; the API on the copy then skips it,
 * because `_migrations` records it. Each listed file must be safe to run twice.
 */
/**
 * The format of the copy metadata (`after-copy.json`, `metric-query-ports.json`)
 * this code reads. A migration directory from another build can hold the same SQL
 * with older metadata, which asks for other rewrites (an older `after-copy.json`
 * reapplied the whole starter dashboard over operator edits). Such a directory is
 * refused before the target is touched.
 */
const COPY_METADATA_FORMAT = 2;

function copyMetadataProblem(migrationsDir: string): string | null {
  for (const name of ["after-copy.json", "metric-query-ports.json"]) {
    const file = join(migrationsDir, name);
    if (!existsSync(file)) continue;
    let format: unknown;
    try {
      format = (JSON.parse(readFileSync(file, "utf8")) as { format?: unknown }).format;
    } catch (error) {
      return `${file} is not valid JSON: ${(error instanceof Error ? error.message : String(error))}`;
    }
    if (format !== COPY_METADATA_FORMAT) {
      return (
        `${file} has copy metadata format ${JSON.stringify(format ?? null)}, this build reads ${COPY_METADATA_FORMAT}: ` +
        "the migration directory comes from another build. Use the chain bundled with this CLI (unset MIGRATIONS_DIR / POSTGRES_MIGRATIONS_DIR), then copy again. Nothing was written."
      );
    }
  }
  return null;
}

function reapplyAfterCopy(
  chain: ReturnType<typeof loadPostgresMigrations>,
  migrationsDir: string,
): ReturnType<typeof loadPostgresMigrations> {
  const file = join(migrationsDir, "after-copy.json");
  if (!existsSync(file)) return [];
  const names = (JSON.parse(readFileSync(file, "utf8")) as { reapply?: string[] }).reapply ?? [];
  return names.map((name) => {
    const migration = chain.find((m) => m.name === name);
    if (!migration) throw new Error(`after-copy.json names ${name}, which is not in the chain`);
    return migration;
  });
}

// ---------------------------------------------------------------------------
// Saved metric queries

type MetricQuery = { sql: string; params?: unknown[] };
type MetricQueryPort = { sqlite: MetricQuery; postgres: MetricQuery };

function sameQuery(a: MetricQuery, b: MetricQuery): boolean {
  return a.sql === b.sql && JSON.stringify(a.params ?? []) === JSON.stringify(b.params ?? []);
}

type PendingPlan = { where: string; row: string; query: MetricQuery };

// The relative ranges `{{key:since}}` accepts (src/http/metrics.ts).
const SINCE_TOKEN_RE = /^\{\{([a-zA-Z][a-zA-Z0-9_]*):since\}\}$/;
const SINCE_RANGE_RE = /^\s*([+-]?\d+)\s+(second|minute|hour|day|month|year)s?\s*$/i;

/** The create_metric rule for saved SQL: one statement, starting with SELECT or WITH. */
function metricQueryProblem(sql: string): string | null {
  const text = sql.trim().replace(/;\s*$/, "");
  // A semicolon outside a string literal, quoted identifier or comment ends a statement.
  const bare = text
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (bare.includes(";")) return "more than one statement";
  if (!/^(select|with)\s/i.test(bare.trim()))
    return "a metric query must start with SELECT or WITH";
  return null;
}

/**
 * Plan a saved query in a READ ONLY transaction on its own session, then roll
 * back. The query sits inside a subquery with a bound parameter, so the server
 * parses exactly one statement (the extended protocol refuses several).
 * Returns the error text, or null when Postgres can plan it.
 */
async function planReadOnly(url: string, query: MetricQuery): Promise<string | null> {
  const params = (query.params ?? []).map(() => null);
  const text = query.sql.trim().replace(/;\s*$/, "");
  const planner = new Bun.SQL({ url, max: 1 });
  try {
    const conn = (await planner.reserve()) as unknown as Conn;
    try {
      await conn.unsafe("BEGIN TRANSACTION READ ONLY");
      try {
        await conn.unsafe("SET LOCAL statement_timeout = '5s'");
        await conn.unsafe(
          `EXPLAIN SELECT * FROM (\n${text}\n) AS saved_metric_query WHERE $${params.length + 1}::int IS NULL`,
          [...params, null],
        );
        return null;
      } catch (error) {
        return (error instanceof Error ? error.message : String(error));
      } finally {
        await conn.unsafe("ROLLBACK").catch(() => {});
      }
    } finally {
      conn.release();
    }
  } finally {
    await planner.close();
  }
}

/**
 * Rewrites the saved metric queries the chain knows (`metric-query-ports.json`:
 * the starter dashboard and the previous new-dashboard template) from SQLite to
 * Postgres, one query at a time, so titles, layout and edited queries stay as
 * the operator saved them. Every other query that does not run on Postgres is
 * reported in `attention`. Returns the number of metrics rows rewritten.
 */
async function portMetricQueries(
  conn: Conn,
  migrationsDir: string,
  report: CopyReport,
  toPlan: PendingPlan[],
): Promise<number> {
  const file = join(migrationsDir, "metric-query-ports.json");
  const ports = existsSync(file)
    ? ((JSON.parse(readFileSync(file, "utf8")) as { ports?: MetricQueryPort[] }).ports ?? [])
    : [];
  const rows = await conn.unsafe(
    `SELECT id, "agentId", slug, definition::text AS definition FROM metrics ORDER BY "_rowid"`,
  );
  let rewritten = 0;
  for (const row of rows) {
    const label = `${String(row.slug)} (agent ${String(row.agentId)})`;
    let definition: {
      widgets?: { id?: string; query?: MetricQuery }[];
      variables?: {
        key?: string;
        defaultValue?: unknown;
        options?: { value?: unknown }[];
        optionsQuery?: MetricQuery;
      }[];
    };
    try {
      definition = JSON.parse(String(row.definition));
    } catch {
      continue;
    }
    const queries: { where: string; query: MetricQuery; set(port: MetricQuery): void }[] = [];
    for (const widget of definition.widgets ?? []) {
      if (!widget.query?.sql) continue;
      const target = widget.query;
      queries.push({
        where: `widget ${widget.id ?? "?"}`,
        query: target,
        set: (port) => {
          target.sql = port.sql;
          target.params = port.params ?? [];
        },
      });
    }
    for (const variable of definition.variables ?? []) {
      if (!variable.optionsQuery?.sql) continue;
      const target = variable.optionsQuery;
      queries.push({
        where: `variable ${variable.key ?? "?"} options`,
        query: { sql: target.sql },
        set: (port) => {
          target.sql = port.sql;
        },
      });
    }
    let changed = false;
    const attention = (where: string, reason: string) => {
      report.attention ??= [];
      report.attention.push({ table: "metrics", column: where, row: label, reason });
    };
    for (const entry of queries) {
      const port = ports.find((p) => sameQuery(p.sqlite, entry.query));
      if (port) {
        entry.set(port.postgres);
        changed = true;
        // A port that binds `{{key:since}}` takes only relative ranges: name a
        // saved value the API would refuse after the move.
        for (const param of port.postgres.params ?? []) {
          const key = SINCE_TOKEN_RE.exec(String(param))?.[1];
          const variable = definition.variables?.find((v) => v.key === key);
          if (!key || !variable) continue;
          const values = [variable.defaultValue, ...(variable.options ?? []).map((o) => o.value)];
          for (const value of values) {
            if (value === undefined || value === null || SINCE_RANGE_RE.test(String(value)))
              continue;
            attention(
              `${entry.where}, variable ${key}`,
              `saved range ${JSON.stringify(value)} is not a relative range such as "-30 days"; the dashboard refuses it on Postgres, edit the option`,
            );
          }
        }
        continue;
      }
      // Not a known query: the same rule as create_metric (one SELECT or WITH),
      // then, after COMMIT, a plan on a separate read-only session. The copy
      // session owns the database and never runs saved SQL.
      const problem = metricQueryProblem(entry.query.sql);
      if (problem) {
        attention(entry.where, `does not run on Postgres, edit it: ${problem}`);
        continue;
      }
      toPlan.push({ where: entry.where, row: label, query: { ...entry.query } });
    }
    if (changed) {
      await conn.unsafe("UPDATE metrics SET definition = $1::text::jsonb WHERE id = $2", [
        JSON.stringify(definition),
        row.id,
      ]);
      rewritten += 1;
    }
  }
  return rewritten;
}

// ---------------------------------------------------------------------------

function float32Vector(bytes: Uint8Array): string {
  const floats = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return `[${Array.from(floats).join(",")}]`;
}

export async function copyIntoPostgres(
  source: CopySource,
  options: PostgresCopyOptions,
): Promise<CopyReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  // Every location stays in the report; the CLI prints only the first ones.
  const maxProblems = options.maxProblems ?? Number.POSITIVE_INFINITY;
  const report: CopyReport = {
    ok: false,
    problems: [],
    problemCount: 0,
    tables: [],
    skipped: source.skippedTables(),
    rebuilt: [],
  };
  const problem = (p: CopyProblem) => {
    report.problemCount++;
    if (report.problems.length < maxProblems) report.problems.push(p);
  };

  // Hold the one-process lock (D16) on the session that writes the copy: if that
  // session ends, its open transaction ends with it, so no write can commit after
  // another process took the lock.
  const pool = new Bun.SQL({ url: options.url, max: 1, idleTimeout: 0, maxLifetime: 0 });
  try {
    let conn: Conn;
    try {
      conn = (await pool.reserve()) as unknown as Conn;
    } catch (error) {
      report.error = `cannot connect to the target database: ${(error instanceof Error ? error.message : String(error))}`;
      return report;
    }
    try {
      const got = await conn.unsafe("SELECT pg_try_advisory_lock($1) AS locked", [
        PROCESS_LOCK_KEY,
      ]);
      if (got[0]?.locked !== true) {
        report.error =
          "an API process holds the target database: another session holds the one-process lock";
        return report;
      }
      const metadataProblem = copyMetadataProblem(options.migrationsDir);
      if (metadataProblem) {
        report.error = metadataProblem;
        return report;
      }
      const chain = loadPostgresMigrations(options.migrationsDir);
      const chainHead = chain.at(-1)?.version ?? null;
      const sourceHead = source.migrationHead();
      const headError = (targetHead: number | null) =>
        `migration heads differ: source ${sourceHead}, target ${targetHead}, this build ${chainHead}. ` +
        "Start the API of this build on the SQLite file once (it applies the chain), stop it, then copy.";
      // Inspect the target before the chain touches it: a refusal must leave its
      // schema and rows as they were.
      const before = await inspectTarget(conn, chainHead, true);
      if (before.error) {
        report.error = before.error;
        return report;
      }
      if (sourceHead !== chainHead) {
        report.error = headError(before.head);
        return report;
      }
      // The chain runs inside the copy transaction: a refusal at any later step
      // rolls the schema back too, so the target stays empty for a re-run.
      const toPlan: PendingPlan[] = [];
      await conn.unsafe("BEGIN");
      let committed = false;
      try {
        // The target has no table: the chain writes the schema and its seed rows.
        await runPostgresMigrations(onConnection(conn), {
          migrationsDir: options.migrationsDir,
          log: (line) => log(line),
          inCallerTransaction: true,
        });
        const after = await inspectTarget(conn, chainHead, false);
        if (after.error) {
          report.error = after.error;
          return report;
        }
        if (after.head !== chainHead) {
          report.error = headError(after.head);
          return report;
        }
        const targets = await readTargetTables(conn);
        const seeded = chainSeededTables(options.migrationsDir);

        const sourceTables = source.tables();
        const sourceNames = new Set(sourceTables.map((t) => t.name));
        const rebuiltTables = new Set(["memory_vec"]);
        const missing = sourceTables.filter((t) => !targets.has(t.name)).map((t) => t.name);
        const extra = [...targets.keys()].filter(
          (name) => name !== "_migrations" && !sourceNames.has(name) && !rebuiltTables.has(name),
        );
        if (missing.length > 0 || extra.length > 0) {
          report.error = `the schemas differ: only in SQLite [${missing.join(", ")}], only in Postgres [${extra.join(", ")}]`;
          return report;
        }

        // The width SQLite searches with today decides the rebuilt index, not the
        // widths of every stored embedding (an old model can leave other widths).
        const sourceIndex = source.vectorIndex?.() ?? null;
        if (
          targets.has("memory_vec") &&
          sourceIndex?.dimensions &&
          sourceIndex.dimensions !== options.embeddingDimensions
        ) {
          report.error =
            `the SQLite vector index has ${sourceIndex.dimensions} dimensions, ` +
            `but this copy indexes ${options.embeddingDimensions}. ` +
            `Set EMBEDDING_DIMENSIONS=${sourceIndex.dimensions} (the value the API uses), then copy again. Nothing was written.`;
          return report;
        }
        await conn.unsafe("SET CONSTRAINTS ALL DEFERRED");
        for (const table of targets.values()) {
          if (table.hasUserTriggers)
            await conn.unsafe(`ALTER TABLE ${quote(table.name)} DISABLE TRIGGER USER`);
        }
        for (const name of seeded) {
          if (targets.has(name)) await conn.unsafe(`DELETE FROM ${quote(name)}`);
        }
        const vectorTable = targets.has("memory_vec");
        if (vectorTable) await conn.unsafe("DELETE FROM memory_vec");

        // Orphan rows first: Postgres would refuse them at the end of the copy and
        // name only the first one. The source lists every one in seconds.
        for (const orphan of source.foreignKeyViolations?.() ?? []) {
          problem({
            table: orphan.table,
            column: orphan.columns.join(", "),
            row: orphan.row,
            reason: `orphan row: no row in ${orphan.parent} for this foreign key`,
          });
        }
        if (report.problemCount > 0)
          log(`[db-copy] ${report.problemCount} orphan row(s) in the source: checking values only`);

        const checksums = new Map<string, TableChecksum>();
        let vectors = 0;
        // Once one value is refused the copy cannot commit: the rest of the run
        // only checks values, which lists every problem in a fraction of the time.
        const writing = () => report.problemCount === 0;
        for (const table of sourceTables) {
          const target = targets.get(table.name) as TargetTable;
          const sum = await copyTable(conn, source, table, target, options, problem, log, writing);
          checksums.set(table.name, sum.checksum);
          if (table.name === "agent_memory" && vectorTable && writing()) {
            const widths = embeddingWidths(sum.embeddings);
            if (sum.embeddings.length > 0 && !widths.has(options.embeddingDimensions)) {
              report.error =
                `the source embeddings have ${[...widths.keys()].join(", ")} dimensions, ` +
                `but this copy indexes ${options.embeddingDimensions}: no vector would be built. ` +
                `Set EMBEDDING_DIMENSIONS=${[...widths.keys()][0]} (the value the API uses), then copy again. Nothing was written.`;
              await conn.unsafe("ROLLBACK");
              return report;
            }
            vectors = await insertVectors(conn, sum.embeddings, options.embeddingDimensions);
            // Every memory the source index searches must stay searchable.
            const indexed = sourceIndex?.ids;
            if (indexed && indexed.length > 0) {
              const rebuilt = new Set(
                sum.embeddings
                  .filter(([, bytes]) => bytes.byteLength === options.embeddingDimensions * 4)
                  .map(([id]) => id),
              );
              const lost = indexed.filter((id) => !rebuilt.has(id));
              if (lost.length > 0) {
                report.error =
                  `${lost.length} memory(ies) in the SQLite vector index would not be searchable on Postgres ` +
                  `(${lost.slice(0, 5).join(", ")}): their embeddings are not ${options.embeddingDimensions}-dimensional. Nothing was written.`;
                await conn.unsafe("ROLLBACK");
                return report;
              }
            }
          }
        }
        if (report.problemCount > 0) {
          report.error = `${report.problemCount} value(s) cannot be stored in Postgres; nothing was written`;
          await conn.unsafe("ROLLBACK");
          return report;
        }
        if (vectorTable) {
          report.rebuilt.push({
            table: "memory_vec",
            rows: vectors,
            reason: `vectors of the agent_memory embeddings with ${options.embeddingDimensions} dimensions`,
          });
        }

        // Run the deferred foreign key checks now: a violation fails here, and
        // ALTER TABLE refuses a table with pending trigger events.
        await conn.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
        // A SQLite AUTOINCREMENT key never goes below its high-water mark, even
        // after the newest rows were deleted: carry the counter to the key column.
        const counters = source.autoincrementCounters?.() ?? {};
        for (const table of targets.values()) {
          const identity = table.columns.filter((c) => c.identity);
          const keyColumn =
            identity.find((c) => c.name !== TABLE_ORDER_KEY) ?? identity[0] ?? undefined;
          for (const column of identity) {
            const counter = column === keyColumn ? BigInt(counters[table.name] ?? 0) : 0n;
            // ALTER SEQUENCE ... RESTART is transactional, unlike setval: a late
            // ROLLBACK of the copy leaves the target's sequence where it was.
            // numeric: MAX + 1 at the bigint maximum would overflow.
            const next = await conn.unsafe(
              `SELECT pg_get_serial_sequence(${quoteLiteral(quote(table.name))}, ${quoteLiteral(column.name)}) AS seq,
                      (GREATEST(COALESCE(MAX(${quote(column.name)}), 0), ${counter}::bigint)::numeric + 1)::text AS next
                 FROM ${quote(table.name)}`,
            );
            const seq = next[0]?.seq as string | null;
            if (seq) {
              const [limit] = await conn.unsafe(
                "SELECT seqmax::text AS max FROM pg_sequence WHERE seqrelid = $1::regclass",
                [seq],
              );
              const max = BigInt(String(limit?.max));
              const wanted = BigInt(String(next[0]?.next));
              if (wanted <= max) {
                await conn.unsafe(`ALTER SEQUENCE ${seq} RESTART WITH ${wanted}`);
              } else {
                // Exhausted, as in SQLite: hand out the last value inside the copy
                // transaction, so the next insert fails with "reached maximum value".
                // RESTART gives the sequence new storage, so a ROLLBACK undoes both.
                await conn.unsafe(`ALTER SEQUENCE ${seq} RESTART WITH ${max}`);
                await conn.unsafe("SELECT nextval($1::regclass)", [seq]);
              }
            }
          }
          if (table.hasUserTriggers)
            await conn.unsafe(`ALTER TABLE ${quote(table.name)} ENABLE TRIGGER USER`);
        }
        // Compare in the copy transaction, before the engine-native rows below
        // replace copied ones on purpose.
        for (const table of sourceTables) {
          const target = targets.get(table.name) as TargetTable;
          const sourceSum = checksums.get(table.name) as TableChecksum;
          const targetSum = await targetChecksum(
            conn,
            target,
            table,
            options.batchBytes ?? DEFAULT_BATCH_BYTES,
          );
          const entry: CopyTableReport = {
            table: table.name,
            sourceRows: sourceSum.count,
            targetRows: targetSum.count,
            sourceChecksum: sourceSum.digest(),
            targetChecksum: targetSum.digest(),
            equal: false,
          };
          entry.equal =
            entry.sourceRows === entry.targetRows && entry.sourceChecksum === entry.targetChecksum;
          report.tables.push(entry);
        }
        // A difference rolls the copy back: a committed mismatch would leave
        // rows that make every later run refuse a non-empty target.
        if (!report.tables.every((t) => t.equal)) {
          report.error = "a row count or checksum differs (see tables); nothing was written";
          await conn.unsafe("ROLLBACK");
          return report;
        }
        // The SQLite migrations older than this chain stay in the history:
        // queries read their applied_at (the session cost credential fallback
        // reads migration 307's). The runner ignores versions outside its chain.
        const chainStart = chain[0]?.version ?? Number.POSITIVE_INFINITY;
        for (const m of source.migrationHistory().filter((h) => h.version < chainStart)) {
          await conn.unsafe(
            "INSERT INTO _migrations (version, name, applied_at, checksum) VALUES ($1, $2, $3::timestamptz, $4)",
            [m.version, m.name, m.appliedAt, m.checksum],
          );
        }
        const ported = targets.has("metrics")
          ? await portMetricQueries(conn, options.migrationsDir, report, toPlan)
          : 0;
        if (ported > 0) {
          report.rebuilt.push({
            table: "metrics",
            rows: ported,
            reason: "stock SQLite widget and options queries rewritten to their Postgres form",
          });
        }
        for (const migration of reapplyAfterCopy(chain, options.migrationsDir)) {
          const result = (await conn.unsafe(migration.sql)) as { count?: number };
          log(`[db-copy] reapplied ${migration.name}`);
          report.rebuilt.push({
            table: migration.name,
            rows: Number(result.count ?? 0),
            reason: "Postgres rows of this migration restored over the copied SQLite rows",
          });
        }
        // Ownership and writes share this session; still check that it holds the
        // lock before the copy becomes visible.
        const held = await conn.unsafe(
          `SELECT EXISTS (SELECT 1 FROM pg_locks
                           WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                             AND ((classid::bigint << 32) | objid::bigint) = $1) AS held`,
          [PROCESS_LOCK_KEY],
        );
        if (held[0]?.held !== true) {
          report.error = "the copy session lost the one-process lock; nothing was written";
          await conn.unsafe("ROLLBACK");
          return report;
        }
        await conn.unsafe("COMMIT");
        committed = true;
        report.ok = true;
        // A bulk load leaves the planner with no statistics and the tables with no
        // visibility map, so the API would start on default plans. VACUUM cannot run
        // in the copy transaction. A failure here leaves the copy committed.
        try {
          log("[db-copy] gathering planner statistics (VACUUM ANALYZE)");
          await conn.unsafe("VACUUM (ANALYZE)");
        } catch (error) {
          report.warnings ??= [];
          report.warnings.push(
            `planner statistics were not gathered (${error instanceof Error ? error.message : String(error)}). ` +
              "The copy is committed. Run VACUUM (ANALYZE) on the target database before you start the API.",
          );
        }
        // After COMMIT: the copy's table locks are gone, and a saved query runs
        // only on a read-only session that does not own the database.
        for (const pending of toPlan) {
          let planned: string | null;
          try {
            planned = await planReadOnly(options.url, pending.query);
          } catch (error) {
            // The data is committed: report this query as unverified, not the copy as failed.
            report.unchecked ??= [];
            report.unchecked.push({
              table: "metrics",
              column: pending.where,
              row: pending.row,
              reason: `could not be checked on Postgres: ${(error instanceof Error ? error.message : String(error))}`,
            });
            continue;
          }
          if (planned) {
            report.attention ??= [];
            report.attention.push({
              table: "metrics",
              column: pending.where,
              row: pending.row,
              reason: `does not run on Postgres, edit it: ${planned}`,
            });
          }
        }
        return report;
      } catch (error) {
        if (!committed) await conn.unsafe("ROLLBACK").catch(() => {});
        report.error = `copy failed${committed ? " after commit" : ", nothing was written"}: ${(error instanceof Error ? error.message : String(error))}`;
        return report;
      } finally {
        // An early refusal returns without COMMIT: undo the chain and every write.
        if (!committed) await conn.unsafe("ROLLBACK").catch(() => {});
      }
    } catch (error) {
      // A failure before the copy transaction (target inspection):
      // it still goes into the report, so --json is written.
      report.error = `the copy did not start, no row was copied: ${(error instanceof Error ? error.message : String(error))}`;
      return report;
    } finally {
      await conn.unsafe("SELECT pg_advisory_unlock($1)", [PROCESS_LOCK_KEY]).catch(() => {});
      conn.release();
    }
  } finally {
    await pool.close();
  }
}

/** Source column order mapped onto the target, plus `_rowid` when the target has it. */
function insertColumns(table: CopyTable, target: TargetTable) {
  const byName = new Map(target.columns.map((c) => [c.name, c]));
  const columns = table.columns.map((c) => {
    const column = byName.get(c.name);
    if (!column) throw new Error(`column ${table.name}.${c.name} is missing in Postgres`);
    if (column.generated)
      throw new Error(`column ${table.name}.${c.name} is generated in Postgres`);
    return column;
  });
  const rowid = byName.get(TABLE_ORDER_KEY);
  const missing = target.columns.filter(
    (c) =>
      !c.generated && c.name !== TABLE_ORDER_KEY && !table.columns.some((s) => s.name === c.name),
  );
  if (missing.length > 0) {
    throw new Error(
      `columns ${missing.map((c) => `${table.name}.${c.name}`).join(", ")} exist only in Postgres`,
    );
  }
  return { columns, rowid: table.hasRowid && rowid ? rowid : undefined };
}

async function copyTable(
  conn: Conn,
  source: CopySource,
  table: CopyTable,
  target: TargetTable,
  options: PostgresCopyOptions,
  problem: (p: CopyProblem) => void,
  log: (line: string) => void,
  writing: () => boolean = () => true,
): Promise<{ checksum: TableChecksum; embeddings: [string, Uint8Array][] }> {
  const { columns, rowid } = insertColumns(table, target);
  const all = rowid ? [rowid, ...columns] : columns;
  const perRow = all.length;
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? 500, Math.floor(MAX_PARAMS / perRow)),
  );
  const columnList = all.map((c) => quote(c.name)).join(", ");
  const checksum = new TableChecksum();
  const embeddings: [string, Uint8Array][] = [];
  const idIndex = table.columns.findIndex((c) => c.name === "id");
  const embeddingIndex = table.columns.findIndex((c) => c.name === "embedding");
  let failed = false;
  let copied = 0;

  for (const batch of source.rows(table, batchSize, options.batchBytes ?? DEFAULT_BATCH_BYTES)) {
    const params: (string | null)[] = [];
    for (const row of batch) {
      const values: (string | null)[] = rowid
        ? [row.rowid === null ? null : row.rowid.toString()]
        : [];
      for (let i = 0; i < columns.length; i++) {
        const column = columns[i] as TargetColumn;
        const converted = convertCell(row.cells[i] as CopyCell, column);
        if (!converted.ok) {
          failed = true;
          problem({
            table: table.name,
            column: column.name,
            row: row.label,
            reason: converted.reason,
          });
          values.push(null);
        } else {
          values.push(converted.value);
        }
      }
      if (failed || !writing()) continue;
      checksum.add(values.map((v, i) => normalizeValue((all[i] as TargetColumn).typname, v)));
      params.push(...values);
      if (table.name === "agent_memory" && idIndex >= 0 && embeddingIndex >= 0) {
        const id = row.cells[idIndex];
        const embedding = row.cells[embeddingIndex];
        if (id?.kind === "text" && embedding?.kind === "blob")
          embeddings.push([new TextDecoder().decode(id.bytes), embedding.bytes]);
      }
    }
    if (failed || !writing()) {
      // No statement to wait for: yield, so the collector can free this batch.
      await new Promise<void>((resolve) => setImmediate(resolve));
      continue;
    }
    const rows = params.length / perRow;
    const tuples: string[] = [];
    for (let r = 0; r < rows; r++) {
      // Through text: Bun.SQL sends a string bound straight to jsonb as a JSON string.
      tuples.push(`(${all.map((c, i) => `$${r * perRow + i + 1}::text::${c.type}`).join(", ")})`);
    }
    await conn.unsafe(
      `INSERT INTO ${quote(table.name)} (${columnList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(", ")}`,
      params,
    );
    copied += rows;
  }
  log(
    `[db-copy] ${table.name}: ${failed ? "values refused" : writing() ? `${copied} rows` : "checked, not written"}`,
  );
  return { checksum, embeddings };
}

/** Embedding widths (floats) found in the source, with how many embeddings have each. */
function embeddingWidths(embeddings: [string, Uint8Array][]): Map<number, number> {
  const widths = new Map<number, number>();
  for (const [, bytes] of embeddings) {
    const width = bytes.byteLength / 4;
    widths.set(width, (widths.get(width) ?? 0) + 1);
  }
  return widths;
}

async function insertVectors(
  conn: Conn,
  embeddings: [string, Uint8Array][],
  dimensions: number,
): Promise<number> {
  const valid = embeddings.filter(([, bytes]) => bytes.byteLength === dimensions * 4);
  for (let start = 0; start < valid.length; start += 500) {
    const batch = valid.slice(start, start + 500);
    const params = batch.flatMap(([id, bytes]) => [id, float32Vector(bytes)]);
    const tuples = batch.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::text::vector)`);
    await conn.unsafe(
      `INSERT INTO memory_vec (memory_id, embedding) VALUES ${tuples.join(", ")}`,
      params,
    );
  }
  return valid.length;
}

async function targetChecksum(
  conn: Conn,
  target: TargetTable,
  table: CopyTable,
  fetchBytes: number,
): Promise<TableChecksum> {
  const { columns, rowid } = insertColumns(table, target);
  const all = rowid ? [rowid, ...columns] : columns;
  const select = all.map((c, i) => `${targetExpression(c)} AS c${i}`).join(", ");
  const checksum = new TableChecksum();
  // A cursor reads the table once, in any order (the checksum is order-free). The
  // fetch size follows the bytes of the last fetch, so a table of multi-megabyte
  // rows is read a few rows at a time and a narrow table 5,000 rows at a time.
  await conn.unsafe(
    `DECLARE db_copy_checksum NO SCROLL CURSOR FOR SELECT ${select} FROM ${quote(target.name)}`,
  );
  try {
    // The first fetch is one row, so every later fetch is sized from rows this
    // cursor already returned. The size grows at most 8 times a step: one small row
    // at the start of a table of large rows cannot ask for 5,000 of them.
    let size = 1;
    for (;;) {
      const rows = await conn.unsafe(`FETCH FORWARD ${size} FROM db_copy_checksum`);
      let bytes = 0;
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
        }
        checksum.add(normalizeRow(all, row));
      }
      if (rows.length < size) return checksum;
      const perRow = Math.max(1, bytes / rows.length);
      size = Math.max(1, Math.min(5000, size * 8, Math.floor(fetchBytes / perRow)));
    }
  } finally {
    // After an error the transaction is aborted and CLOSE fails: the rollback ends the cursor.
    await conn.unsafe("CLOSE db_copy_checksum").catch(() => {});
  }
}

function normalizeRow(columns: TargetColumn[], row: Record<string, unknown>): (string | null)[] {
  return columns.map((c, i) => {
    const value = row[`c${i}`];
    return normalizeValue(c.typname, value === null || value === undefined ? null : String(value));
  });
}
