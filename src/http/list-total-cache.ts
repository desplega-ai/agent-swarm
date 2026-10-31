/**
 * A 30-second cache of list `total`s, keyed by filter set.
 *
 * A list total is a COUNT over the same filters as the page, and on the large
 * tables behind the sessions and task lists it costs as much as the page
 * itself. By default page 1 (offset 0) always counts, so a write (a new
 * session, a triage move) shows at once where the user looks first. A list
 * whose count is expensive and whose total may lag can pass
 * `firstPageTtlMs`: page 1 then reuses a count younger than that, so
 * dashboard tabs that poll the same list share one count. Later pages reuse
 * that count for 30 s. A cold later page (deep link, expired entry) counts
 * too, so `total` is always set.
 */

export const LIST_TOTAL_TTL_MS = 30_000;
const MAX_ENTRIES = 500;

interface Entry {
  countedAt: number;
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

export function createListTotalCache(
  ttlMs = LIST_TOTAL_TTL_MS,
  firstPageTtlMs = 0,
): ListTotalCache {
  const entries = new Map<string, Entry>();
  return {
    get(filters, offset, compute) {
      const key = filterKey(filters);
      const now = Date.now();
      const hit = entries.get(key);
      const maxAge = (offset ?? 0) > 0 ? ttlMs : Math.min(ttlMs, firstPageTtlMs);
      if (hit && hit.countedAt + maxAge > now) return hit.total;
      if (hit) entries.delete(key);

      // Cache the promise, so a request that arrives mid-count shares it.
      const total = compute();
      entries.set(key, { countedAt: now, total });
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
