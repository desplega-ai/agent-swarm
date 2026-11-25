import { likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlJoin, sqlList } from "../sql";

/**
 * Domain: kv (`kv_entries`). `expires_at`, `created_at` and `updated_at` are
 * integer epoch milliseconds on every engine. "Live" means not expired at
 * `nowMs` (`expires_at` NULL or later).
 */

export type KvValueRow = { value: string; value_type: string };
export type KvEntryRow = { key: string; value: string; value_type: string };

/** One full `kv_entries` row. */
export type KvRow = {
  namespace: string;
  key: string;
  value: string;
  value_type: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

/** A key range: lower bound `after` (exclusive) or `from` (inclusive), upper `before` / `through`. */
export type KvKeyRange = { after?: string; from?: string; before?: string; through?: string };

/** Top-level JSON field equality on `json` entries (path text chosen by the caller). */
export type KvJsonFieldFilter = { path: string; value: string | number | boolean };

export interface KvRepository {
  /**
   * The key `offset` rows past `afterKey` inside `(afterKey, prefixUpper)` in
   * key order, or null when fewer remain. Expired rows count.
   */
  keyAfter(
    namespace: string,
    prefixUpper: string,
    afterKey: string,
    offset: number,
  ): Promise<string | null>;
  /** The stored value, expired or not. */
  getValue(namespace: string, key: string): Promise<KvValueRow | null>;
  /**
   * Keys matching a LIKE pattern with `\` escapes (ASCII case folded), expired
   * or not. Ordered by key.
   */
  listKeysLike(namespace: string, pattern: string): Promise<string[]>;
  /** Insert, or replace the value, of a JSON entry with no expiry. */
  upsertJsonValue(namespace: string, key: string, value: string, nowMs: number): Promise<void>;
  /** Live keys in `[lo, hi)`, ordered by key. */
  listLiveKeys(
    namespace: string,
    lo: string,
    hi: string,
    nowMs: number,
    limit: number,
  ): Promise<string[]>;
  /** Live values of the listed keys, ordered by key. */
  listLiveValues(namespace: string, keys: readonly string[], nowMs: number): Promise<KvValueRow[]>;
  /** Live entries in `[lo, hi)` after `afterKey`, ordered by key. */
  listLiveEntriesAfter(
    namespace: string,
    lo: string,
    hi: string,
    afterKey: string,
    nowMs: number,
    limit: number,
  ): Promise<KvEntryRow[]>;
  /** Deletes the first `limit` entries of the namespace in key order (expired ones too). Returns the change count. */
  deleteNamespaceBatch(namespace: string, limit: number): Promise<number>;
  /** Returns the change count. */
  setExpiresAt(namespace: string, key: string, expiresAt: number | null): Promise<number>;
  /** The full row, expired or not. */
  findEntry(namespace: string, key: string): Promise<KvRow | null>;
  /** Returns the change count. */
  deleteEntry(namespace: string, key: string): Promise<number>;
  /** Deletes the namespace's entries expired at `nowMs`. */
  deleteExpired(namespace: string, nowMs: number): Promise<number>;
  /**
   * Deletes up to `limit` entries expired at `nowMs` in `prefix` or any
   * `prefix:*` namespace (`likePattern` is the escaped `prefix:%`, `\` escapes).
   */
  deleteExpiredInFamilyBatch(
    prefix: string,
    likePattern: string,
    nowMs: number,
    limit: number,
  ): Promise<number>;
  /**
   * Deletes up to `limit` entries (expired or not) of every namespace matching
   * `likePattern` (`\` escapes, ASCII case folded). Returns the change count.
   */
  deleteNamespacesLikeBatch(likePattern: string, limit: number): Promise<number>;
  /** Insert or overwrite (keeps `created_at`). */
  upsertEntry(row: KvRow): Promise<KvRow | null>;
  /** Insert, or overwrite an entry expired at `nowMs`; returns the change count. */
  claimEntry(row: KvRow, nowMs: number): Promise<number>;
  setEntryValue(
    namespace: string,
    key: string,
    value: string,
    updatedAt: number,
  ): Promise<KvRow | null>;
  /** Live entries in `range` matching every JSON filter, ordered by key. */
  listLiveEntries(
    namespace: string,
    f: {
      nowMs: number;
      range: KvKeyRange;
      jsonFieldEquals: readonly KvJsonFieldFilter[];
      limit: number;
      offset: number;
    },
  ): Promise<KvRow[]>;
  countLiveEntries(namespace: string, nowMs: number, range: KvKeyRange): Promise<number>;
}

export abstract class BaseKvRepository implements KvRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async keyAfter(
    namespace: string,
    prefixUpper: string,
    afterKey: string,
    offset: number,
  ): Promise<string | null> {
    const row = await this.db.get<{ key: string }>(sql`
      SELECT key FROM kv_entries
      WHERE namespace = ${namespace} AND key > ${afterKey} AND key < ${prefixUpper}
      ORDER BY key
      LIMIT 1 OFFSET ${offset}`);
    return row?.key ?? null;
  }

  getValue(namespace: string, key: string): Promise<KvValueRow | null> {
    return this.db.get<KvValueRow>(
      sql`SELECT value, value_type FROM kv_entries WHERE namespace = ${namespace} AND key = ${key}`,
    );
  }

  async listKeysLike(namespace: string, pattern: string): Promise<string[]> {
    const rows = await this.db.query<{ key: string }>(sql`
      SELECT key FROM kv_entries
      WHERE namespace = ${namespace} AND ${likeAsciiCi(sql`key`, sql`${pattern}`, "\\")}
      ORDER BY key`);
    return rows.map((row) => row.key);
  }

  async upsertJsonValue(
    namespace: string,
    key: string,
    value: string,
    nowMs: number,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
      VALUES (${namespace}, ${key}, ${value}, 'json', NULL, ${nowMs}, ${nowMs})
      ON CONFLICT (namespace, key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        expires_at = NULL,
        updated_at = excluded.updated_at`);
  }

  async listLiveKeys(
    namespace: string,
    lo: string,
    hi: string,
    nowMs: number,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.db.query<{ key: string }>(sql`
      SELECT key FROM kv_entries
      WHERE namespace = ${namespace} AND key >= ${lo} AND key < ${hi}
        AND (expires_at IS NULL OR expires_at > ${nowMs})
      ORDER BY key
      LIMIT ${limit}`);
    return rows.map((row) => row.key);
  }

  async listLiveValues(
    namespace: string,
    keys: readonly string[],
    nowMs: number,
  ): Promise<KvValueRow[]> {
    if (keys.length === 0) return [];
    return this.db.query<KvValueRow>(sql`
      SELECT value, value_type FROM kv_entries
      WHERE namespace = ${namespace} AND key IN (${sqlList(keys)})
        AND (expires_at IS NULL OR expires_at > ${nowMs})
      ORDER BY key`);
  }

  listLiveEntriesAfter(
    namespace: string,
    lo: string,
    hi: string,
    afterKey: string,
    nowMs: number,
    limit: number,
  ): Promise<KvEntryRow[]> {
    return this.db.query<KvEntryRow>(sql`
      SELECT key, value, value_type FROM kv_entries
      WHERE namespace = ${namespace} AND key >= ${lo} AND key < ${hi} AND key > ${afterKey}
        AND (expires_at IS NULL OR expires_at > ${nowMs})
      ORDER BY key
      LIMIT ${limit}`);
  }

  async deleteNamespaceBatch(namespace: string, limit: number): Promise<number> {
    return (
      await this.db.run(sql`
        DELETE FROM kv_entries
        WHERE namespace = ${namespace}
          AND key IN (SELECT key FROM kv_entries WHERE namespace = ${namespace} ORDER BY key LIMIT ${limit})`)
    ).changes;
  }

  async setExpiresAt(namespace: string, key: string, expiresAt: number | null): Promise<number> {
    return (
      await this.db.run(sql`
        UPDATE kv_entries SET expires_at = ${expiresAt} WHERE namespace = ${namespace} AND key = ${key}`)
    ).changes;
  }

  private readonly kvColumns =
    sql`namespace, key, value, value_type, expires_at, created_at, updated_at`;

  findEntry(namespace: string, key: string): Promise<KvRow | null> {
    return this.db.get<KvRow>(sql`
      SELECT ${this.kvColumns} FROM kv_entries WHERE namespace = ${namespace} AND key = ${key}`);
  }

  async deleteEntry(namespace: string, key: string): Promise<number> {
    const result = await this.db.run(
      sql`DELETE FROM kv_entries WHERE namespace = ${namespace} AND key = ${key}`,
    );
    return result.changes;
  }

  async deleteExpired(namespace: string, nowMs: number): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM kv_entries
      WHERE namespace = ${namespace} AND expires_at IS NOT NULL AND expires_at <= ${nowMs}`);
    return result.changes;
  }

  async deleteExpiredInFamilyBatch(
    prefix: string,
    likePattern: string,
    nowMs: number,
    limit: number,
  ): Promise<number> {
    // kv_entries is WITHOUT ROWID: a batch selects the (namespace, key) primary key.
    const result = await this.db.run(sql`
      DELETE FROM kv_entries
      WHERE (namespace, key) IN (
        SELECT namespace, key FROM kv_entries
        WHERE (namespace = ${prefix} OR ${likeAsciiCi(sql`namespace`, sql`${likePattern}`, "\\")})
          AND expires_at IS NOT NULL
          AND expires_at <= ${nowMs}
        LIMIT ${limit})`);
    return result.changes;
  }

  async deleteNamespacesLikeBatch(likePattern: string, limit: number): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM kv_entries
      WHERE (namespace, key) IN (
        SELECT namespace, key FROM kv_entries
        WHERE ${likeAsciiCi(sql`namespace`, sql`${likePattern}`, "\\")}
        LIMIT ${limit})`);
    return result.changes;
  }

  upsertEntry(r: KvRow): Promise<KvRow | null> {
    return this.db.get<KvRow>(sql`
      INSERT INTO kv_entries (${this.kvColumns})
      VALUES (${r.namespace}, ${r.key}, ${r.value}, ${r.value_type}, ${r.expires_at},
        ${r.created_at}, ${r.updated_at})
      ON CONFLICT(namespace, key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      RETURNING ${this.kvColumns}`);
  }

  async claimEntry(r: KvRow, nowMs: number): Promise<number> {
    const result = await this.db.run(sql`
      INSERT INTO kv_entries (${this.kvColumns})
      VALUES (${r.namespace}, ${r.key}, ${r.value}, ${r.value_type}, ${r.expires_at},
        ${r.created_at}, ${r.updated_at})
      ON CONFLICT(namespace, key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      WHERE kv_entries.expires_at IS NOT NULL AND kv_entries.expires_at <= ${nowMs}`);
    return result.changes;
  }

  setEntryValue(
    namespace: string,
    key: string,
    value: string,
    updatedAt: number,
  ): Promise<KvRow | null> {
    return this.db.get<KvRow>(sql`
      UPDATE kv_entries SET value = ${value}, updated_at = ${updatedAt}
      WHERE namespace = ${namespace} AND key = ${key}
      RETURNING ${this.kvColumns}`);
  }

  protected keyRange(range: KvKeyRange): SqlQuery {
    const parts: SqlQuery[] = [];
    if (range.after !== undefined) parts.push(sql` AND key > ${range.after}`);
    if (range.from !== undefined) parts.push(sql` AND key >= ${range.from}`);
    if (range.through !== undefined) parts.push(sql` AND key <= ${range.through}`);
    if (range.before !== undefined) parts.push(sql` AND key < ${range.before}`);
    return parts.length ? sqlJoin(parts, EMPTY) : EMPTY;
  }

  /** `AND <json field = value>` per filter; corrupt JSON rows never match. */
  protected abstract jsonFieldEquals(filters: readonly KvJsonFieldFilter[]): SqlQuery;

  listLiveEntries(
    namespace: string,
    f: {
      nowMs: number;
      range: KvKeyRange;
      jsonFieldEquals: readonly KvJsonFieldFilter[];
      limit: number;
      offset: number;
    },
  ): Promise<KvRow[]> {
    return this.db.query<KvRow>(sql`
      SELECT ${this.kvColumns} FROM kv_entries
      WHERE namespace = ${namespace}
        AND (expires_at IS NULL OR expires_at > ${f.nowMs})${this.keyRange(f.range)}${this.jsonFieldEquals(f.jsonFieldEquals)}
      ORDER BY key
      LIMIT ${f.limit} OFFSET ${f.offset}`);
  }

  async countLiveEntries(namespace: string, nowMs: number, range: KvKeyRange): Promise<number> {
    const row = await this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM kv_entries
      WHERE namespace = ${namespace}
        AND (expires_at IS NULL OR expires_at > ${nowMs})${this.keyRange(range)}`);
    return row?.n ?? 0;
  }
}
