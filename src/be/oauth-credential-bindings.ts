import { ensureTokenOrThrow, oauthAppRowToProviderConfig } from "@/oauth/ensure-token";
import type { OAuthProviderConfig } from "@/oauth/wrapper";
import type { OAuthApp } from "@/tracker/types";
import { getOAuthApp, getOAuthTokens, isTokenExpiringSoon } from "./db-queries/oauth";

export type OAuthBindingTokenStatus = "ok" | "expiring" | "missing";

const OAUTH_BINDING_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function oauthAppToProviderConfig(app: OAuthApp): OAuthProviderConfig {
  return oauthAppRowToProviderConfig(app);
}

export function getOAuthProviderConfig(provider: string): OAuthProviderConfig | null {
  const app = getOAuthApp(provider);
  return app ? oauthAppRowToProviderConfig(app) : null;
}

export function getOAuthBindingTokenStatus(provider: string): OAuthBindingTokenStatus {
  if (!getOAuthApp(provider)) return "missing";
  if (!getOAuthTokens(provider)) return "missing";
  return isTokenExpiringSoon(provider, OAUTH_BINDING_REFRESH_BUFFER_MS) ? "expiring" : "ok";
}

export async function resolveOAuthBindingToken(provider: string): Promise<string | undefined> {
  if (!getOAuthApp(provider)) return undefined;
  const initialTokens = getOAuthTokens(provider);
  if (!initialTokens) return undefined;

  if (isTokenExpiringSoon(provider, OAUTH_BINDING_REFRESH_BUFFER_MS)) {
    await ensureTokenOrThrow(provider, OAUTH_BINDING_REFRESH_BUFFER_MS);
  }

  return getOAuthTokens(provider)?.accessToken;
}
