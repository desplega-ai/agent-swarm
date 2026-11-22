#!/usr/bin/env bun
/**
 * Generates the Postgres baseline migration (decision D12) from the SQLite
 * head schema:
 *
 *   bun scripts/storage/generate-postgres-baseline.ts          # write
 *   bun scripts/storage/generate-postgres-baseline.ts --check  # exit 1 on drift
 *
 * Input: the SQLite chain in src/be/migrations/*.sql applied to an empty
 * in-memory database (plus the boot-created trg_users_default_role), the
 * column classification in src/be/migrations/postgres/column-types.json, and
 * the hand-written triggers in src/be/migrations/postgres/parts/triggers.sql.
 *
 * Output: src/be/migrations/postgres/<newest SQLite ordinal>_baseline.sql.
 * Deterministic: the same input gives the same bytes. Seeded values that come
 * from the clock or from randomblob() (they differ between two chain runs)
 * become the matching Postgres expression instead of a literal.
 *
 * Every default, CHECK and partial-index predicate goes through an explicit
 * rule in pg-translate.ts; one without a rule fails the run with its
 * table.column. The FTS5 virtual tables and their shadow tables are left out:
 * full-text search on Postgres is milestone M4.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ColumnContext,
  PG_EPOCH_MS_NOW,
  PG_NOW_TEXT,
  PG_RANDOM_HEX32,
  qi,
  ql,
  translateDefault,
  translateExpr,
} from "./pg-translate";
import {
  type ColumnTypes,
  extractCheckSourceTexts,
  HEX32,
  type HeadSchema,
  type HeadTable,
  ISO_MS_Z,
  loadColumnTypes,
  type PgClass,
  POSTGRES_MIGRATIONS_DIR,
  pgClassOf,
  pgTypeName,
  ROWID_COLUMN,
  readSeedsWithVolatility,
  rowidIndexName,
  type SeedTable,
  type SeedValue,
  SPACE_TS,
  SQLITE_MIGRATIONS_DIR,
  TRIGGERS_PART_PATH,
} from "./sqlite-head";

/** Postgres truncates identifiers to 63 bytes; two long names could then collide. */
const PG_MAX_IDENT = 63;

export function baselineOrdinal(): string {
  // Once written, the baseline keeps its ordinal: later migrations come as pairs
  // (D12), so the baseline is never renumbered to the SQLite tail.
  const existing = readdirSync(POSTGRES_MIGRATIONS_DIR).find((f) => /^\d+_baseline\.sql$/.test(f));
  if (existing) return existing.split("_")[0] as string;
  const files = readdirSync(SQLITE_MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const last = files[files.length - 1];
  if (!last) throw new Error("no SQLite migrations found");
  return last.split("_")[0] as string;
}

/** SQLite's failure text of each named Postgres CHECK constraint (read by the error mapper). */
export function checkMessagesPath(): string {
  return join(POSTGRES_MIGRATIONS_DIR, "check-messages.json");
}

/** Postgres name of the i-th (0-based) CHECK constraint of a table. */
export function checkConstraintName(table: string, i: number): string {
  const name = `${table}_check_${i + 1}`;
  if (name.length > 63) throw new Error(`CHECK constraint name over 63 bytes: ${name}`);
  return name;
}

/**
 * The SQLite failure text of every baseline CHECK: SQLite reports
 * `CHECK constraint failed: <expression as written>`; Postgres reports the
 * constraint name. The Postgres error mapper turns one into the other, so API
 * error bodies match on both engines.
 */
export function checkMessages(schema: HeadSchema): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of schema.tables) {
    const texts = extractCheckSourceTexts(t.sql);
    if (texts.length !== t.checks.length) {
      throw new Error(
        `${t.name}: ${texts.length} CHECK source texts for ${t.checks.length} checks`,
      );
    }
    texts.forEach((text, i) => {
      out[checkConstraintName(t.name, i)] = text;
    });
  }
  return out;
}

export function baselinePath(): string {
  return join(POSTGRES_MIGRATIONS_DIR, `${baselineOrdinal()}_baseline.sql`);
}

export function tableContext(types: ColumnTypes, table: HeadTable): ColumnContext {
  const ctx: ColumnContext = new Map();
  for (const c of table.columns) ctx.set(c.name, pgClassOf(types, table.name, c.name, c.declared));
  return ctx;
}

function checkIdent(name: string, what: string): void {
  if (Buffer.byteLength(name) > PG_MAX_IDENT) {
    throw new Error(`${what} name ${name} is longer than ${PG_MAX_IDENT} bytes`);
  }
}

function fkAction(action: string, where: string): string | null {
  switch (action.toUpperCase()) {
    case "NO ACTION":
      return null;
    case "CASCADE":
    case "SET NULL":
    case "SET DEFAULT":
    case "RESTRICT":
      return action.toUpperCase();
    default:
      throw new Error(`${where}: foreign key action ${action}`);
  }
}

function emitTable(types: ColumnTypes, t: HeadTable): string {
  checkIdent(t.name, "table");
  const ctx = tableContext(types, t);
  const lines: string[] = [];
  for (const c of t.columns) {
    checkIdent(c.name, "column");
    const where = `${t.name}.${c.name}`;
    const { cls } = pgClassOf(types, t.name, c.name, c.declared);
    if (t.rowidAlias === c.name) {
      if (cls !== "bigint") throw new Error(`${where}: rowid alias classified ${cls}`);
      lines.push(`  ${qi(c.name)} bigint GENERATED BY DEFAULT AS IDENTITY`);
      continue;
    }
    let line = `  ${qi(c.name)} ${pgTypeName(cls)}`;
    if (c.notNull) line += " NOT NULL";
    const dflt = translateDefault(c.dflt, cls, where);
    if (dflt !== null) line += ` DEFAULT ${dflt}`;
    lines.push(line);
  }
  if (t.surrogateRowid) {
    if (t.columns.some((c) => c.name === ROWID_COLUMN)) {
      throw new Error(`${t.name} already has a column named ${ROWID_COLUMN}`);
    }
    // SQLite's implicit rowid: code orders by it and the API exposes it.
    lines.push(`  ${qi(ROWID_COLUMN)} bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL`);
  }
  const pk = t.columns.filter((c) => c.pkOrder > 0).sort((a, b) => a.pkOrder - b.pkOrder);
  if (pk.length > 0) lines.push(`  PRIMARY KEY (${pk.map((c) => qi(c.name)).join(", ")})`);
  for (const u of t.uniques) lines.push(`  UNIQUE (${u.map(qi).join(", ")})`);
  t.checks.forEach((check, i) => {
    lines.push(
      `  CONSTRAINT ${qi(checkConstraintName(t.name, i))} CHECK (${translateExpr(check, ctx, `${t.name} CHECK #${i + 1} (${check})`)})`,
    );
  });
  return `CREATE TABLE ${qi(t.name)} (\n${lines.join(",\n")}\n);\n`;
}

function emitIndexes(types: ColumnTypes, t: HeadTable): string[] {
  const ctx = tableContext(types, t);
  const surrogate: string[] = [];
  if (t.surrogateRowid) {
    checkIdent(rowidIndexName(t.name), "index");
    surrogate.push(
      `CREATE UNIQUE INDEX ${qi(rowidIndexName(t.name))} ON ${qi(t.name)} (${qi(ROWID_COLUMN)});`,
    );
  }
  const declared = t.indexes.map((idx) => {
    checkIdent(idx.name, "index");
    const where = `index ${idx.name} on ${t.name}`;
    const keys = idx.keys.map((k) => {
      const expr = k.column !== null ? qi(k.column) : `(${translateExpr(k.expr, ctx, where)})`;
      return k.desc ? `${expr} DESC` : expr;
    });
    const predicate = idx.where ? ` WHERE ${translateExpr(idx.where, ctx, where)}` : "";
    return `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX ${qi(idx.name)} ON ${qi(t.name)} (${keys.join(", ")})${predicate};`;
  });
  return [...surrogate, ...declared];
}

function emitForeignKeys(schema: HeadSchema, t: HeadTable): string[] {
  return t.foreignKeys.map((fk) => {
    const where = `${t.name}(${fk.columns.join(", ")}) -> ${fk.parent}`;
    const parent = schema.tables.find((p) => p.name === fk.parent);
    if (!parent) throw new Error(`${where}: parent table does not exist`);
    const parentCols = fk.parentColumns.every((c) => c === "")
      ? parent.columns.filter((c) => c.pkOrder > 0).map((c) => c.name)
      : fk.parentColumns;
    const key = [...parentCols].sort().join(",");
    const pkKey = parent.columns
      .filter((c) => c.pkOrder > 0)
      .map((c) => c.name)
      .sort()
      .join(",");
    const uniqueKeys = [
      pkKey,
      ...parent.uniques.map((u) => [...u].sort().join(",")),
      ...parent.indexes
        .filter((i) => i.unique && !i.where && i.keys.every((k) => k.column !== null))
        .map((i) =>
          i.keys
            .map((k) => k.column as string)
            .sort()
            .join(","),
        ),
    ];
    if (!uniqueKeys.includes(key)) {
      throw new Error(`${where}: parent columns (${parentCols.join(", ")}) are not unique`);
    }
    let sql = `ALTER TABLE ${qi(t.name)} ADD FOREIGN KEY (${fk.columns.map(qi).join(", ")}) REFERENCES ${qi(fk.parent)} (${parentCols.map(qi).join(", ")})`;
    const del = fkAction(fk.onDelete, where);
    const upd = fkAction(fk.onUpdate, where);
    if (del) sql += ` ON DELETE ${del}`;
    if (upd) sql += ` ON UPDATE ${upd}`;
    // Checked per statement, like SQLite; DEFERRABLE so a transaction can defer
    // them to COMMIT, as SQLite's `PRAGMA defer_foreign_keys` defers every key.
    sql += " DEFERRABLE INITIALLY IMMEDIATE";
    return `${sql};`;
  });
}

/** Views at the head schema, each written for Postgres by hand (one today). */
export const VIEW_PORTS: Record<string, { sqlite: string; postgres: string }> = {
  session_summary_recompute: {
    sqlite: "CREATE VIEW session_summary_recompute AS SELECT NULL AS rootId",
    postgres: `CREATE VIEW "session_summary_recompute" AS SELECT NULL::text AS "rootId";`,
  },
};

function emitViews(schema: HeadSchema): string[] {
  return schema.views.map((v) => {
    const port = VIEW_PORTS[v.name];
    if (!port) throw new Error(`view ${v.name} has no Postgres port`);
    if (port.sqlite.replace(/\s+/g, " ").trim() !== v.sql.replace(/\s+/g, " ").trim()) {
      throw new Error(`view ${v.name} changed; update VIEW_PORTS: ${v.sql}`);
    }
    return port.postgres;
  });
}

/** One seeded value as a Postgres literal of its column class. */
export function seedLiteral(
  value: SeedValue,
  cls: PgClass,
  format: string | undefined,
  where: string,
): string {
  if (value === null) return "NULL";
  switch (cls) {
    case "boolean":
      if (value === 0 || value === 1) return value === 1 ? "true" : "false";
      throw new Error(`${where}: boolean seed ${String(value)}`);
    case "bigint":
    case "epoch-ms":
      if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
        return String(value);
      }
      throw new Error(`${where}: integer seed ${String(value)}`);
    case "double":
      if (typeof value === "number" || typeof value === "bigint") return String(value);
      throw new Error(`${where}: real seed ${String(value)}`);
    case "bytea":
      if (value instanceof Uint8Array) return `'\\x${Buffer.from(value).toString("hex")}'::bytea`;
      throw new Error(`${where}: blob seed of type ${typeof value}`);
    case "jsonb": {
      const text = String(value);
      JSON.parse(text);
      return `${ql(text)}::jsonb`;
    }
    case "timestamptz": {
      const text = String(value);
      if (format === "iso-ms-z" && ISO_MS_Z.test(text)) return `${ql(text)}::timestamptz`;
      if (format === "space" && SPACE_TS.test(text)) return `${ql(`${text}+00`)}::timestamptz`;
      throw new Error(`${where}: timestamp seed ${text} is not in format ${format}`);
    }
    case "text":
      if (value instanceof Uint8Array) throw new Error(`${where}: blob seed in a text column`);
      return ql(String(value));
  }
}

/** The Postgres expression for a seeded value that came from the clock or randomblob(). */
export function volatileSeedExpr(value: SeedValue, cls: PgClass, where: string): string {
  const text = value === null ? "" : String(value);
  if (cls === "timestamptz") return "statement_timestamp()";
  if (cls === "text" && ISO_MS_Z.test(text)) return PG_NOW_TEXT["iso-ms-z"];
  if (cls === "text" && SPACE_TS.test(text)) return PG_NOW_TEXT.space;
  if (cls === "text" && HEX32.test(text)) return PG_RANDOM_HEX32;
  if ((cls === "epoch-ms" || cls === "bigint") && typeof value === "number") return PG_EPOCH_MS_NOW;
  throw new Error(`${where}: volatile seed ${text} has no Postgres expression`);
}

function emitSeeds(types: ColumnTypes, schema: HeadSchema, seeds: SeedTable[]): string[] {
  const out: string[] = [];
  for (const s of seeds) {
    const t = schema.tables.find((x) => x.name === s.table) as HeadTable;
    const cols = s.columns.map((c) => {
      const decl = t.columns.find((x) => x.name === c)?.declared ?? "";
      return { name: c, ...pgClassOf(types, s.table, c, decl) };
    });
    const names = cols.map((c) => qi(c.name));
    if (s.rowids) names.push(qi(ROWID_COLUMN));
    s.rows.forEach((row, r) => {
      const values = row.map((v, i) => {
        const col = cols[i] as (typeof cols)[number];
        const where = `seed ${s.table}.${col.name}`;
        return s.volatile.includes(col.name)
          ? volatileSeedExpr(v, col.cls, where)
          : seedLiteral(v, col.cls, col.format, where);
      });
      // The SQLite rowid goes into _rowid, so seeded rows keep the same value.
      if (s.rowids) values.push(String(s.rowids[r]));
      out.push(`INSERT INTO ${qi(s.table)} (${names.join(", ")}) VALUES (${values.join(", ")});`);
    });
    if (s.rowids) {
      out.push(
        `SELECT setval(pg_get_serial_sequence(${ql(qi(t.name))}, ${ql(ROWID_COLUMN)}), (SELECT max(${qi(ROWID_COLUMN)}) FROM ${qi(t.name)}));`,
      );
    }
    if (t.rowidAlias && s.columns.includes(t.rowidAlias)) {
      out.push(
        `SELECT setval(pg_get_serial_sequence(${ql(qi(t.name))}, ${ql(t.rowidAlias)}), (SELECT max(${qi(t.rowidAlias)}) FROM ${qi(t.name)}));`,
      );
    }
  }
  return out;
}

export async function generateBaseline(): Promise<string> {
  const types = loadColumnTypes();
  const { db, schema, seeds } = await readSeedsWithVolatility();
  db.close();

  // Every classified column must exist, so a renamed column cannot hide.
  for (const [table, cols] of Object.entries(types)) {
    const t = schema.tables.find((x) => x.name === table);
    if (!t)
      throw new Error(`column-types.json names table ${table}, which is not in the head schema`);
    for (const col of Object.keys(cols)) {
      if (!t.columns.some((c) => c.name === col)) {
        throw new Error(`column-types.json names ${table}.${col}, which is not in the head schema`);
      }
    }
  }

  const ordinal = baselineOrdinal();
  const sections: string[] = [];
  sections.push(
    [
      `-- ${ordinal}_baseline.sql: the Postgres schema equal to the SQLite head schema at migration ${ordinal}.`,
      "-- GENERATED by scripts/storage/generate-postgres-baseline.ts. Do not edit by hand:",
      "-- change column-types.json or parts/triggers.sql and run the generator again.",
      "-- Left out (milestone M4): the FTS5 virtual tables and their shadow tables:",
      `--   ${schema.skippedTables.join(", ")}`,
      "",
      "CREATE EXTENSION IF NOT EXISTS vector;",
      "",
    ].join("\n"),
  );
  sections.push("-- Tables\n");
  for (const t of schema.tables) sections.push(emitTable(types, t));
  sections.push("-- Seeded rows (inserted by the SQLite chain into an empty database)\n");
  sections.push(`${emitSeeds(types, schema, seeds).join("\n")}\n`);
  sections.push("-- Indexes\n");
  sections.push(`${schema.tables.flatMap((t) => emitIndexes(types, t)).join("\n")}\n`);
  sections.push("-- Foreign keys\n");
  sections.push(`${schema.tables.flatMap((t) => emitForeignKeys(schema, t)).join("\n")}\n`);
  sections.push("-- Views\n");
  sections.push(`${emitViews(schema).join("\n")}\n`);
  sections.push("-- Triggers (hand-written: src/be/migrations/postgres/parts/triggers.sql)\n");
  sections.push(readFileSync(TRIGGERS_PART_PATH, "utf8").trimEnd() + "\n");
  lastCheckMessages = checkMessages(schema);
  return sections.join("\n");
}

let lastCheckMessages: Record<string, string> = {};

function messagesJson(): string {
  return `${JSON.stringify(lastCheckMessages, null, 2)}\n`;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const sql = await generateBaseline();
  const path = baselinePath();
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      // missing file counts as drift
    }
    let currentMessages = "";
    try {
      currentMessages = readFileSync(checkMessagesPath(), "utf8");
    } catch {
      // missing file counts as drift
    }
    if (current !== sql || currentMessages !== messagesJson()) {
      console.error(
        `${path} is out of date. Run: bun scripts/storage/generate-postgres-baseline.ts`,
      );
      process.exit(1);
    }
    console.log(`${path} is up to date.`);
  } else {
    writeFileSync(path, sql);
    writeFileSync(checkMessagesPath(), messagesJson());
    console.log(`wrote ${path} and ${checkMessagesPath()}`);
  }
}
