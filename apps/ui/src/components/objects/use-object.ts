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
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetchFn(
    path,
    // no-store: a cached GET would hide a newer version from the poll.
    init ? { method: init.method, body: JSON.stringify(init.body) } : { cache: "no-store", signal },
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

/** The reads of one object and fetch. A response older than one already taken is dropped. */
type ReadSession = {
  objectId: string;
  fetchFn: ObjectFetch;
  abort: AbortController;
  issued: number;
  taken: number;
};

/**
 * Read an object, then poll it every 4 s while the tab is visible. A poll sends
 * `knownVersion`, so an unchanged object costs no download. `refetch` forces a
 * full read and resolves with it. `markVersion` records a version this viewer
 * just saved, so the next poll does not download its own write.
 *
 * Only the newest response counts: a switch of object or fetch aborts the old
 * reads, and a read that returns after a later one (or after a save) is dropped,
 * so a slow response can never put an older object or version on screen.
 */
export function useObject(objectId: string, fetchFn: ObjectFetch) {
  const [snapshot, setSnapshot] = useState<ObjectSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const known = useRef<number | null>(null);
  const current = useRef<ObjectSnapshot | null>(null);
  const session = useRef<ReadSession | null>(null);

  const read = useCallback(
    async (full: boolean): Promise<ObjectSnapshot | null> => {
      const s = session.current;
      // A refetch kept from an earlier object (a sheet write that lands late) reads nothing.
      if (!s || s.objectId !== objectId || s.fetchFn !== fetchFn) return null;
      const seq = ++s.issued;
      const stale = () => s !== session.current || seq <= s.taken;
      const base = `/api/objects/${encodeURIComponent(objectId)}`;
      const path = !full && known.current !== null ? `${base}?knownVersion=${known.current}` : base;
      try {
        const res = await objectCall<ReadResponse>(fetchFn, path, undefined, s.abort.signal);
        // A newer read already landed: hand back what is on screen, never this older body.
        if (stale()) return s === session.current ? current.current : null;
        s.taken = seq;
        setError(null);
        if (res.unchanged) return null;
        known.current = res.version;
        const next = { object: res.object, version: res.version, content: res.content };
        current.current = next;
        setSnapshot(next);
        return next;
      } catch (err) {
        if (stale()) return null;
        s.taken = seq;
        setError(err instanceof Error ? err : new Error(String(err)));
        return null;
      }
    },
    [objectId, fetchFn],
  );

  useEffect(() => {
    const s: ReadSession = {
      objectId,
      fetchFn,
      abort: new AbortController(),
      issued: 0,
      taken: 0,
    };
    session.current = s;
    known.current = null;
    current.current = null;
    setSnapshot(null);
    setError(null);
    void read(true);
    const timer = setInterval(() => {
      if (!document.hidden) void read(false);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      s.abort.abort();
      if (session.current === s) session.current = null;
    };
  }, [read, objectId, fetchFn]);

  const refetch = useCallback(() => read(true), [read]);
  const markVersion = useCallback((version: number | null) => {
    known.current = version;
    // A read sent before this save may carry the older version; drop it.
    const s = session.current;
    if (s) s.taken = s.issued;
  }, []);

  return { snapshot, error, refetch, markVersion };
}
