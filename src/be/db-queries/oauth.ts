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

export async function getOAuthApp(provider: string): Promise<OAuthApp | null> {
  const row = (await getDb())
    .query("SELECT * FROM oauth_apps WHERE provider = ?")
    .get(provider) as OAuthApp | null;
  return row ? normalizeOAuthApp(row) : null;
}

export async function upsertOAuthApp(
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
): Promise<void> {
  // metadata is treated as a runtime-owned column (cloudId, webhookIds, etc.
  // are written by OAuth callback + webhook-register flows). On INSERT we
  // seed it with whatever the caller passed (or "{}"); on UPDATE we ONLY
  // overwrite when the caller explicitly provided one — otherwise the
  // existing value is preserved across server restarts.
  const metadataProvided = data.metadata !== undefined;
  const sql = metadataProvided
    ? `INSERT INTO oauth_apps (provider, clientId, clientSecret, authorizeUrl, tokenUrl, redirectUri, scopes, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         clientId = excluded.clientId,
         clientSecret = excluded.clientSecret,
         authorizeUrl = excluded.authorizeUrl,
         tokenUrl = excluded.tokenUrl,
         redirectUri = excluded.redirectUri,
         scopes = excluded.scopes,
         metadata = excluded.metadata,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    : `INSERT INTO oauth_apps (provider, clientId, clientSecret, authorizeUrl, tokenUrl, redirectUri, scopes, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
       ON CONFLICT(provider) DO UPDATE SET
         clientId = excluded.clientId,
         clientSecret = excluded.clientSecret,
         authorizeUrl = excluded.authorizeUrl,
         tokenUrl = excluded.tokenUrl,
         redirectUri = excluded.redirectUri,
         scopes = excluded.scopes,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  if (metadataProvided) {
    (await getDb())
      .query(sql)
      .run(
        provider,
        data.clientId,
        data.clientSecret,
        data.authorizeUrl,
        data.tokenUrl,
        data.redirectUri,
        data.scopes,
        data.metadata as string,
      );
  } else {
    (await getDb())
      .query(sql)
      .run(
        provider,
        data.clientId,
        data.clientSecret,
        data.authorizeUrl,
        data.tokenUrl,
        data.redirectUri,
        data.scopes,
      );
  }
}

// ── OAuth Tokens ──

export async function getOAuthTokens(provider: string): Promise<OAuthTokens | null> {
  const row = (await getDb())
    .query("SELECT * FROM oauth_tokens WHERE provider = ?")
    .get(provider) as OAuthTokens | null;
  return row ? normalizeOAuthTokens(row) : null;
}

export async function storeOAuthTokens(
  provider: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt: string;
    scope?: string | null;
  },
): Promise<void> {
  (await getDb())
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

export async function updateOAuthTokensAfterRefresh(
  provider: string,
  expectedRefreshToken: string,
  data: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scope?: string | null;
  },
): Promise<void> {
  const result = (await getDb())
    .query(
      `UPDATE oauth_tokens
       SET accessToken = ?,
           refreshToken = ?,
           expiresAt = ?,
           scope = COALESCE(?, scope),
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE provider = ? AND refreshToken = ?`,
    )
    .run(
      data.accessToken,
      data.refreshToken,
      data.expiresAt,
      data.scope ?? null,
      provider,
      expectedRefreshToken,
    );

  if (result.changes === 1) return;

  const current = await getOAuthTokens(provider);
  if (!current) {
    throw new Error(`OAuth token refresh persistence failed for ${provider}: token row missing`);
  }
  if (current.refreshToken !== expectedRefreshToken) {
    throw new Error(
      `OAuth token refresh persistence failed for ${provider}: stored refresh token changed during refresh`,
    );
  }
  throw new Error(`OAuth token refresh persistence failed for ${provider}: no rows updated`);
}

export async function deleteOAuthTokens(provider: string): Promise<void> {
  (await getDb()).query("DELETE FROM oauth_tokens WHERE provider = ?").run(provider);
}

export async function isTokenExpiringSoon(
  provider: string,
  bufferMs = 5 * 60 * 1000,
): Promise<boolean> {
  const tokens = await getOAuthTokens(provider);
  if (!tokens) return true;
  const expiresAt = new Date(tokens.expiresAt).getTime();
  return expiresAt - Date.now() < bufferMs;
}
