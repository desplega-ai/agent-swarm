import type { OAuthApp, OAuthTokens } from "../../tracker/types";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { normalizeDateRequired } from "../date-utils";
import { getDbClient } from "../db";

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

async function rawOAuthAppByProvider(provider: string): Promise<OAuthAppRow | null> {
  return await getDbClient().get<OAuthAppRow>(
    `SELECT * FROM oauth_apps
       WHERE provider = ? AND mcpServerId IS NULL
       ORDER BY createdAt ASC, id ASC
       LIMIT 1`,
    [provider],
  );
}

/** Exact (non-MCP) app lookup by id — used to target a specific row when the
 * provider is ambiguous (N apps per provider are allowed). */
async function rawOAuthAppById(id: string): Promise<OAuthAppRow | null> {
  return await getDbClient().get<OAuthAppRow>(
    "SELECT * FROM oauth_apps WHERE id = ? AND mcpServerId IS NULL",
    [id],
  );
}

async function rawDefaultAuthorizationForApp(appId: string): Promise<OAuthAuthorizationRow | null> {
  return await getDbClient().get<OAuthAuthorizationRow>(
    "SELECT * FROM oauth_authorizations WHERE appId = ? AND label = 'default'",
    [appId],
  );
}

async function rawDefaultAuthorizationForProvider(
  provider: string,
): Promise<OAuthAuthorizationRow | null> {
  return await getDbClient().get<OAuthAuthorizationRow>(
    `SELECT z.*
       FROM oauth_authorizations z
       JOIN oauth_apps a ON a.id = z.appId
       WHERE a.provider = ? AND a.mcpServerId IS NULL AND z.label = 'default'
       ORDER BY a.createdAt ASC, a.id ASC
       LIMIT 1`,
    [provider],
  );
}

export async function getDefaultAuthorizationIdForProvider(
  provider: string,
): Promise<string | null> {
  return (await rawDefaultAuthorizationForProvider(provider))?.id ?? null;
}

// ── OAuth Apps ──

export async function getOAuthApp(provider: string): Promise<OAuthApp | null> {
  const row = await rawOAuthAppByProvider(provider);
  return row ? normalizeOAuthApp(row) : null;
}

export async function getOAuthAppById(id: string): Promise<OAuthApp | null> {
  const row = await getDbClient().get<OAuthAppRow>("SELECT * FROM oauth_apps WHERE id = ?", [id]);
  return row ? normalizeOAuthApp(row) : null;
}

/** Resolve the (non-MCP) app id for a provider slug, or null if none. */
export async function getOAuthAppIdByProvider(provider: string): Promise<string | null> {
  return (await rawOAuthAppByProvider(provider))?.id ?? null;
}

/** Shared write payload for the OAuth-app create / update / provider-upsert
 * paths. The row-resolution strategy is chosen by the calling function — never
 * by this payload — so `id` is intentionally absent here. */
type OAuthAppWriteData = {
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
};

/** Insert a new row (when `existing` is null) or update the given row in place.
 * Returns the row id either way. Callers pick the row-resolution strategy up
 * front — this helper never resolves by provider on its own. */
async function writeOAuthApp(
  existing: OAuthAppRow | null,
  provider: string,
  data: OAuthAppWriteData,
): Promise<string> {
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
    await getDbClient().run(
      `UPDATE oauth_apps SET
           displayName = ?, clientId = ?, clientSecret = ?, clientSecretEncrypted = 1,
           authorizeUrl = ?, tokenUrl = ?, revocationUrl = ?, userinfoUrl = ?,
           redirectUri = ?, scopes = ?, scopeSeparator = ?, tokenAuthStyle = ?,
           tokenBodyFormat = ?, requiresRefreshTokenRotation = ?, extraParamsJson = ?,
           source = ?, metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      [
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
      ],
    );
    return existing.id;
  }

  const inserted = await getDbClient().get<{ id: string }>(
    `INSERT INTO oauth_apps (
         provider, displayName, clientId, clientSecret, clientSecretEncrypted,
         authorizeUrl, tokenUrl, revocationUrl, userinfoUrl, redirectUri, scopes,
         scopeSeparator, tokenAuthStyle, tokenBodyFormat,
         requiresRefreshTokenRotation, extraParamsJson, source, metadata
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    [
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
    ],
  );
  return inserted!.id;
}

/** Create a brand-new OAuth app row and return its id. ALWAYS inserts — it never
 * resolves by provider, so a second app for the same provider can never clobber
 * the first. User-facing create paths (HTTP `POST /api/oauth-apps` without an
 * id, the MCP `oauth-app-upsert` action) MUST use this. */
export async function createOAuthApp(provider: string, data: OAuthAppWriteData): Promise<string> {
  return await writeOAuthApp(null, provider, data);
}

/** Update exactly one existing (non-MCP) app by id. Throws when the id is
 * unknown or refers to an MCP-managed app. Provider is immutable on edit. */
export async function updateOAuthAppById(id: string, data: OAuthAppWriteData): Promise<void> {
  const existing = await rawOAuthAppById(id);
  if (!existing) {
    throw new Error(`OAuth app ${id} not found.`);
  }
  await writeOAuthApp(existing, existing.provider, data);
}

/** Provider-keyed upsert — reserved for BOOT reconciliation (initLinear /
 * initJira) and test seeding. Updates the oldest row for the provider, or
 * inserts when none exists. Do NOT use for user-facing create/edit: with N apps
 * per provider this silently clobbers a sibling row — the create path must use
 * createOAuthApp and the edit path updateOAuthAppById. */
export async function upsertOAuthApp(provider: string, data: OAuthAppWriteData): Promise<void> {
  await writeOAuthApp(await rawOAuthAppByProvider(provider), provider, data);
}

// ── OAuth Authorizations ──

export async function listAuthorizationsForApp(appId: string): Promise<OAuthAuthorization[]> {
  const rows = await getDbClient().query<OAuthAuthorizationRow>(
    "SELECT * FROM oauth_authorizations WHERE appId = ? ORDER BY createdAt ASC, id ASC",
    [appId],
  );
  return rows.map(normalizeAuthorization);
}

export async function getAuthorizationById(id: string): Promise<OAuthAuthorization | null> {
  const row = await getDbClient().get<OAuthAuthorizationRow>(
    "SELECT * FROM oauth_authorizations WHERE id = ?",
    [id],
  );
  return row ? normalizeAuthorization(row) : null;
}

export async function upsertAuthorization(data: {
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
}): Promise<OAuthAuthorization> {
  const label = data.label ?? "default";
  const existing = data.id
    ? await getAuthorizationById(data.id)
    : (await listAuthorizationsForApp(data.appId)).find((row) => row.label === label);
  const key = getEncryptionKey();
  const accessToken = encryptSecret(data.accessToken, key);
  const refreshToken =
    data.refreshToken === undefined
      ? undefined
      : data.refreshToken == null
        ? null
        : encryptSecret(data.refreshToken, key);

  if (existing) {
    await getDbClient().run(
      `UPDATE oauth_authorizations SET
           userId = ?, accountEmail = ?, identityJson = ?, accessToken = ?,
           refreshToken = ?, tokenType = ?, expiresAt = ?, scope = ?,
           tokensEncrypted = 1, tokenVersion = tokenVersion + 1, status = ?,
           lastErrorMessage = ?, lastRefreshedAt = ?, connectedByUserId = ?,
           updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      [
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
      ],
    );
    return (await getAuthorizationById(existing.id)) as OAuthAuthorization;
  }

  const id = data.id ?? crypto.randomUUID();
  await getDbClient().run(
    `INSERT INTO oauth_authorizations (
         id, appId, label, userId, accountEmail, identityJson,
         accessToken, refreshToken, tokenType, expiresAt, scope,
         tokensEncrypted, tokenVersion, status, lastErrorMessage,
         lastRefreshedAt, connectedByUserId
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    [
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
    ],
  );
  return (await getAuthorizationById(id)) as OAuthAuthorization;
}

export async function updateAuthorizationTokens(
  id: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    scope?: string | null;
    expectedTokenVersion?: number;
  },
): Promise<OAuthAuthorization | null> {
  const existing = await getAuthorizationById(id);
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
  const result = await getDbClient().run(
    `UPDATE oauth_authorizations SET
         accessToken = ?, refreshToken = ?, expiresAt = ?, scope = ?,
         tokensEncrypted = 1, tokenVersion = tokenVersion + 1,
         status = 'active', lastErrorMessage = NULL,
         lastRefreshedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND tokenVersion = ?`,
    [
      encryptSecret(data.accessToken, key),
      encryptedRefresh,
      data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt,
      data.scope !== undefined ? data.scope : existing.scope,
      id,
      expectedVersion,
    ],
  );
  return result.changes === 1 ? await getAuthorizationById(id) : null;
}

/**
 * Persist best-effort account identity (email + raw identity claims) captured
 * after a successful token exchange. Never touches token material or
 * tokenVersion — display-only metadata.
 */
export async function updateAuthorizationIdentity(
  id: string,
  data: { accountEmail?: string | null; identityJson?: string | null },
): Promise<void> {
  await getDbClient().run(
    `UPDATE oauth_authorizations SET
         accountEmail = ?, identityJson = ?,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    [data.accountEmail ?? null, data.identityJson ?? null, id],
  );
}

/**
 * Hard-delete a single authorization row (used by the multi-authorization
 * DELETE endpoint after best-effort remote revocation). Bindings referencing
 * it are detached via `ON DELETE SET NULL`.
 */
export async function deleteAuthorizationById(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM oauth_authorizations WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Delete every authorization owned by a SPECIFIC app id. Scoped by app id (not
 * provider) so deleting one of several same-provider apps never touches a
 * sibling app's authorizations. Bindings referencing the rows detach via
 * `ON DELETE SET NULL`.
 */
export async function deleteAuthorizationsForApp(appId: string): Promise<number> {
  return (await getDbClient().run("DELETE FROM oauth_authorizations WHERE appId = ?", [appId]))
    .changes;
}

// ── OAuth pending (DB-backed PKCE state for generic/tracker flows) ──

/** Pending PKCE sessions are valid for 10 minutes (matches the GC window). */
export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

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
export async function createOAuthPending(input: {
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
}): Promise<void> {
  await getDbClient().run(
    `INSERT INTO oauth_pending (
         state, appId, label, flow, codeVerifier, nonce,
         redirectUri, finalRedirect, userId, contextJson
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
  );
}

/**
 * Single-use consume of a generic/tracker pending row by `state`. Returns null
 * for unknown states and for `mcp`-flow rows (those are owned by the MCP
 * adapter), leaving the row untouched so the caller can fall through.
 *
 * Enforces the 10-minute TTL at consume time: an expired row is deleted and
 * treated as invalid, so a stalled/failed GC timer cannot widen the validity
 * window.
 */
export async function consumeOAuthPending(state: string): Promise<OAuthPendingRecord | null> {
  return await getDbClient().transaction(async (tx) => {
    const row = await tx.get<OAuthPendingRow>(
      `SELECT state, appId, label, flow, codeVerifier, nonce, redirectUri,
              finalRedirect, userId, contextJson, createdAt
       FROM oauth_pending
       WHERE state = ? AND flow IN ('generic', 'tracker')`,
      [state],
    );
    if (!row) return null;
    // Single-use: always delete, whether valid or expired.
    await tx.run("DELETE FROM oauth_pending WHERE state = ?", [state]);
    const createdAt = normalizeDateRequired(row.createdAt);
    const createdMs = new Date(createdAt).getTime();
    if (Number.isNaN(createdMs) || Date.now() - createdMs > OAUTH_PENDING_TTL_MS) {
      return null;
    }
    return {
      ...row,
      codeVerifier: decryptSecret(row.codeVerifier, getEncryptionKey()),
      createdAt,
    };
  });
}

/** GC expired generic/tracker pending rows. MCP rows are GC'd separately. */
export async function gcOAuthPending(olderThanMs = 10 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = await getDbClient().run(
    "DELETE FROM oauth_pending WHERE flow IN ('generic', 'tracker') AND createdAt < ?",
    [cutoff],
  );
  return result.changes;
}

/**
 * Persist a `refresh-failed` status + scrubbed error message on an
 * authorization whose refresh just failed. Never clobbers a `revoked` row (a
 * disconnected authorization is terminal, not "failing"). Best-effort by id —
 * no optimistic-concurrency guard, since a successful refresh always bumps
 * status back to `active` and clears the message anyway.
 */
export async function markAuthorizationRefreshFailed(
  id: string,
  message: string | null,
): Promise<OAuthAuthorization | null> {
  const result = await getDbClient().run(
    `UPDATE oauth_authorizations SET
         status = 'refresh-failed', lastErrorMessage = ?,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status != 'revoked'`,
    [message, id],
  );
  return result.changes === 1 ? await getAuthorizationById(id) : null;
}

// ── Provider-string compatibility adapters ──

export async function getOAuthTokens(provider: string): Promise<OAuthTokens | null> {
  const row = await rawDefaultAuthorizationForProvider(provider);
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

export async function storeOAuthTokens(
  provider: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt: string | null;
    scope?: string | null;
  },
): Promise<void> {
  const app = await rawOAuthAppByProvider(provider);
  if (!app) throw new Error(`OAuth app ${provider} is not configured`);
  const existing = await rawDefaultAuthorizationForApp(app.id);
  await upsertAuthorization({
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

export async function updateOAuthTokensAfterRefresh(
  provider: string,
  expectedRefreshToken: string,
  data: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
    scope?: string | null;
    expectedTokenVersion?: number;
  },
): Promise<void> {
  const current = await rawDefaultAuthorizationForProvider(provider);
  if (!current) {
    throw new Error(`OAuth token refresh persistence failed for ${provider}: token row missing`);
  }
  const normalized = normalizeAuthorization(current);
  if (normalized.refreshToken !== expectedRefreshToken) {
    throw new Error(
      `OAuth token refresh persistence failed for ${provider}: stored refresh token changed during refresh`,
    );
  }
  const updated = await updateAuthorizationTokens(current.id, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    ...(data.scope != null ? { scope: data.scope } : {}),
    expectedTokenVersion: data.expectedTokenVersion ?? current.tokenVersion,
  });
  if (updated) return;

  const latest = await getAuthorizationById(current.id);
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

export type AuthorizationSweepRow = {
  authorizationId: string;
  appId: string;
  provider: string;
  label: string;
  status: OAuthAuthorizationStatus;
  hasRefreshToken: boolean;
  expiresAt: string;
  updatedAt: string;
};

/**
 * Every provider-facing authorization (any label; DCR/MCP apps excluded) the
 * background sweep should consider. Keyed by authorization id — the sweep skips
 * `revoked` rows and refreshes `refresh-failed` ones each pass so transient
 * provider outages self-heal.
 */
export async function listAuthorizationSweepRows(): Promise<AuthorizationSweepRow[]> {
  const rows = await getDbClient().query<{
    authorizationId: string;
    appId: string;
    provider: string;
    label: string;
    status: OAuthAuthorizationStatus;
    hasRefreshToken: number;
    expiresAt: string;
    updatedAt: string;
  }>(
    `SELECT z.id AS authorizationId,
              z.appId AS appId,
              a.provider AS provider,
              z.label AS label,
              z.status AS status,
              CASE WHEN z.refreshToken IS NOT NULL AND z.refreshToken != '' THEN 1 ELSE 0 END AS hasRefreshToken,
              COALESCE(z.expiresAt, '') AS expiresAt,
              z.updatedAt AS updatedAt
       FROM oauth_authorizations z
       JOIN oauth_apps a ON a.id = z.appId
       WHERE a.mcpServerId IS NULL
       ORDER BY a.provider ASC, z.label ASC`,
  );
  return rows.map((row) => ({
    authorizationId: row.authorizationId,
    appId: row.appId,
    provider: row.provider,
    label: row.label,
    status: row.status,
    hasRefreshToken: row.hasRefreshToken === 1,
    expiresAt: normalizeDateRequired(row.expiresAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  }));
}

export type KeepAliveAuthorization = {
  authorizationId: string;
  appId: string;
  provider: string;
  label: string;
  displayName: string | null;
};

/**
 * Active, refreshable authorizations whose app opts into keep-alive: either it
 * rotates refresh tokens (`requiresRefreshTokenRotation=1`) or sets the
 * `keepAlive` metadata flag. Replaces the hardcoded `["linear","jira"]` list;
 * migrated tracker rows qualify automatically (jira via rotation, linear via
 * the metadata backfill).
 */
export async function listKeepAliveAuthorizations(): Promise<KeepAliveAuthorization[]> {
  const rows = await getDbClient().query<{
    authorizationId: string;
    appId: string;
    provider: string;
    label: string;
    displayName: string | null;
  }>(
    `SELECT z.id AS authorizationId,
              z.appId AS appId,
              a.provider AS provider,
              z.label AS label,
              a.displayName AS displayName
       FROM oauth_authorizations z
       JOIN oauth_apps a ON a.id = z.appId
       WHERE a.mcpServerId IS NULL
         AND z.status = 'active'
         AND z.refreshToken IS NOT NULL AND z.refreshToken != ''
         AND (
           a.requiresRefreshTokenRotation = 1
           OR (json_valid(a.metadata) = 1 AND json_extract(a.metadata, '$.keepAlive') IN (1, 'true'))
         )
       ORDER BY a.provider ASC, z.label ASC`,
  );
  return rows.map((row) => ({
    authorizationId: row.authorizationId,
    appId: row.appId,
    provider: row.provider,
    label: row.label,
    displayName: row.displayName,
  }));
}

export async function deleteOAuthTokens(provider: string): Promise<void> {
  const app = await rawOAuthAppByProvider(provider);
  if (!app) return;
  const existing = await rawDefaultAuthorizationForApp(app.id);
  if (!existing) return;
  // Disconnect revokes in place — clear token fields and mark revoked but KEEP
  // the row so script_credential_bindings.oauth_authorization_id survives and a
  // later reconnect (upsert by appId+label='default') reuses the same id. Real
  // deletion of an authorization only happens via oauth_apps CASCADE.
  await getDbClient().run(
    `UPDATE oauth_authorizations SET
         accessToken = ?, refreshToken = NULL, expiresAt = NULL, scope = NULL,
         tokensEncrypted = 1, tokenVersion = tokenVersion + 1,
         status = 'revoked', lastErrorMessage = NULL, lastRefreshedAt = NULL,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    [encryptSecret("", getEncryptionKey()), existing.id],
  );
}

export async function isTokenExpiringSoon(
  provider: string,
  bufferMs = 5 * 60 * 1000,
): Promise<boolean> {
  const tokens = await getOAuthTokens(provider);
  if (!tokens) return true;
  const expiresAt = new Date(tokens.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < bufferMs;
}

// ── OAuth Refresh Locks ──

export async function acquireOAuthRefreshLock(
  lockKey: string,
  ttlMs: number,
): Promise<string | null> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const nowIso = new Date(now).toISOString();

  await getDbClient().run(
    `INSERT INTO oauth_refresh_locks (lockKey, owner, expiresAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lockKey) DO UPDATE SET
         owner = excluded.owner,
         expiresAt = excluded.expiresAt,
         updatedAt = excluded.updatedAt
       WHERE oauth_refresh_locks.expiresAt <= ?`,
    [lockKey, owner, expiresAt, nowIso, nowIso, nowIso],
  );

  const row = await getDbClient().get<{ owner: string }>(
    "SELECT owner FROM oauth_refresh_locks WHERE lockKey = ?",
    [lockKey],
  );

  return row?.owner === owner ? owner : null;
}

export async function releaseOAuthRefreshLock(lockKey: string, owner: string): Promise<void> {
  await getDbClient().run("DELETE FROM oauth_refresh_locks WHERE lockKey = ? AND owner = ?", [
    lockKey,
    owner,
  ]);
}
