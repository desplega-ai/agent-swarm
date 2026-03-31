import type { OAuthApp, OAuthTokens } from "../../tracker/types";
import { normalizeDateRequired } from "../date-utils";
import { getDb } from "../db";

// ── OAuth Apps ──

function normalizeOAuthApp(row: OAuthApp): OAuthApp {
  return {
    ...row,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

function normalizeOAuthTokens(row: OAuthTokens): OAuthTokens {
  return {
    ...row,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export function getOAuthApp(provider: string): OAuthApp | null {
  const row = getDb()
    .query("SELECT * FROM oauth_apps WHERE provider = ?")
    .get(provider) as OAuthApp | null;
  return row ? normalizeOAuthApp(row) : null;
}

export function upsertOAuthApp(
  provider: string,
  data: {
    clientId: string;
    clientSecret: string;
    authorizeUrl: string;
    tokenUrl: string;
    redirectUri: string;
    scopes: string;
    metadata?: string;
  },
): void {
  getDb()
    .query(
      `INSERT INTO oauth_apps (provider, clientId, clientSecret, authorizeUrl, tokenUrl, redirectUri, scopes, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         clientId = excluded.clientId,
         clientSecret = excluded.clientSecret,
         authorizeUrl = excluded.authorizeUrl,
         tokenUrl = excluded.tokenUrl,
         redirectUri = excluded.redirectUri,
         scopes = excluded.scopes,
         metadata = excluded.metadata,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(
      provider,
      data.clientId,
      data.clientSecret,
      data.authorizeUrl,
      data.tokenUrl,
      data.redirectUri,
      data.scopes,
      data.metadata ?? "{}",
    );
}

// ── OAuth Tokens ──

export function getOAuthTokens(provider: string): OAuthTokens | null {
  const row = getDb()
    .query("SELECT * FROM oauth_tokens WHERE provider = ?")
    .get(provider) as OAuthTokens | null;
  return row ? normalizeOAuthTokens(row) : null;
}

export function storeOAuthTokens(
  provider: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt: string;
    scope?: string | null;
  },
): void {
  getDb()
    .query(
      `INSERT INTO oauth_tokens (provider, accessToken, refreshToken, expiresAt, scope)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         accessToken = excluded.accessToken,
         refreshToken = COALESCE(excluded.refreshToken, oauth_tokens.refreshToken),
         expiresAt = excluded.expiresAt,
         scope = COALESCE(excluded.scope, oauth_tokens.scope),
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(provider, data.accessToken, data.refreshToken ?? null, data.expiresAt, data.scope ?? null);
}

export function deleteOAuthTokens(provider: string): void {
  getDb().query("DELETE FROM oauth_tokens WHERE provider = ?").run(provider);
}

export function isTokenExpiringSoon(provider: string, bufferMs = 5 * 60 * 1000): boolean {
  const tokens = getOAuthTokens(provider);
  if (!tokens) return true;
  const expiresAt = new Date(tokens.expiresAt).getTime();
  return expiresAt - Date.now() < bufferMs;
}
