import { ensureTokenOrThrow, oauthAppRowToProviderConfig } from "@/oauth/ensure-token";
import type { OAuthProviderConfig } from "@/oauth/wrapper";
import type { OAuthApp } from "@/tracker/types";
import { getAuthorizationById, getOAuthApp, getOAuthAppById } from "./db-queries/oauth";

export type OAuthBindingTokenStatus = "ok" | "expiring" | "missing";

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
  if (!authorization || authorization.status !== "active" || !app || app.mcpServerId !== null) {
    return "missing";
  }
  if (!authorization.expiresAt) return "ok";
  const expiresAt = new Date(authorization.expiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt - Date.now() < OAUTH_BINDING_REFRESH_BUFFER_MS
    ? "expiring"
    : "ok";
}

export async function resolveOAuthBindingToken(
  oauthAuthorizationId: string,
): Promise<string | undefined> {
  const initial = getAuthorizationById(oauthAuthorizationId);
  if (!initial || initial.status !== "active") return undefined;
  const app = getOAuthAppById(initial.appId);
  if (!app || app.mcpServerId !== null) return undefined;

  if (getOAuthBindingTokenStatus(oauthAuthorizationId) === "expiring") {
    // During step 1 every provider-facing authorization is still the migrated
    // `default` authorization. The explicit-id refresh path lands in step 5;
    // routing through the provider adapter here preserves current behavior.
    await ensureTokenOrThrow(app.provider, OAUTH_BINDING_REFRESH_BUFFER_MS);
  }

  return getAuthorizationById(oauthAuthorizationId)?.accessToken;
}
