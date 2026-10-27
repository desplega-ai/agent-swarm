/**
 * The swarm API answers 401 to every route when it no longer accepts the
 * saved key: an admin suspended the user, revoked the `aswt_` token, or the
 * operator key changed. `api/client.ts` reports each 401 from the swarm API
 * here, and the app shell probes once to confirm (`use-access-check.ts`).
 *
 * Relative imports only: `bun:test` runs this from the repo root.
 */

/** The connection a request used: its API URL and saved key. */
export interface AccessConnection {
  apiUrl: string;
  apiKey: string;
}

/**
 * One saved access: the API URL plus the key's last 4 characters (the
 * preview `useWhoami` keys by), never the key itself.
 */
export function accessId({ apiUrl, apiKey }: AccessConnection): string {
  return `${apiUrl.replace(/\/+$/, "")}|${apiKey.slice(-4)}`;
}

/**
 * Whether a 401 for `url` means the swarm rejects the saved key. Only a
 * request to the connection's API that carried its bearer counts. Not the
 * agent-fs proxy (`/agentfs/*`: agent-fs answers those), and not another host
 * (the telemetry proxy). A relative URL is the dev proxy to the API.
 */
export function isKeyRejection(
  url: string,
  headers: HeadersInit | undefined,
  connection: AccessConnection,
  origin: string,
): boolean {
  if (!connection.apiKey) return false;
  if (new Headers(headers).get("authorization") !== `Bearer ${connection.apiKey}`) return false;

  let path: string;
  try {
    const target = new URL(url, origin);
    if (url.startsWith("/") && !url.startsWith("//")) {
      path = target.pathname;
    } else {
      const base = new URL(connection.apiUrl);
      const basePath = base.pathname.replace(/\/+$/, "");
      if (target.origin !== base.origin) return false;
      if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
        return false;
      }
      path = target.pathname.slice(basePath.length);
    }
  } catch {
    return false;
  }
  return path !== "/agentfs" && !path.startsWith("/agentfs/");
}

type RejectionListener = (id: string) => void;

const listeners = new Set<RejectionListener>();

/** Call `listener` with the `accessId` of each rejected request. Returns the unsubscribe. */
export function subscribeKeyRejection(listener: RejectionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Report a 401 response. Notifies only when it is a key rejection (see `isKeyRejection`). */
export function noteUnauthorized(
  url: string,
  headers: HeadersInit | undefined,
  connection: AccessConnection,
  origin: string,
): void {
  if (!isKeyRejection(url, headers, connection, origin)) return;
  const id = accessId(connection);
  for (const listener of [...listeners]) listener(id);
}

/** The accesses a probe confirmed as rejected, in this tab. */
const ended = new Set<string>();
const endedListeners = new Set<() => void>();

function emitEnded() {
  for (const listener of [...endedListeners]) listener();
}

/** For `useSyncExternalStore`. */
export function subscribeEndedAccess(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => {
    endedListeners.delete(listener);
  };
}

export function isAccessEnded(id: string): boolean {
  return ended.has(id);
}

export function setAccessEnded(id: string, value: boolean): void {
  if (ended.has(id) === value) return;
  if (value) ended.add(id);
  else ended.delete(id);
  emitEnded();
}
