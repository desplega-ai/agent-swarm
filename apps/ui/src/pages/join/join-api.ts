import type { InviteExchangeResponse, StatusResponse } from "@/api/types";
import { JoinApiError } from "./join-flow";

/**
 * `/join` talks to the swarm named in the invite link, which is not a saved
 * connection yet, so it cannot use the `api` singleton (bound to the active
 * connection). These calls take the base URL explicitly, as `/connect` does.
 */

function baseUrl(swarm: string): string {
  // Same dev-proxy rule as the `api` singleton.
  if (import.meta.env.DEV && swarm === "http://localhost:3013") return "";
  return swarm.replace(/\/+$/, "");
}

async function request<T>(swarm: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(swarm)}${path}`, init);
  } catch {
    throw new JoinApiError(`Could not reach ${swarm}.`, null);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : null;
    throw new JoinApiError(code ?? `Request failed: ${res.status}`, res.status, code);
  }
  return (await res.json()) as T;
}

/** Unauthenticated: the one-time code is the credential. */
export function exchangeInviteCode(swarm: string, code: string): Promise<InviteExchangeResponse> {
  return request<InviteExchangeResponse>(swarm, "/api/invites/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

/** `GET /status` with the new token: is Comb on? */
export async function fetchCombEnabled(swarm: string, token: string): Promise<boolean> {
  const status = await request<Partial<StatusResponse>>(swarm, "/status", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return status.agent_fs?.comb?.enabled === true;
}
