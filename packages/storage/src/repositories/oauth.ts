import { jsonText, nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlList } from "../sql";

/**
 * Domain: OAuth (`oauth_apps`, `oauth_authorizations`, `oauth_pending`,
 * `oauth_refresh_locks`, `codex_oauth_device_flows`). Rows come back in the
 * SQLite value shape on every engine (flags 0/1, JSON as text, timestamps as
 * the text the column stores). Token and secret columns hold the ciphertext
 * the caller wrote: the repository never encrypts or decrypts.
 */

export type OAuthAppRow = {
  id: string;
  provider: string;
  displayName: string | null;
  clientId: string;
  clientSecret: string | null;
  clientSecretEncrypted: number;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  userinfoUrl: string | null;
  redirectUri: string;
  scopes: string;
  scopeSeparator: string;
  tokenAuthStyle: string;
  tokenBodyFormat: string;
  requiresRefreshTokenRotation: number;
  extraParamsJson: string | null;
  source: string;
  mcpServerId: string | null;
  metadata: string;
  createdAt: string;
  updatedAt: string;
};

/** The columns a provider app write sets. The secret is stored encrypted (flag 1). */
export type OAuthAppWrite = {
  displayName: string | null;
  clientId: string;
  clientSecretCiphertext: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  userinfoUrl: string | null;
  redirectUri: string;
  scopes: string;
  scopeSeparator: string;
  tokenAuthStyle: string;
  tokenBodyFormat: string;
  requiresRefreshTokenRotation: boolean;
  extraParamsJson: string | null;
  source: string;
  metadata: string;
};

export type OAuthAuthorizationRow = {
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
  status: string;
  lastErrorMessage: string | null;
  lastRefreshedAt: string | null;
  connectedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The columns an authorization rewrite sets; tokens are ciphertext (flag 1). */
export type OAuthAuthorizationWrite = {
  userId: string | null;
  accountEmail: string | null;
  identityJson: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  scope: string | null;
  status: string;
  lastErrorMessage: string | null;
  lastRefreshedAt: string | null;
  connectedByUserId: string | null;
};

export type OAuthAuthorizationSweepRow = {
  authorizationId: string;
  appId: string;
  provider: string;
  label: string;
  status: string;
  hasRefreshToken: number;
  expiresAt: string;
  updatedAt: string;
};

export type OAuthKeepAliveRow = {
  authorizationId: string;
  appId: string;
  provider: string;
  label: string;
  displayName: string | null;
};

export type OAuthPendingRow = {
  state: string;
  appId: string;
  label: string;
  flow: string;
  codeVerifier: string;
  nonce: string | null;
  redirectUri: string;
  finalRedirect: string | null;
  userId: string | null;
  contextJson: string;
  createdAt: string;
};

export type NewOAuthPending = Omit<OAuthPendingRow, "createdAt">;

/** An MCP authorization joined with its MCP-managed app. */
export type McpOAuthTokenRow = {
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
  status: string;
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
  source: string;
  metadata: string;
};

/** The columns an MCP app write sets. The secret is stored encrypted (flag 1). */
export type McpOAuthAppWrite = {
  provider: string;
  clientId: string;
  clientSecretCiphertext: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  redirectUri: string;
  scopes: string;
  source: string;
  metadata: string;
};

/** An MCP pending row joined with its app. */
export type McpOAuthPendingJoinRow = {
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

/** A non-MCP app row of the connections listing, with its `default` authorization. */
export type OAuthAppListingRow = {
  id: string;
  provider: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string;
  extraParamsJson: string | null;
  tokenAuthStyle: "body" | "basic";
  tokenBodyFormat: "form" | "json";
  source: string;
  authorizationId: string | null;
  tokenExpiresAt: string | null;
  tokenUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface OAuthRepository {
  /** The oldest non-MCP app of a provider (`createdAt`, then `id`). */
  findAppByProvider(provider: string): Promise<OAuthAppRow | null>;
  /** A non-MCP app by id. */
  findProviderAppById(id: string): Promise<OAuthAppRow | null>;
  /** Any app (MCP-managed too) by id. */
  findAppById(id: string): Promise<OAuthAppRow | null>;
  /** Every app. Order: insertion. */
  listApps(): Promise<OAuthAppRow[]>;
  insertApp(provider: string, app: OAuthAppWrite): Promise<string>;
  updateApp(id: string, app: OAuthAppWrite): Promise<void>;
  /** The metadata of the first-inserted app row of a provider, any kind. */
  getAppMetadata(provider: string): Promise<{ metadata: string | null } | null>;
  /** Writes `metadata` on every app row of a provider and stamps `updatedAt`. */
  setAppMetadata(provider: string, metadata: string): Promise<void>;

  /** Authorizations of an app. Order: `createdAt`, then `id`. */
  listAuthorizationsForApp(appId: string): Promise<OAuthAuthorizationRow[]>;
  findAuthorization(id: string): Promise<OAuthAuthorizationRow | null>;
  findDefaultAuthorizationForApp(appId: string): Promise<OAuthAuthorizationRow | null>;
  /** The `default` authorization of the provider's oldest non-MCP app. */
  findDefaultAuthorizationForProvider(provider: string): Promise<OAuthAuthorizationRow | null>;
  /** The id of the authorization of an app with `label`. */
  findAuthorizationIdByLabel(appId: string, label: string): Promise<string | null>;
  /** The app provider of every authorization. Order: provider, then authorization id. */
  listAuthorizationProviders(): Promise<string[]>;
  /** Every authorization with its app's provider. Order: insertion of the authorization. */
  listAuthorizationsWithProvider(): Promise<(OAuthAuthorizationRow & { provider: string })[]>;
  insertAuthorization(
    row: OAuthAuthorizationWrite & { id: string; appId: string; label: string },
  ): Promise<void>;
  /** Rewrites the row, bumps `tokenVersion` and stamps `updatedAt`. */
  rewriteAuthorization(id: string, row: OAuthAuthorizationWrite): Promise<void>;
  /**
   * Stores refreshed tokens when `tokenVersion` still equals `expectedVersion`:
   * status `active`, error cleared, `lastRefreshedAt` and `updatedAt` stamped.
   * True when the row was updated.
   */
  storeRefreshedTokens(
    id: string,
    expectedVersion: number,
    tokens: {
      accessToken: string;
      refreshToken: string | null;
      expiresAt: string | null;
      scope: string | null;
    },
  ): Promise<boolean>;
  setAuthorizationIdentity(
    id: string,
    identity: { accountEmail: string | null; identityJson: string | null },
  ): Promise<void>;
  deleteAuthorization(id: string): Promise<boolean>;
  deleteAuthorizationsForApp(appId: string): Promise<number>;
  /** Marks `refresh-failed` unless the row is `revoked`. True when updated. */
  markRefreshFailed(id: string, message: string | null): Promise<boolean>;
  /**
   * Clears the tokens (access token = `emptyCiphertext`) and marks the row
   * `revoked`. True when the row was updated.
   */
  revokeAuthorization(id: string, emptyCiphertext: string): Promise<boolean>;
  setAuthorizationStatus(id: string, status: string, message: string | null): Promise<void>;
  /** Non-MCP authorizations. Order: provider, label, then app insertion. */
  listSweepRows(): Promise<OAuthAuthorizationSweepRow[]>;
  /** Active refreshable authorizations of keep-alive apps. Order: provider, label, then app insertion. */
  listKeepAliveRows(): Promise<OAuthKeepAliveRow[]>;

  insertPending(row: NewOAuthPending): Promise<void>;
  /** The pending row of `state` when its flow is one of `flows`. */
  findPending(state: string, flows: readonly string[]): Promise<OAuthPendingRow | null>;
  /** Deletes the pending row of `state` (only when its flow is `flow`, when given). */
  deletePending(state: string, flow?: string): Promise<void>;
  /** Deletes the pending rows of `flows` created before `cutoff`; returns the count. */
  deletePendingBefore(flows: readonly string[], cutoff: string): Promise<number>;

  /** The appIds of the pending rows of `flow` created before `cutoff`. Order: appId. */
  listPendingAppIdsBefore(flow: string, cutoff: string): Promise<string[]>;

  /**
   * The MCP authorization of a server for `userId` (null: the shared one).
   * The oldest by `createdAt`, then `id`.
   */
  findMcpToken(mcpServerId: string, userId: string | null): Promise<McpOAuthTokenRow | null>;
  findMcpTokenById(id: string): Promise<McpOAuthTokenRow | null>;
  /** Order: `createdAt`, then `id`. */
  listMcpTokens(mcpServerId: string): Promise<McpOAuthTokenRow[]>;
  insertMcpApp(id: string, mcpServerId: string, app: McpOAuthAppWrite): Promise<void>;
  updateMcpApp(id: string, app: McpOAuthAppWrite): Promise<void>;
  /** Writes an app's metadata by id and stamps `updatedAt`. */
  setAppMetadataById(id: string, metadata: string): Promise<void>;
  /** The newest MCP pending attempt's appId for the server and user (ties: the first inserted). */
  findLatestMcpPendingAppId(mcpServerId: string, userId: string | null): Promise<string | null>;
  findMcpPending(state: string): Promise<McpOAuthPendingJoinRow | null>;
  /** Deletes an MCP app that no authorization and no pending row references. */
  deleteOrphanMcpApp(appId: string): Promise<void>;

  /** Takes or steals an expired refresh lock; returns the current owner. */
  acquireRefreshLock(
    lockKey: string,
    owner: string,
    expiresAt: string,
    now: string,
  ): Promise<string | null>;
  releaseRefreshLock(lockKey: string, owner: string): Promise<void>;
  /** True while `owner` holds the refresh lock on `lockKey` and it has not expired at `now`. */
  isRefreshLockHeld(lockKey: string, owner: string, now: string): Promise<boolean>;

  getCodexDeviceFlow(flowId: string): Promise<{ state: string; expires_at: number } | null>;
  deleteCodexDeviceFlow(flowId: string): Promise<void>;
  deleteExpiredCodexDeviceFlows(now: number): Promise<void>;
  upsertCodexDeviceFlow(
    flowId: string,
    state: string,
    expiresAt: number,
    now: number,
  ): Promise<void>;
  /**
   * Non-MCP apps with their `default` authorization's id and token times, for
   * the connections listing. Ordered by provider, ties in insertion order.
   */
  listProviderAppsWithDefaultToken(): Promise<OAuthAppListingRow[]>;
  /** Deletes the app row by id (its authorizations cascade). */
  deleteAppById(id: string): Promise<void>;
}

export abstract class BaseOAuthRepository implements OAuthRepository {
  constructor(protected readonly db: SqlExecutor) {}

  /**
   * The current time as ISO-8601 text with milliseconds and `Z`, for the
   * `createdAt`/`updatedAt` columns of `oauth_apps` and
   * `oauth_authorizations`, which stay text on every engine (legacy rows hold
   * another format). `nowIso` is typed per engine and may not be text.
   */
  protected abstract nowIsoText(): SqlQuery;

  findAppByProvider(provider: string): Promise<OAuthAppRow | null> {
    return this.db.get<OAuthAppRow>(sql`
      SELECT * FROM oauth_apps
      WHERE provider = ${provider} AND "mcpServerId" IS NULL
      ORDER BY "createdAt" ASC, id ASC
      LIMIT 1`);
  }

  findProviderAppById(id: string): Promise<OAuthAppRow | null> {
    return this.db.get<OAuthAppRow>(
      sql`SELECT * FROM oauth_apps WHERE id = ${id} AND "mcpServerId" IS NULL`,
    );
  }

  findAppById(id: string): Promise<OAuthAppRow | null> {
    return this.db.get<OAuthAppRow>(sql`SELECT * FROM oauth_apps WHERE id = ${id}`);
  }

  abstract listApps(): Promise<OAuthAppRow[]>;

  async insertApp(provider: string, app: OAuthAppWrite): Promise<string> {
    const row = await this.db.get<{ id: string }>(sql`
      INSERT INTO oauth_apps (
        provider, "displayName", "clientId", "clientSecret", "clientSecretEncrypted",
        "authorizeUrl", "tokenUrl", "revocationUrl", "userinfoUrl", "redirectUri", scopes,
        "scopeSeparator", "tokenAuthStyle", "tokenBodyFormat",
        "requiresRefreshTokenRotation", "extraParamsJson", source, metadata
      ) VALUES (${provider}, ${app.displayName}, ${app.clientId}, ${app.clientSecretCiphertext},
        ${true}, ${app.authorizeUrl}, ${app.tokenUrl}, ${app.revocationUrl}, ${app.userinfoUrl},
        ${app.redirectUri}, ${jsonText(app.scopes)}, ${app.scopeSeparator}, ${app.tokenAuthStyle},
        ${app.tokenBodyFormat}, ${app.requiresRefreshTokenRotation}, ${jsonText(app.extraParamsJson)},
        ${app.source}, ${jsonText(app.metadata)})
      RETURNING id`);
    return (row as { id: string }).id;
  }

  async updateApp(id: string, app: OAuthAppWrite): Promise<void> {
    await this.db.run(sql`
      UPDATE oauth_apps SET
        "displayName" = ${app.displayName}, "clientId" = ${app.clientId},
        "clientSecret" = ${app.clientSecretCiphertext}, "clientSecretEncrypted" = ${true},
        "authorizeUrl" = ${app.authorizeUrl}, "tokenUrl" = ${app.tokenUrl},
        "revocationUrl" = ${app.revocationUrl}, "userinfoUrl" = ${app.userinfoUrl},
        "redirectUri" = ${app.redirectUri}, scopes = ${jsonText(app.scopes)},
        "scopeSeparator" = ${app.scopeSeparator}, "tokenAuthStyle" = ${app.tokenAuthStyle},
        "tokenBodyFormat" = ${app.tokenBodyFormat},
        "requiresRefreshTokenRotation" = ${app.requiresRefreshTokenRotation},
        "extraParamsJson" = ${jsonText(app.extraParamsJson)}, source = ${app.source},
        metadata = ${jsonText(app.metadata)}, "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id}`);
  }

  abstract getAppMetadata(provider: string): Promise<{ metadata: string | null } | null>;

  async setAppMetadata(provider: string, metadata: string): Promise<void> {
    await this.db.run(sql`
      UPDATE oauth_apps SET metadata = ${jsonText(metadata)}, "updatedAt" = ${this.nowIsoText()}
      WHERE provider = ${provider}`);
  }

  listAuthorizationsForApp(appId: string): Promise<OAuthAuthorizationRow[]> {
    return this.db.query<OAuthAuthorizationRow>(sql`
      SELECT * FROM oauth_authorizations WHERE "appId" = ${appId} ORDER BY "createdAt" ASC, id ASC`);
  }

  findAuthorization(id: string): Promise<OAuthAuthorizationRow | null> {
    return this.db.get<OAuthAuthorizationRow>(
      sql`SELECT * FROM oauth_authorizations WHERE id = ${id}`,
    );
  }

  findDefaultAuthorizationForApp(appId: string): Promise<OAuthAuthorizationRow | null> {
    return this.db.get<OAuthAuthorizationRow>(sql`
      SELECT * FROM oauth_authorizations WHERE "appId" = ${appId} AND label = 'default'`);
  }

  findDefaultAuthorizationForProvider(provider: string): Promise<OAuthAuthorizationRow | null> {
    return this.db.get<OAuthAuthorizationRow>(sql`
      SELECT z.*
      FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      WHERE a.provider = ${provider} AND a."mcpServerId" IS NULL AND z.label = 'default'
      ORDER BY a."createdAt" ASC, a.id ASC
      LIMIT 1`);
  }

  async findAuthorizationIdByLabel(appId: string, label: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM oauth_authorizations WHERE "appId" = ${appId} AND label = ${label}`);
    return row?.id ?? null;
  }

  async listAuthorizationProviders(): Promise<string[]> {
    const rows = await this.db.query<{ provider: string }>(sql`
      SELECT a.provider FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      ORDER BY a.provider, z.id`);
    return rows.map((row) => row.provider);
  }

  abstract listAuthorizationsWithProvider(): Promise<
    (OAuthAuthorizationRow & { provider: string })[]
  >;

  async insertAuthorization(
    row: OAuthAuthorizationWrite & { id: string; appId: string; label: string },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO oauth_authorizations (
        id, "appId", label, "userId", "accountEmail", "identityJson",
        "accessToken", "refreshToken", "tokenType", "expiresAt", scope,
        "tokensEncrypted", "tokenVersion", status, "lastErrorMessage",
        "lastRefreshedAt", "connectedByUserId"
      ) VALUES (${row.id}, ${row.appId}, ${row.label}, ${row.userId}, ${row.accountEmail},
        ${jsonText(row.identityJson)}, ${row.accessToken}, ${row.refreshToken}, ${row.tokenType},
        ${row.expiresAt}, ${row.scope}, ${true}, 1, ${row.status}, ${row.lastErrorMessage},
        ${row.lastRefreshedAt}, ${row.connectedByUserId})`);
  }

  async rewriteAuthorization(id: string, row: OAuthAuthorizationWrite): Promise<void> {
    await this.db.run(sql`
      UPDATE oauth_authorizations SET
        "userId" = ${row.userId}, "accountEmail" = ${row.accountEmail},
        "identityJson" = ${jsonText(row.identityJson)}, "accessToken" = ${row.accessToken},
        "refreshToken" = ${row.refreshToken}, "tokenType" = ${row.tokenType},
        "expiresAt" = ${row.expiresAt}, scope = ${row.scope},
        "tokensEncrypted" = ${true}, "tokenVersion" = "tokenVersion" + 1, status = ${row.status},
        "lastErrorMessage" = ${row.lastErrorMessage}, "lastRefreshedAt" = ${row.lastRefreshedAt},
        "connectedByUserId" = ${row.connectedByUserId},
        "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id}`);
  }

  async storeRefreshedTokens(
    id: string,
    expectedVersion: number,
    tokens: {
      accessToken: string;
      refreshToken: string | null;
      expiresAt: string | null;
      scope: string | null;
    },
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      UPDATE oauth_authorizations SET
        "accessToken" = ${tokens.accessToken}, "refreshToken" = ${tokens.refreshToken},
        "expiresAt" = ${tokens.expiresAt}, scope = ${tokens.scope},
        "tokensEncrypted" = ${true}, "tokenVersion" = "tokenVersion" + 1,
        status = 'active', "lastErrorMessage" = NULL,
        "lastRefreshedAt" = ${nowIso},
        "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id} AND "tokenVersion" = ${expectedVersion}`);
    return result.changes === 1;
  }

  async setAuthorizationIdentity(
    id: string,
    identity: { accountEmail: string | null; identityJson: string | null },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE oauth_authorizations SET
        "accountEmail" = ${identity.accountEmail}, "identityJson" = ${jsonText(identity.identityJson)},
        "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id}`);
  }

  async deleteAuthorization(id: string): Promise<boolean> {
    const result = await this.db.run(sql`DELETE FROM oauth_authorizations WHERE id = ${id}`);
    return result.changes > 0;
  }

  async deleteAuthorizationsForApp(appId: string): Promise<number> {
    const result = await this.db.run(
      sql`DELETE FROM oauth_authorizations WHERE "appId" = ${appId}`,
    );
    return result.changes;
  }

  async markRefreshFailed(id: string, message: string | null): Promise<boolean> {
    const result = await this.db.run(sql`
      UPDATE oauth_authorizations SET
        status = 'refresh-failed', "lastErrorMessage" = ${message},
        "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id} AND status != 'revoked'`);
    return result.changes === 1;
  }

  async revokeAuthorization(id: string, emptyCiphertext: string): Promise<boolean> {
    const result = await this.db.run(sql`
      UPDATE oauth_authorizations SET
        "accessToken" = ${emptyCiphertext}, "refreshToken" = NULL, "expiresAt" = NULL, scope = NULL,
        "tokensEncrypted" = ${true}, "tokenVersion" = "tokenVersion" + 1,
        status = 'revoked', "lastErrorMessage" = NULL, "lastRefreshedAt" = NULL,
        "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id}`);
    return result.changes === 1;
  }

  async setAuthorizationStatus(id: string, status: string, message: string | null): Promise<void> {
    await this.db.run(sql`
      UPDATE oauth_authorizations
      SET status = ${status}, "lastErrorMessage" = ${message}, "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id}`);
  }

  abstract listSweepRows(): Promise<OAuthAuthorizationSweepRow[]>;

  protected sweepSelect(): SqlQuery {
    return sql`
      SELECT z.id AS "authorizationId",
        z."appId" AS "appId",
        a.provider AS provider,
        z.label AS label,
        z.status AS status,
        CASE WHEN z."refreshToken" IS NOT NULL AND z."refreshToken" != '' THEN 1 ELSE 0 END AS "hasRefreshToken",
        COALESCE(z."expiresAt", '') AS "expiresAt",
        z."updatedAt" AS "updatedAt"
      FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      WHERE a."mcpServerId" IS NULL`;
  }

  abstract listKeepAliveRows(): Promise<OAuthKeepAliveRow[]>;

  async insertPending(row: NewOAuthPending): Promise<void> {
    await this.db.run(sql`
      INSERT INTO oauth_pending (
        state, "appId", label, flow, "codeVerifier", nonce,
        "redirectUri", "finalRedirect", "userId", "contextJson"
      ) VALUES (${row.state}, ${row.appId}, ${row.label}, ${row.flow}, ${row.codeVerifier},
        ${row.nonce}, ${row.redirectUri}, ${row.finalRedirect}, ${row.userId}, ${jsonText(row.contextJson)})`);
  }

  findPending(state: string, flows: readonly string[]): Promise<OAuthPendingRow | null> {
    return this.db.get<OAuthPendingRow>(sql`
      SELECT state, "appId", label, flow, "codeVerifier", nonce, "redirectUri",
        "finalRedirect", "userId", "contextJson", "createdAt"
      FROM oauth_pending
      WHERE state = ${state} AND flow IN (${sqlList(flows)})`);
  }

  async deletePending(state: string, flow?: string): Promise<void> {
    await this.db.run(
      flow === undefined
        ? sql`DELETE FROM oauth_pending WHERE state = ${state}`
        : sql`DELETE FROM oauth_pending WHERE state = ${state} AND flow = ${flow}`,
    );
  }

  async deletePendingBefore(flows: readonly string[], cutoff: string): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM oauth_pending WHERE flow IN (${sqlList(flows)}) AND "createdAt" < ${cutoff}`);
    return result.changes;
  }

  async listPendingAppIdsBefore(flow: string, cutoff: string): Promise<string[]> {
    const rows = await this.db.query<{ appId: string }>(sql`
      SELECT DISTINCT "appId" FROM oauth_pending
      WHERE flow = ${flow} AND "createdAt" < ${cutoff}
      ORDER BY "appId"`);
    return rows.map((row) => row.appId);
  }

  protected mcpTokenSelect(where: SqlQuery): SqlQuery {
    return sql`SELECT
        z.id, z."appId", a."mcpServerId", z."userId",
        z."accessToken", z."refreshToken", z."tokenType", z."expiresAt", z.scope,
        z."tokensEncrypted", z."tokenVersion", z.status, z."lastErrorMessage", z."lastRefreshedAt",
        z."connectedByUserId", z."createdAt", z."updatedAt",
        a."authorizeUrl", a."tokenUrl", a."revocationUrl", a."clientId", a."clientSecret",
        a."clientSecretEncrypted", a.scopes, a.source, a.metadata
      FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      WHERE a."mcpServerId" IS NOT NULL AND ${where}`;
  }

  findMcpToken(mcpServerId: string, userId: string | null): Promise<McpOAuthTokenRow | null> {
    const user = userId == null ? sql`z."userId" IS NULL` : sql`z."userId" = ${userId}`;
    return this.db.get<McpOAuthTokenRow>(
      sql`${this.mcpTokenSelect(
        sql`a."mcpServerId" = ${mcpServerId} AND ${user}`,
      )} ORDER BY z."createdAt" ASC, z.id ASC LIMIT 1`,
    );
  }

  findMcpTokenById(id: string): Promise<McpOAuthTokenRow | null> {
    return this.db.get<McpOAuthTokenRow>(this.mcpTokenSelect(sql`z.id = ${id}`));
  }

  listMcpTokens(mcpServerId: string): Promise<McpOAuthTokenRow[]> {
    return this.db.query<McpOAuthTokenRow>(
      sql`${this.mcpTokenSelect(
        sql`a."mcpServerId" = ${mcpServerId}`,
      )} ORDER BY z."createdAt" ASC, z.id ASC`,
    );
  }

  async insertMcpApp(id: string, mcpServerId: string, app: McpOAuthAppWrite): Promise<void> {
    await this.db.run(sql`
      INSERT INTO oauth_apps (
        id, provider, "clientId", "clientSecret", "clientSecretEncrypted",
        "authorizeUrl", "tokenUrl", "revocationUrl", "redirectUri", scopes,
        "scopeSeparator", "tokenAuthStyle", "tokenBodyFormat",
        "requiresRefreshTokenRotation", source, "mcpServerId", metadata
      ) VALUES (${id}, ${app.provider}, ${app.clientId}, ${app.clientSecretCiphertext}, ${true},
        ${app.authorizeUrl}, ${app.tokenUrl}, ${app.revocationUrl}, ${app.redirectUri}, ${jsonText(app.scopes)},
        ' ', 'body', 'form', ${false}, ${app.source}, ${mcpServerId}, ${jsonText(app.metadata)})`);
  }

  async updateMcpApp(id: string, app: McpOAuthAppWrite): Promise<void> {
    await this.db.run(sql`
      UPDATE oauth_apps SET
        provider = ${app.provider}, "clientId" = ${app.clientId},
        "clientSecret" = ${app.clientSecretCiphertext}, "clientSecretEncrypted" = ${true},
        "authorizeUrl" = ${app.authorizeUrl}, "tokenUrl" = ${app.tokenUrl},
        "revocationUrl" = ${app.revocationUrl}, "redirectUri" = ${app.redirectUri},
        scopes = ${jsonText(app.scopes)}, source = ${app.source}, metadata = ${jsonText(app.metadata)},
        "updatedAt" = ${this.nowIsoText()}
      WHERE id = ${id}`);
  }

  async setAppMetadataById(id: string, metadata: string): Promise<void> {
    await this.db.run(
      sql`UPDATE oauth_apps SET metadata = ${jsonText(metadata)}, "updatedAt" = ${this.nowIsoText()} WHERE id = ${id}`,
    );
  }

  abstract findLatestMcpPendingAppId(
    mcpServerId: string,
    userId: string | null,
  ): Promise<string | null>;

  findMcpPending(state: string): Promise<McpOAuthPendingJoinRow | null> {
    return this.db.get<McpOAuthPendingJoinRow>(sql`
      SELECT p.state, a."mcpServerId", p."userId", p."codeVerifier", p.nonce,
        p."redirectUri", p."finalRedirect", p."createdAt",
        p."appId", p."contextJson"
      FROM oauth_pending p
      JOIN oauth_apps a ON a.id = p."appId"
      WHERE p.state = ${state} AND p.flow = 'mcp'`);
  }

  async deleteOrphanMcpApp(appId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM oauth_apps
      WHERE id = ${appId} AND "mcpServerId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM oauth_authorizations WHERE "appId" = oauth_apps.id)
        AND NOT EXISTS (SELECT 1 FROM oauth_pending WHERE "appId" = oauth_apps.id)`);
  }

  async acquireRefreshLock(
    lockKey: string,
    owner: string,
    expiresAt: string,
    now: string,
  ): Promise<string | null> {
    await this.db.run(sql`
      INSERT INTO oauth_refresh_locks ("lockKey", owner, "expiresAt", "createdAt", "updatedAt")
      VALUES (${lockKey}, ${owner}, ${expiresAt}, ${now}, ${now})
      ON CONFLICT ("lockKey") DO UPDATE SET
        owner = excluded.owner,
        "expiresAt" = excluded."expiresAt",
        "updatedAt" = excluded."updatedAt"
      WHERE oauth_refresh_locks."expiresAt" <= ${now}`);
    const row = await this.db.get<{ owner: string }>(
      sql`SELECT owner FROM oauth_refresh_locks WHERE "lockKey" = ${lockKey}`,
    );
    return row?.owner ?? null;
  }

  async releaseRefreshLock(lockKey: string, owner: string): Promise<void> {
    await this.db.run(
      sql`DELETE FROM oauth_refresh_locks WHERE "lockKey" = ${lockKey} AND owner = ${owner}`,
    );
  }

  async isRefreshLockHeld(lockKey: string, owner: string, now: string): Promise<boolean> {
    const row = await this.db.get<{ owner: string }>(
      sql`SELECT owner FROM oauth_refresh_locks
          WHERE "lockKey" = ${lockKey} AND owner = ${owner} AND "expiresAt" > ${now}`,
    );
    return !!row;
  }

  getCodexDeviceFlow(flowId: string): Promise<{ state: string; expires_at: number } | null> {
    return this.db.get<{ state: string; expires_at: number }>(
      sql`SELECT state, expires_at FROM codex_oauth_device_flows WHERE flow_id = ${flowId}`,
    );
  }

  async deleteCodexDeviceFlow(flowId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM codex_oauth_device_flows WHERE flow_id = ${flowId}`);
  }

  async deleteExpiredCodexDeviceFlows(now: number): Promise<void> {
    await this.db.run(sql`DELETE FROM codex_oauth_device_flows WHERE expires_at <= ${now}`);
  }

  async upsertCodexDeviceFlow(
    flowId: string,
    state: string,
    expiresAt: number,
    now: number,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO codex_oauth_device_flows (flow_id, state, expires_at, created_at, updated_at)
      VALUES (${flowId}, ${state}, ${expiresAt}, ${now}, ${now})
      ON CONFLICT (flow_id) DO UPDATE SET
        state = excluded.state,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listProviderAppsWithDefaultToken(): Promise<OAuthAppListingRow[]>;

  async deleteAppById(id: string): Promise<void> {
    await this.db.run(sql`DELETE FROM oauth_apps WHERE id = ${id}`);
  }
}
