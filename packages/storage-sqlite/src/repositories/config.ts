import {
  type ApiKeyAdmissionRow,
  type ApiKeyRowFilter,
  type ApiKeyStatusRow,
  apiKeyRowFilter,
  BaseConfigRepository,
  type SwarmConfigRow,
  sql,
  sqlList,
} from "@desplega/storage";

export class SqliteConfigRepository extends BaseConfigRepository {
  listConfigs(filters: {
    scope?: string;
    scopeId?: string;
    key?: string;
  }): Promise<SwarmConfigRow[]> {
    return this.db.query<SwarmConfigRow>(
      sql`SELECT * FROM swarm_config${this.configFilters(filters)} ORDER BY key ASC, rowid ASC`,
    );
  }

  listGlobalConfigsExcept(excludedUpperKeys: readonly string[]): Promise<SwarmConfigRow[]> {
    return this.db.query<SwarmConfigRow>(sql`
      SELECT * FROM swarm_config
      WHERE scope = 'global'
        AND UPPER(key) NOT IN (${sqlList(excludedUpperKeys)})
      ORDER BY key ASC, rowid ASC`);
  }

  listSecretConfigs(): Promise<{ key: string; value: string; encrypted: number }[]> {
    return this.db.query(sql`
      SELECT key, value, encrypted FROM swarm_config
      WHERE "isSecret" = ${true} OR encrypted = ${true}
      ORDER BY rowid`);
  }

  listCodexOauthConfigs(): Promise<{ key: string; value: string; encrypted: number }[]> {
    return this.db.query(sql`
      SELECT key, value, encrypted FROM swarm_config
      WHERE scope = 'global' AND (key = 'codex_oauth' OR key GLOB 'codex_oauth_[0-9]*')
      ORDER BY rowid`);
  }

  listKeyLabels(): Promise<
    Pick<ApiKeyStatusRow, "keyType" | "keySuffix" | "name" | "plan" | "planSource">[]
  > {
    return this.db.query(sql`
      SELECT "keyType", "keySuffix", name, plan, "planSource" FROM api_key_status
      ORDER BY CASE "planSource" WHEN 'manual' THEN 0 WHEN 'detected' THEN 1 WHEN 'estimated' THEN 2 ELSE 3 END,
        "updatedAt" DESC, rowid ASC`);
  }

  listKeyStatuses(filters: {
    keyType?: string;
    scope?: string;
    scopeId?: string;
  }): Promise<ApiKeyStatusRow[]> {
    // Ties keep the order SQLite returned before the move: with a key type the
    // lookup index (keyType, scope, scopeId, status) drives it, else rowid.
    const tiebreak = filters.keyType ? sql`scope, "scopeId", status, rowid` : sql`rowid`;
    return this.db.query<ApiKeyStatusRow>(
      sql`SELECT * FROM api_key_status${this.keyStatusFilters(filters)} ORDER BY "keyIndex", ${tiebreak}`,
    );
  }

  listAdmissionRows(filter: ApiKeyRowFilter): Promise<ApiKeyAdmissionRow[]> {
    return this.db.query<ApiKeyAdmissionRow>(sql`
      SELECT "keyIndex", "keySuffix", scope, "scopeId", status, "rateLimitWindows", plan,
        "authFailureSeq", "lastValidationFailedAt", "spendCap"
      FROM api_key_status
      WHERE ${apiKeyRowFilter(filter)}
      ORDER BY ${
        // The order SQLite returned before the move: the unique index for a
        // suffix list, the lookup index (keyType, scope, scopeId, status) for a scope.
        "suffixes" in filter ? sql`"keySuffix", scope, "scopeId"` : sql`status, rowid`
      }`);
  }

  async listAgentScopeIdsWithValue(key: string, value: string): Promise<string[]> {
    const rows = await this.db.query<{ scopeId: string }>(sql`
      SELECT "scopeId" FROM swarm_config
       WHERE scope = 'agent' AND key = ${key} AND value = ${value}
       ORDER BY rowid`);
    return rows.map((row) => row.scopeId);
  }

  listRepoNamesAndUrls(): Promise<{ name: string | null; url: string | null }[]> {
    return this.db.query<{ name: string | null; url: string | null }>(
      sql`SELECT name, url FROM swarm_repos ORDER BY rowid`,
    );
  }
}
