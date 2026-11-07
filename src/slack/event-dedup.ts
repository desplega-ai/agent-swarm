/**
 * Slack event idempotency cache.
 *
 * Slack's Events API (and Socket Mode delivery) retries event deliveries on
 * 3-second timeouts or 5xx responses. A slow handler — e.g. one that fetches
 * thread context before calling `createTaskExtended` — therefore produces N
 * duplicate task rows from a single user message.
 *
 * The canonical idempotency key for Slack deliveries is `event_id` on the
 * envelope (`body.event_id` in Bolt). It is unique per delivery; retries of
 * the same logical event reuse the same id.
 *
 * This module exposes a single in-memory check-and-insert that returns `false`
 * the first time we see an event_id (caller should proceed) and `true` on
 * subsequent retries within the TTL window — i.e. it answers "was this event
 * already seen?" (default TTL 25h). The TTL must outlive the last possible
 * redelivery: Slack's standard schedule ends after ~5 min, but the optional
 * Delayed Events feature retries hourly for 24h. The socket-ack wrapper
 * (`socket-ack.ts`) runs listeners for an event whose ack failed, so this cache
 * is what drops the later redelivery. Entries are an id and a number, so the
 * long TTL costs little memory.
 *
 * Single-pod-only. The API server (which owns the Slack socket) runs as a
 * single API process; if that ever changes, swap this for a DB-backed table.
 */

export const EVENT_DEDUP_TTL_MS = 25 * 60 * 60 * 1000; // 24h delayed-retry window + 1h margin
const DEFAULT_TTL_MS = EVENT_DEDUP_TTL_MS;
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

interface DedupCache {
  ttlMs: number;
  entries: Map<string, number>;
  cleanupTimer: ReturnType<typeof setInterval> | null;
}

function createCache(ttlMs: number): DedupCache {
  return {
    ttlMs,
    entries: new Map(),
    cleanupTimer: null,
  };
}

const defaultCache: DedupCache = createCache(DEFAULT_TTL_MS);

function cleanup(cache: DedupCache, now: number): void {
  for (const [key, expiresAt] of cache.entries) {
    if (expiresAt <= now) {
      cache.entries.delete(key);
    }
  }
}

function ensureCleanupTimer(cache: DedupCache): void {
  if (cache.cleanupTimer) return;
  cache.cleanupTimer = setInterval(() => {
    cleanup(cache, Date.now());
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the event loop alive on this timer.
  if (
    typeof cache.cleanupTimer === "object" &&
    cache.cleanupTimer &&
    "unref" in cache.cleanupTimer
  ) {
    (cache.cleanupTimer as { unref: () => void }).unref();
  }
}

/**
 * Internal check-and-insert. Returns `true` if the event was already seen
 * (caller should drop), `false` if this is the first sighting (caller should
 * proceed). Inserts on a miss so subsequent calls dedup.
 */
function checkAndInsert(cache: DedupCache, eventId: string, now: number): boolean {
  ensureCleanupTimer(cache);

  const existing = cache.entries.get(eventId);
  if (existing !== undefined && existing > now) {
    return true; // hit — within TTL
  }

  cache.entries.set(eventId, now + cache.ttlMs);
  return false;
}

/**
 * Has this Slack event_id been seen recently? Returns `true` if it's a retry
 * we should drop, `false` on the first delivery (and inserts so subsequent
 * calls return true).
 *
 * Pass `null`/`undefined`/empty as a no-op (returns `false`) — defensive against
 * malformed envelopes; we'd rather process once than block legitimate work.
 */
export function wasEventSeen(eventId: string | undefined | null): boolean {
  if (!eventId) return false;
  return checkAndInsert(defaultCache, eventId, Date.now());
}

/**
 * Test-only helper: build an isolated cache so tests don't leak state into
 * each other or into production.
 */
export function _createTestCache(ttlMs: number = DEFAULT_TTL_MS): {
  wasEventSeen: (eventId: string | undefined | null) => boolean;
  size: () => number;
  advance: (ms: number) => void;
  destroy: () => void;
} {
  const cache = createCache(ttlMs);
  let nowOffset = 0;
  const now = () => Date.now() + nowOffset;

  return {
    wasEventSeen: (eventId) => {
      if (!eventId) return false;
      return checkAndInsert(cache, eventId, now());
    },
    size: () => {
      cleanup(cache, now());
      return cache.entries.size;
    },
    advance: (ms) => {
      nowOffset += ms;
    },
    destroy: () => {
      if (cache.cleanupTimer) {
        clearInterval(cache.cleanupTimer);
        cache.cleanupTimer = null;
      }
      cache.entries.clear();
    },
  };
}

/**
 * Test-only helper to reset the production cache. Do not call from app code.
 */
export function _resetForTests(): void {
  defaultCache.entries.clear();
  if (defaultCache.cleanupTimer) {
    clearInterval(defaultCache.cleanupTimer);
    defaultCache.cleanupTimer = null;
  }
}
