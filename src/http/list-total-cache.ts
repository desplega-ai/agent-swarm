/**
 * A 30-second cache of list `total`s, keyed by filter set.
 *
 * A list total is a COUNT over the same filters as the page, and on the large
 * tables behind the sessions and task lists it costs as much as the page
 * itself. Page 1 (offset 0) always counts, so a write (a new session, a
 * triage move) shows at once where the user looks first. Later pages reuse
 * that count for 30 s. A cold later page (deep link, expired entry) counts
 * too, so `total` is always set.
 */

export const LIST_TOTAL_TTL_MS = 30_000;
const MAX_ENTRIES = 500;

interface Entry {
  expiresAt: number;
  total: Promise<number>;
}

export interface ListTotalCache {
  get(
    filters: Record<string, unknown>,
    offset: number | undefined,
    compute: () => Promise<number>,
  ): Promise<number>;
}

/** Stable key: sorted object keys, `undefined` fields dropped. */
function filterKey(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function createListTotalCache(ttlMs = LIST_TOTAL_TTL_MS): ListTotalCache {
  const entries = new Map<string, Entry>();
  return {
    get(filters, offset, compute) {
      const key = filterKey(filters);
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now && (offset ?? 0) > 0) return hit.total;
      if (hit) entries.delete(key);

      // Cache the promise, so a later page that arrives mid-count shares it.
      const total = compute();
      entries.set(key, { expiresAt: now + ttlMs, total });
      total.catch(() => {
        if (entries.get(key)?.total === total) entries.delete(key);
      });
      // Map iterates in insertion order, so the first key is the oldest.
      while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return total;
    },
  };
}
