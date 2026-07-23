import * as oauth from "oauth4webapi";
import {
  consumeOAuthPending,
  createOAuthPending,
  getOAuthAppIdByProvider,
  type OAuthPendingFlow,
  storeOAuthTokens,
  updateOAuthTokensAfterRefresh,
} from "../be/db-queries/oauth";

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

/**
 * Options controlling how the pending PKCE session is keyed. When `appId` is
 * omitted it is resolved from `config.provider` (single-app-per-provider
 * callers). `label` selects which authorization the callback upserts into,
 * enabling N labeled authorizations per app.
 */
export interface BuildAuthorizationUrlOptions {
  appId?: string;
  label?: string;
  flow?: OAuthPendingFlow;
  finalRedirect?: string | null;
  userId?: string | null;
  nonce?: string | null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build an OAuth 2.0 authorization URL with PKCE (S256). Persists a DB-backed
 * pending row (encrypted code verifier) keyed by `state` for later exchange by
 * the static callback handler — survives process restarts.
 */
export async function buildAuthorizationUrl(
  config: OAuthProviderConfig,
  options: BuildAuthorizationUrlOptions = {},
): Promise<{ url: string; state: string; codeVerifier: string }> {
  const state = oauth.generateRandomState();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

  const appId = options.appId ?? getOAuthAppIdByProvider(config.provider);
  if (!appId) {
    throw new Error(`OAuth app ${config.provider} is not configured`);
  }
  createOAuthPending({
    state,
    appId,
    label: options.label ?? "default",
    flow: options.flow ?? "generic",
    codeVerifier,
    nonce: options.nonce ?? null,
    redirectUri: config.redirectUri,
    finalRedirect: options.finalRedirect ?? null,
    userId: options.userId ?? null,
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
  // Always request a JSON token response. RFC 6749 responses are JSON, but some
  // providers (notably GitHub) default to form-encoded and only return JSON when
  // Accept: application/json is sent — without this the unconditional
  // response.json() in exchange/refresh would throw on their token payload.
  const headers: Record<string, string> = { Accept: "application/json" };
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

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
  /** OIDC id_token, when the provider returns one (used for identity capture). */
  idToken?: string;
}

/**
 * Exchange an authorization code for tokens. Pure protocol mechanics — does NOT
 * touch the DB. The caller (static callback handler) consumes the pending row,
 * passes the stored `codeVerifier` + `redirectUri`, and persists the tokens
 * onto the target authorization.
 */
export async function exchangeAuthorizationCode(
  config: OAuthProviderConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<OAuthTokenResponse> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    ...tokenRequestInit(config, {
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
      code: params.code,
      code_verifier: params.codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
    id_token?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    tokenType: data.token_type,
    idToken: data.id_token,
  };
}

/**
 * Backward-compatible code exchange for provider-string callers (tracker
 * callbacks). Consumes the DB-backed pending row by `state`, exchanges the
 * code, and persists onto the provider's `default` authorization. New
 * multi-authorization flows use {@link exchangeAuthorizationCode} directly.
 */
export async function exchangeCode(
  config: OAuthProviderConfig,
  code: string,
  state: string,
): Promise<OAuthTokenResponse> {
  const pending = consumeOAuthPending(state);
  if (!pending) {
    throw new Error("Invalid or expired OAuth state");
  }
  const tokens = await exchangeAuthorizationCode(config, {
    code,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
  });
  const expiresAt = tokens.expiresIn
    ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  storeOAuthTokens(config.provider, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    expiresAt,
    scope: tokens.scope ?? null,
  });
  return tokens;
}

/**
 * Refresh a token using the `refresh_token` grant. Pure protocol mechanics — no
 * DB writes. The caller persists onto the target authorization (id-keyed). Used
 * by the per-authorization refresh endpoint.
 */
export async function refreshTokenGrant(
  config: OAuthProviderConfig,
  refreshToken: string,
): Promise<OAuthTokenResponse> {
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
    token_type?: string;
    expires_in?: number;
    scope?: string;
    refresh_token?: string;
  };

  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error(`Token refresh failed: ${config.provider} response missing access_token`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    tokenType: data.token_type,
  };
}

/**
 * Call the token endpoint to exchange a refresh token, validate the response
 * (access token present; rotated refresh token present when the provider
 * requires rotation), and return the normalized result WITHOUT persisting.
 *
 * Persistence is the caller's job — provider-string callers persist via
 * {@link refreshAccessToken}; authorization-keyed callers
 * (src/oauth/ensure-token.ts) persist against a specific authorization id.
 * Throws on any HTTP error, missing access token, or a missing rotated refresh
 * token.
 */
export async function performTokenRefreshRequest(
  config: OAuthProviderConfig,
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  expiresAt: string;
}> {
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

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    expiresAt,
  };
}

/**
 * Refresh an access token using a stored refresh token.
 * Persists the new tokens via updateOAuthTokensAfterRefresh() (provider-keyed
 * default-authorization path).
 */
export async function refreshAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string,
  expectedTokenVersion?: number,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
  const refreshed = await performTokenRefreshRequest(config, refreshToken);

  const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
  try {
    updateOAuthTokensAfterRefresh(config.provider, refreshToken, {
      accessToken: refreshed.accessToken,
      refreshToken: nextRefreshToken,
      expiresAt: refreshed.expiresAt,
      scope: refreshed.scope ?? null,
      ...(expectedTokenVersion !== undefined ? { expectedTokenVersion } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[OAuth] Refusing to use refreshed ${config.provider} access token because persistence failed: ${message}`,
    );
    throw err;
  }

  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresIn: refreshed.expiresIn,
    scope: refreshed.scope,
  };
}

// ─── Test helpers (exported for unit tests only) ─────────────────────────────

/**
 * Deprecated no-op retained for backward compatibility. Pending PKCE state now
 * lives in the `oauth_pending` table (per-test DBs isolate it), so there is no
 * in-memory map to clear.
 */
export function _clearPendingStates(): void {}
