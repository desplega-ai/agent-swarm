import * as oauth from "oauth4webapi";
import { storeOAuthTokens } from "../be/db-queries/oauth";

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
  url.searchParams.set("scope", config.scopes.join(","));
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
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
    code_verifier: codeVerifier,
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
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
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
    refresh_token?: string;
  };

  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  storeOAuthTokens(config.provider, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

// ─── Test helpers (exported for unit tests only) ─────────────────────────────

export function _getPendingState(state: string): PendingState | undefined {
  return pendingStates.get(state);
}

export function _clearPendingStates(): void {
  pendingStates.clear();
}
