import { decryptSecret, getEncryptionKey } from "../crypto";
import { isReservedConfigKey } from "../swarm-config-guard";
import { getDbClient } from "./runtime";

/**
 * Every stored secret config value (all scopes, incl. derived
 * `connection.<slug>.secret` rows), decrypted, for the secret registry
 * (src/be/secret-registry.ts). Reserved env-only keys are skipped: their live
 * value is in env. A row that fails to decrypt is counted, not thrown, so one
 * bad row cannot hide the rest.
 */
export async function listStoredConfigSecrets(): Promise<{
  secrets: { key: string; value: string }[];
  failed: number;
}> {
  const rows = await getDbClient().query<{ key: string; value: string; encrypted: number }>(
    "SELECT key, value, encrypted FROM swarm_config WHERE isSecret = 1 OR encrypted = 1",
  );
  const secrets: { key: string; value: string }[] = [];
  let failed = 0;
  for (const row of rows) {
    if (isReservedConfigKey(row.key)) continue;
    try {
      const value = row.encrypted === 1 ? decryptSecret(row.value, getEncryptionKey()) : row.value;
      if (value) secrets.push({ key: row.key, value });
    } catch {
      failed++;
    }
  }
  return { secrets, failed };
}
