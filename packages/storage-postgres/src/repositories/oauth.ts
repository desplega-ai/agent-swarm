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

/** ISO-8601 text with milliseconds and `Z` of a timestamptz value (the SQLite text). */
const isoText = (value: SqlQuery) =>
  sql`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// "_rowid" is the SQLite rowid: insertion order.
export class PostgresOAuthRepository extends BaseOAuthRepository {
  protected nowIsoText(): SqlQuery {
    return isoText(sql`statement_timestamp()`);
  }

  listApps(): Promise<OAuthAppRow[]> {
    return this.db.query<OAuthAppRow>(sql`SELECT * FROM oauth_apps ORDER BY "_rowid"`);
  }

  getAppMetadata(provider: string): Promise<{ metadata: string | null } | null> {
    return this.db.get<{ metadata: string | null }>(
      sql`SELECT metadata FROM oauth_apps WHERE provider = ${provider} ORDER BY "_rowid" LIMIT 1`,
    );
  }

  listAuthorizationsWithProvider(): Promise<(OAuthAuthorizationRow & { provider: string })[]> {
    return this.db.query<OAuthAuthorizationRow & { provider: string }>(sql`
      SELECT z.*, a.provider AS provider
      FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      ORDER BY z."_rowid"`);
  }

  listSweepRows(): Promise<OAuthAuthorizationSweepRow[]> {
    // The base sweepSelect, with expiresAt (timestamptz here) rendered as the
    // ISO text SQLite stores, '' when unset.
    return this.db.query<OAuthAuthorizationSweepRow>(sql`
      SELECT z.id AS "authorizationId",
        z."appId" AS "appId",
        a.provider AS provider,
        z.label AS label,
        z.status AS status,
        CASE WHEN z."refreshToken" IS NOT NULL AND z."refreshToken" != '' THEN 1 ELSE 0 END AS "hasRefreshToken",
        COALESCE(${isoText(sql`z."expiresAt"`)}, '') AS "expiresAt",
        z."updatedAt" AS "updatedAt"
      FROM oauth_authorizations z
      JOIN oauth_apps a ON a.id = z."appId"
      WHERE a."mcpServerId" IS NULL
      ORDER BY a.provider ASC, z.label ASC, a."_rowid" ASC`);
  }

  listKeepAliveRows(): Promise<OAuthKeepAliveRow[]> {
    // SQLite's json_extract(metadata, '$.keepAlive') IN (1, 'true'): JSON true,
    // the number 1, or the string "true". jsonb compares numbers by value.
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
          a."requiresRefreshTokenRotation" = ${true}
          OR (a.metadata->'keepAlive') IN ('true'::jsonb, '1'::jsonb, '"true"'::jsonb)
        )
      ORDER BY a.provider ASC, z.label ASC, a."_rowid" ASC`);
  }

  async findLatestMcpPendingAppId(
    mcpServerId: string,
    userId: string | null,
  ): Promise<string | null> {
    const user = userId == null ? sql`p."userId" IS NULL` : sql`p."userId" = ${userId}`;
    const row = await this.db.get<{ appId: string }>(sql`
      SELECT p."appId" FROM oauth_pending p
      JOIN oauth_apps a ON a.id = p."appId"
      WHERE p.flow = 'mcp' AND a."mcpServerId" = ${mcpServerId} AND ${user}
      ORDER BY p."createdAt" DESC, p."_rowid" ASC LIMIT 1`);
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
       ORDER BY a.provider ASC, a."_rowid" ASC`);
  }
}
