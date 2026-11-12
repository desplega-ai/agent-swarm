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

import { deleteKv, getDbClient, getKv, incrKv, upsertKv } from "./db";

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Operator ignore list: `integration:unmapped-dismissed:<kind>` / `<externalId>`,
 * no TTL. Dismissing only hides an identity from triage and stops the tracker
 * re-recording it. It never links, maps or trusts the identity.
 */
export function dismissedNamespace(kind: string): string {
  return `integration:unmapped-dismissed:${kind}`;
}

/** Value stored on the ignore list: the tracker row at dismiss time, for the dismissed view and Undo. */
export interface DismissedUnmapped {
  dismissedAt: string;
  dismissedBy: string;
  meta: unknown;
  count: number;
}

export async function isUnmappedIdentityDismissed(
  kind: string,
  externalId: string,
): Promise<boolean> {
  return (await getKv(dismissedNamespace(kind), externalId)) !== null;
}

/** Move an identity from the triage queue to the ignore list. */
export async function dismissUnmappedIdentity(
  kind: string,
  externalId: string,
  dismissedBy: string,
): Promise<void> {
  const ns = namespace(kind);
  await getDbClient().transaction(async () => {
    const meta = await getKv(ns, `${externalId}:meta`);
    const count = await getKv(ns, `${externalId}:count`);
    await upsertKv({
      namespace: dismissedNamespace(kind),
      key: externalId,
      value: {
        dismissedAt: new Date().toISOString(),
        dismissedBy,
        meta: meta?.value ?? null,
        count: Number(count?.value ?? 0),
      } satisfies DismissedUnmapped,
      valueType: "json",
    });
    await deleteKv(ns, `${externalId}:meta`);
    await deleteKv(ns, `${externalId}:count`);
  });
}

/**
 * Undo a dismissal: drop the ignore-list row and put the saved tracker row
 * back with a fresh TTL. Returns false when the identity was not dismissed.
 */
export async function restoreUnmappedIdentity(kind: string, externalId: string): Promise<boolean> {
  const ns = namespace(kind);
  return getDbClient().transaction(async () => {
    const row = await getKv(dismissedNamespace(kind), externalId);
    if (!row) return false;
    await deleteKv(dismissedNamespace(kind), externalId);
    const saved = row.value as Partial<DismissedUnmapped> | null;
    const expiresAt = Date.now() + TTL_MS;
    if (saved?.meta && typeof saved.meta === "object") {
      await upsertKv({
        namespace: ns,
        key: `${externalId}:meta`,
        value: saved.meta,
        valueType: "json",
        expiresAt,
      });
      await upsertKv({
        namespace: ns,
        key: `${externalId}:count`,
        value: Number(saved.count ?? 0),
        valueType: "integer",
        expiresAt,
      });
    }
    return true;
  });
}

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
export async function recordUnmappedIdentity(
  kind: string,
  externalId: string,
  meta: { sampleEventType: string; sampleContext: string },
): Promise<void> {
  if (await isUnmappedIdentityDismissed(kind, externalId)) return;
  const ns = namespace(kind);
  const now = new Date().toISOString();
  const expiresAt = Date.now() + TTL_MS;
  const countKey = `${externalId}:count`;

  // Snapshot count-row existence BEFORE incrementing so we know whether to
  // patch the TTL. Reads are race-tolerant: worst case two callers both see
  // "no row" and both patch — the second patch is idempotent.
  const countBefore = await getKv(ns, countKey);

  await upsertKv({
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

  const incremented = await incrKv(ns, countKey, 1);

  // First-mint TTL patch. Only patch when:
  //   * The pre-incr snapshot showed no row (or expired)
  //   * AND the post-incr value is the count we just established
  // Reading the post-incr value back keeps us from clobbering a concurrent
  // increment that already bumped past 1.
  if (countBefore === null) {
    await upsertKv({
      namespace: ns,
      key: countKey,
      value: Number(incremented.value),
      valueType: "integer",
      expiresAt,
    });
  }
}
