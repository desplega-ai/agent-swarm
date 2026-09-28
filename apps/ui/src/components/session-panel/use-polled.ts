import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Fetch now and restart the interval. */
  refresh: () => void;
}

/**
 * Minimal polling for the session panel, so it runs without a host
 * QueryClient. `load === null` pauses polling and clears the data.
 * `intervalMs` sees the latest data, so a settled session can slow down.
 */
export function usePolled<T>(
  load: (() => Promise<T>) | null,
  intervalMs: (data: T | null) => number,
): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(load !== null);
  const [nonce, setNonce] = useState(0);
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const loadRef = useRef(load);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the manual refresh trigger
  useEffect(() => {
    if (!load) {
      loadRef.current = null;
      setData(null);
      setLoading(false);
      return;
    }
    // A different resource (another session): drop the old rows right away.
    if (loadRef.current !== load) {
      loadRef.current = load;
      setData(null);
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next: T | null = null;
      try {
        next = await load();
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      }
      setLoading(false);
      timer = setTimeout(tick, intervalRef.current(next));
    };
    setLoading(true);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
}
