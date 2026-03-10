/**
 * Linear OAuth 2.0 implementation with PKCE.
 *
 * Handles the full auth-code flow (authorize URL generation, callback exchange)
 * and automatic token refresh.
 */
import { getDb } from "../be/db";
import type { LinearOAuthToken, LinearTokenResponse, PendingOAuthState } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const OAUTH_SCOPES =
  "read,write,issues:create,comments:create,admin,app:assignable,app:mentionable";

// In-memory map of state → code_verifier (short-lived, cleaned up on callback)
const pendingStates = new Map<string, PendingOAuthState>();

// Expire pending states after 10 minutes
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest("SHA-256", encoder.encode(plain));
}

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const hash = await sha256(codeVerifier);
  return base64url(hash);
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export async function getAuthorizationUrl(): Promise<string> {
  const clientId = process.env.LINEAR_CLIENT_ID;
  const redirectUri = process.env.LINEAR_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error("[Linear] LINEAR_CLIENT_ID and LINEAR_REDIRECT_URI must be set");
  }

  // Clean up expired pending states
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (now - val.createdAt > PENDING_STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }

  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(32);

  pendingStates.set(state, { codeVerifier, createdAt: now });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// OAuth callback — exchange code for tokens
// ---------------------------------------------------------------------------

export async function handleOAuthCallback(code: string, state: string): Promise<void> {
  const pending = pendingStates.get(state);
  if (!pending) {
    throw new Error("[Linear] Invalid or expired OAuth state parameter");
  }
  pendingStates.delete(state);

  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  const redirectUri = process.env.LINEAR_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "[Linear] LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_REDIRECT_URI must be set",
    );
  }

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: pending.codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[Linear] Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as LinearTokenResponse;
  await storeTokens(data);
  console.log("[Linear] OAuth tokens stored successfully");
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshAccessToken(): Promise<LinearOAuthToken | null> {
  const tokens = getStoredTokens();
  if (!tokens) {
    console.warn("[Linear] No stored tokens to refresh");
    return null;
  }

  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.warn("[Linear] Cannot refresh — missing CLIENT_ID or CLIENT_SECRET");
    return null;
  }

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Linear] Token refresh failed (${response.status}): ${text}`);
    return null;
  }

  const data = (await response.json()) as LinearTokenResponse;
  return storeTokens(data);
}

// ---------------------------------------------------------------------------
// Token storage (DB)
// ---------------------------------------------------------------------------

export function getStoredTokens(): LinearOAuthToken | null {
  const db = getDb();
  const row = db.query("SELECT * FROM linear_oauth_tokens ORDER BY createdAt DESC LIMIT 1").get();
  return (row as LinearOAuthToken) ?? null;
}

export function isTokenExpiringSoon(expiresAt: string, bufferMs = 5 * 60 * 1000): boolean {
  const expiryTime = new Date(expiresAt).getTime();
  return Date.now() + bufferMs >= expiryTime;
}

async function storeTokens(data: LinearTokenResponse): Promise<LinearOAuthToken> {
  const db = getDb();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  const now = new Date().toISOString();

  // Upsert: delete all existing rows, insert the new one (single-row table)
  // Wrapped in a transaction to ensure atomicity
  const store = db.transaction(() => {
    db.run("DELETE FROM linear_oauth_tokens");
    db.run(
      `INSERT INTO linear_oauth_tokens (accessToken, refreshToken, expiresAt, scope, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.access_token,
        data.refresh_token ?? "",
        expiresAt,
        data.scope ?? OAUTH_SCOPES,
        now,
        now,
      ],
    );
  });
  store();

  return getStoredTokens()!;
}
