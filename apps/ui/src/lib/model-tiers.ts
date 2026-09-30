import { isAlias } from "@desplega/model-catalog";
import type { ModelTierPreview } from "@/api/types";

export type ModelTier = "smol" | "regular" | "smart" | "ultra";

export const MODEL_TIER_OPTIONS: { value: ModelTier; label: string }[] = [
  { value: "smol", label: "Smol" },
  { value: "regular", label: "Regular" },
  { value: "smart", label: "Smart" },
  { value: "ultra", label: "Ultra" },
];

export function modelTierLabel(value: string | null | undefined): string {
  return MODEL_TIER_OPTIONS.find((option) => option.value === value)?.label ?? value ?? "";
}

/**
 * The model a Model Tier resolves to for one harness, from the tier rows
 * (`GET /api/models-catalog/tiers`): the row's resolved model, else the value of
 * the layer that wins. A `latest:` alias with nothing resolved yet has no model
 * to run, and a harness or tier without a row has none either: `null`.
 */
export function tierRowModel(
  tiers: readonly ModelTierPreview[] | null | undefined,
  provider: string | null | undefined,
  tier: string | null | undefined,
): string | null {
  const row = tiers?.find((r) => r.provider === provider && r.tier === tier);
  if (!row) return null;
  const value = (
    row.resolvedModel ?? (row.source === "tier-config" ? row.configured : row.defaultValue)
  )?.trim();
  return value && !isAlias(value) ? value : null;
}
