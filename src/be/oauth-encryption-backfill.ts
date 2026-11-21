import type { Database } from "bun:sqlite";
import { encryptSecret, getEncryptionKey } from "./crypto";
import { listPlaintextOAuthSecrets, storeEncryptedOAuthSecrets } from "./storage-root";

export type OAuthEncryptionBackfillResult = {
  appsEncrypted: number;
  authorizationsEncrypted: number;
};

/**
 * Encrypt OAuth values copied from the pre-117 tracker tables.
 *
 * Migration 117 deliberately carries plaintext values with an explicit 0
 * flag so the SQL migration itself never needs access to the encryption key.
 * This post-migration pass encrypts every flagged row atomically and flips
 * the flag in the same UPDATE. Rows written through the unified adapters are
 * already encrypted and never enter this scan.
 */
export function autoEncryptLegacyOAuthSecrets(database: Database): OAuthEncryptionBackfillResult {
  const { apps, authorizations } = listPlaintextOAuthSecrets(database);

  if (apps.length === 0 && authorizations.length === 0) {
    console.log("[oauth-encryption] No plaintext OAuth secrets to migrate.");
    return { appsEncrypted: 0, authorizationsEncrypted: 0 };
  }

  const key = getEncryptionKey();
  storeEncryptedOAuthSecrets(
    database,
    apps.map((app) => ({ id: app.id, clientSecret: encryptSecret(app.clientSecret, key) })),
    authorizations.map((authorization) => ({
      id: authorization.id,
      accessToken: encryptSecret(authorization.accessToken, key),
      refreshToken:
        authorization.refreshToken == null ? null : encryptSecret(authorization.refreshToken, key),
    })),
  );

  console.log(
    `[oauth-encryption] Migrated ${apps.length} app secret(s) and ${authorizations.length} authorization token set(s).`,
  );
  return {
    appsEncrypted: apps.length,
    authorizationsEncrypted: authorizations.length,
  };
}
