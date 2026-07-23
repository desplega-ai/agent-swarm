import type { OAuthApp, OAuthTokens } from "../../tracker/types";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { normalizeDateRequired } from "../date-utils";
import { getDb } from "../db";

type OAuthAppRow = Omit<
  OAuthApp,
  "clientSecretEncrypted" | "requiresRefreshTokenRotation" | "scopes"
> & {
  clientSecret: string | null;
  clientSecretEncrypted: number;
  requiresRefreshTokenRotation: number;
  scopes: string;
};

export type OAuthAuthorizationStatus = "active" | "refresh-failed" | "expired" | "revoked";

type OAuthAuthorizationRow = {
  id: string;
  appId: string;
  label: string;
  userId: string | null;
  accountEmail: string | null;
  identityJson: string | null;
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
};

export type OAuthAuthorization = Omit<OAuthAuthorizationRow, "tokensEncrypted"> & {
  tokensEncrypted: boolean;
};

function parseScopeList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Legacy callers still pass comma-delimited scope strings.
  }
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function storeScopeList(value: string | string[]): string {
  return JSON.stringify(Array.isArray(value) ? value : parseScopeList(value));
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

function storageMetadata(metadata: string): {
  metadata: string;
  extraParamsJson: string | null;
  tokenAuthStyle: "body" | "basic";
  tokenBodyFormat: "form" | "json";
  revocationUrl: string | null;
} {
  const parsed = parseObject(metadata);
  const extraParams =
    parsed.extraParams &&
    typeof parsed.extraParams === "object" &&
    !Array.isArray(parsed.extraParams)
      ? parsed.extraParams
      : null;
  const tokenAuthStyle = parsed.tokenAuthStyle === "basic" ? "basic" : "body";
  const tokenBodyFormat = parsed.tokenBodyFormat === "json" ? "json" : "form";
  const revocationUrl = typeof parsed.revocationUrl === "string" ? parsed.revocationUrl : null;
  const hasLiftedFields = [
    "extraParams",
    "tokenAuthStyle",
    "tokenBodyFormat",
    "revocationUrl",
  ].some((key) => Object.hasOwn(parsed, key));
  if (hasLiftedFields) {
    delete parsed.extraParams;
    delete parsed.tokenAuthStyle;
    delete parsed.tokenBodyFormat;
    delete parsed.revocationUrl;
  }
  return {
    metadata: hasLiftedFields ? JSON.stringify(parsed) : metadata,
    extraParamsJson: extraParams ? JSON.stringify(extraParams) : null,
    tokenAuthStyle,
    tokenBodyFormat,
    revocationUrl,
  };
}

function normalizeOAuthApp(row: OAuthAppRow): OAuthApp {
  const encrypted = row.clientSecretEncrypted === 1;
  return {
    ...row,
    clientSecret:
      row.clientSecret == null
        ? ""
        : encrypted
          ? decryptSecret(row.clientSecret, getEncryptionKey())
          : row.clientSecret,
    clientSecretEncrypted: encrypted,
    scopes: parseScopeList(row.scopes).join(","),
    requiresRefreshTokenRotation: row.requiresRefreshTokenRotation === 1,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

function normalizeAuthorization(row: OAuthAuthorizationRow): OAuthAuthorization {
  const encrypted = row.tokensEncrypted === 1;
  const key = encrypted ? getEncryptionKey() : null;
  return {
    ...row,
    accessToken: key ? decryptSecret(row.accessToken, key) : row.accessToken,
    refreshToken:
      row.refreshToken == null
        ? null
        : key
          ? decryptSecret(row.refreshToken, key)
          : row.refreshToken,
    tokensEncrypted: encrypted,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

function rawOAuthAppByProvider(provider: string): OAuthAppRow | null {
  return getDb()
    .query(
      `SELECT * FROM oauth_apps
       WHERE provider = ? AND mcpServerId IS NULL
       ORDER BY createdAt ASC, id ASC
       LIMIT 1`,
    )
    .get(provider) as OAuthAppRow | null;
}

function rawDefaultAuthorizationForApp(appId: string): OAuthAuthorizationRow | null {
  return getDb()
    .query("SELECT * FROM oauth_authorizations WHERE appId = ? AND label = 'default'")
    .get(appId) as OAuthAuthorizationRow | null;
}

function rawDefaultAuthorizationForProvider(provider: string): OAuthAuthorizationRow | null {
  return getDb()
    .query(
      `SELECT z.*
       FROM oauth_authorizations z
       JOIN oauth_apps a ON a.id = z.appId
       WHERE a.provider = ? AND a.mcpServerId IS NULL AND z.label = 'default'
       ORDER BY a.createdAt ASC, a.id ASC
       LIMIT 1`,
    )
    .get(provider) as OAuthAuthorizationRow | null;
}

export function getDefaultAuthorizationIdForProvider(provider: string): string | null {
  return rawDefaultAuthorizationForProvider(provider)?.id ?? null;
}

// ── OAuth Apps ──

export function getOAuthApp(provider: string): OAuthApp | null {
  const row = rawOAuthAppByProvider(provider);
  return row ? normalizeOAuthApp(row) : null;
}

export function getOAuthAppById(id: string): OAuthApp | null {
  const row = getDb().query("SELECT * FROM oauth_apps WHERE id = ?").get(id) as OAuthAppRow | null;
  return row ? normalizeOAuthApp(row) : null;
}

/** Resolve the (non-MCP) app id for a provider slug, or null if none. */
export function getOAuthAppIdByProvider(provider: string): string | null {
  return rawOAuthAppByProvider(provider)?.id ?? null;
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
    displayName?: string | null;
    revocationUrl?: string | null;
    userinfoUrl?: string | null;
    scopeSeparator?: string;
    tokenAuthStyle?: "body" | "basic";
    tokenBodyFormat?: "form" | "json";
    requiresRefreshTokenRotation?: boolean;
    extraParams?: Record<string, string> | null;
    source?: "manual" | "dcr" | "curated-prefill";
  },
): void {
  const existing = rawOAuthAppByProvider(provider);
  const metadataProvided = data.metadata !== undefined;
  const lifted = metadataProvided ? storageMetadata(data.metadata as string) : null;
  const encryptedSecret = encryptSecret(data.clientSecret, getEncryptionKey());
  const scopeSeparator =
    data.scopeSeparator ?? existing?.scopeSeparator ?? (provider === "linear" ? "," : " ");
  const rotation =
    data.requiresRefreshTokenRotation ??
    (existing ? existing.requiresRefreshTokenRotation === 1 : provider === "jira");
  const tokenAuthStyle =
    data.tokenAuthStyle ?? lifted?.tokenAuthStyle ?? existing?.tokenAuthStyle ?? "body";
  const tokenBodyFormat =
    data.tokenBodyFormat ?? lifted?.tokenBodyFormat ?? existing?.tokenBodyFormat ?? "form";
  const extraParamsJson =
    data.extraParams !== undefined
      ? data.extraParams == null
        ? null
        : JSON.stringify(data.extraParams)
      : lifted
        ? lifted.extraParamsJson
        : (existing?.extraParamsJson ?? null);
  const revocationUrl =
    data.revocationUrl !== undefined
      ? data.revocationUrl
      : lifted
        ? lifted.revocationUrl
        : (existing?.revocationUrl ?? null);

  if (existing) {
    getDb()
      .query(
        `UPDATE oauth_apps SET
           displayName = ?, clientId = ?, clientSecret = ?, clientSecretEncrypted = 1,
           authorizeUrl = ?, tokenUrl = ?, revocationUrl = ?, userinfoUrl = ?,
           redirectUri = ?, scopes = ?, scopeSeparator = ?, tokenAuthStyle = ?,
           tokenBodyFormat = ?, requiresRefreshTokenRotation = ?, extraParamsJson = ?,
           source = ?, metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(
        data.displayName !== undefined ? data.displayName : existing.displayName,
        data.clientId,
        encryptedSecret,
        data.authorizeUrl,
        data.tokenUrl,
        revocationUrl,
        data.userinfoUrl !== undefined ? data.userinfoUrl : existing.userinfoUrl,
        data.redirectUri,
        storeScopeList(data.scopes),
        scopeSeparator,
        tokenAuthStyle,
        tokenBodyFormat,
        rotation ? 1 : 0,
        extraParamsJson,
        data.source ?? existing.source,
        lifted?.metadata ?? existing.metadata,
        existing.id,
      );
    return;
  }

  getDb()
    .query(
      `INSERT INTO oauth_apps (
         provider, displayName, clientId, clientSecret, clientSecretEncrypted,
         authorizeUrl, tokenUrl, revocationUrl, userinfoUrl, redirectUri, scopes,
         scopeSeparator, tokenAuthStyle, tokenBodyFormat,
         requiresRefreshTokenRotation, extraParamsJson, source, metadata
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      provider,
      data.displayName ?? null,
      data.clientId,
      encryptedSecret,
      data.authorizeUrl,
      data.tokenUrl,
      revocationUrl,
      data.userinfoUrl ?? null,
      data.redirectUri,
      storeScopeList(data.scopes),
      scopeSeparator,
      tokenAuthStyle,
      tokenBodyFormat,
      rotation ? 1 : 0,
      extraParamsJson,
      data.source ?? "manual",
      lifted?.metadata ?? "{}",
    );
}

// ── OAuth Authorizations ──

export function listAuthorizationsForApp(appId: string): OAuthAuthorization[] {
  const rows = getDb()
    .query("SELECT * FROM oauth_authorizations WHERE appId = ? ORDER BY createdAt ASC, id ASC")
    .all(appId) as OAuthAuthorizationRow[];
  return rows.map(normalizeAuthorization);
}

export function getAuthorizationById(id: string): OAuthAuthorization | null {
  const row = getDb()
    .query("SELECT * FROM oauth_authorizations WHERE id = ?")
    .get(id) as OAuthAuthorizationRow | null;
  return row ? normalizeAuthorization(row) : null;
}

export function upsertAuthorization(data: {
  id?: string;
  appId: string;
  label?: string;
  userId?: string | null;
  accountEmail?: string | null;
  identityJson?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string;
  expiresAt?: string | null;
  scope?: string | null;
  status?: OAuthAuthorizationStatus;
  lastErrorMessage?: string | null;
  lastRefreshedAt?: string | null;
  connectedByUserId?: string | null;
}): OAuthAuthorization {
  const label = data.label ?? "default";
  const existing = data.id
    ? getAuthorizationById(data.id)
    : listAuthorizationsForApp(data.appId).find((row) => row.label === label);
  const key = getEncryptionKey();
  const accessToken = encryptSecret(data.accessToken, key);
  const refreshToken =
    data.refreshToken === undefined
      ? undefined
      : data.refreshToken == null
        ? null
        : encryptSecret(data.refreshToken, key);

  if (existing) {
    getDb()
      .query(
        `UPDATE oauth_authorizations SET
           userId = ?, accountEmail = ?, identityJson = ?, accessToken = ?,
           refreshToken = ?, tokenType = ?, expiresAt = ?, scope = ?,
           tokensEncrypted = 1, tokenVersion = tokenVersion + 1, status = ?,
           lastErrorMessage = ?, lastRefreshedAt = ?, connectedByUserId = ?,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(
        data.userId !== undefined ? data.userId : existing.userId,
        data.accountEmail !== undefined ? data.accountEmail : existing.accountEmail,
        data.identityJson !== undefined ? data.identityJson : existing.identityJson,
        accessToken,
        refreshToken === undefined
          ? existing.refreshToken == null
            ? null
            : encryptSecret(existing.refreshToken, key)
          : refreshToken,
        data.tokenType ?? existing.tokenType,
        data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt,
        data.scope !== undefined ? data.scope : existing.scope,
        data.status ?? existing.status,
        data.lastErrorMessage !== undefined ? data.lastErrorMessage : existing.lastErrorMessage,
        data.lastRefreshedAt !== undefined ? data.lastRefreshedAt : existing.lastRefreshedAt,
        data.connectedByUserId !== undefined ? data.connectedByUserId : existing.connectedByUserId,
        existing.id,
      );
    return getAuthorizationById(existing.id) as OAuthAuthorization;
  }

  const id = data.id ?? crypto.randomUUID();
  getDb()
    .query(
      `INSERT INTO oauth_authorizations (
         id, appId, label, userId, accountEmail, identityJson,
         accessToken, refreshToken, tokenType, expiresAt, scope,
         tokensEncrypted, tokenVersion, status, lastErrorMessage,
         lastRefreshedAt, connectedByUserId
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      data.appId,
      label,
      data.userId ?? null,
      data.accountEmail ?? null,
      data.identityJson ?? null,
      accessToken,
      refreshToken ?? null,
      data.tokenType ?? "Bearer",
      data.expiresAt ?? null,
      data.scope ?? null,
      data.status ?? "active",
      data.lastErrorMessage ?? null,
      data.lastRefreshedAt ?? null,
      data.connectedByUserId ?? null,
    );
  return getAuthorizationById(id) as OAuthAuthorization;
}

export function updateAuthorizationTokens(
  id: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    scope?: string | null;
    expectedTokenVersion?: number;
  },
): OAuthAuthorization | null {
  const existing = getAuthorizationById(id);
  if (!existing) return null;
  const expectedVersion = data.expectedTokenVersion ?? existing.tokenVersion;
  const key = getEncryptionKey();
  const encryptedRefresh =
    data.refreshToken === undefined
      ? existing.refreshToken == null
        ? null
        : encryptSecret(existing.refreshToken, key)
      : data.refreshToken == null
        ? null
        : encryptSecret(data.refreshToken, key);
  const result = getDb()
    .query(
      `UPDATE oauth_authorizations SET
         accessToken = ?, refreshToken = ?, expiresAt = ?, scope = ?,
         tokensEncrypted = 1, tokenVersion = tokenVersion + 1,
         status = 'active', lastErrorMessage = NULL,
         lastRefreshedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND tokenVersion = ?`,
    )
    .run(
      encryptSecret(data.accessToken, key),
      encryptedRefresh,
      data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt,
      data.scope !== undefined ? data.scope : existing.scope,
      id,
      expectedVersion,
    );
  return result.changes === 1 ? getAuthorizationById(id) : null;
}

/**
 * Persist best-effort account identity (email + raw identity claims) captured
 * after a successful token exchange. Never touches token material or
 * tokenVersion — display-only metadata.
 */
export function updateAuthorizationIdentity(
  id: string,
  data: { accountEmail?: string | null; identityJson?: string | null },
): void {
  getDb()
    .query(
      `UPDATE oauth_authorizations SET
         accountEmail = ?, identityJson = ?,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(data.accountEmail ?? null, data.identityJson ?? null, id);
}

/**
 * Hard-delete a single authorization row (used by the multi-authorization
 * DELETE endpoint after best-effort remote revocation). Bindings referencing
 * it are detached via `ON DELETE SET NULL`.
 */
export function deleteAuthorizationById(id: string): boolean {
  const result = getDb().query("DELETE FROM oauth_authorizations WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── OAuth pending (DB-backed PKCE state for generic/tracker flows) ──

export type OAuthPendingFlow = "generic" | "tracker";

export interface OAuthPendingRecord {
  state: string;
  appId: string;
  label: string;
  flow: OAuthPendingFlow;
  /** Decrypted PKCE code verifier. */
  codeVerifier: string;
  nonce: string | null;
  redirectUri: string;
  finalRedirect: string | null;
  userId: string | null;
  contextJson: string;
  createdAt: string;
}

type OAuthPendingRow = {
  state: string;
  appId: string;
  label: string;
  flow: OAuthPendingFlow;
  codeVerifier: string;
  nonce: string | null;
  redirectUri: string;
  finalRedirect: string | null;
  userId: string | null;
  contextJson: string;
  createdAt: string;
};

/** Persist a pending PKCE session for a generic/tracker OAuth flow. */
export function createOAuthPending(input: {
  state: string;
  appId: string;
  label?: string;
  flow?: OAuthPendingFlow;
  /** Plaintext PKCE code verifier — encrypted at rest. */
  codeVerifier: string;
  nonce?: string | null;
  redirectUri: string;
  finalRedirect?: string | null;
  userId?: string | null;
  contextJson?: string;
}): void {
  getDb()
    .query(
      `INSERT INTO oauth_pending (
         state, appId, label, flow, codeVerifier, nonce,
         redirectUri, finalRedirect, userId, contextJson
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.state,
      input.appId,
      input.label ?? "default",
      input.flow ?? "generic",
      encryptSecret(input.codeVerifier, getEncryptionKey()),
      input.nonce ?? null,
      input.redirectUri,
      input.finalRedirect ?? null,
      input.userId ?? null,
      input.contextJson ?? "{}",
    );
}

/**
 * Single-use consume of a generic/tracker pending row by `state`. Returns null
 * for unknown states and for `mcp`-flow rows (those are owned by the MCP
 * adapter), leaving the row untouched so the caller can fall through.
 */
export function consumeOAuthPending(state: string): OAuthPendingRecord | null {
  return getDb().transaction(() => {
    const row = getDb()
      .query(
        `SELECT state, appId, label, flow, codeVerifier, nonce, redirectUri,
                finalRedirect, userId, contextJson, createdAt
         FROM oauth_pending
         WHERE state = ? AND flow IN ('generic', 'tracker')`,
      )
      .get(state) as OAuthPendingRow | null;
    if (!row) return null;
    getDb().query("DELETE FROM oauth_pending WHERE state = ?").run(state);
    return {
      ...row,
      codeVerifier: decryptSecret(row.codeVerifier, getEncryptionKey()),
      createdAt: normalizeDateRequired(row.createdAt),
    };
  })();
}

/** GC expired generic/tracker pending rows. MCP rows are GC'd separately. */
export function gcOAuthPending(olderThanMs = 10 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return getDb()
    .query("DELETE FROM oauth_pending WHERE flow IN ('generic', 'tracker') AND createdAt < ?")
    .run(cutoff).changes;
}

// ── Provider-string compatibility adapters ──

export function getOAuthTokens(provider: string): OAuthTokens | null {
  const row = rawDefaultAuthorizationForProvider(provider);
  if (!row) return null;
  const authorization = normalizeAuthorization(row);
  // A revoked authorization is a disconnected connection: the row is kept for
  // referential continuity (script_credential_bindings.oauth_authorization_id,
  // ON DELETE SET NULL) but must read as "no tokens" to provider-string callers.
  if (authorization.status === "revoked") return null;
  return {
    id: authorization.id,
    provider,
    accessToken: authorization.accessToken,
    refreshToken: authorization.refreshToken,
    expiresAt: authorization.expiresAt ?? "",
    scope: authorization.scope,
    tokenVersion: authorization.tokenVersion,
    createdAt: authorization.createdAt,
    updatedAt: authorization.updatedAt,
  };
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
  const app = rawOAuthAppByProvider(provider);
  if (!app) throw new Error(`OAuth app ${provider} is not configured`);
  const existing = rawDefaultAuthorizationForApp(app.id);
  upsertAuthorization({
    ...(existing ? { id: existing.id } : {}),
    appId: app.id,
    label: "default",
    accessToken: data.accessToken,
    ...(data.refreshToken != null && data.refreshToken !== ""
      ? { refreshToken: data.refreshToken }
      : {}),
    expiresAt: data.expiresAt,
    ...(data.scope != null ? { scope: data.scope } : {}),
    status: "active",
  });
}

export function updateOAuthTokensAfterRefresh(
  provider: string,
  expectedRefreshToken: string,
  data: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scope?: string | null;
    expectedTokenVersion?: number;
  },
): void {
  const current = rawDefaultAuthorizationForProvider(provider);
  if (!current) {
    throw new Error(`OAuth token refresh persistence failed for ${provider}: token row missing`);
  }
  const normalized = normalizeAuthorization(current);
  if (normalized.refreshToken !== expectedRefreshToken) {
    throw new Error(
      `OAuth token refresh persistence failed for ${provider}: stored refresh token changed during refresh`,
    );
  }
  const updated = updateAuthorizationTokens(current.id, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    ...(data.scope != null ? { scope: data.scope } : {}),
    expectedTokenVersion: data.expectedTokenVersion ?? current.tokenVersion,
  });
  if (updated) return;

  const latest = getAuthorizationById(current.id);
  if (!latest) {
    throw new Error(`OAuth token refresh persistence failed for ${provider}: token row missing`);
  }
  if (latest.refreshToken === expectedRefreshToken) {
    throw new Error(`OAuth token refresh persistence failed for ${provider}: no rows updated`);
  }
  throw new Error(
    `OAuth token refresh persistence failed for ${provider}: stored refresh token changed during refresh`,
  );
}

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
      `SELECT a.provider,
              1 AS hasApp,
              CASE WHEN z.refreshToken IS NOT NULL AND z.refreshToken != '' THEN 1 ELSE 0 END AS hasRefreshToken,
              COALESCE(z.expiresAt, '') AS expiresAt,
              z.updatedAt
       FROM oauth_authorizations z
       JOIN oauth_apps a ON a.id = z.appId
       WHERE a.mcpServerId IS NULL AND z.label = 'default'
       ORDER BY a.provider ASC`,
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
  const app = rawOAuthAppByProvider(provider);
  if (!app) return;
  const existing = rawDefaultAuthorizationForApp(app.id);
  if (!existing) return;
  // Disconnect revokes in place — clear token fields and mark revoked but KEEP
  // the row so script_credential_bindings.oauth_authorization_id survives and a
  // later reconnect (upsert by appId+label='default') reuses the same id. Real
  // deletion of an authorization only happens via oauth_apps CASCADE.
  getDb()
    .query(
      `UPDATE oauth_authorizations SET
         accessToken = ?, refreshToken = NULL, expiresAt = NULL, scope = NULL,
         tokensEncrypted = 1, tokenVersion = tokenVersion + 1,
         status = 'revoked', lastErrorMessage = NULL, lastRefreshedAt = NULL,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(encryptSecret("", getEncryptionKey()), existing.id);
}

export function isTokenExpiringSoon(provider: string, bufferMs = 5 * 60 * 1000): boolean {
  const tokens = getOAuthTokens(provider);
  if (!tokens) return true;
  const expiresAt = new Date(tokens.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < bufferMs;
}

// ── OAuth Refresh Locks ──

export function acquireOAuthRefreshLock(lockKey: string, ttlMs: number): string | null {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const nowIso = new Date(now).toISOString();

  getDb()
    .query(
      `INSERT INTO oauth_refresh_locks (lockKey, owner, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lockKey) DO UPDATE SET
         owner = excluded.owner,
         expiresAt = excluded.expiresAt,
         updatedAt = excluded.updatedAt
       WHERE oauth_refresh_locks.expiresAt <= ?`,
    )
    .run(lockKey, owner, expiresAt, nowIso, nowIso, nowIso);

  const row = getDb()
    .query("SELECT owner FROM oauth_refresh_locks WHERE lockKey = ?")
    .get(lockKey) as { owner: string } | null;

  return row?.owner === owner ? owner : null;
}

export function releaseOAuthRefreshLock(lockKey: string, owner: string): void {
  getDb()
    .query("DELETE FROM oauth_refresh_locks WHERE lockKey = ? AND owner = ?")
    .run(lockKey, owner);
}
