import { deriveProviderFromKeyType } from "../../utils/credentials";
import type { ModelFamily } from "../../utils/model-rate-limit-windows";
import { planAllowsModelFamily } from "../../utils/subscription-plans";
import { getDbClient } from "./runtime";

/**
 * Records a `credits_required` rejection: the key's seat cannot run `model`.
 * Sets `lastSeatMismatchAt` / `lastSeatMismatchModel` on every scope row of
 * the key. A Claude key whose plan the operator did not pick gets
 * `claude_team_standard` / `detected`, the only plan that excludes Fable,
 * but only when that plan excludes `model`: an Opus or Sonnet rejection is
 * no evidence of a standard seat. A `manual` plan is never changed; a
 * contradiction is logged instead. The key `status` is not touched.
 */
export async function recordKeySeatMismatch(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  model: ModelFamily,
  scope = "global",
  scopeId: string | null = null,
): Promise<{ planChanged: boolean }> {
  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  return getDbClient().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId, provider, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(keyType, keySuffix, scope, scopeId)
         DO UPDATE SET
           keyIndex = excluded.keyIndex,
           provider = excluded.provider,
           updatedAt = excluded.updatedAt`,
      [keyType, keySuffix, keyIndex, scope, effectiveScopeId, provider, now],
    );
    await tx.run(
      `UPDATE api_key_status SET lastSeatMismatchAt = ?, lastSeatMismatchModel = ?
         WHERE keyType = ? AND keySuffix = ?`,
      [now, model, keyType, keySuffix],
    );

    let planChanged = false;
    if (
      keyType === "CLAUDE_CODE_OAUTH_TOKEN" &&
      !planAllowsModelFamily("claude_team_standard", model)
    ) {
      const result = await tx.run(
        `UPDATE api_key_status SET plan = 'claude_team_standard', planSource = 'detected'
           WHERE keyType = ? AND keySuffix = ? AND COALESCE(planSource, '') != 'manual'`,
        [keyType, keySuffix],
      );
      planChanged = result.changes > 0;
    }

    if (!planChanged) {
      const stored = await tx.get<{ plan: string | null }>(
        `SELECT plan FROM api_key_status
           WHERE keyType = ? AND keySuffix = ? AND scope = ? AND scopeId = ?`,
        [keyType, keySuffix, scope, effectiveScopeId],
      );
      if (planAllowsModelFamily(stored?.plan, model)) {
        console.warn(
          `[api-keys] seat mismatch: key ...${keySuffix} (${keyType}) has plan ${stored?.plan ?? "none"} but cannot run ${model}`,
        );
      }
    }
    return { planChanged };
  });
}

/** Store definitive live-test results and retire rejections for removed pool members. */
export async function recordKeyValidation(
  keyType: string,
  keys: Array<{
    keyIndex: number;
    keySuffix: string;
    ok: boolean;
    httpStatus?: number;
    error?: string;
  }>,
  scope = "global",
  scopeId: string | null = null,
  options: { retireAbsent?: boolean } = {},
): Promise<void> {
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  await getDbClient().transaction(async (tx) => {
    const now = new Date().toISOString();
    for (const key of keys) {
      // Only 401 means the key is bad. A 403 on a list endpoint can be a valid
      // key without that scope (an OpenAI restricted key, a gateway virtual key).
      if (!key.ok && key.httpStatus !== 401) continue;
      await tx.run(
        `INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId, lastValidationError, lastValidationFailedAt, provider, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(keyType, keySuffix, scope, scopeId)
         DO UPDATE SET lastValidationError = excluded.lastValidationError,
           lastValidationFailedAt = excluded.lastValidationFailedAt,
           keyIndex = excluded.keyIndex, updatedAt = excluded.updatedAt`,
        [
          keyType,
          key.keySuffix,
          key.keyIndex,
          scope,
          effectiveScopeId,
          key.ok ? null : `HTTP ${key.httpStatus}`,
          key.ok ? null : now,
          provider,
          now,
        ],
      );
      // A passing test clears the key's rejection in every scope, since the
      // suffix read in `getAvailableKeyIndices` matches them all.
      if (key.ok) {
        await tx.run(
          `UPDATE api_key_status SET lastValidationError = NULL, lastValidationFailedAt = NULL, updatedAt = ?
           WHERE keyType = ? AND keySuffix = ? AND lastValidationFailedAt IS NOT NULL`,
          [now, keyType, key.keySuffix],
        );
      }
    }
    if (options.retireAbsent === false) return;
    const placeholders = keys.map(() => "?").join(", ");
    await tx.run(
      `UPDATE api_key_status SET lastValidationError = NULL, lastValidationFailedAt = NULL, updatedAt = ?
       WHERE keyType = ? AND scope = ? AND scopeId = ?
         ${keys.length ? `AND keySuffix NOT IN (${placeholders})` : ""}
         AND lastValidationFailedAt IS NOT NULL`,
      [now, keyType, scope, effectiveScopeId, ...keys.map((key) => key.keySuffix)],
    );
  });
}

/**
 * Forget the status of a key that left its pool, and store the new index of
 * each remaining key. A new key that later takes the same index or Codex slot
 * then starts with no rejection, rate limit or auth bench.
 */
export async function retirePoolKeyStatus(
  keyType: string,
  removedSuffix: string,
  remaining: Array<{ keySuffix: string; keyIndex: number }>,
): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    if (!remaining.some((key) => key.keySuffix === removedSuffix)) {
      await tx.run(
        "DELETE FROM api_key_status WHERE keyType = ? AND keySuffix = ? AND scope = 'global' AND scopeId = ''",
        [keyType, removedSuffix],
      );
    }
    for (const key of remaining) {
      await tx.run(
        "UPDATE api_key_status SET keyIndex = ? WHERE keyType = ? AND keySuffix = ? AND scope = 'global' AND scopeId = ''",
        [key.keyIndex, keyType, key.keySuffix],
      );
    }
  });
}
