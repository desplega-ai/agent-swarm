import { ensureAuthorizationTokenOrThrow, oauthAppRowToProviderConfig } from "@/oauth/ensure-token";
import type { OAuthProviderConfig } from "@/oauth/wrapper";
import type { OAuthApp } from "@/tracker/types";
import { getAuthorizationById, getOAuthApp, getOAuthAppById } from "./db-queries/oauth";

/**
 * Derived binding-token health for connection/binding list surfaces (and later
 * UI badges): `ok`/`expiring` from expiry, `refresh-failed`/`revoked` from the
 * persisted authorization status, `missing` when the authorization/app is gone
 * or is a DCR/MCP app (not a provider-facing binding).
 */
export type OAuthBindingTokenStatus = "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";

const OAUTH_BINDING_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function oauthAppToProviderConfig(app: OAuthApp): OAuthProviderConfig {
  return oauthAppRowToProviderConfig(app);
}

export function getOAuthProviderConfig(provider: string): OAuthProviderConfig | null {
  const app = getOAuthApp(provider);
  return app ? oauthAppRowToProviderConfig(app) : null;
}

export function getOAuthBindingTokenStatus(oauthAuthorizationId: string): OAuthBindingTokenStatus {
  const authorization = getAuthorizationById(oauthAuthorizationId);
  const app = authorization ? getOAuthAppById(authorization.appId) : null;
  if (!authorization || !app || app.mcpServerId !== null) {
    return "missing";
  }
  if (authorization.status === "revoked") return "revoked";
  if (authorization.status === "refresh-failed") return "refresh-failed";
  if (!authorization.expiresAt) return "ok";
  const expiresAt = new Date(authorization.expiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt - Date.now() < OAUTH_BINDING_REFRESH_BUFFER_MS
    ? "expiring"
    : "ok";
}

/**
 * Resolve the current access token for a provider-facing OAuth binding,
 * refreshing on demand. Returns `undefined` only for genuinely-missing states
 * (no authorization, revoked/disconnected, or a non-provider-facing app).
 *
 * Throws {@link OAuthRefreshError} (via the authorization-keyed refresh core)
 * when an expiring or already-`refresh-failed` authorization cannot be
 * refreshed — the credential broker turns that into a `failedBindings` entry so
 * the script's fetch throws a typed error instead of leaking an unsubstituted
 * placeholder toward the provider.
 */
export async function resolveOAuthBindingToken(
  oauthAuthorizationId: string,
): Promise<string | undefined> {
  const initial = getAuthorizationById(oauthAuthorizationId);
  if (!initial) return undefined;
  const app = getOAuthAppById(initial.appId);
  if (!app || app.mcpServerId !== null) return undefined;
  if (initial.status === "revoked") return undefined;

  const status = getOAuthBindingTokenStatus(oauthAuthorizationId);
  if (status === "expiring" || status === "refresh-failed") {
    // Refresh (or retry a previously-failed refresh) against this specific
    // authorization. On success it flips back to `active`; on failure it
    // re-persists `refresh-failed` and throws OAuthRefreshError.
    await ensureAuthorizationTokenOrThrow(oauthAuthorizationId, OAUTH_BINDING_REFRESH_BUFFER_MS);
  }

  return getAuthorizationById(oauthAuthorizationId)?.accessToken;
}
