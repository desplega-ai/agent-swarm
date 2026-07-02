import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { normalizeDateRequired } from "../date-utils";
import { getDb } from "../db";

// ─── Types ───────────────────────────────────────────────────────────────────

export type McpOAuthStatus = "connected" | "expired" | "error" | "revoked";
export type McpOAuthClientSource = "dcr" | "manual" | "preregistered";

/**
 * Token row as stored in SQLite. `accessToken`, `refreshToken`, and
 * `dcrClientSecret` are encrypted at rest — always go through the exported
 * getters/inserts, never query the table directly.
 */
interface McpOAuthTokenRow {
  id: string;
  mcpServerId: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  scope: string | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  dcrClientId: string | null;
  dcrClientSecret: string | null;
  clientSource: McpOAuthClientSource;
  status: McpOAuthStatus;
  lastErrorMessage: string | null;
  lastRefreshedAt: string | null;
  connectedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpOAuthToken {
  id: string;
  mcpServerId: string;
  userId: string | null;
  /** Decrypted access token (plaintext). */
  accessToken: string;
  /** Decrypted refresh token (plaintext), or null. */
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  scope: string | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  dcrClientId: string | null;
  /** Decrypted DCR client secret (plaintext), or null. */
  dcrClientSecret: string | null;
  clientSource: McpOAuthClientSource;
  status: McpOAuthStatus;
  lastErrorMessage: string | null;
  lastRefreshedAt: string | null;
  connectedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpOAuthPendingRow {
  state: string;
  mcpServerId: string;
  userId: string | null;
  /** Decrypted PKCE code verifier (plaintext). */
  codeVerifier: string;
  nonce: string | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  scopes: string | null;
  dcrClientId: string | null;
  /** Decrypted DCR client secret (plaintext), or null. */
  dcrClientSecret: string | null;
  redirectUri: string;
  finalRedirect: string | null;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function encryptOrNull(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return null;
  return encryptSecret(plaintext, getEncryptionKey());
}

function decryptOrNull(ciphertext: string | null | undefined): string | null {
  if (ciphertext == null || ciphertext === "") return null;
  return decryptSecret(ciphertext, getEncryptionKey());
}

function decryptTokenRow(row: McpOAuthTokenRow): McpOAuthToken {
  const key = getEncryptionKey();
  return {
    ...row,
    accessToken: decryptSecret(row.accessToken, key),
    refreshToken: decryptOrNull(row.refreshToken),
    dcrClientSecret: decryptOrNull(row.dcrClientSecret),
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

// ─── mcp_oauth_tokens ────────────────────────────────────────────────────────

export function getMcpOAuthToken(
  mcpServerId: string,
  userId: string | null = null,
): McpOAuthToken | null {
  const row = getDb()
    .query(
      userId == null
        ? "SELECT * FROM mcp_oauth_tokens WHERE mcpServerId = ? AND userId IS NULL"
        : "SELECT * FROM mcp_oauth_tokens WHERE mcpServerId = ? AND userId = ?",
    )
    .get(...(userId == null ? [mcpServerId] : [mcpServerId, userId])) as McpOAuthTokenRow | null;
  return row ? decryptTokenRow(row) : null;
}

export function getMcpOAuthTokenById(id: string): McpOAuthToken | null {
  const row = getDb()
    .query("SELECT * FROM mcp_oauth_tokens WHERE id = ?")
    .get(id) as McpOAuthTokenRow | null;
  return row ? decryptTokenRow(row) : null;
}

export function listMcpOAuthTokensForMcp(mcpServerId: string): McpOAuthToken[] {
  const rows = getDb()
    .query("SELECT * FROM mcp_oauth_tokens WHERE mcpServerId = ?")
    .all(mcpServerId) as McpOAuthTokenRow[];
  return rows.map(decryptTokenRow);
}

export interface UpsertMcpOAuthTokenInput {
  mcpServerId: string;
  userId?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string;
  expiresAt?: string | null;
  scope?: string | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl?: string | null;
  dcrClientId?: string | null;
  dcrClientSecret?: string | null;
  clientSource: McpOAuthClientSource;
  status?: McpOAuthStatus;
  lastErrorMessage?: string | null;
  lastRefreshedAt?: string | null;
  connectedByUserId?: string | null;
}

/**
 * Insert or update the token for a given (mcpServerId, userId) pair.
 * Encrypts accessToken/refreshToken/dcrClientSecret at write time.
 *
 * Uses explicit select-then-insert-or-update rather than ON CONFLICT because
 * SQLite treats NULL values in UNIQUE(mcpServerId, userId) as distinct, so the
 * v1 per-swarm case (userId IS NULL) would never trigger the conflict path.
 */
export function upsertMcpOAuthToken(input: UpsertMcpOAuthTokenInput): void {
  const userId = input.userId ?? null;
  const encryptedAccess = encryptSecret(input.accessToken, getEncryptionKey());
  const encryptedRefresh = encryptOrNull(input.refreshToken);
  const encryptedClientSecret = encryptOrNull(input.dcrClientSecret);

  const existing = getMcpOAuthToken(input.mcpServerId, userId);
  if (!existing) {
    getDb()
      .query(
        `INSERT INTO mcp_oauth_tokens (
          mcpServerId, userId,
          accessToken, refreshToken, tokenType, expiresAt, scope,
          resourceUrl, authorizationServerIssuer, authorizeUrl, tokenUrl, revocationUrl,
          dcrClientId, dcrClientSecret, clientSource,
          status, lastErrorMessage, lastRefreshedAt, connectedByUserId
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.mcpServerId,
        userId,
        encryptedAccess,
        encryptedRefresh,
        input.tokenType ?? "Bearer",
        input.expiresAt ?? null,
        input.scope ?? null,
        input.resourceUrl,
        input.authorizationServerIssuer,
        input.authorizeUrl,
        input.tokenUrl,
        input.revocationUrl ?? null,
        input.dcrClientId ?? null,
        encryptedClientSecret,
        input.clientSource,
        input.status ?? "connected",
        input.lastErrorMessage ?? null,
        input.lastRefreshedAt ?? null,
        input.connectedByUserId ?? null,
      );
    return;
  }

  getDb()
    .query(
      `UPDATE mcp_oauth_tokens SET
        accessToken = ?,
        refreshToken = COALESCE(?, refreshToken),
        tokenType = ?,
        expiresAt = ?,
        scope = COALESCE(?, scope),
        resourceUrl = ?,
        authorizationServerIssuer = ?,
        authorizeUrl = ?,
        tokenUrl = ?,
        revocationUrl = ?,
        dcrClientId = COALESCE(?, dcrClientId),
        dcrClientSecret = COALESCE(?, dcrClientSecret),
        clientSource = ?,
        status = ?,
        lastErrorMessage = ?,
        lastRefreshedAt = ?,
        connectedByUserId = COALESCE(?, connectedByUserId),
        updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`,
    )
    .run(
      encryptedAccess,
      encryptedRefresh,
      input.tokenType ?? "Bearer",
      input.expiresAt ?? null,
      input.scope ?? null,
      input.resourceUrl,
      input.authorizationServerIssuer,
      input.authorizeUrl,
      input.tokenUrl,
      input.revocationUrl ?? null,
      input.dcrClientId ?? null,
      encryptedClientSecret,
      input.clientSource,
      input.status ?? "connected",
      input.lastErrorMessage ?? null,
      input.lastRefreshedAt ?? null,
      input.connectedByUserId ?? null,
      existing.id,
    );
}

/**
 * Apply a refresh result: rewrite access token, optionally refresh token, and
 * bump expiresAt + status. Does not touch AS metadata.
 */
export function applyMcpOAuthRefresh(
  id: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    scope?: string | null;
  },
): void {
  const key = getEncryptionKey();
  const encryptedAccess = encryptSecret(data.accessToken, key);
  const encryptedRefresh =
    data.refreshToken === undefined
      ? undefined
      : data.refreshToken == null
        ? null
        : encryptSecret(data.refreshToken, key);

  if (encryptedRefresh === undefined) {
    getDb()
      .query(
        `UPDATE mcp_oauth_tokens
         SET accessToken = ?,
             expiresAt = COALESCE(?, expiresAt),
             scope = COALESCE(?, scope),
             status = 'connected',
             lastErrorMessage = NULL,
             lastRefreshedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(encryptedAccess, data.expiresAt ?? null, data.scope ?? null, id);
  } else {
    getDb()
      .query(
        `UPDATE mcp_oauth_tokens
         SET accessToken = ?,
             refreshToken = ?,
             expiresAt = COALESCE(?, expiresAt),
             scope = COALESCE(?, scope),
             status = 'connected',
             lastErrorMessage = NULL,
             lastRefreshedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(encryptedAccess, encryptedRefresh, data.expiresAt ?? null, data.scope ?? null, id);
  }
}

export function markMcpOAuthTokenStatus(
  id: string,
  status: McpOAuthStatus,
  errorMessage?: string | null,
): void {
  getDb()
    .query(
      `UPDATE mcp_oauth_tokens
       SET status = ?,
           lastErrorMessage = ?,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(status, errorMessage ?? null, id);
}

export function deleteMcpOAuthToken(mcpServerId: string, userId: string | null = null): boolean {
  const result = getDb()
    .query(
      userId == null
        ? "DELETE FROM mcp_oauth_tokens WHERE mcpServerId = ? AND userId IS NULL"
        : "DELETE FROM mcp_oauth_tokens WHERE mcpServerId = ? AND userId = ?",
    )
    .run(...(userId == null ? [mcpServerId] : [mcpServerId, userId]));
  return result.changes > 0;
}

export function isMcpTokenExpiringSoon(token: McpOAuthToken, bufferMs = 5 * 60 * 1000): boolean {
  if (!token.expiresAt) return false;
  const expiresAt = new Date(token.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < bufferMs;
}

// ─── mcp_oauth_pending ───────────────────────────────────────────────────────

export interface InsertMcpOAuthPendingInput {
  state: string;
  mcpServerId: string;
  userId?: string | null;
  codeVerifier: string;
  nonce?: string | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl?: string | null;
  scopes?: string | null;
  dcrClientId?: string | null;
  dcrClientSecret?: string | null;
  redirectUri: string;
  finalRedirect?: string | null;
}

export function insertMcpOAuthPending(input: InsertMcpOAuthPendingInput): void {
  const key = getEncryptionKey();
  getDb()
    .query(
      `INSERT INTO mcp_oauth_pending (
        state, mcpServerId, userId,
        codeVerifier, nonce,
        resourceUrl, authorizationServerIssuer, authorizeUrl, tokenUrl, revocationUrl,
        scopes, dcrClientId, dcrClientSecret, redirectUri, finalRedirect
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.state,
      input.mcpServerId,
      input.userId ?? null,
      encryptSecret(input.codeVerifier, key),
      input.nonce ?? null,
      input.resourceUrl,
      input.authorizationServerIssuer,
      input.authorizeUrl,
      input.tokenUrl,
      input.revocationUrl ?? null,
      input.scopes ?? null,
      input.dcrClientId ?? null,
      encryptOrNull(input.dcrClientSecret),
      input.redirectUri,
      input.finalRedirect ?? null,
    );
}

interface McpOAuthPendingRawRow {
  state: string;
  mcpServerId: string;
  userId: string | null;
  codeVerifier: string;
  nonce: string | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  scopes: string | null;
  dcrClientId: string | null;
  dcrClientSecret: string | null;
  redirectUri: string;
  finalRedirect: string | null;
  createdAt: string;
}

export function consumeMcpOAuthPending(state: string): McpOAuthPendingRow | null {
  const row = getDb()
    .query("SELECT * FROM mcp_oauth_pending WHERE state = ?")
    .get(state) as McpOAuthPendingRawRow | null;
  if (!row) return null;
  getDb().query("DELETE FROM mcp_oauth_pending WHERE state = ?").run(state);
  const key = getEncryptionKey();
  return {
    ...row,
    codeVerifier: decryptSecret(row.codeVerifier, key),
    dcrClientSecret: decryptOrNull(row.dcrClientSecret),
  };
}

export function gcMcpOAuthPending(olderThanMs = 10 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = getDb().query("DELETE FROM mcp_oauth_pending WHERE createdAt < ?").run(cutoff);
  return result.changes;
}

// ─── mcp_servers.authMethod ──────────────────────────────────────────────────

export type McpAuthMethod = "static" | "oauth" | "auto";

export function getMcpServerAuthMethod(mcpServerId: string): McpAuthMethod | null {
  const row = getDb().query("SELECT authMethod FROM mcp_servers WHERE id = ?").get(mcpServerId) as {
    authMethod: McpAuthMethod;
  } | null;
  return row?.authMethod ?? null;
}

export function setMcpServerAuthMethod(mcpServerId: string, authMethod: McpAuthMethod): void {
  getDb()
    .query(
      "UPDATE mcp_servers SET authMethod = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
    .run(authMethod, mcpServerId);
}
