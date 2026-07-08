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
    getDb()
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
    getDb()
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
  // TODO(secrets-cipher): encrypt OAuth tokens at rest with src/be/crypto/secrets-cipher.ts.
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

export function updateOAuthTokensAfterRefresh(
  provider: string,
  expectedRefreshToken: string,
  data: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scope?: string | null;
  },
): void {
  const result = getDb()
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

  const current = getOAuthTokens(provider);
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

/**
 * Presence-flags-only projection of oauth_tokens for the background refresh
 * sweep. Deliberately excludes token values so sweep code can never leak
 * them into logs.
 */
export type OAuthTokenSweepRow = {
  provider: string;
  hasApp: boolean;
  hasRefreshToken: boolean;
  expiresAt: string;
  updatedAt: string;
};

export function listOAuthTokenSweepRows(): OAuthTokenSweepRow[] {
  const rows = getDb()
    .query(
      `SELECT t.provider,
              CASE WHEN a.provider IS NOT NULL THEN 1 ELSE 0 END AS hasApp,
              CASE WHEN t.refreshToken IS NOT NULL AND t.refreshToken != '' THEN 1 ELSE 0 END AS hasRefreshToken,
              t.expiresAt,
              t.updatedAt
       FROM oauth_tokens t
       LEFT JOIN oauth_apps a ON a.provider = t.provider
       ORDER BY t.provider ASC`,
    )
    .all() as Array<{
    provider: string;
    hasApp: number;
    hasRefreshToken: number;
    expiresAt: string;
    updatedAt: string;
  }>;
  return rows.map((row) => ({
    provider: row.provider,
    hasApp: row.hasApp === 1,
    hasRefreshToken: row.hasRefreshToken === 1,
    expiresAt: normalizeDateRequired(row.expiresAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  }));
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

// ── OAuth Refresh Locks ──

export function acquireOAuthRefreshLock(provider: string, ttlMs: number): string | null {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const nowIso = new Date(now).toISOString();

  getDb()
    .query(
      `INSERT INTO oauth_refresh_locks (provider, owner, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         owner = excluded.owner,
         expiresAt = excluded.expiresAt,
         updatedAt = excluded.updatedAt
       WHERE oauth_refresh_locks.expiresAt <= ?`,
    )
    .run(provider, owner, expiresAt, nowIso, nowIso, nowIso);

  const row = getDb()
    .query("SELECT owner FROM oauth_refresh_locks WHERE provider = ?")
    .get(provider) as { owner: string } | null;

  return row?.owner === owner ? owner : null;
}

export function releaseOAuthRefreshLock(provider: string, owner: string): void {
  getDb()
    .query("DELETE FROM oauth_refresh_locks WHERE provider = ? AND owner = ?")
    .run(provider, owner);
}
