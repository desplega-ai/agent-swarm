import { scrubSecrets } from "../../utils/secret-scrubber";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { normalizeDateRequired } from "../date-utils";
import { getDb } from "../db";
import {
  type OAuthAuthorizationStatus,
  updateAuthorizationTokens,
  upsertAuthorization,
} from "./oauth";

export type McpOAuthStatus = "connected" | "expired" | "error" | "revoked";
export type McpOAuthClientSource = "dcr" | "manual" | "preregistered";

type UnifiedMcpTokenRow = {
  id: string;
  appId: string;
  mcpServerId: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  scope: string | null;
  tokensEncrypted: number;
  tokenVersion: number;
  status: OAuthAuthorizationStatus;
  lastErrorMessage: string | null;
  lastRefreshedAt: string | null;
  connectedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  clientId: string;
  clientSecret: string | null;
  clientSecretEncrypted: number;
  scopes: string;
  source: "manual" | "dcr" | "curated-prefill";
  metadata: string;
};

export interface McpOAuthToken {
  id: string;
  mcpServerId: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  scope: string | null;
  tokenVersion: number;
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

export interface McpOAuthPendingRow {
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

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function storeScopes(value: string | null | undefined): string {
  return JSON.stringify(
    (value ?? "")
      .split(" ")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

function statusFromUnified(status: OAuthAuthorizationStatus): McpOAuthStatus {
  if (status === "active") return "connected";
  if (status === "refresh-failed") return "error";
  return status;
}

function statusToUnified(status: McpOAuthStatus): OAuthAuthorizationStatus {
  if (status === "connected") return "active";
  if (status === "error") return "refresh-failed";
  return status;
}

function tokenSelect(where: string): string {
  return `SELECT
    z.id, z.appId, a.mcpServerId, z.userId,
    z.accessToken, z.refreshToken, z.tokenType, z.expiresAt, z.scope,
    z.tokensEncrypted, z.tokenVersion, z.status, z.lastErrorMessage, z.lastRefreshedAt,
    z.connectedByUserId, z.createdAt, z.updatedAt,
    a.authorizeUrl, a.tokenUrl, a.revocationUrl, a.clientId, a.clientSecret,
    a.clientSecretEncrypted, a.scopes, a.source, a.metadata
  FROM oauth_authorizations z
  JOIN oauth_apps a ON a.id = z.appId
  WHERE a.mcpServerId IS NOT NULL AND ${where}`;
}

function decryptTokenRow(row: UnifiedMcpTokenRow): McpOAuthToken {
  const metadata = parseObject(row.metadata);
  const tokenKey = row.tokensEncrypted === 1 ? getEncryptionKey() : null;
  const clientKey = row.clientSecretEncrypted === 1 ? getEncryptionKey() : null;
  const clientSource =
    metadata.clientSource === "dcr" ||
    metadata.clientSource === "manual" ||
    metadata.clientSource === "preregistered"
      ? metadata.clientSource
      : row.source === "dcr"
        ? "dcr"
        : "manual";
  return {
    id: row.id,
    mcpServerId: row.mcpServerId,
    userId: row.userId,
    accessToken: tokenKey ? decryptSecret(row.accessToken, tokenKey) : row.accessToken,
    refreshToken:
      row.refreshToken == null
        ? null
        : tokenKey
          ? decryptSecret(row.refreshToken, tokenKey)
          : row.refreshToken,
    tokenType: row.tokenType,
    expiresAt: row.expiresAt,
    scope: row.scope,
    tokenVersion: row.tokenVersion,
    resourceUrl: typeof metadata.resourceUrl === "string" ? metadata.resourceUrl : "",
    authorizationServerIssuer:
      typeof metadata.authorizationServerIssuer === "string"
        ? metadata.authorizationServerIssuer
        : "",
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    revocationUrl: row.revocationUrl,
    dcrClientId: row.clientId || null,
    dcrClientSecret:
      row.clientSecret == null
        ? null
        : clientKey
          ? decryptSecret(row.clientSecret, clientKey)
          : row.clientSecret,
    clientSource,
    status: statusFromUnified(row.status),
    lastErrorMessage: row.lastErrorMessage,
    lastRefreshedAt: row.lastRefreshedAt,
    connectedByUserId: row.connectedByUserId,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

function rawMcpToken(mcpServerId: string, userId: string | null): UnifiedMcpTokenRow | null {
  return getDb()
    .query(
      `${tokenSelect(
        userId == null
          ? "a.mcpServerId = ? AND z.userId IS NULL"
          : "a.mcpServerId = ? AND z.userId = ?",
      )} ORDER BY z.createdAt ASC, z.id ASC LIMIT 1`,
    )
    .get(...(userId == null ? [mcpServerId] : [mcpServerId, userId])) as UnifiedMcpTokenRow | null;
}

function upsertMcpApp(input: {
  appId?: string;
  mcpServerId: string;
  resourceUrl: string;
  authorizationServerIssuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl?: string | null;
  scopes?: string | null;
  dcrClientId?: string | null;
  dcrClientSecret?: string | null;
  clientSource: McpOAuthClientSource;
  redirectUri?: string;
}): string {
  // An app is reused only through an existing authorization's exact appId.
  // Looking up by mcpServerId alone would collapse the dormant per-user
  // dimension and let one user's client context overwrite another's.
  const existing = input.appId
    ? (getDb()
        .query(
          "SELECT id, clientId, clientSecret, metadata, redirectUri, scopes FROM oauth_apps WHERE id = ?",
        )
        .get(input.appId) as {
        id: string;
        clientId: string;
        clientSecret: string | null;
        metadata: string;
        redirectUri: string;
        scopes: string;
      } | null)
    : null;
  const metadata = JSON.stringify({
    ...parseObject(existing?.metadata),
    resourceUrl: input.resourceUrl,
    authorizationServerIssuer: input.authorizationServerIssuer,
    clientSource: input.clientSource,
  });
  const encryptedClientSecret =
    input.dcrClientSecret == null || input.dcrClientSecret === ""
      ? (existing?.clientSecret ?? null)
      : encryptSecret(input.dcrClientSecret, getEncryptionKey());
  // MCP OAuth applications are DCR-owned storage rows even when the client
  // credentials were supplied manually or preregistered. Preserve that exact
  // distinction in metadata for the legacy adapter boundary.
  const source = "dcr";

  if (existing) {
    getDb()
      .query(
        `UPDATE oauth_apps SET
           provider = ?, clientId = ?, clientSecret = ?, clientSecretEncrypted = 1,
           authorizeUrl = ?, tokenUrl = ?, revocationUrl = ?, redirectUri = ?, scopes = ?,
           source = ?, metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(
        `mcp-${input.mcpServerId}`,
        input.dcrClientId ?? existing.clientId,
        encryptedClientSecret,
        input.authorizeUrl,
        input.tokenUrl,
        input.revocationUrl ?? null,
        input.redirectUri ?? existing.redirectUri,
        input.scopes == null ? existing.scopes : storeScopes(input.scopes),
        source,
        metadata,
        existing.id,
      );
    return existing.id;
  }

  const id = crypto.randomUUID();
  getDb()
    .query(
      `INSERT INTO oauth_apps (
         id, provider, clientId, clientSecret, clientSecretEncrypted,
         authorizeUrl, tokenUrl, revocationUrl, redirectUri, scopes,
         scopeSeparator, tokenAuthStyle, tokenBodyFormat,
         requiresRefreshTokenRotation, source, mcpServerId, metadata
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ' ', 'body', 'form', 0, ?, ?, ?)`,
    )
    .run(
      id,
      `mcp-${input.mcpServerId}`,
      input.dcrClientId ?? "",
      encryptedClientSecret,
      input.authorizeUrl,
      input.tokenUrl,
      input.revocationUrl ?? null,
      input.redirectUri ?? "",
      storeScopes(input.scopes),
      source,
      input.mcpServerId,
      metadata,
    );
  return id;
}

export function getMcpOAuthToken(
  mcpServerId: string,
  userId: string | null = null,
): McpOAuthToken | null {
  const row = rawMcpToken(mcpServerId, userId);
  return row ? decryptTokenRow(row) : null;
}

export function getMcpOAuthTokenById(id: string): McpOAuthToken | null {
  const row = getDb().query(tokenSelect("z.id = ?")).get(id) as UnifiedMcpTokenRow | null;
  return row ? decryptTokenRow(row) : null;
}

export function listMcpOAuthTokensForMcp(mcpServerId: string): McpOAuthToken[] {
  const rows = getDb()
    .query(`${tokenSelect("a.mcpServerId = ?")} ORDER BY z.createdAt ASC, z.id ASC`)
    .all(mcpServerId) as UnifiedMcpTokenRow[];
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

export function upsertMcpOAuthToken(input: UpsertMcpOAuthTokenInput): void {
  getDb().transaction(() => {
    const userId = input.userId ?? null;
    const existing = rawMcpToken(input.mcpServerId, userId);
    const appId = upsertMcpApp({
      ...(existing ? { appId: existing.appId } : {}),
      mcpServerId: input.mcpServerId,
      resourceUrl: input.resourceUrl,
      authorizationServerIssuer: input.authorizationServerIssuer,
      authorizeUrl: input.authorizeUrl,
      tokenUrl: input.tokenUrl,
      revocationUrl: input.revocationUrl,
      scopes: input.scope,
      dcrClientId: input.dcrClientId,
      dcrClientSecret: input.dcrClientSecret,
      clientSource: input.clientSource,
    });
    upsertAuthorization({
      ...(existing ? { id: existing.id } : {}),
      appId,
      label: userId ? `user:${userId}` : "default",
      userId,
      accessToken: input.accessToken,
      ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
      tokenType: input.tokenType ?? "Bearer",
      expiresAt: input.expiresAt ?? null,
      ...(input.scope != null ? { scope: input.scope } : {}),
      status: statusToUnified(input.status ?? "connected"),
      lastErrorMessage: input.lastErrorMessage ?? null,
      lastRefreshedAt: input.lastRefreshedAt ?? null,
      ...(input.connectedByUserId != null ? { connectedByUserId: input.connectedByUserId } : {}),
    });
  })();
}

export function applyMcpOAuthRefresh(
  id: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    scope?: string | null;
    expectedTokenVersion?: number;
  },
): void {
  const updated = updateAuthorizationTokens(id, {
    accessToken: data.accessToken,
    ...(data.refreshToken !== undefined ? { refreshToken: data.refreshToken } : {}),
    ...(data.expiresAt != null ? { expiresAt: data.expiresAt } : {}),
    ...(data.scope != null ? { scope: data.scope } : {}),
    ...(data.expectedTokenVersion !== undefined
      ? { expectedTokenVersion: data.expectedTokenVersion }
      : {}),
  });
  if (updated) return;

  const message = `MCP OAuth refresh persistence conflict for authorization ${id}: token version changed during refresh`;
  console.warn(`[mcp-oauth] ${scrubSecrets(message)}`);
  throw new Error(message);
}

export function markMcpOAuthTokenStatus(
  id: string,
  status: McpOAuthStatus,
  errorMessage?: string | null,
): void {
  getDb()
    .query(
      `UPDATE oauth_authorizations
       SET status = ?, lastErrorMessage = ?,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(statusToUnified(status), errorMessage ?? null, id);
}

export function deleteMcpOAuthToken(mcpServerId: string, userId: string | null = null): boolean {
  const existing = rawMcpToken(mcpServerId, userId);
  if (!existing) return false;
  const result = getDb()
    .query(
      `UPDATE oauth_authorizations SET
         accessToken = ?, refreshToken = NULL, expiresAt = NULL, scope = NULL,
         tokensEncrypted = 1, tokenVersion = tokenVersion + 1,
         status = 'revoked', lastErrorMessage = NULL, lastRefreshedAt = NULL,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(encryptSecret("", getEncryptionKey()), existing.id);
  return result.changes === 1;
}

export function isMcpTokenExpiringSoon(token: McpOAuthToken, bufferMs = 5 * 60 * 1000): boolean {
  if (!token.expiresAt) return false;
  const expiresAt = new Date(token.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < bufferMs;
}

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
  getDb().transaction(() => {
    const existingToken = rawMcpToken(input.mcpServerId, input.userId ?? null);
    const clientSource = existingToken
      ? decryptTokenRow(existingToken).clientSource
      : input.dcrClientId
        ? "dcr"
        : "preregistered";
    // A pending attempt must not mutate the connected app. If no authorization
    // exists yet, create a short-lived app solely to satisfy oauth_pending's FK;
    // consume/GC removes it when it remains orphaned.
    const appId =
      existingToken?.appId ??
      upsertMcpApp({
        mcpServerId: input.mcpServerId,
        resourceUrl: input.resourceUrl,
        authorizationServerIssuer: input.authorizationServerIssuer,
        authorizeUrl: input.authorizeUrl,
        tokenUrl: input.tokenUrl,
        revocationUrl: input.revocationUrl,
        scopes: input.scopes,
        dcrClientId: input.dcrClientId,
        dcrClientSecret: input.dcrClientSecret,
        clientSource,
        redirectUri: input.redirectUri,
      });
    const contextJson = JSON.stringify({
      resourceUrl: input.resourceUrl,
      authorizationServerIssuer: input.authorizationServerIssuer,
      authorizeUrl: input.authorizeUrl,
      tokenUrl: input.tokenUrl,
      revocationUrl: input.revocationUrl ?? null,
      scopes: input.scopes ?? null,
      dcrClientId: input.dcrClientId ?? null,
      dcrClientSecret:
        input.dcrClientSecret == null
          ? null
          : encryptSecret(input.dcrClientSecret, getEncryptionKey()),
      clientSource,
    });
    getDb()
      .query(
        `INSERT INTO oauth_pending (
         state, appId, label, flow, codeVerifier, nonce,
         redirectUri, finalRedirect, userId, contextJson
       ) VALUES (?, ?, ?, 'mcp', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.state,
        appId,
        input.userId ? `user:${input.userId}` : "default",
        encryptSecret(input.codeVerifier, getEncryptionKey()),
        input.nonce ?? null,
        input.redirectUri,
        input.finalRedirect ?? null,
        input.userId ?? null,
        contextJson,
      );
  })();
}

type UnifiedPendingRow = {
  state: string;
  mcpServerId: string;
  userId: string | null;
  codeVerifier: string;
  nonce: string | null;
  redirectUri: string;
  finalRedirect: string | null;
  createdAt: string;
  appId: string;
  contextJson: string;
};

function rawPending(state: string): UnifiedPendingRow | null {
  return getDb()
    .query(
      `SELECT p.state, a.mcpServerId, p.userId, p.codeVerifier, p.nonce,
              p.redirectUri, p.finalRedirect, p.createdAt,
              p.appId, p.contextJson
       FROM oauth_pending p
       JOIN oauth_apps a ON a.id = p.appId
       WHERE p.state = ? AND p.flow = 'mcp'`,
    )
    .get(state) as UnifiedPendingRow | null;
}

function deleteOrphanMcpApp(appId: string): void {
  getDb()
    .query(
      `DELETE FROM oauth_apps
       WHERE id = ? AND mcpServerId IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM oauth_authorizations WHERE appId = oauth_apps.id)
         AND NOT EXISTS (SELECT 1 FROM oauth_pending WHERE appId = oauth_apps.id)`,
    )
    .run(appId);
}

export function consumeMcpOAuthPending(state: string): McpOAuthPendingRow | null {
  return getDb().transaction(() => {
    const row = rawPending(state);
    if (!row) return null;
    getDb().query("DELETE FROM oauth_pending WHERE state = ? AND flow = 'mcp'").run(state);
    const context = parseObject(row.contextJson);
    deleteOrphanMcpApp(row.appId);
    const encryptedClientSecret =
      typeof context.dcrClientSecret === "string" ? context.dcrClientSecret : null;
    return {
      state: row.state,
      mcpServerId: row.mcpServerId,
      userId: row.userId,
      codeVerifier: decryptSecret(row.codeVerifier, getEncryptionKey()),
      nonce: row.nonce,
      resourceUrl: typeof context.resourceUrl === "string" ? context.resourceUrl : "",
      authorizationServerIssuer:
        typeof context.authorizationServerIssuer === "string"
          ? context.authorizationServerIssuer
          : "",
      authorizeUrl: typeof context.authorizeUrl === "string" ? context.authorizeUrl : "",
      tokenUrl: typeof context.tokenUrl === "string" ? context.tokenUrl : "",
      revocationUrl: typeof context.revocationUrl === "string" ? context.revocationUrl : null,
      scopes: typeof context.scopes === "string" ? context.scopes : null,
      dcrClientId: typeof context.dcrClientId === "string" ? context.dcrClientId : null,
      dcrClientSecret: encryptedClientSecret
        ? decryptSecret(encryptedClientSecret, getEncryptionKey())
        : null,
      redirectUri: row.redirectUri,
      finalRedirect: row.finalRedirect,
      createdAt: normalizeDateRequired(row.createdAt),
    };
  })();
}

export function gcMcpOAuthPending(olderThanMs = 10 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return getDb().transaction(() => {
    const appIds = getDb()
      .query<{ appId: string }, [string]>(
        "SELECT DISTINCT appId FROM oauth_pending WHERE flow = 'mcp' AND createdAt < ?",
      )
      .all(cutoff);
    const result = getDb()
      .query("DELETE FROM oauth_pending WHERE flow = 'mcp' AND createdAt < ?")
      .run(cutoff);
    for (const { appId } of appIds) deleteOrphanMcpApp(appId);
    return result.changes;
  })();
}

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
