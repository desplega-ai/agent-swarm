import { getOAuthApp } from "../be/db-queries/oauth";
import { buildAuthorizationUrl, exchangeCode, type OAuthProviderConfig } from "../oauth/wrapper";

export function getLinearOAuthConfig(): OAuthProviderConfig | null {
  const app = getOAuthApp("linear");
  if (!app) return null;

  const metadata = JSON.parse(app.metadata || "{}");
  return {
    provider: "linear",
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    redirectUri: app.redirectUri,
    scopes: app.scopes.split(","),
    extraParams: metadata.actor ? { actor: metadata.actor } : {},
  };
}

export async function getLinearAuthorizationUrl(): Promise<string | null> {
  const config = getLinearOAuthConfig();
  if (!config) return null;
  const result = await buildAuthorizationUrl(config);
  return result.url;
}

export async function handleLinearCallback(
  code: string,
  state: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
  const config = getLinearOAuthConfig();
  if (!config) throw new Error("Linear OAuth not configured");
  return exchangeCode(config, code, state);
}

/**
 * Revoke an OAuth access token with Linear. Best-effort — caller should not
 * abort the disconnect flow if this fails. Linear's revocation endpoint is
 * `POST https://api.linear.app/oauth/revoke` with the access token in the
 * Authorization header (per https://developers.linear.app/docs/oauth/authentication).
 *
 * Returns true on a 2xx response, false otherwise.
 */
export async function revokeLinearToken(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.linear.app/oauth/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch (err) {
    console.warn(
      "[Linear] Token revocation failed (best-effort):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
