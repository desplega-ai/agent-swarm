import type { DbParam } from "../client";
import { likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlIdent, sqlJoin } from "../sql";

/**
 * Domain: maintenance sweeps that walk rows of other domains by key (the boot
 * scrub sweep), and their progress rows in `seed_state` (kind `maintenance`).
 * Table and column names come from code, never from input.
 */

/** One table of a keyed text sweep. */
export type KeyedTextTable = {
  table: string;
  /** Unique TEXT row key. Returned as `id`. */
  idColumn: string;
  /** Only rows where this column equals this value. */
  whereEquals?: { column: string; value: string };
};

export interface MaintenanceRepository {
  /** `seededHash` of the `('maintenance', key)` row, or null. */
  getState(key: string): Promise<string | null>;
  /** Upsert `('maintenance', key)` with `value`, stamped with the engine time (`YYYY-MM-DD HH:MM:SS`). */
  setState(key: string, value: string): Promise<void>;
  /** Delete the maintenance rows whose key matches a LIKE pattern that escapes with `!`. */
  deleteStatesLike(pattern: string): Promise<void>;
  /** Delete the `boot-scrub-skipped-v<N>` rows with N <= `version`. */
  deleteSkippedBootScrubVersions(version: number): Promise<void>;
  /**
   * The next `limit` rows with key > `after`, in key order (unique, so total).
   * Each row has `id` plus the named columns.
   */
  scanKeyedBatch(
    target: KeyedTextTable,
    columns: readonly string[],
    after: string,
    limit: number,
  ): Promise<Record<string, string | null>[]>;
  /**
   * Compare-and-set one row: write `set` only while every `expect` column still
   * holds its value and every `expectNull` column is NULL. Returns true when it wrote.
   */
  compareAndSetRow(
    target: KeyedTextTable,
    id: string,
    set: Readonly<Record<string, DbParam>>,
    expect: Readonly<Record<string, DbParam>>,
    expectNull: readonly string[],
  ): Promise<boolean>;
}

export abstract class BaseMaintenanceRepository implements MaintenanceRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async getState(key: string): Promise<string | null> {
    const row = await this.db.get<{ seededHash: string }>(
      sql`SELECT "seededHash" FROM seed_state WHERE kind = 'maintenance' AND key = ${key}`,
    );
    return row?.seededHash ?? null;
  }

  /**
   * `seededAt` is a TEXT column on every engine: the engine time rendered as
   * `YYYY-MM-DD HH:MM:SS` text differs per engine.
   */
  abstract setState(key: string, value: string): Promise<void>;

  async deleteStatesLike(pattern: string): Promise<void> {
    await this.db.run(
      sql`DELETE FROM seed_state WHERE kind = 'maintenance' AND ${likeAsciiCi(sql`key`, sql`${pattern}`, "!")}`,
    );
  }

  abstract deleteSkippedBootScrubVersions(version: number): Promise<void>;

  scanKeyedBatch(
    target: KeyedTextTable,
    columns: readonly string[],
    after: string,
    limit: number,
  ): Promise<Record<string, string | null>[]> {
    const id = sqlIdent(target.idColumn);
    const selected = sqlJoin(
      [sql`${id} AS id`, ...columns.map((column) => sql`${sqlIdent(column)}`)],
      sql`, `,
    );
    return this.db.query<Record<string, string | null>>(sql`
      SELECT ${selected} FROM ${sqlIdent(target.table)}
      WHERE ${this.filter(target)}${id} > ${after} ORDER BY ${id} ASC LIMIT ${limit}`);
  }

  async compareAndSetRow(
    target: KeyedTextTable,
    id: string,
    set: Readonly<Record<string, DbParam>>,
    expect: Readonly<Record<string, DbParam>>,
    expectNull: readonly string[],
  ): Promise<boolean> {
    const sets = sqlJoin(
      Object.entries(set).map(([column, value]) => sql`${sqlIdent(column)} = ${value}`),
      sql`, `,
    );
    const guards = [
      ...Object.entries(expect).map(
        ([column, value]) => sql`${sqlIdent(column)} IS NOT DISTINCT FROM ${value}`,
      ),
      ...expectNull.map((column) => sql`${sqlIdent(column)} IS NULL`),
    ];
    const guard = guards.length === 0 ? sql`` : sql` AND ${sqlJoin(guards, sql` AND `)}`;
    const result = await this.db.run(sql`
      UPDATE ${sqlIdent(target.table)} SET ${sets}
      WHERE ${this.filter(target)}${sqlIdent(target.idColumn)} = ${id}${guard}`);
    return result.changes > 0;
  }

  private filter(target: KeyedTextTable): SqlQuery {
    return target.whereEquals
      ? sql`${sqlIdent(target.whereEquals.column)} = ${target.whereEquals.value} AND `
      : sql``;
  }
}
