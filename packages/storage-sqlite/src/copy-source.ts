import { Database } from "bun:sqlite";
import type { CopyCell, CopyRow, CopySource, CopyTable, SkippedCopyTable } from "@desplega/storage";

/**
 * The SQLite side of the data copy (decision D11): a read-only view of a
 * database file. Integers come back as bigint (no precision loss past 2^53) and
 * text as its stored bytes, so the target can find invalid UTF-8 that
 * bun:sqlite would otherwise replace without a word.
 */

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type TableListRow = { name: string; type: string };
type XInfoRow = { name: string; type: string; pk: bigint | number; hidden: bigint | number };

/** Tables that hold bookkeeping, not data. The target keeps its own copy of each. */
const BOOKKEEPING: Record<string, string> = {
  _migrations: "migration bookkeeping: the target records its own chain",
  sqlite_sequence: "SQLite AUTOINCREMENT counters: the copy resets the target sequences",
};

/** Shadow table suffixes of FTS5 and sqlite-vec (vec0). A table like `agent_tasks_fts_state` is data. */
const SHADOW_SUFFIX =
  /^(config|content|data|docsize|idx|chunks|rowids|info|auxiliary|vector_chunks\d+|metadatachunks\d+|metadatatext\d+)$/;

export function openSqliteCopySource(path: string): CopySource {
  const db = new Database(path, { readonly: true, safeIntegers: true });
  db.run("PRAGMA query_only = ON");

  const listed = db
    .query<TableListRow, []>(
      "SELECT name, type FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all();
  // A virtual table's module (FTS5, sqlite-vec) may not be loaded here, so the
  // virtual tables are found by their CREATE text, and their shadow tables by name.
  const virtual = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
    )
    .all()
    .map((row) => row.name);
  const skipped: SkippedCopyTable[] = [];
  const tables: CopyTable[] = [];
  for (const { name } of listed) {
    if (BOOKKEEPING[name]) {
      skipped.push({ name, reason: BOOKKEEPING[name] });
      continue;
    }
    if (name.startsWith("sqlite_")) {
      skipped.push({ name, reason: "SQLite internal table" });
      continue;
    }
    if (virtual.includes(name)) {
      skipped.push({
        name,
        reason: "SQLite virtual table (FTS5 or sqlite-vec): the target rebuilds its own index",
      });
      continue;
    }
    const owner = virtual.find(
      (v) => name.startsWith(`${v}_`) && SHADOW_SUFFIX.test(name.slice(v.length + 1)),
    );
    if (owner) {
      skipped.push({ name, reason: `shadow table of the virtual table ${owner}` });
      continue;
    }
    const info = db
      .query<XInfoRow, []>(`SELECT * FROM pragma_table_xinfo(${quoteText(name)})`)
      .all();
    const withoutRowid =
      db
        .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
        .get(name)
        ?.sql.replace(/\s+/g, " ")
        .toUpperCase()
        .includes("WITHOUT ROWID") ?? false;
    tables.push({
      name,
      // hidden 0 = ordinary column; 2 and 3 are generated columns (not insertable).
      columns: info
        .filter((c) => Number(c.hidden) === 0)
        .map((c) => ({ name: c.name, declaredType: c.type })),
      hasRowid: !withoutRowid,
    });
  }

  const primaryKey = (table: string): string[] =>
    db
      .query<XInfoRow, []>(`SELECT * FROM pragma_table_xinfo(${quoteText(table)})`)
      .all()
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name);

  return {
    migrationHead() {
      const exists = db
        .query<{ n: bigint }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_migrations'",
        )
        .get();
      if (!exists || Number(exists.n) === 0) return null;
      const row = db
        .query<{ v: bigint | null }, []>("SELECT MAX(version) AS v FROM _migrations")
        .get();
      return row?.v === null || row?.v === undefined ? null : Number(row.v);
    },
    migrationHistory() {
      if (this.migrationHead() === null) return [];
      return db
        .query<{ version: bigint; name: string; applied_at: string; checksum: string }, []>(
          "SELECT version, name, applied_at, checksum FROM _migrations ORDER BY version",
        )
        .all()
        .map((r) => ({
          version: Number(r.version),
          name: r.name,
          appliedAt: r.applied_at,
          checksum: r.checksum,
        }));
    },
    tables: () => tables,
    skippedTables: () => skipped,
    *rows(table: CopyTable, batchSize: number): Iterable<CopyRow[]> {
      const pk = primaryKey(table.name);
      const select = table.columns
        .map((c, i) => {
          const col = quote(c.name);
          return `typeof(${col}) AS k${i}, CASE WHEN typeof(${col}) = 'text' THEN CAST(${col} AS BLOB) ELSE ${col} END AS v${i}`;
        })
        .join(", ");
      const order = table.hasRowid ? "rowid" : pk.map(quote).join(", ");
      const rowidSelect = table.hasRowid ? "rowid AS __rowid, " : "";
      const statement = db.query<Record<string, unknown>, []>(
        `SELECT ${rowidSelect}${select} FROM ${quote(table.name)} ORDER BY ${order}`,
      );
      const pkIndexes = pk.map((name) => table.columns.findIndex((c) => c.name === name));
      let batch: CopyRow[] = [];
      for (const raw of statement.iterate()) {
        const cells: CopyCell[] = table.columns.map((_, i) => toCell(raw[`k${i}`], raw[`v${i}`]));
        const rowid = table.hasRowid ? (raw.__rowid as bigint) : null;
        const label =
          rowid !== null
            ? `rowid ${rowid}`
            : pkIndexes.map((i) => labelOf(cells[i] ?? { kind: "null" })).join(", ");
        batch.push({ rowid, label, cells });
        if (batch.length >= batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    },
    close() {
      db.close();
    },
  };
}

function quoteText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function toCell(kind: unknown, value: unknown): CopyCell {
  switch (kind) {
    case "null":
      return { kind: "null" };
    case "integer":
      return { kind: "integer", value: BigInt(value as bigint | number) };
    case "real":
      return { kind: "real", value: Number(value) };
    case "text":
      return { kind: "text", bytes: value as Uint8Array };
    default:
      return { kind: "blob", bytes: value as Uint8Array };
  }
}

function labelOf(cell: CopyCell): string {
  switch (cell.kind) {
    case "null":
      return "NULL";
    case "integer":
    case "real":
      return String(cell.value);
    case "text":
      return new TextDecoder().decode(cell.bytes).slice(0, 80);
    default:
      return `<blob ${cell.bytes.length} bytes>`;
  }
}
