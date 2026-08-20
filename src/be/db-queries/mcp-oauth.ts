import { scrubSecrets } from "../../utils/secret-scrubber";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { normalizeDateRequired } from "../date-utils";
import { getDbClient } from "../db";
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
  tokenEndpointAuthMethod: string | null;
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
  registrationEndpoint: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  scopes: string | null;
  registeredScopes: string[] | null;
  dcrClientId: string | null;
  dcrClientSecret: string | null;
  tokenEndpointAuthMethod: string | null;
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
    tokenEndpointAuthMethod:
      typeof metadata.tokenEndpointAuthMethod === "string"
        ? metadata.tokenEndpointAuthMethod
        : null,
    clientSource,
    status: statusFromUnified(row.status),
    lastErrorMessage: row.lastErrorMessage,
    lastRefreshedAt: row.lastRefreshedAt,
    connectedByUserId: row.connectedByUserId,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

async function rawMcpToken(
  mcpServerId: string,
  userId: string | null,
): Promise<UnifiedMcpTokenRow | null> {
  return await getDbClient().get<UnifiedMcpTokenRow>(
    `${tokenSelect(
      userId == null
        ? "a.mcpServerId = ? AND z.userId IS NULL"
        : "a.mcpServerId = ? AND z.userId = ?",
    )} ORDER BY z.createdAt ASC, z.id ASC LIMIT 1`,
    userId == null ? [mcpServerId] : [mcpServerId, userId],
  );
}

async function upsertMcpApp(input: {
  appId?: string;
  mcpServerId: string;
  resourceUrl: string;
  authorizationServerIssuer: string;
  registrationEndpoint?: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl?: string | null;
  scopes?: string | null;
  // The scope set the client was actually REGISTERED with at the provider —
  // distinct from `scopes` above, which becomes the token's GRANTED scope
  // once a callback completes. Omit (undefined) when this call isn't a
  // fresh registration, so the previously-recorded value survives; pass an
  // explicit array (possibly empty) only at the point a registration — fresh
  // or reused-as-is — is known to have happened.
  registeredScopes?: string[];
  dcrClientId?: string | null;
  dcrClientSecret?: string | null;
  tokenEndpointAuthMethod?: string | null;
  clientSource: McpOAuthClientSource;
  redirectUri?: string;
}): Promise<string> {
  // An app is reused only through an existing authorization's or pending
  // attempt's exact appId. Looking up by mcpServerId alone would collapse
  // the dormant per-user dimension and let one user's client context
  // overwrite another's.
  const existing = input.appId
    ? await getDbClient().get<{
        id: string;
        clientId: string;
        clientSecret: string | null;
        metadata: string;
        redirectUri: string;
        scopes: string;
      }>(
        "SELECT id, clientId, clientSecret, metadata, redirectUri, scopes FROM oauth_apps WHERE id = ?",
        [input.appId],
      )
    : null;
  // A write means the client is currently in use / believed valid — clear
  // any stale `invalidated` flag left over from a prior provider rejection.
  const existingMetadata = parseObject(existing?.metadata);
  const metadata = JSON.stringify({
    ...existingMetadata,
    resourceUrl: input.resourceUrl,
    authorizationServerIssuer: input.authorizationServerIssuer,
    registrationEndpoint: input.registrationEndpoint ?? null,
    clientSource: input.clientSource,
    ...(input.tokenEndpointAuthMethod !== undefined
      ? { tokenEndpointAuthMethod: input.tokenEndpointAuthMethod }
      : {}),
    registeredScopes:
      input.registeredScopes !== undefined
        ? input.registeredScopes
        : (existingMetadata.registeredScopes ?? null),
    invalidated: false,
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
    await getDbClient().run(
      `UPDATE oauth_apps SET
           provider = ?, clientId = ?, clientSecret = ?, clientSecretEncrypted = 1,
           authorizeUrl = ?, tokenUrl = ?, revocationUrl = ?, redirectUri = ?, scopes = ?,
           source = ?, metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      [
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
      ],
    );
    return existing.id;
  }

  const id = crypto.randomUUID();
  await getDbClient().run(
    `INSERT INTO oauth_apps (
         id, provider, clientId, clientSecret, clientSecretEncrypted,
         authorizeUrl, tokenUrl, revocationUrl, redirectUri, scopes,
         scopeSeparator, tokenAuthStyle, tokenBodyFormat,
         requiresRefreshTokenRotation, source, mcpServerId, metadata
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ' ', 'body', 'form', 0, ?, ?, ?)`,
    [
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
    ],
  );
  return id;
}

export async function getMcpOAuthToken(
  mcpServerId: string,
  userId: string | null = null,
): Promise<McpOAuthToken | null> {
  const row = await rawMcpToken(mcpServerId, userId);
  return row ? decryptTokenRow(row) : null;
}

export async function getMcpOAuthTokenById(id: string): Promise<McpOAuthToken | null> {
  const row = await getDbClient().get<UnifiedMcpTokenRow>(tokenSelect("z.id = ?"), [id]);
  return row ? decryptTokenRow(row) : null;
}

export async function listMcpOAuthTokensForMcp(mcpServerId: string): Promise<McpOAuthToken[]> {
  const rows = await getDbClient().query<UnifiedMcpTokenRow>(
    `${tokenSelect("a.mcpServerId = ?")} ORDER BY z.createdAt ASC, z.id ASC`,
    [mcpServerId],
  );
  return rows.map(decryptTokenRow);
}

// ─── DCR client reuse (avoid re-registering on every /authorize call) ────────

export interface StoredMcpOAuthClient {
  appId: string;
  clientId: string;
  clientSecret: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  redirectUri: string;
  scopes: string[];
  // The scope set the client was registered with, tracked separately from
  // `scopes` (which holds the token's granted scope once connected). Null
  // means unknown — a legacy row from before this field was recorded.
  registeredScopes: string[] | null;
  resourceUrl: string;
  authorizationServerIssuer: string;
  registrationEndpoint: string | null;
  // Null means unknown — a row written before this field was recorded. Callers
  // must resolve it through authMethodForStoredClient, not the RFC default.
  tokenEndpointAuthMethod: string | null;
  clientSource: McpOAuthClientSource;
}

type RawAppRow = {
  id: string;
  clientId: string;
  clientSecret: string | null;
  clientSecretEncrypted: number;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  redirectUri: string;
  scopes: string;
  metadata: string;
};

async function readMcpOAuthApp(appId: string): Promise<StoredMcpOAuthClient | null> {
  const row = await getDbClient().get<RawAppRow>(
    `SELECT id, clientId, clientSecret, clientSecretEncrypted, authorizeUrl, tokenUrl,
              revocationUrl, redirectUri, scopes, metadata
       FROM oauth_apps WHERE id = ?`,
    [appId],
  );
  if (!row || !row.clientId) return null;

  const metadata = parseObject(row.metadata);
  if (metadata.invalidated === true) return null;

  const clientSource =
    metadata.clientSource === "manual" ||
    metadata.clientSource === "dcr" ||
    metadata.clientSource === "preregistered"
      ? metadata.clientSource
      : "dcr";
  // Manual clients are resolved through manualClientFromToken (http layer);
  // never surface them through this reuse path.
  if (clientSource === "manual") return null;

  const clientKey = row.clientSecretEncrypted === 1 ? getEncryptionKey() : null;
  return {
    appId: row.id,
    clientId: row.clientId,
    clientSecret:
      row.clientSecret == null
        ? null
        : clientKey
          ? decryptSecret(row.clientSecret, clientKey)
          : row.clientSecret,
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    revocationUrl: row.revocationUrl,
    redirectUri: row.redirectUri,
    scopes: (() => {
      try {
        const parsed = JSON.parse(row.scopes || "[]");
        return Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        return [];
      }
    })(),
    resourceUrl: typeof metadata.resourceUrl === "string" ? metadata.resourceUrl : "",
    authorizationServerIssuer:
      typeof metadata.authorizationServerIssuer === "string"
        ? metadata.authorizationServerIssuer
        : "",
    registrationEndpoint:
      typeof metadata.registrationEndpoint === "string" ? metadata.registrationEndpoint : null,
    registeredScopes: Array.isArray(metadata.registeredScopes)
      ? (metadata.registeredScopes as string[])
      : null,
    tokenEndpointAuthMethod:
      typeof metadata.tokenEndpointAuthMethod === "string"
        ? metadata.tokenEndpointAuthMethod
        : null,
    clientSource,
  };
}

async function rawPendingAppIdForUser(
  mcpServerId: string,
  userId: string | null,
): Promise<string | null> {
  const row = await getDbClient().get<{ appId: string }>(
    `SELECT p.appId FROM oauth_pending p
       JOIN oauth_apps a ON a.id = p.appId
       WHERE p.flow = 'mcp' AND a.mcpServerId = ?
         AND ${userId == null ? "p.userId IS NULL" : "p.userId = ?"}
       ORDER BY p.createdAt DESC LIMIT 1`,
    userId == null ? [mcpServerId] : [mcpServerId, userId],
  );
  return row?.appId ?? null;
}

/**
 * Find a previously-registered (or manually-preregistered, excluded here)
 * DCR client that can be reused for this connector+user instead of running a
 * fresh RFC 7591 registration. Checks the existing token's app first (covers
 * re-authorizing an already-connected DCR client), then the most recent
 * still-live pending attempt's app (covers retrying an abandoned flow before
 * the 10-minute GC sweep). Callers must still verify AS identity
 * (issuer/registrationEndpoint/redirectUri) against fresh discovery before
 * trusting the result — this only returns what's stored.
 */
export async function findReusableMcpOAuthClient(
  mcpServerId: string,
  userId: string | null = null,
): Promise<StoredMcpOAuthClient | null> {
  const tokenRow = await rawMcpToken(mcpServerId, userId);
  if (tokenRow) {
    const client = await readMcpOAuthApp(tokenRow.appId);
    if (client) return client;
  }
  const pendingAppId = await rawPendingAppIdForUser(mcpServerId, userId);
  if (pendingAppId) {
    const client = await readMcpOAuthApp(pendingAppId);
    if (client) return client;
  }
  return null;
}

/**
 * Mark an app's stored DCR client as invalid without deleting it (deleting
 * would cascade and destroy authorization history). Idempotent per
 * client_id: a client stays the same row's `clientId` until the next
 * successful registration clears `invalidated` (see `upsertMcpApp`), so once
 * this fires, later invalid_client errors against that SAME still-stored
 * client — from the other call sites, or repeated automatic-refresh retries
 * before the next /authorize re-registers — are no-ops instead of redundant
 * writes.
 */
async function invalidateMcpOAuthApp(appId: string): Promise<void> {
  const row = await getDbClient().get<{ metadata: string }>(
    "SELECT metadata FROM oauth_apps WHERE id = ?",
    [appId],
  );
  if (!row) return;

  const meta = parseObject(row.metadata);
  if (meta.invalidated === true) return;

  const metadata = JSON.stringify({ ...meta, invalidated: true });
  await getDbClient().run(
    "UPDATE oauth_apps SET metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    [metadata, appId],
  );
}

/**
 * Mark the stored DCR client for this connector+user as invalid. The next
 * /authorize call's findReusableMcpOAuthClient will skip it and register
 * fresh exactly once.
 */
export async function invalidateMcpOAuthClient(
  mcpServerId: string,
  userId: string | null = null,
): Promise<void> {
  const tokenRow = await rawMcpToken(mcpServerId, userId);
  const appId = tokenRow?.appId ?? (await rawPendingAppIdForUser(mcpServerId, userId));
  if (!appId) return;
  await invalidateMcpOAuthApp(appId);
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
  registrationEndpoint?: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl?: string | null;
  // Pass the pending row's registeredScopes (undefined if it doesn't know
  // one) — never pass an explicit null here, or a reuse flow that already
  // has a correctly-tracked value on the still-live app row gets clobbered.
  registeredScopes?: string[];
  dcrClientId?: string | null;
  dcrClientSecret?: string | null;
  tokenEndpointAuthMethod?: string | null;
  clientSource: McpOAuthClientSource;
  status?: McpOAuthStatus;
  lastErrorMessage?: string | null;
  lastRefreshedAt?: string | null;
  connectedByUserId?: string | null;
  redirectUri?: string;
}

export async function upsertMcpOAuthToken(input: UpsertMcpOAuthTokenInput): Promise<void> {
  await getDbClient().transaction(async () => {
    const userId = input.userId ?? null;
    const existing = await rawMcpToken(input.mcpServerId, userId);
    const appId = await upsertMcpApp({
      ...(existing ? { appId: existing.appId } : {}),
      mcpServerId: input.mcpServerId,
      resourceUrl: input.resourceUrl,
      authorizationServerIssuer: input.authorizationServerIssuer,
      registrationEndpoint: input.registrationEndpoint ?? null,
      authorizeUrl: input.authorizeUrl,
      tokenUrl: input.tokenUrl,
      revocationUrl: input.revocationUrl,
      redirectUri: input.redirectUri,
      scopes: input.scope,
      registeredScopes: input.registeredScopes,
      dcrClientId: input.dcrClientId,
      dcrClientSecret: input.dcrClientSecret,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      clientSource: input.clientSource,
    });
    await upsertAuthorization({
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
  });
}

export async function applyMcpOAuthRefresh(
  id: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    scope?: string | null;
    expectedTokenVersion?: number;
  },
): Promise<void> {
  const updated = await updateAuthorizationTokens(id, {
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

export async function markMcpOAuthTokenStatus(
  id: string,
  status: McpOAuthStatus,
  errorMessage?: string | null,
): Promise<void> {
  await getDbClient().run(
    `UPDATE oauth_authorizations
       SET status = ?, lastErrorMessage = ?,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    [statusToUnified(status), errorMessage ?? null, id],
  );
}

export async function deleteMcpOAuthToken(
  mcpServerId: string,
  userId: string | null = null,
): Promise<boolean> {
  const existing = await rawMcpToken(mcpServerId, userId);
  if (!existing) return false;
  const result = await getDbClient().run(
    `UPDATE oauth_authorizations SET
         accessToken = ?, refreshToken = NULL, expiresAt = NULL, scope = NULL,
         tokensEncrypted = 1, tokenVersion = tokenVersion + 1,
         status = 'revoked', lastErrorMessage = NULL, lastRefreshedAt = NULL,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    [encryptSecret("", getEncryptionKey()), existing.id],
  );
  if (result.changes === 1) {
    // Disconnect is the canonical user recovery gesture. Clear the stored
    // DCR client too, or Reconnect silently hands back the same client_id —
    // rawMcpToken has no status filter, so findReusableMcpOAuthClient would
    // otherwise still surface a "revoked" token's client as reusable.
    await invalidateMcpOAuthApp(existing.appId);
  }
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
  registrationEndpoint?: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl?: string | null;
  scopes?: string | null;
  // Set only when this pending attempt just performed a fresh DCR
  // registration (or is otherwise the authority on what the client was
  // registered with) — see upsertMcpApp's `registeredScopes` doc.
  registeredScopes?: string[];
  dcrClientId?: string | null;
  dcrClientSecret?: string | null;
  tokenEndpointAuthMethod?: string | null;
  redirectUri: string;
  finalRedirect?: string | null;
}

export async function insertMcpOAuthPending(input: InsertMcpOAuthPendingInput): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    const userId = input.userId ?? null;
    const existingToken = await rawMcpToken(input.mcpServerId, userId);
    const clientSource = existingToken
      ? decryptTokenRow(existingToken).clientSource
      : input.dcrClientId
        ? "dcr"
        : "preregistered";
    // A pending attempt must not mutate a *valid* connected app — a different
    // client context might be tried concurrently while the old one keeps
    // working. But if the connected app was invalidated (provider rejected
    // it — see invalidateMcpOAuthClient), this pending attempt IS the
    // recovery registration for that exact appId, so it must update the row
    // in place; otherwise the invalidated flag never clears and every future
    // /authorize call re-registers again (an infinite-registration loop).
    // If no authorization exists yet, reuse the most recent still-live
    // pending attempt's app for this same connector+user (this is what lets
    // a retried/abandoned authorize call share one DCR client instead of
    // registering a fresh one — see findReusableMcpOAuthClient in the http
    // layer) instead of always creating a new row; consume/GC removes it
    // once it's orphaned.
    const existingTokenAppValid = existingToken
      ? (await readMcpOAuthApp(existingToken.appId)) != null
      : false;
    const reuseAppId = existingToken
      ? existingToken.appId
      : await rawPendingAppIdForUser(input.mcpServerId, userId);
    const appId =
      existingToken && existingTokenAppValid
        ? existingToken.appId
        : await upsertMcpApp({
            ...(reuseAppId ? { appId: reuseAppId } : {}),
            mcpServerId: input.mcpServerId,
            resourceUrl: input.resourceUrl,
            authorizationServerIssuer: input.authorizationServerIssuer,
            registrationEndpoint: input.registrationEndpoint ?? null,
            authorizeUrl: input.authorizeUrl,
            tokenUrl: input.tokenUrl,
            revocationUrl: input.revocationUrl,
            scopes: input.scopes,
            registeredScopes: input.registeredScopes,
            dcrClientId: input.dcrClientId,
            dcrClientSecret: input.dcrClientSecret,
            tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
            clientSource,
            redirectUri: input.redirectUri,
          });
    const contextJson = JSON.stringify({
      resourceUrl: input.resourceUrl,
      authorizationServerIssuer: input.authorizationServerIssuer,
      registrationEndpoint: input.registrationEndpoint ?? null,
      authorizeUrl: input.authorizeUrl,
      tokenUrl: input.tokenUrl,
      revocationUrl: input.revocationUrl ?? null,
      scopes: input.scopes ?? null,
      // Carried through the pending row so a first-ever connect's callback
      // can restore it: consumeMcpOAuthPending's deleteOrphanMcpApp deletes
      // this app the moment the pending row is consumed (no authorization
      // exists yet), so the metadata written by insertMcpOAuthPending's own
      // upsertMcpApp call above does not survive to the following
      // upsertMcpOAuthToken call — it re-creates the row from scratch.
      registeredScopes: input.registeredScopes ?? null,
      dcrClientId: input.dcrClientId ?? null,
      dcrClientSecret:
        input.dcrClientSecret == null
          ? null
          : encryptSecret(input.dcrClientSecret, getEncryptionKey()),
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? null,
      clientSource,
    });
    await tx.run(
      `INSERT INTO oauth_pending (
         state, appId, label, flow, codeVerifier, nonce,
         redirectUri, finalRedirect, userId, contextJson
       ) VALUES (?, ?, ?, 'mcp', ?, ?, ?, ?, ?, ?)`,
      [
        input.state,
        appId,
        userId ? `user:${userId}` : "default",
        encryptSecret(input.codeVerifier, getEncryptionKey()),
        input.nonce ?? null,
        input.redirectUri,
        input.finalRedirect ?? null,
        userId,
        contextJson,
      ],
    );
  });
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

async function rawPending(state: string): Promise<UnifiedPendingRow | null> {
  return await getDbClient().get<UnifiedPendingRow>(
    `SELECT p.state, a.mcpServerId, p.userId, p.codeVerifier, p.nonce,
              p.redirectUri, p.finalRedirect, p.createdAt,
              p.appId, p.contextJson
       FROM oauth_pending p
       JOIN oauth_apps a ON a.id = p.appId
       WHERE p.state = ? AND p.flow = 'mcp'`,
    [state],
  );
}

async function deleteOrphanMcpApp(appId: string): Promise<void> {
  await getDbClient().run(
    `DELETE FROM oauth_apps
       WHERE id = ? AND mcpServerId IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM oauth_authorizations WHERE appId = oauth_apps.id)
         AND NOT EXISTS (SELECT 1 FROM oauth_pending WHERE appId = oauth_apps.id)`,
    [appId],
  );
}

export async function consumeMcpOAuthPending(state: string): Promise<McpOAuthPendingRow | null> {
  return await getDbClient().transaction(async (tx) => {
    const row = await rawPending(state);
    if (!row) return null;
    await tx.run("DELETE FROM oauth_pending WHERE state = ? AND flow = 'mcp'", [state]);
    const context = parseObject(row.contextJson);
    await deleteOrphanMcpApp(row.appId);
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
      registrationEndpoint:
        typeof context.registrationEndpoint === "string" ? context.registrationEndpoint : null,
      authorizeUrl: typeof context.authorizeUrl === "string" ? context.authorizeUrl : "",
      tokenUrl: typeof context.tokenUrl === "string" ? context.tokenUrl : "",
      revocationUrl: typeof context.revocationUrl === "string" ? context.revocationUrl : null,
      scopes: typeof context.scopes === "string" ? context.scopes : null,
      registeredScopes: Array.isArray(context.registeredScopes)
        ? (context.registeredScopes as string[])
        : null,
      dcrClientId: typeof context.dcrClientId === "string" ? context.dcrClientId : null,
      dcrClientSecret: encryptedClientSecret
        ? decryptSecret(encryptedClientSecret, getEncryptionKey())
        : null,
      tokenEndpointAuthMethod:
        typeof context.tokenEndpointAuthMethod === "string"
          ? context.tokenEndpointAuthMethod
          : null,
      redirectUri: row.redirectUri,
      finalRedirect: row.finalRedirect,
      createdAt: normalizeDateRequired(row.createdAt),
    };
  });
}

export async function gcMcpOAuthPending(olderThanMs = 10 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return await getDbClient().transaction(async (tx) => {
    const appIds = await tx.query<{ appId: string }>(
      "SELECT DISTINCT appId FROM oauth_pending WHERE flow = 'mcp' AND createdAt < ?",
      [cutoff],
    );
    const result = await tx.run("DELETE FROM oauth_pending WHERE flow = 'mcp' AND createdAt < ?", [
      cutoff,
    ]);
    for (const { appId } of appIds) await deleteOrphanMcpApp(appId);
    return result.changes;
  });
}

export type McpAuthMethod = "static" | "oauth" | "auto";

export async function getMcpServerAuthMethod(mcpServerId: string): Promise<McpAuthMethod | null> {
  const row = await getDbClient().get<{ authMethod: McpAuthMethod }>(
    "SELECT authMethod FROM mcp_servers WHERE id = ?",
    [mcpServerId],
  );
  return row?.authMethod ?? null;
}

export async function setMcpServerAuthMethod(
  mcpServerId: string,
  authMethod: McpAuthMethod,
): Promise<void> {
  await getDbClient().run(
    "UPDATE mcp_servers SET authMethod = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    [authMethod, mcpServerId],
  );
}
