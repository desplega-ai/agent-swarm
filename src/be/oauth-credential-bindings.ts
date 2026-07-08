import { ensureTokenOrThrow } from "@/oauth/ensure-token";
import type { OAuthProviderConfig } from "@/oauth/wrapper";
import type { OAuthApp } from "@/tracker/types";
import { getOAuthApp, getOAuthTokens, isTokenExpiringSoon } from "./db-queries/oauth";

export type OAuthBindingTokenStatus = "ok" | "expiring" | "missing";

const OAUTH_BINDING_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

export function oauthAppToProviderConfig(app: OAuthApp): OAuthProviderConfig {
  const metadata = parseMetadata(app.metadata);
  const extraParams =
    stringRecord(metadata.extraParams) ??
    (typeof metadata.actor === "string" ? { actor: metadata.actor } : undefined);

  return {
    provider: app.provider,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    redirectUri: app.redirectUri,
    scopes: app.scopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    extraParams,
    // Standard OAuth wants space-separated scopes; the wrapper's comma
    // default exists only for Linear, which has its own dedicated flow.
    scopeSeparator: " ",
    requiresRefreshTokenRotation: app.provider === "jira",
  };
}

export function getOAuthProviderConfig(provider: string): OAuthProviderConfig | null {
  const app = getOAuthApp(provider);
  return app ? oauthAppToProviderConfig(app) : null;
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
