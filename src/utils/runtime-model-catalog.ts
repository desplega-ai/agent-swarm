/**
 * Process-wide model catalog for code that runs on BOTH sides of the
 * API/worker boundary (provider adapters, context-window math, reasoning
 * gating). Model-catalog phase 4: this replaces the hand-maintained per-model
 * tables (codex allowlist/windows/pricing, claude-managed allowlist/pricing,
 * per-model context windows, the slim reasoning snapshot).
 *
 * Sources, highest first:
 *   1. the live catalog: the API server's `model_catalog` + overlay rows.
 *      Workers pull it over HTTP (`GET /api/models-catalog`, see
 *      `refreshRuntimeModelCatalog`); the API process sets it directly after
 *      every catalog reload.
 *   2. the vendored models.dev snapshot (`src/be/modelsdev-cache.json`) —
 *      offline fallback, and the only source for ids the live catalog has
 *      dropped (legacy models still named by old tasks and pricing rows).
 *
 * NO database imports (worker-safe). Every lookup is synchronous; the HTTP
 * refresh is TTL-cached and never throws, so hot paths stay cheap.
 */
import modelsDevSnapshot from "../be/modelsdev-cache.json";

export interface RuntimeCatalogModel {
  id?: string;
  name?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number };
  release_date?: string;
  status?: string;
  reasoning?: boolean;
  reasoning_options?: { type?: string; values?: string[] }[];
}

export interface RuntimeCatalogProvider {
  id?: string;
  name?: string;
  models?: Record<string, RuntimeCatalogModel>;
}

export type RuntimeCatalog = Record<string, RuntimeCatalogProvider | undefined>;

const SNAPSHOT = modelsDevSnapshot as unknown as RuntimeCatalog;

/** Default freshness window for the worker-side HTTP pull. */
export const RUNTIME_CATALOG_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let live: RuntimeCatalog | null = null;
let liveAt = 0;
let liveSource: "live" | "snapshot" | null = null;
const mergedSections = new Map<string, Record<string, RuntimeCatalogModel>>();
let inFlight: Promise<boolean> | null = null;

/** Replace the live layer (API process after a reload; worker after a pull). */
export function setRuntimeModelCatalog(
  providers: RuntimeCatalog,
  at: number = Date.now(),
  source: "live" | "snapshot" = "live",
): void {
  live = providers;
  liveAt = at;
  liveSource = source;
  mergedSections.clear();
}

export function resetRuntimeModelCatalogForTests(): void {
  live = null;
  liveAt = 0;
  liveSource = null;
  mergedSections.clear();
  inFlight = null;
}

/** Where the current live layer came from; null = snapshot only. */
export function runtimeModelCatalogSource(): "live" | "snapshot" | null {
  return liveSource;
}

/** One provider section: snapshot models overlaid by the live catalog (live wins per id). */
export function runtimeCatalogSection(provider: string): Record<string, RuntimeCatalogModel> {
  const cached = mergedSections.get(provider);
  if (cached) return cached;
  const merged: Record<string, RuntimeCatalogModel> = {
    ...(SNAPSHOT[provider]?.models ?? {}),
    ...(live?.[provider]?.models ?? {}),
  };
  mergedSections.set(provider, merged);
  return merged;
}

export function runtimeCatalogModel(
  provider: string,
  modelId: string,
): RuntimeCatalogModel | undefined {
  return runtimeCatalogSection(provider)[modelId];
}

/**
 * Pull the live catalog from the API server. TTL-cached (`maxAgeMs`),
 * single-flight, never throws: returns false and keeps the previous layer
 * when the server is unreachable or answers non-2xx.
 */
export async function refreshRuntimeModelCatalog(opts: {
  apiUrl: string;
  apiKey?: string;
  agentId?: string;
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const maxAge = opts.maxAgeMs ?? RUNTIME_CATALOG_TTL_MS;
  if (live && Date.now() - liveAt < maxAge) return true;
  if (inFlight) return inFlight;
  const doFetch = opts.fetchImpl ?? fetch;
  inFlight = (async () => {
    try {
      const headers: Record<string, string> = {};
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
      if (opts.agentId) headers["X-Agent-ID"] = opts.agentId;
      const res = await doFetch(`${opts.apiUrl}/api/models-catalog`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        source?: "live" | "snapshot";
        providers?: RuntimeCatalog;
      };
      if (!body || typeof body.providers !== "object" || body.providers === null) return false;
      setRuntimeModelCatalog(body.providers, Date.now(), body.source ?? "live");
      return true;
    } catch {
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
