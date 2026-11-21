import type { Lock, Message, QueueEntry, SerializedMessage, StateAdapter } from "chat";
import { getStorage } from "@/be/storage";

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

function chat() {
  return getStorage().repos.chat;
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
    await chat().subscribe(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await chat().unsubscribe(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return chat().isSubscribed(threadId);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const now = Date.now();
    const lock: Lock = { threadId, token: crypto.randomUUID(), expiresAt: now + ttlMs };
    const taken = await chat().acquireLock(threadId, lock.token, lock.expiresAt, now);
    return taken ? lock : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    return chat().extendLock(lock.threadId, lock.token, now + ttlMs, now);
  }

  async releaseLock(lock: Lock): Promise<void> {
    await chat().releaseLock(lock.threadId, lock.token);
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await chat().forceReleaseLock(threadId);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const now = Date.now();
    const row = await chat().getKv(key);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) {
      await chat().deleteExpiredKv(key, now);
      return null;
    }
    return decode<T>(row.value);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await chat().setKv(key, encode(value), expiresAtFor(ttlMs, Date.now()));
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const now = Date.now();
    return chat().setKvIfAbsent(key, encode(value), expiresAtFor(ttlMs, now), now);
  }

  async delete(key: string): Promise<void> {
    await chat().deleteKv(key);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = expiresAtFor(options?.ttlMs, now);
    const repo = chat();
    await getStorage().transaction(async () => {
      // An expired list starts over, like the memory adapter.
      await repo.deleteExpiredList(key, now);
      await repo.appendListItem(key, encode(value), expiresAt);
      if (options?.maxLength && options.maxLength > 0) {
        await repo.trimList(key, options.maxLength);
      }
      await repo.setListExpiry(key, expiresAt);
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const values = await chat().listItems(key, Date.now());
    return values.map((value) => decode<T>(value));
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const repo = chat();
    return await getStorage().transaction(async () => {
      await repo.enqueue(threadId, encode(entry));
      await repo.trimQueue(threadId, Math.max(maxSize, 0));
      return repo.queueDepth(threadId);
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const repo = chat();
    return await getStorage().transaction(async () => {
      const row = await repo.firstQueued(threadId);
      if (!row) return null;
      await repo.deleteQueued(row.id);
      return decode<QueueEntry>(row.entry);
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    return chat().queueDepth(threadId);
  }
}

/**
 * Delete expired state rows. Called from the Phase 3 watcher tick; exported
 * now for tests.
 */
export async function sweepExpired(now: number = Date.now()): Promise<void> {
  await getStorage().transaction(() => chat().sweepExpired(now));
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
