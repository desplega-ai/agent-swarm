import type { ModelTier, ModelTierPreview } from "@/api/types";

/**
 * Model tier rows as `GET /api/models-catalog/tiers` returns them, for tests.
 * The defaults mirror `DEFAULT_MODEL_TIER_MAP` in `src/types.ts` (the shipped
 * tier config): a test that retunes a tier passes its own values.
 */
export const DEFAULT_TIER_VALUES: Record<string, Record<ModelTier, string>> = {
  claude: { smol: "haiku", regular: "sonnet", smart: "opus", ultra: "fable" },
  codex: {
    smol: "gpt-5.6-luna",
    regular: "gpt-5.6-terra",
    smart: "gpt-5.6-sol",
    ultra: "gpt-5.6-sol",
  },
  pi: {
    smol: "openrouter/deepseek/deepseek-v4.1-flash",
    regular: "openrouter/deepseek/deepseek-v4.1-flash",
    smart: "openrouter/deepseek/deepseek-v4-pro-0813",
    ultra: "openrouter/anthropic/claude-opus-5.5",
  },
  opencode: {
    smol: "openrouter/deepseek/deepseek-v4.1-flash",
    regular: "openrouter/deepseek/deepseek-v4.1-flash",
    smart: "openrouter/deepseek/deepseek-v4-pro-0813",
    ultra: "openrouter/anthropic/claude-opus-5.5",
  },
  dsh: {
    smol: "openrouter/deepseek/deepseek-v4.1-flash",
    regular: "openrouter/deepseek/deepseek-v4.1-flash",
    smart: "openrouter/deepseek/deepseek-v4-pro-0813",
    ultra: "openrouter/anthropic/claude-opus-5.5",
  },
  devin: { smol: "devin", regular: "devin", smart: "devin", ultra: "devin" },
  amp: { smol: "low", regular: "medium", smart: "high", ultra: "ultra" },
};

const TIERS: ModelTier[] = ["smol", "regular", "smart", "ultra"];

/**
 * Tier rows for `values` (a provider to tier map, the shipped defaults when
 * omitted), each resolved to its value. `override` retunes single tiers:
 * `{ "codex:smart": "gpt-9" }` reads like `MODEL_TIER_CODEX_SMART=gpt-9`.
 */
export function tierRows(
  override: Record<string, string> = {},
  values: Record<string, Record<ModelTier, string>> = DEFAULT_TIER_VALUES,
): ModelTierPreview[] {
  return Object.entries(values).flatMap(([provider, byTier]) =>
    TIERS.map((tier) => {
      const configured = override[`${provider}:${tier}`] ?? null;
      const value = configured ?? byTier[tier];
      return {
        provider,
        tier,
        key: `MODEL_TIER_${provider.toUpperCase().replace(/-/g, "_")}_${tier.toUpperCase()}`,
        defaultValue: byTier[tier],
        configured,
        source: configured ? "tier-config" : "tier-default",
        resolvedModel: value,
        alias: null,
      } satisfies ModelTierPreview;
    }),
  );
}
