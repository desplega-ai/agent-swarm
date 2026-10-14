import type { Lock, Message, QueueEntry, SerializedMessage, StateAdapter } from "chat";
import { getDbClient } from "@/be/db";

/**
 * Chat SDK `StateAdapter` backed by the dedicated `chat_*` tables (migration
 * 213). Every method is one statement or one short transaction through the
 * async DB seam, so each operation is atomic by construction.
 *
 * Expiry columns hold epoch milliseconds. A `ttlMs` of 0 or undefined means no
 * expiry. Queue entries are not filtered by `expiresAt` here: the Chat core
 * drops expired entries itself on dequeue.
 */

function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

function expiresAtFor(ttlMs: number | undefined, now: number): number | null {
  return ttlMs ? now + ttlMs : null;
}

export class SqliteChatState implements StateAdapter {
  async connect(): Promise<void> {}

  /**
   * No-op on purpose. The memory adapter clears subscriptions on disconnect
   * because it is memory. A durable store keeps "we own this thread" across
   * restarts, and locks expire by TTL.
   */
  async disconnect(): Promise<void> {}

  async subscribe(threadId: string): Promise<void> {
    await getDbClient().run("INSERT OR IGNORE INTO chat_subscriptions (thread_id) VALUES (?)", [
      threadId,
    ]);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await getDbClient().run("DELETE FROM chat_subscriptions WHERE thread_id = ?", [threadId]);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const row = await getDbClient().get<{ one: number }>(
      "SELECT 1 AS one FROM chat_subscriptions WHERE thread_id = ?",
      [threadId],
    );
    return row !== null;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const now = Date.now();
    const lock: Lock = { threadId, token: crypto.randomUUID(), expiresAt: now + ttlMs };
    const result = await getDbClient().run(
      `INSERT INTO chat_locks (thread_id, token, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         token = excluded.token,
         expires_at = excluded.expires_at
       WHERE chat_locks.expires_at <= ?`,
      [threadId, lock.token, lock.expiresAt, now],
    );
    return result.changes > 0 ? lock : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const result = await getDbClient().run(
      "UPDATE chat_locks SET expires_at = ? WHERE thread_id = ? AND token = ? AND expires_at > ?",
      [now + ttlMs, lock.threadId, lock.token, now],
    );
    return result.changes > 0;
  }

  async releaseLock(lock: Lock): Promise<void> {
    await getDbClient().run("DELETE FROM chat_locks WHERE thread_id = ? AND token = ?", [
      lock.threadId,
      lock.token,
    ]);
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await getDbClient().run("DELETE FROM chat_locks WHERE thread_id = ?", [threadId]);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const now = Date.now();
    const row = await getDbClient().get<{ value: string; expires_at: number | null }>(
      "SELECT value, expires_at FROM chat_state_kv WHERE key = ?",
      [key],
    );
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) {
      await getDbClient().run("DELETE FROM chat_state_kv WHERE key = ? AND expires_at <= ?", [
        key,
        now,
      ]);
      return null;
    }
    return decode<T>(row.value);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await getDbClient().run(
      `INSERT INTO chat_state_kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      [key, encode(value), expiresAtFor(ttlMs, Date.now())],
    );
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const now = Date.now();
    const result = await getDbClient().run(
      `INSERT INTO chat_state_kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
       WHERE chat_state_kv.expires_at IS NOT NULL AND chat_state_kv.expires_at <= ?`,
      [key, encode(value), expiresAtFor(ttlMs, now), now],
    );
    return result.changes > 0;
  }

  async delete(key: string): Promise<void> {
    await getDbClient().run("DELETE FROM chat_state_kv WHERE key = ?", [key]);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = expiresAtFor(options?.ttlMs, now);
    await getDbClient().transaction(async (tx) => {
      // An expired list starts over, like the memory adapter.
      await tx.run(
        "DELETE FROM chat_lists WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?",
        [key, now],
      );
      await tx.run(
        `INSERT INTO chat_lists (key, seq, value, expires_at)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_lists WHERE key = ?), ?, ?)`,
        [key, key, encode(value), expiresAt],
      );
      if (options?.maxLength && options.maxLength > 0) {
        await tx.run(
          `DELETE FROM chat_lists WHERE key = ? AND seq NOT IN (
             SELECT seq FROM chat_lists WHERE key = ? ORDER BY seq DESC LIMIT ?
           )`,
          [key, key, options.maxLength],
        );
      }
      await tx.run("UPDATE chat_lists SET expires_at = ? WHERE key = ?", [expiresAt, key]);
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const rows = await getDbClient().query<{ value: string }>(
      `SELECT value FROM chat_lists
       WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY seq ASC`,
      [key, Date.now()],
    );
    return rows.map((row) => decode<T>(row.value));
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    return await getDbClient().transaction(async (tx) => {
      await tx.run("INSERT INTO chat_queue (thread_id, entry) VALUES (?, ?)", [
        threadId,
        encode(entry),
      ]);
      await tx.run(
        `DELETE FROM chat_queue WHERE thread_id = ? AND id NOT IN (
           SELECT id FROM chat_queue WHERE thread_id = ? ORDER BY id DESC LIMIT ?
         )`,
        [threadId, threadId, Math.max(maxSize, 0)],
      );
      const row = await tx.get<{ depth: number }>(
        "SELECT COUNT(*) AS depth FROM chat_queue WHERE thread_id = ?",
        [threadId],
      );
      return row?.depth ?? 0;
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    return await getDbClient().transaction(async (tx) => {
      const row = await tx.get<{ id: number; entry: string }>(
        "SELECT id, entry FROM chat_queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1",
        [threadId],
      );
      if (!row) return null;
      await tx.run("DELETE FROM chat_queue WHERE id = ?", [row.id]);
      return decode<QueueEntry>(row.entry);
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    const row = await getDbClient().get<{ depth: number }>(
      "SELECT COUNT(*) AS depth FROM chat_queue WHERE thread_id = ?",
      [threadId],
    );
    return row?.depth ?? 0;
  }
}

/**
 * Delete expired state rows. Called from the Phase 3 watcher tick; exported
 * now for tests.
 */
export async function sweepExpired(now: number = Date.now()): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    await tx.run("DELETE FROM chat_state_kv WHERE expires_at IS NOT NULL AND expires_at <= ?", [
      now,
    ]);
    await tx.run("DELETE FROM chat_lists WHERE expires_at IS NOT NULL AND expires_at <= ?", [now]);
    await tx.run("DELETE FROM chat_locks WHERE expires_at <= ?", [now]);
  });
}

/**
 * Key prefix of the SDK `ThreadHistoryCache` (chat 4.41): the per-thread
 * message list for adapters with `persistThreadHistory` (Telegram, WhatsApp).
 * Pinned by `chat-sdk-commands.test.ts` against the real SDK.
 */
export const SDK_THREAD_HISTORY_PREFIX = "msg-history:";

/**
 * The thread history the SDK persisted here, oldest first. The adapters that
 * persist it answer `fetchMessages` from process memory, and the SDK reads this
 * store only when that memory is empty. After a restart the memory holds just
 * the newest message, so callers merge both sources themselves.
 */
export async function readPersistedThreadHistory(threadId: string): Promise<Message[]> {
  const rows = await new SqliteChatState().getList<SerializedMessage>(
    `${SDK_THREAD_HISTORY_PREFIX}${threadId}`,
  );
  if (rows.length === 0) return [];
  const { Message: MessageClass } = await import("chat");
  return rows.map((row) => MessageClass.fromJSON(row));
}
