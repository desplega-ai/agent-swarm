import type { Database } from "bun:sqlite";
import { encryptSecret, getEncryptionKey } from "./crypto";

export type OAuthEncryptionBackfillResult = {
  appsEncrypted: number;
  authorizationsEncrypted: number;
};

type PlaintextAppRow = {
  id: string;
  clientSecret: string;
};

type PlaintextAuthorizationRow = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
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
  const apps = database
    .prepare<PlaintextAppRow, []>(
      `SELECT id, clientSecret
       FROM oauth_apps
       WHERE clientSecretEncrypted = 0 AND clientSecret IS NOT NULL`,
    )
    .all();
  const authorizations = database
    .prepare<PlaintextAuthorizationRow, []>(
      `SELECT id, accessToken, refreshToken
       FROM oauth_authorizations
       WHERE tokensEncrypted = 0`,
    )
    .all();

  if (apps.length === 0 && authorizations.length === 0) {
    console.log("[oauth-encryption] No plaintext OAuth secrets to migrate.");
    return { appsEncrypted: 0, authorizationsEncrypted: 0 };
  }

  const key = getEncryptionKey();
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
    for (const app of apps) {
      updateApp.run(encryptSecret(app.clientSecret, key), app.id);
    }
    for (const authorization of authorizations) {
      updateAuthorization.run(
        encryptSecret(authorization.accessToken, key),
        authorization.refreshToken == null ? null : encryptSecret(authorization.refreshToken, key),
        authorization.id,
      );
    }
  })();

  console.log(
    `[oauth-encryption] Migrated ${apps.length} app secret(s) and ${authorizations.length} authorization token set(s).`,
  );
  return {
    appsEncrypted: apps.length,
    authorizationsEncrypted: authorizations.length,
  };
}
