import { useCallback, useEffect, useRef, useState } from "react";

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

/** Ticking Date.now() — drives Spinner/Elapsed. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
