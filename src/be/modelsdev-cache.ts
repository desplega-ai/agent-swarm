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
    try {
      return JSON.parse(readFileSync(candidate, "utf-8")) as ModelsDevCache;
    } catch {
      // try next candidate
    }
  }

  return null;
}
