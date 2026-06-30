import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getModels, listConfigs } from "./api.ts";
import type { ConfigJson, ModelJson, ModelsResponse } from "./types.ts";

export interface Route {
  /** "#/runs/a/attempts/b" → ["runs", "a", "attempts", "b"] */
  parts: string[];
  /** The full hash path, e.g. "#/runs/a/attempts/b". */
  path: string;
}

function parseHash(): Route {
  const raw = window.location.hash || "#/";
  const path = raw.startsWith("#") ? raw.slice(1) : raw;
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  return { parts, path: raw };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** path starts with "#/". */
export function navigate(path: string): void {
  window.location.hash = path;
}

export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number | null, // null → fetch once
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // biome-ignore lint/correctness/useExhaustiveDependencies: caller-supplied deps drive refetch; fn goes through a ref
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const schedule = () => {
      if (cancelled || intervalMs === null) return;
      timer = window.setTimeout(() => {
        // pause polling while the tab is hidden; previous data stays on screen
        if (document.hidden) schedule();
        else void run();
      }, intervalMs);
    };

    const run = async () => {
      try {
        const result = await fnRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
      schedule();
    };

    setLoading(true);
    void run();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [...deps, intervalMs, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refresh };
}

const CATALOG_CACHE_TTL_MS = 60_000;

function isCatalogCacheStale(lastFetchedAt: number): boolean {
  return lastFetchedAt === 0 || Date.now() - lastFetchedAt > CATALOG_CACHE_TTL_MS;
}

// ---- models.dev catalog (stale-while-revalidate cache, shared by every ModelChip) ----

let modelsCache: ModelsResponse | null = null;
let modelsPromise: Promise<ModelsResponse> | null = null;
let modelsFetchedAt = 0;
const modelsSubscribers = new Set<(data: ModelsResponse) => void>();

export interface ModelLookup {
  models: ModelJson[];
  defaultJudgeModel: string | null;
  /** Resolve any observed model-id shape to a catalog entry (null when unknown). */
  resolve: (id: string | null) => ModelJson | null;
  /** False while the first fetch is still in flight. */
  loaded: boolean;
}

/** Candidate catalog ids for an observed model id (config override, harness output, …). */
function modelIdCandidates(id: string): string[] {
  const out = [id];
  const unprefixed = id.startsWith("openrouter/") ? id.slice("openrouter/".length) : id;
  if (unprefixed !== id) out.push(unprefixed);
  const dateless = unprefixed.replace(/-\d{8}$/, ""); // claude-haiku-4-5-20251001 → claude-haiku-4-5
  if (dateless !== unprefixed) out.push(dateless);
  const dotted = dateless.replace(/-(\d+)-(\d+)$/, "-$1.$2"); // claude-haiku-4-5 → claude-haiku-4.5
  if (dotted !== dateless) out.push(dotted);
  return out;
}

function refreshModelsCache(): Promise<ModelsResponse> {
  modelsPromise ??= getModels()
    .then((res) => {
      modelsCache = res;
      modelsFetchedAt = Date.now();
      for (const notify of modelsSubscribers) notify(res);
      return res;
    })
    .finally(() => {
      modelsPromise = null;
    });
  return modelsPromise;
}

function revalidateModelsCache(): void {
  if (modelsCache !== null && !isCatalogCacheStale(modelsFetchedAt)) return;
  void refreshModelsCache().catch(() => {
    // Keep the last good cache; a later mount/focus will retry.
  });
}

/** Cached models.dev catalog + resolver. Revalidates stale `/api/models` data in the background. */
export function useModels(): ModelLookup {
  const [data, setData] = useState<ModelsResponse | null>(modelsCache);
  useEffect(() => {
    let cancelled = false;
    const notify = (res: ModelsResponse) => {
      if (!cancelled) setData(res);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) revalidateModelsCache();
    };

    modelsSubscribers.add(notify);
    revalidateModelsCache();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      modelsSubscribers.delete(notify);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return useMemo<ModelLookup>(() => {
    const models = data?.models ?? [];
    const aliases = data?.aliases ?? {};
    const byId = new Map(models.map((m) => [m.id, m]));
    const resolve = (id: string | null): ModelJson | null => {
      if (id === null || id.length === 0 || models.length === 0) return null;
      // v7 §8: bare claude aliases ("fable") resolve to the latest family
      // member ("claude-fable-5") via the server-computed frozen map FIRST,
      // then go through the normal candidate chain (dotted/suffix matching).
      const target = aliases[id.trim().toLowerCase()] ?? id;
      for (const candidate of modelIdCandidates(target)) {
        const hit = byId.get(candidate);
        if (hit) return hit;
      }
      // last resort: suffix match ("deepseek-v4-flash" → "deepseek/deepseek-v4-flash")
      for (const candidate of modelIdCandidates(target)) {
        const hit = models.find((m) => m.id.endsWith(`/${candidate}`));
        if (hit) return hit;
      }
      return null;
    };
    return {
      models,
      defaultJudgeModel: data?.defaultJudgeModel ?? null,
      resolve,
      loaded: data !== null,
    };
  }, [data]);
}

// ---- config catalog (stale-while-revalidate cache, shared by every ConfigChip) ----

let configsCache: ConfigJson[] | null = null;
let configsPromise: Promise<ConfigJson[]> | null = null;
let configsFetchedAt = 0;
const configsSubscribers = new Set<(data: ConfigJson[]) => void>();

export interface ConfigLookup {
  configs: ConfigJson[];
  /** Resolve a config id to its registry entry (null when unknown/removed). */
  byId: (id: string | null) => ConfigJson | null;
  /** False while the first fetch is still in flight. */
  loaded: boolean;
}

function refreshConfigsCache(): Promise<ConfigJson[]> {
  configsPromise ??= listConfigs()
    .then((res) => {
      configsCache = res;
      configsFetchedAt = Date.now();
      for (const notify of configsSubscribers) notify(res);
      return res;
    })
    .finally(() => {
      configsPromise = null;
    });
  return configsPromise;
}

function revalidateConfigsCache(): void {
  if (configsCache !== null && !isCatalogCacheStale(configsFetchedAt)) return;
  void refreshConfigsCache().catch(() => {
    // Keep the last good cache; a later mount/focus will retry.
  });
}

/** Cached config catalog. Revalidates stale `/api/configs` data in the background. */
export function useConfigs(): ConfigLookup {
  const [data, setData] = useState<ConfigJson[] | null>(configsCache);
  useEffect(() => {
    let cancelled = false;
    const notify = (res: ConfigJson[]) => {
      if (!cancelled) setData(res);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) revalidateConfigsCache();
    };

    configsSubscribers.add(notify);
    revalidateConfigsCache();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      configsSubscribers.delete(notify);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return useMemo<ConfigLookup>(() => {
    const configs = data ?? [];
    const map = new Map(configs.map((c) => [c.id, c]));
    return {
      configs,
      byId: (id) => (id === null ? null : (map.get(id) ?? null)),
      loaded: data !== null,
    };
  }, [data]);
}

/** Ticking Date.now() — drives Spinner/Elapsed. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
