import { deriveProviderFromKeyType } from "../../utils/credentials";
import type { ModelFamily } from "../../utils/model-rate-limit-windows";
import { planAllowsModelFamily } from "../../utils/subscription-plans";
import { getStorage } from "../storage";

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
  const storage = getStorage();
  const keys = storage.repos.config;
  const ref = { keyType, keySuffix, scope, scopeId: effectiveScopeId };
  return storage.transaction(async () => {
    await keys.touchKey(ref, keyIndex, provider, now);
    await keys.setSeatMismatch(keyType, keySuffix, model, now);

    let planChanged = false;
    if (
      keyType === "CLAUDE_CODE_OAUTH_TOKEN" &&
      !planAllowsModelFamily("claude_team_standard", model)
    ) {
      planChanged =
        (await keys.setDetectedPlanUnlessManual(keyType, keySuffix, "claude_team_standard")) > 0;
    }

    if (!planChanged) {
      const storedPlan = await keys.getKeyPlan(ref);
      if (planAllowsModelFamily(storedPlan, model)) {
        console.warn(
          `[api-keys] seat mismatch: key ...${keySuffix} (${keyType}) has plan ${storedPlan ?? "none"} but cannot run ${model}`,
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
  const storage = getStorage();
  const statuses = storage.repos.config;
  await storage.transaction(async () => {
    const now = new Date().toISOString();
    for (const key of keys) {
      // Only 401 means the key is bad. A 403 on a list endpoint can be a valid
      // key without that scope (an OpenAI restricted key, a gateway virtual key).
      if (!key.ok && key.httpStatus !== 401) continue;
      await statuses.upsertValidation(
        { keyType, keySuffix: key.keySuffix, scope, scopeId: effectiveScopeId },
        {
          keyIndex: key.keyIndex,
          error: key.ok ? null : `HTTP ${key.httpStatus}`,
          failedAt: key.ok ? null : now,
          provider,
          now,
        },
      );
      // A passing test clears the key's rejection in every scope, since the
      // suffix read in `getAvailableKeyIndices` matches them all.
      if (key.ok) await statuses.clearValidation(keyType, key.keySuffix, now);
    }
    if (options.retireAbsent === false) return;
    await statuses.clearValidationExcept(
      keyType,
      scope,
      effectiveScopeId,
      keys.map((key) => key.keySuffix),
      now,
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
  const storage = getStorage();
  const statuses = storage.repos.config;
  await storage.transaction(async () => {
    if (!remaining.some((key) => key.keySuffix === removedSuffix)) {
      await statuses.deleteGlobalKey(keyType, removedSuffix);
    }
    for (const key of remaining) {
      await statuses.setGlobalKeyIndex(keyType, key.keySuffix, key.keyIndex);
    }
  });
}
