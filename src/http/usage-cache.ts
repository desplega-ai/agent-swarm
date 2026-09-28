/**
 * Short-lived cache for the usage page reports (`/api/session-costs/summary`,
 * `/api/attribution/by-person`). Each open usage page polls them, and every
 * reply aggregates the whole window.
 *
 * A key holds the request filters plus a data version (see
 * `getUsageDataVersion`), so a new session or task misses the cache at once.
 * Changes to existing rows (a task re-attributed to another requester) show
 * after at most `USAGE_CACHE_TTL_MS`. A credential plan or name change
 * clears the cache.
 */

export const USAGE_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 100;

const entries = new Map<string, { expiresAt: number; value: unknown }>();

export async function cachedUsageReport<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const value = await load();
  entries.delete(key);
  // Map order is insertion order, so the first key is the oldest entry.
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  entries.set(key, { expiresAt: now + USAGE_CACHE_TTL_MS, value });
  return value;
}

export function clearUsageCache(): void {
  entries.clear();
}
