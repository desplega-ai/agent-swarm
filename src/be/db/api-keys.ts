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
