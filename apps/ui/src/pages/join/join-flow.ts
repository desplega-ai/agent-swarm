/**
 * Pure decision logic for the `/join` route: a teammate opens the invite link
 * `/join?swarm=<API URL>#code=<one-time code>`. After the teammate confirms
 * the host, the page trades the code for a personal token, saves it as a
 * normal dashboard connection, and lands the teammate on Home (or on Comb when
 * Comb is on, so it connects their files account). Kept free of React and `@/` imports so the rules are
 * unit-testable on their own.
 */

export interface JoinParams {
  /** The API URL, without a trailing slash. */
  swarm: string;
  code: string;
}

/** The URL params `/join` reads, and drops from history at once. */
export const JOIN_URL_PARAMS = ["swarm", "code"] as const;

/** Read the fragment code first. Older links can supply the code in the query. */
export function parseJoinParams(search: string, hash = ""): JoinParams | null {
  const params = new URLSearchParams(search);
  const rawSwarm = params.get("swarm")?.trim();
  const code =
    new URLSearchParams(hash.replace(/^#/, "")).get("code")?.trim() || params.get("code")?.trim();
  if (!rawSwarm || !code) return null;
  let url: URL;
  try {
    url = new URL(rawSwarm);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return { swarm: rawSwarm.replace(/\/+$/, ""), code };
}

/** The query string without the join params (`""` when nothing else is left). */
export function withoutJoinParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of JOIN_URL_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** The connection name for a swarm URL: its host. */
export function swarmHost(swarm: string): string {
  try {
    return new URL(swarm).host || swarm;
  } catch {
    return swarm;
  }
}

/** An HTTP failure of a join call. `status` is null for a network failure. */
export class JoinApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, status: number | null, code: string | null = null) {
    super(message);
    this.name = "JoinApiError";
    this.status = status;
    this.code = code;
  }
}

export interface JoinConnection {
  id: string;
}

export interface JoinDeps {
  /** True when a baked deployment connection manages this dashboard's connections. */
  connectionsManaged: () => boolean;
  /** `POST <swarm>/api/invites/exchange`. */
  exchange: (swarm: string, code: string) => Promise<{ token: string; userId: string }>;
  /** `useConfig().addConnection`. Throws in builds with a baked deployment connection. */
  addConnection: (conn: { name: string; apiUrl: string; apiKey: string }) => JoinConnection;
  /** `useConfig().switchConnection`. */
  switchConnection: (id: string) => void;
  /** Whether Comb is on, from `GET <swarm>/status` with the new token. */
  combEnabled: (swarm: string, token: string) => Promise<boolean>;
}

export type JoinOutcome =
  /** Saved and activated: navigate to `redirect`. */
  | { kind: "joined"; redirect: string; host: string }
  /** 404 `code_invalid`: the link is used or expired. */
  | { kind: "invalid" }
  /** A baked deployment connection: the dashboard cannot add connections. */
  | { kind: "managed" }
  | { kind: "failed"; message: string; retryable: boolean };

export const JOIN_COPY = {
  invalid: "This invite link is used or expired. Ask the admin for a new one.",
  managed:
    "This dashboard is managed by its deployment. Open the invite in the dashboard of that swarm.",
  missing: "This invite link is incomplete. Open the full link from your invite.",
} as const;

/** Where to land after joining. Comb on: Comb, which then connects the files account. */
export function joinRedirect(combEnabled: boolean): string {
  return combEnabled ? "/file?connect=auto" : "/";
}

/**
 * Trade the code, save the connection, and pick the landing page. The managed
 * check runs before the exchange, so a dashboard that cannot save the token
 * never spends the one-time code.
 */
export async function runJoin(deps: JoinDeps, params: JoinParams): Promise<JoinOutcome> {
  if (deps.connectionsManaged()) return { kind: "managed" };

  let token: string;
  try {
    token = (await deps.exchange(params.swarm, params.code)).token;
  } catch (err) {
    if (err instanceof JoinApiError && err.status === 404) return { kind: "invalid" };
    if (err instanceof JoinApiError && err.status === 429) {
      return {
        kind: "failed",
        message: "Too many attempts. Wait a minute, then retry.",
        retryable: true,
      };
    }
    if (err instanceof JoinApiError && err.status === null) {
      return { kind: "failed", message: err.message, retryable: true };
    }
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : "Could not join this swarm.",
      retryable: false,
    };
  }

  const host = swarmHost(params.swarm);
  let connection: JoinConnection;
  try {
    connection = deps.addConnection({ name: host, apiUrl: params.swarm, apiKey: token });
  } catch {
    return { kind: "managed" };
  }
  deps.switchConnection(connection.id);

  let comb = false;
  try {
    comb = await deps.combEnabled(params.swarm, token);
  } catch {
    // `/status` failed: Home works without Comb.
  }
  return { kind: "joined", redirect: joinRedirect(comb), host };
}
