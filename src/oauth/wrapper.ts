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
   * - `"body"` (default — Linear/Jira): client_id + client_secret in the
   *   form-encoded request body alongside `code` / `refresh_token`.
   * - `"basic"` (Notion): credentials as HTTP Basic auth header
   *   (`Authorization: Basic base64(id:secret)`); body carries only the grant.
   */
  tokenAuthMode?: "body" | "basic";
  /**
   * Wire format for the token-endpoint request body.
   *
   * - `"form"` (default — RFC 6749): `application/x-www-form-urlencoded`.
   * - `"json"` (Notion): `application/json`.
   */
  tokenContentType?: "form" | "json";
  /**
   * Extra headers to attach to every token-endpoint request (code exchange
   * AND refresh). Notion needs `Notion-Version` here; passing it via
   * extraParams would put it in the body, which Notion ignores.
   */
  extraTokenHeaders?: Record<string, string>;
  /**
   * Whether to include PKCE (S256) parameters in the authorize URL and the
   * code-exchange request body. Default `true` (Linear/Jira). Notion's public
   * OAuth doesn't support PKCE — set `false` to suppress `code_challenge`,
   * `code_challenge_method`, and `code_verifier` plumbing.
   */
  usePkce?: boolean;
  /**
   * Fallback access-token lifetime (ms) when the provider's response omits
   * `expires_in`. Default 24h. Notion responses don't include `expires_in`
   * but actual access-token TTL is ~1h with refresh-token rotation; setting
   * this to ~1h ensures `isTokenExpiringSoon` triggers under the standard
   * 65-min keepalive buffer.
   */
  defaultTokenLifetimeMs?: number;
}

interface PendingState {
  codeVerifier: string;
  config: OAuthProviderConfig;
  createdAt: number;
}

// ─── In-memory pending state (PKCE code verifiers keyed by state) ────────────

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24h

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

function buildBasicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function buildTokenRequestInit(
  config: OAuthProviderConfig,
  bodyFields: Record<string, string>,
): RequestInit {
  const tokenAuthMode = config.tokenAuthMode ?? "body";
  const tokenContentType = config.tokenContentType ?? "form";

  const headers: Record<string, string> = { ...(config.extraTokenHeaders ?? {}) };

  if (tokenAuthMode === "basic") {
    headers.Authorization = buildBasicAuthHeader(config.clientId, config.clientSecret);
  } else {
    bodyFields.client_id = config.clientId;
    bodyFields.client_secret = config.clientSecret;
  }

  let body: string;
  if (tokenContentType === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(bodyFields);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(bodyFields).toString();
  }

  return { method: "POST", headers, body };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build an OAuth 2.0 authorization URL.
 *
 * PKCE (S256) is on by default; opt out per provider via `usePkce: false`.
 * Stores the pending state + (when PKCE-enabled) code verifier in-memory for
 * later exchange.
 */
export async function buildAuthorizationUrl(
  config: OAuthProviderConfig,
): Promise<{ url: string; state: string; codeVerifier: string }> {
  cleanupExpiredStates();

  const usePkce = config.usePkce ?? true;
  const state = oauth.generateRandomState();
  // Always generate a verifier so the in-memory state has a stable shape and
  // tests can assert it; we just don't put it on the wire when usePkce=false.
  const codeVerifier = oauth.generateRandomCodeVerifier();

  pendingStates.set(state, {
    codeVerifier,
    config,
    createdAt: Date.now(),
  });

  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  // Notion has no scopes; emitting `scope=` is harmless for most providers but
  // some validators reject empty values, so omit when no scopes are configured.
  if (config.scopes.length > 0) {
    url.searchParams.set("scope", config.scopes.join(config.scopeSeparator ?? ","));
  }
  url.searchParams.set("state", state);
  if (usePkce) {
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  // Append provider-specific extra params (e.g. actor=app for Linear,
  // owner=user for Notion).
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
  const usePkce = config.usePkce ?? true;

  const bodyFields: Record<string, string> = {
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
    code,
  };
  if (usePkce) bodyFields.code_verifier = codeVerifier;

  const response = await fetch(config.tokenUrl, buildTokenRequestInit(config, bodyFields));

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
  const fallbackLifetimeMs = config.defaultTokenLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : new Date(Date.now() + fallbackLifetimeMs).toISOString();

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
  const bodyFields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };

  const response = await fetch(config.tokenUrl, buildTokenRequestInit(config, bodyFields));

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

  const fallbackLifetimeMs = config.defaultTokenLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : new Date(Date.now() + fallbackLifetimeMs).toISOString();

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
