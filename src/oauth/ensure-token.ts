import { getOAuthApp, getOAuthTokens, isTokenExpiringSoon } from "../be/db-queries/oauth";
import { type OAuthProviderConfig, refreshAccessToken } from "./wrapper";

/**
 * Build an OAuthProviderConfig from the oauth_apps table for any provider.
 */
function getOAuthConfig(provider: string): OAuthProviderConfig | null {
  const app = getOAuthApp(provider);
  if (!app) return null;

  const metadata = JSON.parse(app.metadata || "{}");
  return {
    provider,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    redirectUri: app.redirectUri,
    scopes: app.scopes.split(","),
    extraParams: metadata.extraParams ?? (metadata.actor ? { actor: metadata.actor } : undefined),
  };
}

/**
 * Ensure a valid OAuth token exists for the given provider.
 * If the token is expiring soon, attempt to refresh it.
 * Call this before any API interaction with an OAuth-protected service.
 *
 * @param bufferMs - How far ahead to check for expiry. Default 5 min (reactive use).
 *                   Keepalive callers should pass a larger value (e.g. 13h) to force
 *                   a proactive refresh well before the token actually expires.
 */
export async function ensureToken(provider: string, bufferMs?: number): Promise<void> {
  if (!isTokenExpiringSoon(provider, bufferMs)) return;

  const config = getOAuthConfig(provider);
  const tokens = getOAuthTokens(provider);
  if (!config || !tokens?.refreshToken) {
    console.warn(
      `[OAuth] ${provider} token expiring but cannot refresh (missing config or refresh token)`,
    );
    return;
  }

  try {
    await refreshAccessToken(config, tokens.refreshToken);
    console.log(`[OAuth] ${provider} token refreshed successfully`);
  } catch (err) {
    console.error(
      `[OAuth] Failed to refresh ${provider} token:`,
      err instanceof Error ? err.message : err,
    );
  }
}
