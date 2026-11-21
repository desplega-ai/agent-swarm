import { decryptSecret, getEncryptionKey } from "../crypto";
import { getStorage } from "../storage";
import { isReservedConfigKey } from "../swarm-config-guard";

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
  const rows = await getStorage().repos.config.listSecretConfigs();
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
