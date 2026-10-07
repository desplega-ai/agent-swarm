/**
 * API-side registry of every stored secret value.
 *
 * The scrubber's exact-match pass only knows sensitive env values and values
 * registered at runtime. Without this registry, a secret stored before the
 * last restart (an agent-scoped config secret, an OAuth or MCP OAuth token, a
 * script API bearer token) stays unknown until something reads it again, and
 * the boot retro-sweep cannot redact a value it does not know.
 *
 * At boot, `loadSecretRegistry()` decrypts every stored secret and registers
 * it. Each encrypt site calls `registerStoredSecret()` with the new plaintext,
 * so a write after boot is covered without a reload.
 *
 * Feeds the scrubber only through `registerVolatileSecret`, so worker-side
 * code is untouched. Append-only: a deleted or rotated secret stays
 * registered, since redacting a revoked value is still correct. Never logs a
 * value: names are source markers (`config:<KEY>`, `oauth:<provider>:…`,
 * `script-api:<id>`), and load results are counts.
 */
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { listStoredConfigSecrets } from "./db/config-secrets";
import { listStoredOAuthSecrets, type StoredOAuthSecretKind } from "./db-queries/oauth";
import { listStoredScriptApiSecrets } from "./scripts/db";

export function configSecretName(key: string): string {
  return `config:${key}`;
}

export function oauthSecretName(provider: string, kind: StoredOAuthSecretKind): string {
  return `oauth:${provider}:${kind}`;
}

export function scriptApiSecretName(id: string): string {
  return `script-api:${id}`;
}

/**
 * Base64 text that encodes `value` wherever it sits in a larger byte string.
 * Base64 maps 3 bytes to 4 chars, so the chars depend on the value's byte
 * offset mod 3. For each offset, keep only the chars computed from the value's
 * bytes alone: drop the leading chars that mix in preceding bytes and the
 * trailing chars that depend on following bytes. Offset 0 also keeps the whole
 * padded encoding (the value encoded on its own). This catches
 * `Basic base64(user:secret)` and a secret inside an encoded JSON blob.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const forms = [bytes.toString("base64")];
  for (const offset of [0, 1, 2]) {
    const shifted = Buffer.concat([Buffer.alloc(offset), bytes]);
    // Offset 1 mixes the prefix into the first 2 chars, offset 2 into the first 3.
    const skip = offset === 0 ? 0 : offset + 1;
    const end = Math.floor(shifted.length / 3) * 4;
    forms.push(shifted.toString("base64").slice(skip, end));
  }
  const urlSafe = forms.map((form) =>
    form.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  );
  return [...forms, ...urlSafe];
}

/**
 * Encoded forms of a known value: base64 (std and url-safe, see
 * `base64Forms`) and URL percent-encoding. Shell and JSON escaping are not
 * repeated here: `registerVolatileSecret` already adds those forms (and
 * drops any form shorter than the scrubber's minimum length).
 */
export function encodedForms(value: string): string[] {
  const forms = new Set(base64Forms(value));
  const uriEncoded = encodeURIComponent(value);
  if (uriEncoded !== value) forms.add(uriEncoded);
  forms.delete(value);
  forms.delete("");
  return [...forms];
}

/** Register a stored secret value, plus its encoded forms, with the scrubber. */
export function registerStoredSecret(value: string | null | undefined, name: string): void {
  if (!value) return;
  registerVolatileSecret(value, name);
  for (const form of encodedForms(value)) registerVolatileSecret(form, name);
}

export interface SecretRegistryLoadResult {
  config: number;
  oauth: number;
  scriptApi: number;
  /** Rows that could not be read or decrypted (wrong or missing key). */
  failed: number;
}

/**
 * Register every stored secret. Called once at API boot, before the boot
 * retro-sweep. A row that fails to decrypt is counted and skipped; a source
 * that fails as a whole (e.g. no encryption key resolved) is counted as one
 * failure and the other sources still load.
 */
export async function loadSecretRegistry(): Promise<SecretRegistryLoadResult> {
  const result: SecretRegistryLoadResult = { config: 0, oauth: 0, scriptApi: 0, failed: 0 };

  try {
    const { secrets, failed } = await listStoredConfigSecrets();
    for (const { key, value } of secrets) registerStoredSecret(value, configSecretName(key));
    result.config = secrets.length;
    result.failed += failed;
  } catch {
    result.failed += 1;
  }

  try {
    const { secrets, failed } = await listStoredOAuthSecrets();
    for (const { provider, kind, value } of secrets) {
      registerStoredSecret(value, oauthSecretName(provider, kind));
    }
    result.oauth = secrets.length;
    result.failed += failed;
  } catch {
    result.failed += 1;
  }

  try {
    const { secrets, failed } = await listStoredScriptApiSecrets();
    for (const { id, token } of secrets) registerStoredSecret(token, scriptApiSecretName(id));
    result.scriptApi = secrets.length;
    result.failed += failed;
  } catch {
    result.failed += 1;
  }

  return result;
}
