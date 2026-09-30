import { readFileSync } from "node:fs";
import path from "node:path";

export interface ModelsDevCostBlock {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevReasoningOption {
  type?: string;
  values?: string[];
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  cost?: ModelsDevCostBlock;
  limit?: { context?: number };
  release_date?: string;
  status?: string;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCache = Record<string, ModelsDevProvider>;

export const MODELSDEV_CACHE_PATH = path.join("src", "be", "modelsdev-cache.json");

/**
 * Parsed snapshots by file path, so a changed `MODELSDEV_CACHE_PATH` is honoured.
 * The file is 8.6 MB and its `JSON.parse` blocks the event loop for ~40 ms, so a
 * second load while the first result is still alive reuses it. References are
 * weak: the parsed tree is ~27 MB of heap that nothing needs pinned once the
 * seed and catalog have read it. Callers must treat the result as read-only.
 */
const parsedCaches = new Map<string, WeakRef<ModelsDevCache>>();

/**
 * Resolve the vendored models.dev cache from source checkouts and compiled
 * Docker images. The API image copies the snapshot to `/app/src/be/...`.
 *
 * This file is now fallback-only for pricing freshness: boot seeding uses it
 * when the DB is empty or models.dev is unavailable, while
 * `src/be/pricing-refresh.ts` owns live price updates. The UI model picker
 * fetches the live catalog from `GET /api/models-catalog`
 * (`src/be/models-catalog.ts`) and only falls back to its bundled copy of
 * this snapshot when that request hasn't resolved.
 */
export function loadModelsDevCache(): ModelsDevCache | null {
  const explicitPath = process.env.MODELSDEV_CACHE_PATH;
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    path.join(process.cwd(), MODELSDEV_CACHE_PATH),
    path.join(process.cwd(), "..", MODELSDEV_CACHE_PATH),
    path.join("/app", MODELSDEV_CACHE_PATH),
  ];

  for (const candidate of candidates) {
    const memoized = parsedCaches.get(candidate)?.deref();
    if (memoized) return memoized;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as ModelsDevCache;
      parsedCaches.set(candidate, new WeakRef(parsed));
      return parsed;
    } catch {
      // try next candidate
    }
  }

  return null;
}
