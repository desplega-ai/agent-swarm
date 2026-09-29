/**
 * Short-lived cache for the usage page reports (`/api/session-costs/summary`,
 * `/api/attribution/by-person`). Each open usage page polls them, and every
 * reply aggregates the whole window.
 *
 * A key holds only the request filters. An entry is fresh for
 * `USAGE_CACHE_TTL_MS` (the time bucket). Past that it is served as-is while one
 * background load revalidates it, until its total age reaches
 * `USAGE_CACHE_MAX_STALE_MS`; an older or missing entry blocks on a load.
 * Concurrent misses for one key share that load.
 *
 * The key deliberately carries no data version. The old one changed on every
 * new task or session, and the swarm creates one every few seconds, so it
 * almost never hit. The cost is staleness: the first request past the bucket
 * still gets the old value and only starts the refresh, so a new session shows
 * up on the request after that. A client polling once per bucket sees it about
 * one poll later. A credential plan or name change clears the cache.
 */

export const USAGE_CACHE_TTL_MS = 30_000;
export const USAGE_CACHE_MAX_STALE_MS = 120_000;
const MAX_ENTRIES = 100;

const entries = new Map<string, { fetchedAt: number; value: unknown }>();
const loading = new Map<string, Promise<unknown>>();
// Bumped by `clearUsageCache`, so a load that started before the clear cannot
// write its (now outdated) result back.
let generation = 0;

function load<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const running = loading.get(key);
  if (running) return running as Promise<T>;

  const startedIn = generation;
  const promise: Promise<T> = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (startedIn === generation) {
        entries.delete(key);
        // Map order is insertion order, so the first key is the oldest entry.
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
        entries.set(key, { fetchedAt: Date.now(), value });
      }
      return value;
    })
    .finally(() => {
      if (loading.get(key) === promise) loading.delete(key);
    });
  loading.set(key, promise);
  return promise;
}

export async function cachedUsageReport<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit) {
    const age = Date.now() - hit.fetchedAt;
    if (age < USAGE_CACHE_TTL_MS) return hit.value as T;
    if (age < USAGE_CACHE_MAX_STALE_MS) {
      // Keep serving the stale value; a failed refresh retries on the next request.
      load(key, loader).catch((error) => {
        console.error(`[usage-cache] background refresh failed for ${key.split(":")[0]}:`, error);
      });
      return hit.value as T;
    }
  }
  return load(key, loader);
}

export function clearUsageCache(): void {
  generation++;
  entries.clear();
  loading.clear();
}
