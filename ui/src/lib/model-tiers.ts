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
