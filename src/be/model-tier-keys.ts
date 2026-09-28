/**
 * Pure helpers for the MODEL_TIER_<PROVIDER>_<TIER> swarm_config keys (no DB),
 * shared by the config validator and claim-time resolution.
 */
import { isAlias, parseAlias } from "@desplega/model-catalog";
import { MODEL_TIERS, type ModelTier, type ProviderName, ProviderNameSchema } from "../types";

/** `MODEL_TIER_<PROVIDER>_<TIER>`; provider dashes become underscores. */
export function tierConfigKey(provider: ProviderName, tier: ModelTier): string {
  return `MODEL_TIER_${provider.toUpperCase().replace(/-/g, "_")}_${tier.toUpperCase()}`;
}

const TIER_CONFIG_KEY_RE = new RegExp(
  `^MODEL_TIER_(${ProviderNameSchema.options
    .map((p) => p.toUpperCase().replace(/-/g, "_"))
    .join("|")})_(${MODEL_TIERS.map((t) => t.toUpperCase()).join("|")})$`,
);

export function isTierConfigKey(key: string): boolean {
  return TIER_CONFIG_KEY_RE.test(key.toUpperCase());
}

/** Validator for MODEL_TIER_<PROVIDER>_<TIER> values; null = ok. */
export function validateTierConfigValue(key: string, value: unknown): string | null {
  const message = `Invalid ${key} (expected a model id, a CLI alias such as "opus", or latest:<anthropic|openai|openrouter>/<target>[@stable|@any])`;
  if (typeof value !== "string") return message;
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed) || trimmed.length > 200) return message;
  if (isAlias(trimmed) && !parseAlias(trimmed)) return message;
  return null;
}
