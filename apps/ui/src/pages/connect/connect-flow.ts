/**
 * Pure decision logic for the `/connect` route: the inbound handoff from the
 * agent-swarm.dev connector. The connector opens
 * `/connect?return_to=<connect page>&client=<client>` in a new tab; this tab
 * mints a single-use code and navigates back to `return_to` with
 * `swarm`, `code` and `client` appended. Kept free of React and `@/` imports
 * so the rules are unit-testable on their own.
 */

export const CONNECT_CLIENTS = ["chatgpt", "claude", "codex", "cursor"] as const;
export type ConnectClient = (typeof CONNECT_CLIENTS)[number];

export const CONNECT_CLIENT_NAMES: Record<ConnectClient, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

/** Matches the server's DEFAULT_CONNECTOR_CONNECT_URL. */
export const DEFAULT_CONNECTOR_CONNECT_URL = "https://mcp.agent-swarm.dev/connections";

/** Connector origins every build accepts as `return_to`. */
export const STATIC_RETURN_TO_ORIGINS = [
  "https://mcp.agent-swarm.dev",
  "https://mcp-preview.agent-swarm.dev",
] as const;

export function parseClient(value: string | null): ConnectClient {
  return CONNECT_CLIENTS.find((client) => client === value) ?? "chatgpt";
}

export function defaultConnectorLabel(client: ConnectClient): string {
  return `${CONNECT_CLIENT_NAMES[client]} connector`;
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The validated `return_to`, or null. Only exact origins on the allowlist pass:
 * the static connector origins, `extraOrigins` (each swarm's
 * `CONNECTOR_CONNECT_URL`, from discovery), and `http://localhost:*` when
 * `allowLocalhost` is set (dev builds). Never redirect to anything else.
 */
export function validateReturnTo(
  raw: string | null,
  options: { extraOrigins?: readonly string[]; allowLocalhost?: boolean } = {},
): URL | null {
  const url = parseUrl(raw);
  if (!url) return null;
  if (url.username || url.password) return null;
  if (options.allowLocalhost && url.protocol === "http:" && url.hostname === "localhost") {
    return url;
  }
  if (url.protocol !== "https:") return null;
  const allowed = new Set<string>([...STATIC_RETURN_TO_ORIGINS]);
  for (const extra of options.extraOrigins ?? []) {
    const origin = parseUrl(extra);
    if (origin?.protocol === "https:") allowed.add(origin.origin);
  }
  return allowed.has(url.origin) ? url : null;
}

/**
 * The connector URL to navigate to. The server's `connectUrl` carries
 * `swarm` and `code` on its own (env-configured) base; the base is replaced
 * by the validated `returnTo` (its own query and fragment kept), and
 * `client` is appended.
 */
export function buildConnectorRedirect(
  returnTo: URL,
  connectUrl: string,
  client: ConnectClient,
): string {
  const issued = new URL(connectUrl);
  const swarm = issued.searchParams.get("swarm");
  const code = issued.searchParams.get("code");
  if (!swarm || !code) throw new Error("The swarm returned a connect link without a code.");
  const target = new URL(returnTo.toString());
  target.searchParams.set("swarm", swarm);
  target.searchParams.set("code", code);
  target.searchParams.set("client", client);
  return target.toString();
}

export type ConnectionStep<C> =
  | { kind: "none" }
  | { kind: "selected"; connection: C }
  | { kind: "pick"; connections: C[] };

/**
 * Zero connections: send the user to add one. One: use it. Several: let the
 * user pick, unless `preferredId` (the `connection` hint the People page
 * passes) names one of them.
 */
export function selectConnectionStep<C extends { id: string }>(
  connections: readonly C[],
  preferredId?: string | null,
): ConnectionStep<C> {
  if (connections.length === 0) return { kind: "none" };
  if (connections.length === 1) return { kind: "selected", connection: connections[0] };
  const preferred = preferredId ? connections.find((c) => c.id === preferredId) : undefined;
  if (preferred) return { kind: "selected", connection: preferred };
  return { kind: "pick", connections: [...connections] };
}

export type UserStep<U> = { kind: "self"; user: U } | { kind: "pick" };

/**
 * A user-bound bearer (`aswt_` token) resolves to its user through
 * `/api/whoami`, so the picker is skipped. An operator key, or an older
 * server without whoami (null), needs a pick.
 */
export function resolveUserStep<U>(
  whoami: { kind: "operator" | "user"; user: U | null } | null,
): UserStep<U> {
  if (whoami?.kind === "user" && whoami.user) return { kind: "self", user: whoami.user };
  return { kind: "pick" };
}

const LAST_USER_KEY_PREFIX = "agent-swarm-connect-user:";

export function lastUserStorageKey(connectionId: string): string {
  return `${LAST_USER_KEY_PREFIX}${connectionId}`;
}
