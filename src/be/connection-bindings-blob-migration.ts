import type { Database } from "bun:sqlite";
import {
  CREDENTIAL_BINDINGS_CONFIG_KEY,
  normalizeCredentialBindingsDocument,
} from "@/scripts-runtime/credential-broker";
import { scrubSecrets } from "@/utils/secret-scrubber";
import {
  findDefaultOAuthAuthorization,
  type LegacyCredentialBinding,
  listCredentialBindingBlobs,
  replaceCredentialBindingBlob,
} from "./storage-root";

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
  const rows = listCredentialBindingBlobs(database, CREDENTIAL_BINDINGS_CONFIG_KEY);
  if (rows.length === 0) return 0;

  const resolveLegacyOAuthProvider = (provider: string): string | undefined =>
    findDefaultOAuthAuthorization(database, provider);

  const promoted: LegacyCredentialBinding[] = [];
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
      promoted.push({
        id: crypto.randomUUID(),
        configKey: binding.configKey,
        allowedHostsJson: JSON.stringify(binding.allowedHosts),
        headerTemplate: binding.headerTemplate ?? null,
        queryTemplate: binding.queryTemplate ?? null,
        scope,
        scopeId: scope === "global" ? null : scopeId,
        active: binding.active !== false,
        authKind: binding.authKind,
        oauthAuthorizationId: binding.oauthAuthorizationId ?? null,
      });
    }
  }
  // The inserts and the blob delete commit together.
  replaceCredentialBindingBlob(database, CREDENTIAL_BINDINGS_CONFIG_KEY, promoted);
  const imported = promoted.length;

  console.log(
    `[credential-bindings] Migrated ${imported} legacy SCRIPT_CREDENTIAL_BINDINGS entr(ies) to relational rows and retired the blob key.`,
  );
  return imported;
}
