import type { OAuthApp, OAuthTokens } from "../../tracker/types";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { normalizeDateRequired } from "../date-utils";
import { oauthSecretName, registerStoredSecret } from "../secret-registry";
import { getStorage } from "../storage";

function oauthRepo() {
  return getStorage().repos.oauth;
}

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
  return (await oauthRepo().findAppByProvider(provider)) as OAuthAppRow | null;
}

/** Exact (non-MCP) app lookup by id — used to target a specific row when the
 * provider is ambiguous (N apps per provider are allowed). */
async function rawOAuthAppById(id: string): Promise<OAuthAppRow | null> {
  return (await oauthRepo().findProviderAppById(id)) as OAuthAppRow | null;
}

async function rawDefaultAuthorizationForApp(appId: string): Promise<OAuthAuthorizationRow | null> {
  return (await oauthRepo().findDefaultAuthorizationForApp(appId)) as OAuthAuthorizationRow | null;
}

async function rawDefaultAuthorizationForProvider(
  provider: string,
): Promise<OAuthAuthorizationRow | null> {
  return (await oauthRepo().findDefaultAuthorizationForProvider(
    provider,
  )) as OAuthAuthorizationRow | null;
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
  const row = (await oauthRepo().findAppById(id)) as OAuthAppRow | null;
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
  registerStoredSecret(data.clientSecret, oauthSecretName(provider, "client_secret"));
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
    await oauthRepo().updateApp(existing.id, {
      displayName: data.displayName !== undefined ? data.displayName : existing.displayName,
      clientId: data.clientId,
      clientSecretCiphertext: encryptedSecret,
      authorizeUrl: data.authorizeUrl,
      tokenUrl: data.tokenUrl,
      revocationUrl,
      userinfoUrl: data.userinfoUrl !== undefined ? data.userinfoUrl : existing.userinfoUrl,
      redirectUri: data.redirectUri,
      scopes: storeScopeList(data.scopes),
      scopeSeparator,
      tokenAuthStyle,
      tokenBodyFormat,
      requiresRefreshTokenRotation: rotation,
      extraParamsJson,
      source: data.source ?? existing.source,
      metadata: lifted?.metadata ?? existing.metadata,
    });
    return existing.id;
  }

  return await oauthRepo().insertApp(provider, {
    displayName: data.displayName ?? null,
    clientId: data.clientId,
    clientSecretCiphertext: encryptedSecret,
    authorizeUrl: data.authorizeUrl,
    tokenUrl: data.tokenUrl,
    revocationUrl,
    userinfoUrl: data.userinfoUrl ?? null,
    redirectUri: data.redirectUri,
    scopes: storeScopeList(data.scopes),
    scopeSeparator,
    tokenAuthStyle,
    tokenBodyFormat,
    requiresRefreshTokenRotation: rotation,
    extraParamsJson,
    source: data.source ?? "manual",
    metadata: lifted?.metadata ?? "{}",
  });
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
  const rows = (await oauthRepo().listAuthorizationsForApp(appId)) as OAuthAuthorizationRow[];
  return rows.map(normalizeAuthorization);
}

export async function getAuthorizationById(id: string): Promise<OAuthAuthorization | null> {
  const row = (await oauthRepo().findAuthorization(id)) as OAuthAuthorizationRow | null;
  return row ? normalizeAuthorization(row) : null;
}

/** Register an authorization's new plaintext tokens with the secret registry,
 * named by the owning app's provider (`mcp-<serverId>` for MCP apps). */
async function registerAuthorizationSecrets(
  appId: string,
  accessToken: string,
  refreshToken: string | null | undefined,
): Promise<void> {
  const app = await oauthRepo().findAppById(appId);
  const provider = app?.provider ?? appId;
  registerStoredSecret(accessToken, oauthSecretName(provider, "access_token"));
  registerStoredSecret(refreshToken, oauthSecretName(provider, "refresh_token"));
}

export type StoredOAuthSecretKind = "client_secret" | "access_token" | "refresh_token";

/**
 * Every stored OAuth credential, decrypted, for the secret registry
 * (src/be/secret-registry.ts): client secrets of all apps (provider and
 * MCP-managed) and the tokens of all authorizations, whatever their status.
 * A row that fails to decrypt is counted, not thrown.
 */
export async function listStoredOAuthSecrets(): Promise<{
  secrets: { provider: string; kind: StoredOAuthSecretKind; value: string }[];
  failed: number;
}> {
  const secrets: { provider: string; kind: StoredOAuthSecretKind; value: string }[] = [];
  let failed = 0;

  const apps = (await oauthRepo().listApps()) as OAuthAppRow[];
  for (const row of apps) {
    try {
      const app = normalizeOAuthApp(row);
      if (app.clientSecret) {
        secrets.push({ provider: app.provider, kind: "client_secret", value: app.clientSecret });
      }
    } catch {
      failed++;
    }
  }

  const authorizations =
    (await oauthRepo().listAuthorizationsWithProvider()) as (OAuthAuthorizationRow & {
      provider: string;
    })[];
  for (const row of authorizations) {
    try {
      const authorization = normalizeAuthorization(row);
      if (authorization.accessToken) {
        secrets.push({
          provider: row.provider,
          kind: "access_token",
          value: authorization.accessToken,
        });
      }
      if (authorization.refreshToken) {
        secrets.push({
          provider: row.provider,
          kind: "refresh_token",
          value: authorization.refreshToken,
        });
      }
    } catch {
      failed++;
    }
  }

  return { secrets, failed };
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
  await registerAuthorizationSecrets(data.appId, data.accessToken, data.refreshToken);

  if (existing) {
    await oauthRepo().rewriteAuthorization(existing.id, {
      userId: data.userId !== undefined ? data.userId : existing.userId,
      accountEmail: data.accountEmail !== undefined ? data.accountEmail : existing.accountEmail,
      identityJson: data.identityJson !== undefined ? data.identityJson : existing.identityJson,
      accessToken,
      refreshToken:
        refreshToken === undefined
          ? existing.refreshToken == null
            ? null
            : encryptSecret(existing.refreshToken, key)
          : refreshToken,
      tokenType: data.tokenType ?? existing.tokenType,
      expiresAt: data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt,
      scope: data.scope !== undefined ? data.scope : existing.scope,
      status: data.status ?? existing.status,
      lastErrorMessage:
        data.lastErrorMessage !== undefined ? data.lastErrorMessage : existing.lastErrorMessage,
      lastRefreshedAt:
        data.lastRefreshedAt !== undefined ? data.lastRefreshedAt : existing.lastRefreshedAt,
      connectedByUserId:
        data.connectedByUserId !== undefined ? data.connectedByUserId : existing.connectedByUserId,
    });
    return (await getAuthorizationById(existing.id)) as OAuthAuthorization;
  }

  const id = data.id ?? crypto.randomUUID();
  await oauthRepo().insertAuthorization({
    id,
    appId: data.appId,
    label,
    userId: data.userId ?? null,
    accountEmail: data.accountEmail ?? null,
    identityJson: data.identityJson ?? null,
    accessToken,
    refreshToken: refreshToken ?? null,
    tokenType: data.tokenType ?? "Bearer",
    expiresAt: data.expiresAt ?? null,
    scope: data.scope ?? null,
    status: data.status ?? "active",
    lastErrorMessage: data.lastErrorMessage ?? null,
    lastRefreshedAt: data.lastRefreshedAt ?? null,
    connectedByUserId: data.connectedByUserId ?? null,
  });
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
  await registerAuthorizationSecrets(existing.appId, data.accessToken, data.refreshToken);
  const updated = await oauthRepo().storeRefreshedTokens(id, expectedVersion, {
    accessToken: encryptSecret(data.accessToken, key),
    refreshToken: encryptedRefresh,
    expiresAt: data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt,
    scope: data.scope !== undefined ? data.scope : existing.scope,
  });
  return updated ? await getAuthorizationById(id) : null;
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
  await oauthRepo().setAuthorizationIdentity(id, {
    accountEmail: data.accountEmail ?? null,
    identityJson: data.identityJson ?? null,
  });
}

/**
 * Hard-delete a single authorization row (used by the multi-authorization
 * DELETE endpoint after best-effort remote revocation). Bindings referencing
 * it are detached via `ON DELETE SET NULL`.
 */
export async function deleteAuthorizationById(id: string): Promise<boolean> {
  return oauthRepo().deleteAuthorization(id);
}

/**
 * Delete every authorization owned by a SPECIFIC app id. Scoped by app id (not
 * provider) so deleting one of several same-provider apps never touches a
 * sibling app's authorizations. Bindings referencing the rows detach via
 * `ON DELETE SET NULL`.
 */
export async function deleteAuthorizationsForApp(appId: string): Promise<number> {
  return oauthRepo().deleteAuthorizationsForApp(appId);
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
  await oauthRepo().insertPending({
    state: input.state,
    appId: input.appId,
    label: input.label ?? "default",
    flow: input.flow ?? "generic",
    codeVerifier: encryptSecret(input.codeVerifier, getEncryptionKey()),
    nonce: input.nonce ?? null,
    redirectUri: input.redirectUri,
    finalRedirect: input.finalRedirect ?? null,
    userId: input.userId ?? null,
    contextJson: input.contextJson ?? "{}",
  });
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
  const repo = oauthRepo();
  return await getStorage().transaction(async () => {
    const row = (await repo.findPending(state, ["generic", "tracker"])) as OAuthPendingRow | null;
    if (!row) return null;
    // Single-use: always delete, whether valid or expired.
    await repo.deletePending(state);
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
  return oauthRepo().deletePendingBefore(["generic", "tracker"], cutoff);
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
  const updated = await oauthRepo().markRefreshFailed(id, message);
  return updated ? await getAuthorizationById(id) : null;
}

// ── Provider-string compatibility adapters ──

/** Same answer as `getOAuthTokens(provider) !== null`, without decrypting the tokens. */
export async function hasOAuthTokens(provider: string): Promise<boolean> {
  const row = await rawDefaultAuthorizationForProvider(provider);
  return row !== null && row.status !== "revoked";
}

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
  const rows = await oauthRepo().listSweepRows();
  return rows.map((row) => ({
    authorizationId: row.authorizationId,
    appId: row.appId,
    provider: row.provider,
    label: row.label,
    status: row.status as OAuthAuthorizationStatus,
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
  const rows = await oauthRepo().listKeepAliveRows();
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
  await oauthRepo().revokeAuthorization(existing.id, encryptSecret("", getEncryptionKey()));
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

  const current = await oauthRepo().acquireRefreshLock(lockKey, owner, expiresAt, nowIso);
  return current === owner ? owner : null;
}

export async function releaseOAuthRefreshLock(lockKey: string, owner: string): Promise<void> {
  await oauthRepo().releaseRefreshLock(lockKey, owner);
}

/** True while `owner` still holds an unexpired refresh lock on `lockKey`. */
export async function isOAuthRefreshLockHeld(lockKey: string, owner: string): Promise<boolean> {
  return oauthRepo().isRefreshLockHeld(lockKey, owner, new Date().toISOString());
}
