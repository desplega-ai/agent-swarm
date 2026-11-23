import { jsonText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

/**
 * Domain: Chat SDK state (`chat_subscriptions`, `chat_locks`, `chat_state_kv`,
 * `chat_lists`, `chat_queue`). Expiry columns hold epoch milliseconds; a null
 * expiry never expires. Values are JSON text that the caller encodes.
 */

export interface ChatRepository {
  /** No-op when the thread is already subscribed. */
  subscribe(threadId: string): Promise<void>;
  unsubscribe(threadId: string): Promise<void>;
  isSubscribed(threadId: string): Promise<boolean>;

  /** Takes the lock when it is free or expired at `now`. True when taken. */
  acquireLock(threadId: string, token: string, expiresAt: number, now: number): Promise<boolean>;
  /** Moves the expiry of a live lock held with `token`. True when extended. */
  extendLock(threadId: string, token: string, expiresAt: number, now: number): Promise<boolean>;
  releaseLock(threadId: string, token: string): Promise<void>;
  forceReleaseLock(threadId: string): Promise<void>;

  getKv(key: string): Promise<{ value: string; expires_at: number | null } | null>;
  /** Deletes the key only when it expired at `now`. */
  deleteExpiredKv(key: string, now: number): Promise<void>;
  setKv(key: string, value: string, expiresAt: number | null): Promise<void>;
  /** Writes when the key is absent or expired at `now`. True when written. */
  setKvIfAbsent(
    key: string,
    value: string,
    expiresAt: number | null,
    now: number,
  ): Promise<boolean>;
  deleteKv(key: string): Promise<void>;

  /** Deletes the list when it expired at `now`. */
  deleteExpiredList(key: string, now: number): Promise<void>;
  /** Appends at the next `seq` of the list. */
  appendListItem(key: string, value: string, expiresAt: number | null): Promise<void>;
  /** Keeps only the newest `maxLength` items. */
  trimList(key: string, maxLength: number): Promise<void>;
  setListExpiry(key: string, expiresAt: number | null): Promise<void>;
  /** Live items of the list. Order: `seq` ascending. */
  listItems(key: string, now: number): Promise<string[]>;

  enqueue(threadId: string, entry: string): Promise<void>;
  /** Keeps only the newest `maxSize` entries of the thread. */
  trimQueue(threadId: string, maxSize: number): Promise<void>;
  queueDepth(threadId: string): Promise<number>;
  /** The oldest entry of the thread (lowest id). */
  firstQueued(threadId: string): Promise<{ id: number; entry: string } | null>;
  deleteQueued(id: number): Promise<void>;

  /** Deletes every kv row, list item and lock that expired at `now`. */
  sweepExpired(now: number): Promise<void>;
}

export abstract class BaseChatRepository implements ChatRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async subscribe(threadId: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO chat_subscriptions (thread_id) VALUES (${threadId})
      ON CONFLICT DO NOTHING`);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM chat_subscriptions WHERE thread_id = ${threadId}`);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const row = await this.db.get<{ one: number }>(
      sql`SELECT 1 AS one FROM chat_subscriptions WHERE thread_id = ${threadId}`,
    );
    return row !== null;
  }

  async acquireLock(
    threadId: string,
    token: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO chat_locks (thread_id, token, expires_at) VALUES (${threadId}, ${token}, ${expiresAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        token = excluded.token,
        expires_at = excluded.expires_at
      WHERE chat_locks.expires_at <= ${now}`);
    return result.changes > 0;
  }

  async extendLock(
    threadId: string,
    token: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      UPDATE chat_locks SET expires_at = ${expiresAt}
      WHERE thread_id = ${threadId} AND token = ${token} AND expires_at > ${now}`);
    return result.changes > 0;
  }

  async releaseLock(threadId: string, token: string): Promise<void> {
    await this.db.run(
      sql`DELETE FROM chat_locks WHERE thread_id = ${threadId} AND token = ${token}`,
    );
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM chat_locks WHERE thread_id = ${threadId}`);
  }

  getKv(key: string): Promise<{ value: string; expires_at: number | null } | null> {
    return this.db.get<{ value: string; expires_at: number | null }>(
      sql`SELECT value, expires_at FROM chat_state_kv WHERE key = ${key}`,
    );
  }

  async deleteExpiredKv(key: string, now: number): Promise<void> {
    await this.db.run(sql`DELETE FROM chat_state_kv WHERE key = ${key} AND expires_at <= ${now}`);
  }

  async setKv(key: string, value: string, expiresAt: number | null): Promise<void> {
    await this.db.run(sql`
      INSERT INTO chat_state_kv (key, value, expires_at) VALUES (${key}, ${jsonText(value)}, ${expiresAt})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`);
  }

  async setKvIfAbsent(
    key: string,
    value: string,
    expiresAt: number | null,
    now: number,
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO chat_state_kv (key, value, expires_at) VALUES (${key}, ${jsonText(value)}, ${expiresAt})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
      WHERE chat_state_kv.expires_at IS NOT NULL AND chat_state_kv.expires_at <= ${now}`);
    return result.changes > 0;
  }

  async deleteKv(key: string): Promise<void> {
    await this.db.run(sql`DELETE FROM chat_state_kv WHERE key = ${key}`);
  }

  async deleteExpiredList(key: string, now: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM chat_lists WHERE key = ${key} AND expires_at IS NOT NULL AND expires_at <= ${now}`);
  }

  async appendListItem(key: string, value: string, expiresAt: number | null): Promise<void> {
    await this.db.run(sql`
      INSERT INTO chat_lists (key, seq, value, expires_at)
      VALUES (${key}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_lists WHERE key = ${key}),
        ${jsonText(value)}, ${expiresAt})`);
  }

  async trimList(key: string, maxLength: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM chat_lists WHERE key = ${key} AND seq NOT IN (
        SELECT seq FROM chat_lists WHERE key = ${key} ORDER BY seq DESC LIMIT ${maxLength}
      )`);
  }

  async setListExpiry(key: string, expiresAt: number | null): Promise<void> {
    await this.db.run(sql`UPDATE chat_lists SET expires_at = ${expiresAt} WHERE key = ${key}`);
  }

  async listItems(key: string, now: number): Promise<string[]> {
    const rows = await this.db.query<{ value: string }>(sql`
      SELECT value FROM chat_lists
      WHERE key = ${key} AND (expires_at IS NULL OR expires_at > ${now})
      ORDER BY seq ASC`);
    return rows.map((row) => row.value);
  }

  async enqueue(threadId: string, entry: string): Promise<void> {
    await this.db.run(
      sql`INSERT INTO chat_queue (thread_id, entry) VALUES (${threadId}, ${entry})`,
    );
  }

  async trimQueue(threadId: string, maxSize: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM chat_queue WHERE thread_id = ${threadId} AND id NOT IN (
        SELECT id FROM chat_queue WHERE thread_id = ${threadId} ORDER BY id DESC LIMIT ${maxSize}
      )`);
  }

  async queueDepth(threadId: string): Promise<number> {
    const row = await this.db.get<{ depth: number }>(
      sql`SELECT COUNT(*) AS depth FROM chat_queue WHERE thread_id = ${threadId}`,
    );
    return Number(row?.depth ?? 0);
  }

  firstQueued(threadId: string): Promise<{ id: number; entry: string } | null> {
    return this.db.get<{ id: number; entry: string }>(sql`
      SELECT id, entry FROM chat_queue WHERE thread_id = ${threadId} ORDER BY id ASC LIMIT 1`);
  }

  async deleteQueued(id: number): Promise<void> {
    await this.db.run(sql`DELETE FROM chat_queue WHERE id = ${id}`);
  }

  async sweepExpired(now: number): Promise<void> {
    await this.db.run(
      sql`DELETE FROM chat_state_kv WHERE expires_at IS NOT NULL AND expires_at <= ${now}`,
    );
    await this.db.run(
      sql`DELETE FROM chat_lists WHERE expires_at IS NOT NULL AND expires_at <= ${now}`,
    );
    await this.db.run(sql`DELETE FROM chat_locks WHERE expires_at <= ${now}`);
  }
}
