import type { Database } from "bun:sqlite";

/**
 * One-time data repairs that only an upgraded SQLite file can need. Each one
 * runs on the synchronous SQLite start path, after the migrations. A Postgres
 * database starts from the baseline or from the copy of a SQLite file that
 * already ran them, so they have no Postgres counterpart. The rules (what to
 * encrypt, how to read a legacy document) stay in the API; only the SQL is here.
 */

// ---- OAuth values that migration 117 carried as plaintext ----

export type PlaintextOAuthApp = { id: string; clientSecret: string };
export type PlaintextOAuthAuthorization = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
};

export function listPlaintextOAuthSecrets(database: Database): {
  apps: PlaintextOAuthApp[];
  authorizations: PlaintextOAuthAuthorization[];
} {
  const apps = database
    .prepare<PlaintextOAuthApp, []>(
      `SELECT id, clientSecret
       FROM oauth_apps
       WHERE clientSecretEncrypted = 0 AND clientSecret IS NOT NULL`,
    )
    .all();
  const authorizations = database
    .prepare<PlaintextOAuthAuthorization, []>(
      `SELECT id, accessToken, refreshToken
       FROM oauth_authorizations
       WHERE tokensEncrypted = 0`,
    )
    .all();
  return { apps, authorizations };
}

/** Writes the encrypted values and flips each flag, all in one transaction. */
export function storeEncryptedOAuthSecrets(
  database: Database,
  apps: readonly PlaintextOAuthApp[],
  authorizations: readonly PlaintextOAuthAuthorization[],
): void {
  const updateApp = database.prepare<unknown, [string, string]>(
    `UPDATE oauth_apps
     SET clientSecret = ?, clientSecretEncrypted = 1,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND clientSecretEncrypted = 0`,
  );
  const updateAuthorization = database.prepare<unknown, [string, string | null, string]>(
    `UPDATE oauth_authorizations
     SET accessToken = ?, refreshToken = ?, tokensEncrypted = 1,
         updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND tokensEncrypted = 0`,
  );
  database.transaction(() => {
    for (const app of apps) updateApp.run(app.clientSecret, app.id);
    for (const authorization of authorizations) {
      updateAuthorization.run(
        authorization.accessToken,
        authorization.refreshToken,
        authorization.id,
      );
    }
  })();
}

// ---- The retired SCRIPT_CREDENTIAL_BINDINGS swarm-config blob ----

export type CredentialBindingBlobRow = {
  id: string;
  scope: string;
  scopeId: string | null;
  value: string;
};

export type LegacyCredentialBinding = {
  id: string;
  configKey: string;
  allowedHostsJson: string;
  headerTemplate: string | null;
  queryTemplate: string | null;
  scope: string;
  scopeId: string | null;
  active: boolean;
  authKind: string;
  oauthAuthorizationId: string | null;
};

export function listCredentialBindingBlobs(
  database: Database,
  configKey: string,
): CredentialBindingBlobRow[] {
  return database
    .prepare<CredentialBindingBlobRow, [string]>(
      "SELECT id, scope, scopeId, value FROM swarm_config WHERE key = ?",
    )
    .all(configKey);
}

/** The oldest unmanaged `default` authorization of a provider (oldest app, then app id). */
export function findDefaultOAuthAuthorization(
  database: Database,
  provider: string,
): string | undefined {
  const row = database
    .prepare<{ id: string }, [string]>(
      `SELECT z.id
       FROM oauth_authorizations z
       JOIN oauth_apps a ON a.id = z.appId
       WHERE a.provider = ? AND a.mcpServerId IS NULL AND z.label = 'default'
       ORDER BY a.createdAt ASC, a.id ASC
       LIMIT 1`,
    )
    .get(provider);
  return row?.id;
}

/**
 * In one transaction: insert the bindings (an existing identity wins) and
 * delete the blob rows.
 */
export function replaceCredentialBindingBlob(
  database: Database,
  configKey: string,
  bindings: readonly LegacyCredentialBinding[],
): void {
  const insert = database.prepare<
    unknown,
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string | null,
      number,
      string,
      string | null,
    ]
  >(
    `INSERT OR IGNORE INTO script_credential_bindings
       (id, config_key, allowed_hosts_json, header_template, query_template, scope, scope_id,
        active, auth_kind, oauth_authorization_id, source, managed_by_connection_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration', NULL,
             datetime('now'), datetime('now'))`,
  );
  database.transaction(() => {
    for (const b of bindings) {
      insert.run(
        b.id,
        b.configKey,
        b.allowedHostsJson,
        b.headerTemplate,
        b.queryTemplate,
        b.scope,
        b.scopeId,
        b.active ? 1 : 0,
        b.authKind,
        b.oauthAuthorizationId,
      );
    }
    database.prepare<unknown, [string]>("DELETE FROM swarm_config WHERE key = ?").run(configKey);
  })();
}

// ---- swarm_config secrets stored as plaintext before encryption existed ----

export type PlaintextSecretConfig = { id: string; key: string; value: string };

/** Secret config rows still stored as plaintext. */
export function listPlaintextSecretConfigs(database: Database): PlaintextSecretConfig[] {
  return database
    .prepare<PlaintextSecretConfig, []>(
      "SELECT id, key, value FROM swarm_config WHERE isSecret = 1 AND encrypted = 0",
    )
    .all();
}

/** Store the ciphertext of each row and flag it encrypted, in one transaction. */
export function storeEncryptedSecretConfigs(
  database: Database,
  rows: { id: string; value: string }[],
): void {
  const txn = database.transaction((items: { id: string; value: string }[]) => {
    const stmt = database.prepare<unknown, [string, string]>(
      "UPDATE swarm_config SET value = ?, encrypted = 1 WHERE id = ?",
    );
    for (const r of items) stmt.run(r.value, r.id);
  });
  txn(rows);
}

// ---- first context version of each agent profile field (SQLite start) ----

export type AgentProfileFields = {
  id: string;
  soulMd: string | null;
  identityMd: string | null;
  toolsMd: string | null;
  claudeMd: string | null;
  setupScript: string | null;
  heartbeatMd: string | null;
};

export function listAgentProfileFields(database: Database): AgentProfileFields[] {
  return database
    .prepare<AgentProfileFields, []>(
      `SELECT id, soulMd, identityMd, toolsMd, claudeMd, setupScript, heartbeatMd FROM agents`,
    )
    .all();
}

export function hasContextVersion(database: Database, agentId: string, field: string): boolean {
  return (
    database
      .prepare<{ id: string }, [string, string]>(
        `SELECT id FROM context_versions WHERE agentId = ? AND field = ? LIMIT 1`,
      )
      .get(agentId, field) !== null
  );
}

export function insertFirstContextVersion(
  database: Database,
  v: { id: string; agentId: string; field: string; content: string; hash: string; now: string },
): void {
  database
    .prepare(
      `INSERT INTO context_versions (id, agentId, field, content, version, changeSource, contentHash, createdAt)
           VALUES (?, ?, ?, ?, 1, 'system', ?, ?)`,
    )
    .run(v.id, v.agentId, v.field, v.content, v.hash, v.now);
}
