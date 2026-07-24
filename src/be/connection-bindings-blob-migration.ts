import type { Database } from "bun:sqlite";
import {
  CREDENTIAL_BINDINGS_CONFIG_KEY,
  normalizeCredentialBindingsDocument,
} from "@/scripts-runtime/credential-broker";
import { scrubSecrets } from "@/utils/secret-scrubber";

type BlobConfigRow = {
  id: string;
  scope: string;
  scopeId: string | null;
  value: string;
};

/**
 * One-shot retirement of the legacy `SCRIPT_CREDENTIAL_BINDINGS` swarm-config
 * JSON blob. Any remaining blob entries are promoted to relational
 * `script_credential_bindings` rows (standalone / unmanaged), then the config
 * key is deleted so the broker becomes relational-only.
 *
 * Idempotent: once the config rows are gone the scan is a no-op, and the
 * identity index (partial on managed_by_connection_id IS NULL) makes the
 * relational inserts collision-safe if a partial run is retried.
 */
export function migrateLegacyCredentialBindingBlob(database: Database): number {
  const rows = database
    .prepare<BlobConfigRow, [string]>(
      "SELECT id, scope, scopeId, value FROM swarm_config WHERE key = ?",
    )
    .all(CREDENTIAL_BINDINGS_CONFIG_KEY);
  if (rows.length === 0) return 0;

  const resolveLegacyOAuthProvider = (provider: string): string | undefined => {
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
  };

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

  let imported = 0;
  const tx = database.transaction(() => {
    for (const config of rows) {
      let bindings: ReturnType<typeof normalizeCredentialBindingsDocument>;
      try {
        bindings = normalizeCredentialBindingsDocument(
          JSON.parse(config.value),
          resolveLegacyOAuthProvider,
          // Entries that omit their own scope inherit the containing config
          // row's scope, so agent/repo-scoped blobs stay scoped instead of
          // being promoted to global relational bindings (secret leak).
          config.scope as "global" | "agent" | "repo",
        );
      } catch (err) {
        // Don't silently drop an unparseable blob entry — the whole point of
        // fatal-on-failure boot wiring is to never lose bindings quietly. Log a
        // scrubbed warning (the blob value may embed secrets) and skip only this
        // row so the rest still migrate.
        console.warn(
          `[credential-bindings] Skipping unparseable SCRIPT_CREDENTIAL_BINDINGS entry (config id ${config.id}, scope ${config.scope}): ${scrubSecrets(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
        continue;
      }
      for (const binding of bindings) {
        const scope = binding.scope ?? (config.scope as "global" | "agent" | "repo");
        const scopeId = binding.scopeId ?? config.scopeId ?? null;
        insert.run(
          crypto.randomUUID(),
          binding.configKey,
          JSON.stringify(binding.allowedHosts),
          binding.headerTemplate ?? null,
          binding.queryTemplate ?? null,
          scope,
          scope === "global" ? null : scopeId,
          binding.active === false ? 0 : 1,
          binding.authKind,
          binding.oauthAuthorizationId ?? null,
        );
        imported += 1;
      }
    }
    database
      .prepare<unknown, [string]>("DELETE FROM swarm_config WHERE key = ?")
      .run(CREDENTIAL_BINDINGS_CONFIG_KEY);
  });
  tx();

  console.log(
    `[credential-bindings] Migrated ${imported} legacy SCRIPT_CREDENTIAL_BINDINGS entr(ies) to relational rows and retired the blob key.`,
  );
  return imported;
}
