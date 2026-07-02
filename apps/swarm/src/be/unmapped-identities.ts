/**
 * Kv-backed tracker for external identities that hit a webhook handler but
 * couldn't be auto-linked to a `users` row (no email available + no existing
 * mapping in `user_external_ids`). Operators triage these via the People-page
 * Unmapped tab (Q17.D / Q14).
 *
 * Storage layout — two rows per `(kind, externalId)`:
 *   * `<externalId>:meta`  → JSON `UnmappedMeta`, upserted on each sighting
 *                            with a refreshed 30-day TTL.
 *   * `<externalId>:count` → integer, atomically incremented via `incrKv`.
 *
 * Namespace shape: `integration:unmapped:<kind>` (e.g. `integration:unmapped:slack`).
 *
 * TTL: The `:meta` row carries the canonical 30-day expiry, refreshed on every
 * sighting. The `:count` row inherits the same TTL when first minted; the
 * operator UI reads `:meta` rows and joins to `:count`, so a stale `:count`
 * without a matching `:meta` is treated as gone (and naturally expires after
 * 30 days of inactivity).
 *
 * API-side only — uses `getDb`-backed helpers via `src/be/db`. The DB-boundary
 * checker enforces that worker-side paths don't import this file.
 */

import { getKv, incrKv, upsertKv } from "./db";

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Metadata stored under `<externalId>:meta`. */
export interface UnmappedMeta {
  /** ISO timestamp of the most recent sighting. */
  lastSeenAt: string;
  /** Coarse event-type label (e.g. `message`, `assistant_message`, `block_actions`). */
  sampleEventType: string;
  /** ≤100 char excerpt of the trigger payload so operators have triage context. */
  sampleContext: string;
}

function namespace(kind: string): string {
  return `integration:unmapped:${kind}`;
}

/**
 * Record one sighting of an unmapped external identity. Emits exactly two
 * kv writes:
 *   1. `<externalId>:meta` — JSON upsert with a refreshed 30-day TTL.
 *   2. `<externalId>:count` — atomic integer increment. On the first sighting
 *      the counter row is created without a TTL by `incrKv`, so we patch it
 *      to inherit the 30-day window. Concurrent increments are safe — the
 *      patch is a no-op once the row already has a TTL.
 *
 * The writes are NOT bundled in a single transaction — the tracker is
 * best-effort audit, not a primary store. A partial failure is acceptable;
 * the next sighting reconciles.
 */
export function recordUnmappedIdentity(
  kind: string,
  externalId: string,
  meta: { sampleEventType: string; sampleContext: string },
): void {
  const ns = namespace(kind);
  const now = new Date().toISOString();
  const expiresAt = Date.now() + TTL_MS;
  const countKey = `${externalId}:count`;

  // Snapshot count-row existence BEFORE incrementing so we know whether to
  // patch the TTL. Reads are race-tolerant: worst case two callers both see
  // "no row" and both patch — the second patch is idempotent.
  const countBefore = getKv(ns, countKey);

  upsertKv({
    namespace: ns,
    key: `${externalId}:meta`,
    value: {
      lastSeenAt: now,
      sampleEventType: meta.sampleEventType,
      sampleContext: meta.sampleContext.slice(0, 100),
    } satisfies UnmappedMeta,
    valueType: "json",
    expiresAt,
  });

  const incremented = incrKv(ns, countKey, 1);

  // First-mint TTL patch. Only patch when:
  //   * The pre-incr snapshot showed no row (or expired)
  //   * AND the post-incr value is the count we just established
  // Reading the post-incr value back keeps us from clobbering a concurrent
  // increment that already bumped past 1.
  if (countBefore === null) {
    upsertKv({
      namespace: ns,
      key: countKey,
      value: Number(incremented.value),
      valueType: "integer",
      expiresAt,
    });
  }
}
