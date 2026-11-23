import {
  BaseOAuthRepository,
  type OAuthAppListingRow,
  type OAuthAppRow,
  type OAuthAuthorizationRow,
  type OAuthAuthorizationSweepRow,
  type OAuthKeepAliveRow,
  type SqlQuery,
  sql,
} from "@desplega/storage";

export class SqliteOAuthRepository extends BaseOAuthRepository {
  protected nowIsoText(): SqlQuery {
    return sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  }

  listApps(): Promise<OAuthAppRow[]> {
    return this.db.query<OAuthAppRow>(sql`SELECT * FROM oauth_apps ORDER BY rowid`);
  }

  getAppMetadata(provider: string): Promise<{ metadata: string | null } | null> {
    // The row SQLite returned first before the move: idx_oauth_apps_provider, then rowid.
    return this.db.get<{ metadata: string | null }>(
      sql`SELECT metadata FROM oauth_apps WHERE provider = ${provider} ORDER BY rowid LIMIT 1`,
    );
  }

  listAuthorizationsWithProvider(): Promise<(OAuthAuthorizationRow & { provider: string })[]> {
    // The order SQLite returned before the move: a scan of the authorizations.
    return this.db.query<OAuthAuthorizationRow & { provider: string }>(sql`
      SELECT z.*, a.provider AS provider
      FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      ORDER BY z.rowid`);
  }

  listSweepRows(): Promise<OAuthAuthorizationSweepRow[]> {
    // Equal (provider, label) pairs belong to different apps; the app scan
    // (idx_oauth_apps_mcp_server, then rowid) ordered them before the move.
    return this.db.query<OAuthAuthorizationSweepRow>(
      sql`${this.sweepSelect()} ORDER BY a.provider ASC, z.label ASC, a.rowid ASC`,
    );
  }

  listKeepAliveRows(): Promise<OAuthKeepAliveRow[]> {
    return this.db.query<OAuthKeepAliveRow>(sql`
      SELECT z.id AS "authorizationId",
        z."appId" AS "appId",
        a.provider AS provider,
        z.label AS label,
        a."displayName" AS "displayName"
      FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      WHERE a."mcpServerId" IS NULL
        AND z.status = 'active'
        AND z."refreshToken" IS NOT NULL AND z."refreshToken" != ''
        AND (
          a."requiresRefreshTokenRotation" = 1
          OR (json_valid(a.metadata) = 1 AND json_extract(a.metadata, '$.keepAlive') IN (1, 'true'))
        )
      ORDER BY a.provider ASC, z.label ASC, a.rowid ASC`);
  }

  async findLatestMcpPendingAppId(
    mcpServerId: string,
    userId: string | null,
  ): Promise<string | null> {
    // Equal createdAt values: the first inserted wins, as the sort over the
    // pending scan returned before the move.
    const user = userId == null ? sql`p."userId" IS NULL` : sql`p."userId" = ${userId}`;
    const row = await this.db.get<{ appId: string }>(sql`
      SELECT p."appId" FROM oauth_pending p
      JOIN oauth_apps a ON a.id = p."appId"
      WHERE p.flow = 'mcp' AND a."mcpServerId" = ${mcpServerId} AND ${user}
      ORDER BY p."createdAt" DESC, p.rowid ASC LIMIT 1`);
    return row?.appId ?? null;
  }

  listProviderAppsWithDefaultToken(): Promise<OAuthAppListingRow[]> {
    return this.db.query<OAuthAppListingRow>(sql`
      SELECT a.id, a.provider, a."clientId", a."authorizeUrl", a."tokenUrl", a."redirectUri",
             a.scopes, a."extraParamsJson", a."tokenAuthStyle", a."tokenBodyFormat", a.source,
             z.id AS "authorizationId", z."expiresAt" AS "tokenExpiresAt",
             z."updatedAt" AS "tokenUpdatedAt", a."createdAt", a."updatedAt"
        FROM oauth_apps a
        LEFT JOIN oauth_authorizations z ON z."appId" = a.id AND z.label = 'default'
       WHERE a."mcpServerId" IS NULL
       ORDER BY a.provider ASC, a.rowid ASC`);
  }
}
