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
