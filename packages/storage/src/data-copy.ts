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
  /**
   * The AUTOINCREMENT high-water mark of each table that has one (SQLite
   * `sqlite_sequence`). It can exceed the largest surviving key when the
   * newest rows were deleted, and a key is never reused below it. A bigint
   * keeps a counter above 2^53 exact.
   */
  autoincrementCounters?(): Record<string, bigint | number>;
  /**
   * The vector index searches run on in the source (SQLite `memory_vec`): its
   * width and the memory IDs it holds. Null when the source has none. The copy
   * refuses to rebuild an index that would drop a searchable memory.
   */
  vectorIndex?(): { dimensions: number | null; ids: string[] | null } | null;
  /**
   * Rows whose foreign key names no parent row (SQLite `PRAGMA foreign_key_check`).
   * A source that never enforced a key, or lost rows with enforcement off, holds
   * them; the target refuses each one.
   */
  foreignKeyViolations?(): CopyOrphan[];
  /**
   * Every row of `table`, in insertion order, in batches of at most `batchSize`
   * rows. With `batchBytes`, a batch also ends once its text and blob cells hold
   * that many bytes (one larger row still forms a batch by itself).
   */
  rows(table: CopyTable, batchSize: number, batchBytes?: number): Iterable<CopyRow[]>;
  close(): void;
}

/**
 * A row whose foreign key columns name no row of `parent`. `onDelete` is the
 * action of that key in the source (`CASCADE`, `SET NULL`, `NO ACTION`, ...).
 */
export type CopyOrphan = {
  table: string;
  row: string;
  parent: string;
  columns: string[];
  onDelete: string;
};

/** One value or row that `--repair` changed, and how. */
export type CopyRepair = { table: string; column: string; row: string; action: string };

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
  /** Problems found in total (the list holds every one unless a cap was set). */
  problemCount: number;
  /**
   * Saved SQLite queries (metric widgets and variable options) that the copy
   * could not rewrite and that do not run on Postgres. The copy still
   * succeeds; an operator edits each one before or right after cutover.
   */
  attention?: CopyProblem[];
  /**
   * Saved queries the copy could not check after COMMIT (for example the
   * planning session could not connect). The data is copied; each of these
   * queries is unverified, so an operator runs it once on Postgres.
   */
  unchecked?: CopyProblem[];
  /** What `--repair` changed (the list holds every one unless a cap was set). */
  repairs?: CopyRepair[];
  repairCount?: number;
  /**
   * Steps after COMMIT that did not run (planner statistics). The copy is
   * committed and complete; each line says what the operator runs by hand.
   */
  warnings?: string[];
  /** A failure that stopped the copy (refused target, constraint at commit). */
  error?: string;
  tables: CopyTableReport[];
  skipped: SkippedCopyTable[];
  /** Rows written to rebuilt engine-specific data (vectors). */
  rebuilt: { table: string; rows: number; reason: string }[];
};
