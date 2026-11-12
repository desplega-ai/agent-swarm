import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How ObjectEmbed reaches `/api/objects/:id/*`. The host injects it: the
 * dashboard passes `api.fetchApi` (its base URL and headers), a page host can
 * pass a fetch on its own `/@swarm/api` prefix. Paths start with `/api/`.
 */
export type ObjectFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type ObjectRecord = {
  id: string;
  kind: string;
  title: string | null;
  fileVersion: number | null;
  link: string | null;
};

export type ObjectSnapshot = { object: ObjectRecord; version: number | null; content: unknown };

export class ObjectRequestError extends Error {
  readonly status: number;
  /** The file's current version, on a board 409. */
  readonly version: number | null | undefined;
  constructor(status: number, message: string, version?: number | null) {
    super(message);
    this.status = status;
    this.version = version;
  }
}

/** One JSON call; a non-2xx becomes an `ObjectRequestError` with the server's message. */
export async function objectCall<T>(
  fetchFn: ObjectFetch,
  path: string,
  init?: { method: string; body: unknown },
): Promise<T> {
  const res = await fetchFn(
    path,
    // no-store: a cached GET would hide a newer version from the poll.
    init ? { method: init.method, body: JSON.stringify(init.body) } : { cache: "no-store" },
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof body.error === "string" ? body.error : `request failed (${res.status})`;
    const version = typeof body.version === "number" ? body.version : undefined;
    throw new ObjectRequestError(res.status, message, version);
  }
  return body as T;
}

type ReadResponse = {
  object: ObjectRecord;
  version: number | null;
  unchanged: boolean;
  content?: unknown;
};

export const POLL_MS = 4000;

/**
 * Read an object, then poll it every 4 s while the tab is visible. A poll sends
 * `knownVersion`, so an unchanged object costs no download. `refetch` forces a
 * full read and resolves with it. `markVersion` records a version this viewer
 * just saved, so the next poll does not download its own write.
 */
export function useObject(objectId: string, fetchFn: ObjectFetch) {
  const [snapshot, setSnapshot] = useState<ObjectSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const known = useRef<number | null>(null);

  const read = useCallback(
    async (full: boolean): Promise<ObjectSnapshot | null> => {
      const base = `/api/objects/${encodeURIComponent(objectId)}`;
      const path = !full && known.current !== null ? `${base}?knownVersion=${known.current}` : base;
      try {
        const res = await objectCall<ReadResponse>(fetchFn, path);
        setError(null);
        if (res.unchanged) return null;
        known.current = res.version;
        const next = { object: res.object, version: res.version, content: res.content };
        setSnapshot(next);
        return next;
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        return null;
      }
    },
    [objectId, fetchFn],
  );

  useEffect(() => {
    known.current = null;
    setSnapshot(null);
    setError(null);
    void read(true);
    const timer = setInterval(() => {
      if (!document.hidden) void read(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  const refetch = useCallback(() => read(true), [read]);
  const markVersion = useCallback((version: number | null) => {
    known.current = version;
  }, []);

  return { snapshot, error, refetch, markVersion };
}
