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
import { acquireProcessLock } from "./boot";
import { ROWID_COLUMN } from "./codec";
import { loadPostgresMigrations, runPostgresMigrations } from "./migrations";

/**
 * Copy a SQLite database into an empty Postgres database at the same migration
 * head (decision D11). One transaction: a refused value, a foreign key that
 * fails at COMMIT, or any other error leaves the target as it was.
 *
 * Steps (D11 numbering): the source is opened read-only by the caller (1); a
 * target with rows is refused (2); user triggers are off during the copy (3);
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
const TABLE_ORDER_KEY = ROWID_COLUMN;

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Tables the migration chain writes rows into: the only ones a fresh target may hold rows in. */
function chainSeededTables(migrationsDir: string): Set<string> {
  const seeded = new Set<string>();
  for (const migration of loadPostgresMigrations(migrationsDir)) {
    for (const match of migration.sql.matchAll(/INSERT\s+INTO\s+"?([A-Za-z0-9_]+)"?/gi)) {
      if (match[1]) seeded.add(match[1]);
    }
  }
  return seeded;
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

const utf8 = new TextDecoder("utf-8", { fatal: true });
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

function hasNulString(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(hasNulString);
  if (value && typeof value === "object")
    return Object.entries(value).some(([k, v]) => k.includes("\u0000") || hasNulString(v));
  return false;
}

/** SQLite timestamp text to an ISO instant; text with no zone is UTC, as SQLite reads it. */
function timestampText(text: string): string | null {
  const match = ISO_TIMESTAMP.exec(text.trim());
  if (!match) return null;
  const zone = match[3] ?? "Z";
  const time = match[2]?.length === 5 ? `${match[2]}:00` : match[2];
  const iso = `${match[1]}T${time}${zone}`;
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
      if (hasNulString(parsed)) return { ok: false, reason: "JSON holds a \\u0000 character" };
      return text;
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

class TableChecksum {
  private readonly hashes: string[] = [];
  add(values: (string | null)[]): void {
    this.hashes.push(createHash("sha1").update(JSON.stringify(values)).digest("hex"));
  }
  get count(): number {
    return this.hashes.length;
  }
  digest(): string {
    // Order-free: the sorted row hashes, so the engines need not agree on row order.
    return createHash("sha256").update(this.hashes.sort().join("\n")).digest("hex");
  }
}

/**
 * Migrations the copy runs again after it writes the rows (`after-copy.json` in the
 * chain directory). The chain runs on the empty target before the copy, so a
 * migration that rewrites seeded rows into Postgres SQL (the starter dashboard,
 * 370) is overwritten by the SQLite rows; the API on the copy then skips it,
 * because `_migrations` records it. Each listed file must be safe to run twice.
 */
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
  const maxProblems = options.maxProblems ?? 200;
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

  // Hold the one-process lock (D16): no API may run on the target during the copy.
  let lock: Awaited<ReturnType<typeof acquireProcessLock>>;
  try {
    lock = await acquireProcessLock(options.url, { waitMs: 0 });
  } catch (error) {
    report.error = `an API process holds the target database: ${(error as Error).message}`;
    return report;
  }
  const pool = new Bun.SQL({ url: options.url, max: 1 });
  try {
    // A database with no table gets the chain first; one at another head is refused.
    const chain = loadPostgresMigrations(options.migrationsDir);
    const chainHead = chain.at(-1)?.version ?? null;
    await runPostgresMigrations(pool as never, {
      migrationsDir: options.migrationsDir,
      log: (line) => log(line),
    });
    const conn = (await pool.reserve()) as unknown as Conn;
    try {
      const targetHeadRow = await conn.unsafe("SELECT MAX(version)::bigint AS v FROM _migrations");
      const targetHead = Number(targetHeadRow[0]?.v);
      const sourceHead = source.migrationHead();
      if (sourceHead !== chainHead || targetHead !== chainHead) {
        report.error =
          `migration heads differ: source ${sourceHead}, target ${targetHead}, this build ${chainHead}. ` +
          "Start the API of this build on the SQLite file once (it applies the chain), stop it, then copy.";
        return report;
      }

      const targets = await readTargetTables(conn);
      const seeded = chainSeededTables(options.migrationsDir);
      const occupied: string[] = [];
      for (const name of targets.keys()) {
        if (name === "_migrations" || seeded.has(name)) continue;
        const rows = await conn.unsafe(`SELECT EXISTS(SELECT 1 FROM ${quote(name)}) AS present`);
        if (rows[0]?.present === true) occupied.push(name);
      }
      if (occupied.length > 0) {
        report.error = `the target database holds rows (tables: ${occupied.slice(0, 10).join(", ")}). Copy into an empty database only.`;
        return report;
      }

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

      await conn.unsafe("BEGIN");
      let committed = false;
      try {
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

        const checksums = new Map<string, TableChecksum>();
        let vectors = 0;
        for (const table of sourceTables) {
          const target = targets.get(table.name) as TargetTable;
          const sum = await copyTable(conn, source, table, target, options, problem, log);
          checksums.set(table.name, sum.checksum);
          if (table.name === "agent_memory" && vectorTable) {
            vectors = await insertVectors(conn, sum.embeddings, options.embeddingDimensions);
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
        for (const table of targets.values()) {
          for (const column of table.columns.filter((c) => c.identity)) {
            await conn.unsafe(
              `SELECT setval(pg_get_serial_sequence(${quoteLiteral(quote(table.name))}, ${quoteLiteral(column.name)}),
                      COALESCE((SELECT MAX(${quote(column.name)}) FROM ${quote(table.name)}), 1),
                      (SELECT MAX(${quote(column.name)}) FROM ${quote(table.name)}) IS NOT NULL)`,
            );
          }
          if (table.hasUserTriggers)
            await conn.unsafe(`ALTER TABLE ${quote(table.name)} ENABLE TRIGGER USER`);
        }
        // Compare in the copy transaction, before the engine-native rows below
        // replace copied ones on purpose.
        for (const table of sourceTables) {
          const target = targets.get(table.name) as TargetTable;
          const sourceSum = checksums.get(table.name) as TableChecksum;
          const targetSum = await targetChecksum(conn, target, table);
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
        for (const migration of reapplyAfterCopy(chain, options.migrationsDir)) {
          const result = (await conn.unsafe(migration.sql)) as { count?: number };
          log(`[db-copy] reapplied ${migration.name}`);
          report.rebuilt.push({
            table: migration.name,
            rows: Number(result.count ?? 0),
            reason: "Postgres rows of this migration restored over the copied SQLite rows",
          });
        }
        await conn.unsafe("COMMIT");
        committed = true;
        report.ok = report.tables.every((t) => t.equal);
        if (!report.ok) report.error = "a row count or checksum differs (see tables)";
        return report;
      } catch (error) {
        if (!committed) await conn.unsafe("ROLLBACK").catch(() => {});
        report.error = `copy failed${committed ? " after commit" : ", nothing was written"}: ${(error as Error).message}`;
        return report;
      }
    } finally {
      conn.release();
    }
  } finally {
    await pool.close();
    await lock.release();
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

  for (const batch of source.rows(table, batchSize)) {
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
      if (failed) continue;
      checksum.add(values.map((v, i) => normalizeValue((all[i] as TargetColumn).typname, v)));
      params.push(...values);
      if (table.name === "agent_memory" && idIndex >= 0 && embeddingIndex >= 0) {
        const id = row.cells[idIndex];
        const embedding = row.cells[embeddingIndex];
        if (id?.kind === "text" && embedding?.kind === "blob")
          embeddings.push([new TextDecoder().decode(id.bytes), embedding.bytes]);
      }
    }
    if (failed) continue;
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
  log(`[db-copy] ${table.name}: ${failed ? "values refused" : `${copied} rows`}`);
  return { checksum, embeddings };
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
): Promise<TableChecksum> {
  const { columns, rowid } = insertColumns(table, target);
  const all = rowid ? [rowid, ...columns] : columns;
  const select = all.map((c, i) => `${targetExpression(c)} AS c${i}`).join(", ");
  const checksum = new TableChecksum();
  const key = target.columns.find((c) => c.name === TABLE_ORDER_KEY)
    ? TABLE_ORDER_KEY
    : target.columns.find((c) => c.identity)?.name;
  if (!key) {
    const rows = await conn.unsafe(`SELECT ${select} FROM ${quote(target.name)}`);
    for (const row of rows) checksum.add(normalizeRow(all, row));
    return checksum;
  }
  // Keyset pages over the insertion-order key keep memory flat on large tables.
  let after: string | null = null;
  for (;;) {
    const rows: Record<string, unknown>[] = await conn.unsafe(
      `SELECT ${select}, ${quote(key)}::text AS __key FROM ${quote(target.name)}
        ${after === null ? "" : `WHERE ${quote(key)} > $1::bigint`}
        ORDER BY ${quote(key)} LIMIT 5000`,
      after === null ? [] : [after],
    );
    for (const row of rows) checksum.add(normalizeRow(all, row));
    if (rows.length < 5000) return checksum;
    after = String(rows.at(-1)?.__key);
  }
}

function normalizeRow(columns: TargetColumn[], row: Record<string, unknown>): (string | null)[] {
  return columns.map((c, i) => {
    const value = row[`c${i}`];
    return normalizeValue(c.typname, value === null || value === undefined ? null : String(value));
  });
}
