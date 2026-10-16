/**
 * Boot seed for the shipped model profiles: one `<harness>-<tier>` profile per
 * harness and tier, a 1:1 copy of `DEFAULT_MODEL_TIER_MAP` (runbooks/model-tiers.md
 * § Model profiles). A global `MODEL_TIER_<HARNESS>_<TIER>` row, when one exists,
 * overrides the seed's model at seeding time. Seeds use the harness default
 * route, no effort and no fallbacks.
 *
 * Idempotent: an existing name is never overwritten, so an operator's edit to a
 * seed survives every boot. Harnesses with no portable tier mapping (acp) get
 * no seeds.
 */
import { DEFAULT_MODEL_TIER_MAP, MODEL_TIERS, ProviderNameSchema } from "../types";
import { createModelProfile } from "./db/model-profiles";
import { getDbClient } from "./db/runtime";
import { tierConfigKey } from "./model-tier-keys";

export async function seedModelProfiles(): Promise<number> {
  let inserted = 0;
  for (const harness of ProviderNameSchema.options) {
    for (const tier of MODEL_TIERS) {
      const fallback = DEFAULT_MODEL_TIER_MAP[harness]?.[tier];
      if (!fallback) continue;
      const configured = await getDbClient().get<{ value: string }>(
        "SELECT value FROM swarm_config WHERE scope = 'global' AND scopeId IS NULL AND key = ? AND isSecret = 0",
        [tierConfigKey(harness, tier)],
      );
      const created = await createModelProfile({
        name: `${harness}-${tier}`,
        harness,
        model: configured?.value.trim() || fallback,
        effort: null,
        // Tier values are free-form today (a `latest:` alias, a gateway id); keep that.
        allowCustomModel: true,
        description: `The ${tier} tier on ${harness}, seeded from the tier map.`,
        seededFrom: `tier:${tier}`,
      });
      if (created) inserted++;
    }
  }
  return inserted;
}
