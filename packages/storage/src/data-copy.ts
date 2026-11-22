/**
 * The data copy contract (decision D11): a source engine hands its rows to a
 * target engine. Today the source is a SQLite file
 * (`@desplega/storage-sqlite` `openSqliteCopySource`) and the target is an empty
 * Postgres database (`@desplega/storage-postgres` `copyIntoPostgres`).
 */

/** One stored value, with the storage class the source engine gave it. */
export type CopyCell =
  | { kind: "null" }
  | { kind: "integer"; value: bigint }
  | { kind: "real"; value: number }
  /** Text arrives as its stored bytes, so the target can reject invalid UTF-8. */
  | { kind: "text"; bytes: Uint8Array }
  | { kind: "blob"; bytes: Uint8Array };

export type CopyColumn = { name: string; declaredType: string };

export type CopyTable = {
  name: string;
  /** Insertable columns, in table order (generated and hidden columns excluded). */
  columns: CopyColumn[];
  /** True when the table has an insertion-order rowid (not WITHOUT ROWID). */
  hasRowid: boolean;
};

export type CopyRow = {
  /** The rowid, when the table has one. */
  rowid: bigint | null;
  /** A short row label for problem reports (the rowid or the primary key values). */
  label: string;
  /** One cell for each column of `CopyTable.columns`, same order. */
  cells: CopyCell[];
};

/** A source table the copy does not carry, with the reason. */
export type SkippedCopyTable = { name: string; reason: string };

/** One applied migration of the source, as its `_migrations` row records it. */
export type CopyMigration = { version: number; name: string; appliedAt: string; checksum: string };

export interface CopySource {
  /** Highest applied migration ordinal, or null when the source has none. */
  migrationHead(): number | null;
  /** Every applied migration of the source, in version order. */
  migrationHistory(): CopyMigration[];
  /** The data tables to copy (migration bookkeeping and engine-internal tables excluded). */
  tables(): CopyTable[];
  /** Engine-internal tables that the target rebuilds itself (full text, vectors). */
  skippedTables(): SkippedCopyTable[];
  /** Every row of `table`, in insertion order, in batches of at most `batchSize`. */
  rows(table: CopyTable, batchSize: number): Iterable<CopyRow[]>;
  close(): void;
}

/** A value the target cannot store as it is. The copy writes nothing when any exists. */
export type CopyProblem = { table: string; column: string; row: string; reason: string };

export type CopyTableReport = {
  table: string;
  sourceRows: number;
  targetRows: number;
  sourceChecksum: string;
  targetChecksum: string;
  equal: boolean;
};

export type CopyReport = {
  /** True when every table copied and every count and checksum compared equal. */
  ok: boolean;
  /** Values the target cannot store (the copy then rolls back). */
  problems: CopyProblem[];
  /** Problems found in total (the list keeps the first ones only). */
  problemCount: number;
  /** A failure that stopped the copy (refused target, constraint at commit). */
  error?: string;
  tables: CopyTableReport[];
  skipped: SkippedCopyTable[];
  /** Rows written to rebuilt engine-specific data (vectors). */
  rebuilt: { table: string; rows: number; reason: string }[];
};
