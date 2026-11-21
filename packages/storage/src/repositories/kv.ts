import { likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { sql, sqlList } from "../sql";

/**
 * Domain: kv (`kv_entries`). `expires_at`, `created_at` and `updated_at` are
 * integer epoch milliseconds on every engine. "Live" means not expired at
 * `nowMs` (`expires_at` NULL or later).
 */

export type KvValueRow = { value: string; value_type: string };
export type KvEntryRow = { key: string; value: string; value_type: string };

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
}
