import type { ConnectorCodeResponse, User, UsersResponse, WhoamiResponse } from "@/api/types";
import type { Connection } from "@/lib/config";

/**
 * `/connect` talks to the connection the user picks, which need not be the
 * dashboard's active one, so it cannot use the `api` singleton (bound to the
 * active connection). These calls take the connection explicitly.
 */

export class ConnectApiError extends Error {
  /** HTTP status, or null for a network failure. */
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ConnectApiError";
    this.status = status;
  }
}

function baseUrl(connection: Connection): string {
  // Same dev-proxy rule as the `api` singleton.
  if (import.meta.env.DEV && connection.apiUrl === "http://localhost:3013") return "";
  return connection.apiUrl.replace(/\/+$/, "");
}

async function request<T>(
  connection: Connection,
  path: string,
  init: RequestInit & { authed?: boolean } = {},
): Promise<T> {
  const { authed = true, ...rest } = init;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authed && connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrl(connection)}${path}`, { ...rest, headers });
  } catch {
    throw new ConnectApiError(`Could not reach ${connection.apiUrl}.`, null);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : `Request failed: ${res.status}`;
    throw new ConnectApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export function fetchHealth(connection: Connection) {
  return request<{ status: string; version: string }>(connection, "/health", { authed: false });
}

export interface ConnectorDiscovery {
  apiUrl: string;
  appUrl?: string;
  connectUrl: string | null;
}

/** Null on servers that predate `/api/connector/discovery`. */
export async function fetchDiscovery(connection: Connection): Promise<ConnectorDiscovery | null> {
  try {
    return await request<ConnectorDiscovery>(connection, "/api/connector/discovery", {
      authed: false,
    });
  } catch (err) {
    if (err instanceof ConnectApiError && err.status === 404) return null;
    throw err;
  }
}

/** Null on servers that predate `/api/whoami`. */
export async function fetchWhoami(connection: Connection): Promise<WhoamiResponse | null> {
  try {
    return await request<WhoamiResponse>(connection, "/api/whoami");
  } catch (err) {
    if (err instanceof ConnectApiError && err.status === 404) return null;
    throw err;
  }
}

export async function fetchUsers(connection: Connection): Promise<User[]> {
  return (await request<UsersResponse>(connection, "/api/users")).users;
}

export function createConnectorCode(
  connection: Connection,
  userId: string,
  label: string,
): Promise<ConnectorCodeResponse> {
  return request<ConnectorCodeResponse>(
    connection,
    `/api/users/${encodeURIComponent(userId)}/connector-codes`,
    { method: "POST", body: JSON.stringify({ label }) },
  );
}
