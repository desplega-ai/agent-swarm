import * as oauth from "oauth4webapi";
import { storeOAuthTokens, updateOAuthTokensAfterRefresh } from "../be/db-queries/oauth";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OAuthProviderConfig {
  provider: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string[];
  /** Extra query params appended to the authorization URL (e.g. { actor: "app" } for Linear) */
  extraParams?: Record<string, string>;
  /**
   * Provider rotates refresh tokens on every refresh. When true, a refresh
   * response without a new refresh token is unusable because the old one may
   * already be invalidated server-side.
   */
  requiresRefreshTokenRotation?: boolean;
  /**
   * How to join `scopes` in the authorization URL.
   *
   * - Linear: `","` (its OAuth implementation requires comma-separated scopes).
   * - Atlassian / RFC 6749 default: `" "` (space-separated).
   *
   * Defaults to `","` for backward compatibility with Linear, the only
   * pre-existing consumer of this wrapper.
   */
  scopeSeparator?: string;
  /**
   * How client credentials are sent to the token endpoint.
   *
   * - `"body"` (default): `client_id` + `client_secret` as body parameters.
   * - `"basic"`: HTTP Basic `Authorization` header (RFC 6749 §2.3.1) —
   *   required by providers like Notion that reject body credentials.
   */
  tokenAuthStyle?: "body" | "basic";
  /**
   * Token request body encoding. `"form"` (default) sends
   * `application/x-www-form-urlencoded`; `"json"` sends a JSON body
   * (Notion requires JSON).
   */
  tokenBodyFormat?: "form" | "json";
}

interface PendingState {
  codeVerifier: string;
  config: OAuthProviderConfig;
  createdAt: number;
}

// ─── In-memory pending state (PKCE code verifiers keyed by state) ────────────

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const pendingStates = new Map<string, PendingState>();

/** Remove expired entries from the pending state map */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build an OAuth 2.0 authorization URL with PKCE (S256).
 * Stores the pending state + code verifier in-memory for later exchange.
 */
export async function buildAuthorizationUrl(
  config: OAuthProviderConfig,
): Promise<{ url: string; state: string; codeVerifier: string }> {
  cleanupExpiredStates();

  const state = oauth.generateRandomState();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

  pendingStates.set(state, {
    codeVerifier,
    config,
    createdAt: Date.now(),
  });

  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(config.scopeSeparator ?? ","));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  // Append provider-specific extra params (e.g. actor=app for Linear)
  if (config.extraParams) {
    for (const [key, value] of Object.entries(config.extraParams)) {
      url.searchParams.set(key, value);
    }
  }

  return { url: url.toString(), state, codeVerifier };
}

/**
 * Exchange an authorization code for tokens.
 * Validates the state against our pending map, calls the token endpoint,
 * and persists tokens via storeOAuthTokens().
 */
/**
 * Build headers + body for a token-endpoint request, honoring the provider's
 * client-auth style (body params vs HTTP Basic) and body encoding (form vs JSON).
 */
function tokenRequestInit(
  config: OAuthProviderConfig,
  params: Record<string, string>,
): { headers: Record<string, string>; body: string } {
  const useBasic = config.tokenAuthStyle === "basic";
  const bodyParams = useBasic
    ? params
    : { ...params, client_id: config.clientId, client_secret: config.clientSecret };
  const headers: Record<string, string> = {};
  if (useBasic) {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  }
  if (config.tokenBodyFormat === "json") {
    headers["Content-Type"] = "application/json";
    return { headers, body: JSON.stringify(bodyParams) };
  }
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  return { headers, body: new URLSearchParams(bodyParams).toString() };
}

export async function exchangeCode(
  config: OAuthProviderConfig,
  code: string,
  state: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
  const pending = pendingStates.get(state);
  if (!pending) {
    throw new Error("Invalid or expired OAuth state");
  }
  pendingStates.delete(state);

  const { codeVerifier } = pending;

  // Build token request manually — Linear doesn't use standard OAuth discovery
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    ...tokenRequestInit(config, {
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
  };

  // Persist tokens
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // default 24h

  storeOAuthTokens(config.provider, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt,
    scope: data.scope ?? null,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

/**
 * Refresh an access token using a stored refresh token.
 * Persists the new tokens via storeOAuthTokens().
 */
export async function refreshAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    ...tokenRequestInit(config, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
  };

  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error(`Token refresh failed: ${config.provider} response missing access_token`);
  }

  if (
    config.requiresRefreshTokenRotation &&
    (typeof data.refresh_token !== "string" || data.refresh_token.length === 0)
  ) {
    throw new Error(
      `Token refresh failed: ${config.provider} response did not include a rotated refresh_token`,
    );
  }

  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const nextRefreshToken = data.refresh_token ?? refreshToken;
  try {
    updateOAuthTokensAfterRefresh(config.provider, refreshToken, {
      accessToken: data.access_token,
      refreshToken: nextRefreshToken,
      expiresAt,
      scope: data.scope ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[OAuth] Refusing to use refreshed ${config.provider} access token because persistence failed: ${message}`,
    );
    throw err;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

// ─── Test helpers (exported for unit tests only) ─────────────────────────────

export function _getPendingState(state: string): PendingState | undefined {
  return pendingStates.get(state);
}

export function _clearPendingStates(): void {
  pendingStates.clear();
}
