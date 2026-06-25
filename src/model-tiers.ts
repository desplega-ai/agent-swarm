import { z } from "zod";
import type { ProviderName } from "./types";

export const ModelTierSchema = z.enum(["smol", "regular", "smart", "ultra"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const MODEL_TIERS = ModelTierSchema.options;

export const LEGACY_MODEL_TO_TIER: Record<string, ModelTier> = {
  haiku: "smol",
  sonnet: "regular",
  opus: "smart",
  fable: "ultra",
};

export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  smol: "Smol",
  regular: "Regular",
  smart: "Smart",
  ultra: "Ultra",
};

export const DEFAULT_MODEL_TIER_MAP: Record<ProviderName, Record<ModelTier, string>> = {
  claude: {
    smol: "haiku",
    regular: "sonnet",
    smart: "opus",
    ultra: "fable",
  },
  "claude-managed": {
    smol: "claude-haiku-4-5",
    regular: "claude-sonnet-4-6",
    smart: "claude-opus-4-8",
    ultra: "claude-fable-5",
  },
  codex: {
    smol: "gpt-5.4-mini",
    regular: "gpt-5.4",
    smart: "gpt-5.5",
    ultra: "gpt-5.5",
  },
  pi: {
    smol: "openrouter/deepseek/deepseek-v4-flash",
    regular: "openrouter/deepseek/deepseek-v4-flash",
    smart: "openrouter/deepseek/deepseek-v4-pro",
    ultra: "openrouter/anthropic/claude-opus-4.8",
  },
  opencode: {
    smol: "openrouter/deepseek/deepseek-v4-flash",
    regular: "openrouter/deepseek/deepseek-v4-flash",
    smart: "openrouter/deepseek/deepseek-v4-pro",
    ultra: "openrouter/anthropic/claude-opus-4.8",
  },
  "ai-sdk-agent": {
    smol: "gpt-5.4-mini",
    regular: "gpt-5.4",
    smart: "gpt-5.5",
    ultra: "gpt-5.5",
  },
  devin: {
    smol: "devin",
    regular: "devin",
    smart: "devin",
    ultra: "devin",
  },
};

export function parseModelTier(value: string | null | undefined): ModelTier | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return ModelTierSchema.safeParse(normalized).success
    ? (normalized as ModelTier)
    : LEGACY_MODEL_TO_TIER[normalized];
}

export function splitLegacyModelAlias(input: {
  model?: string | null;
  modelTier?: string | null;
}): { model?: string; modelTier?: ModelTier } {
  const explicitTier = parseModelTier(input.modelTier);
  const model = input.model?.trim();
  if (!model) return { modelTier: explicitTier };

  const legacyTier = parseModelTier(model);
  if (legacyTier && !explicitTier) {
    return { modelTier: legacyTier };
  }

  return {
    model,
    modelTier: explicitTier,
  };
}

function parseTierMapJson(value: string | undefined): Partial<Record<ModelTier, string>> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Partial<Record<ModelTier, string>> = {};
    for (const tier of MODEL_TIERS) {
      const model = (parsed as Record<string, unknown>)[tier];
      if (typeof model === "string" && model.trim()) result[tier] = model.trim();
    }
    return result;
  } catch {
    return {};
  }
}

export function resolveModelTier(opts: {
  tier?: string | null;
  harnessProvider: ProviderName;
  env?: Record<string, string | undefined>;
}): string | undefined {
  const tier = parseModelTier(opts.tier);
  if (!tier) return undefined;

  const env = opts.env ?? {};
  const jsonOverrides = parseTierMapJson(env.MODEL_TIER_MAP);
  const envKey = `MODEL_TIER_${tier.toUpperCase()}`;
  const directOverride = env[envKey]?.trim();
  if (directOverride) return directOverride;
  if (jsonOverrides[tier]) return jsonOverrides[tier];

  return DEFAULT_MODEL_TIER_MAP[opts.harnessProvider]?.[tier];
}

export function resolveTaskModelSelection(opts: {
  model?: string | null;
  modelTier?: string | null;
  harnessProvider: ProviderName;
  env?: Record<string, string | undefined>;
}): { model?: string; source: "model" | "modelTier" | "none" } {
  const model = opts.model?.trim();
  if (model) return { model, source: "model" };

  const tierModel = resolveModelTier({
    tier: opts.modelTier,
    harnessProvider: opts.harnessProvider,
    env: opts.env,
  });
  if (tierModel) return { model: tierModel, source: "modelTier" };

  return { source: "none" };
}
