/**
 * Codex API-addressable models, verified from https://developers.openai.com/api/docs/models
 * and https://developers.openai.com/api/docs/deprecations as of 2026-07-10.
 *
 * NOTE: `gpt-5.3-codex-spark` is intentionally excluded. It is a ChatGPT Pro
 * research preview and is NOT API-addressable via the Codex SDK at launch.
 * Including it here would cause runtime errors if selected via MODEL_OVERRIDE.
 *
 * Bump this file when the CLI / SDK adds new models. Kept separate from the
 * adapter so the onboarding UI and model selector can import it without
 * pulling in the SDK.
 */
import modelsDevCache from "../be/modelsdev-cache.json";

/**
 * List of Codex models we know about (drives the onboarding model selector,
 * the pricing table, and the context-window map). The resolver does NOT
 * constrain inputs to this list — it passes unknown strings through to the
 * SDK, so new OpenAI models work without a code change.
 */
export const CODEX_MODELS = [
  "gpt-5.6-sol", // frontier GPT-5.6 tier for complex reasoning/coding
  "gpt-5.6-terra", // balanced GPT-5.6 tier
  "gpt-5.6-luna", // fast/cheap GPT-5.6 tier for high-volume workloads
  "gpt-5.5", // previous frontier coding/professional-work model
  "gpt-5.4", // previous mainline reasoning model w/ frontier coding
  "gpt-5.4-mini", // faster/cheaper
  "gpt-5.3-codex", // coding-specialized legacy model
  "gpt-5.2-codex", // legacy — scheduled for retirement, see openai deprecations page
] as const;

export type CodexModel = (typeof CODEX_MODELS)[number];

/** The baseline default when neither MODEL_OVERRIDE nor task.model is set. */
export const CODEX_DEFAULT_MODEL: CodexModel = "gpt-5.6-terra";

/**
 * Map claude-style shortnames (that flow through MODEL_OVERRIDE / task.model)
 * to Codex equivalents. Mirrors `pi-mono-adapter.ts:71-75` shortnames map so
 * a task authored for Claude works unchanged when pointed at a Codex worker.
 */
const CLAUDE_SHORTNAMES: Record<string, CodexModel> = {
  fable: "gpt-5.6-sol",
  opus: "gpt-5.6-sol",
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
};

/**
 * Resolve a model string (shortname or full Codex model id) into the literal
 * id we hand to the Codex SDK. Behavior:
 *   - empty/undefined → `CODEX_DEFAULT_MODEL`
 *   - claude shortname (opus/sonnet/haiku) → mapped Codex id
 *   - anything else → passthrough (lowercased), so new OpenAI models work
 *     without a code change. The SDK is the source of truth for validity.
 */
export function resolveCodexModel(modelStr: string | undefined): string {
  if (!modelStr) return CODEX_DEFAULT_MODEL;
  const normalized = modelStr.toLowerCase();
  return CLAUDE_SHORTNAMES[normalized] ?? normalized;
}

interface ModelsDevOpenAiModel {
  limit?: {
    context?: number;
  };
  cost?: {
    input?: number;
    cache_read?: number;
    output?: number;
  };
}

const MODELSDEV_OPENAI_MODELS =
  (
    modelsDevCache as {
      openai?: {
        models?: Record<string, ModelsDevOpenAiModel>;
      };
    }
  ).openai?.models ?? {};

const FALLBACK_CODEX_MODEL_CONTEXT_WINDOWS: Record<CodexModel, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.2-codex": 200_000,
};

/**
 * Per-model approximate context window (tokens). The Codex SDK does not
 * expose these at runtime, so we read the vendored models.dev cache used by
 * the pricing seeder and fall back only for legacy/incomplete cache entries.
 * The values are used by the `context_usage` percent calculation inside
 * `CodexSession`.
 */
export const CODEX_MODEL_CONTEXT_WINDOWS: Record<CodexModel, number> = Object.fromEntries(
  CODEX_MODELS.map((model) => [
    model,
    MODELSDEV_OPENAI_MODELS[model]?.limit?.context ?? FALLBACK_CODEX_MODEL_CONTEXT_WINDOWS[model],
  ]),
) as Record<CodexModel, number>;

/**
 * Return the context window in tokens for a given Codex model. Unknown models
 * (passthrough strings) get the 200k default — keeps `context_usage` finite
 * even on a model id we haven't catalogued yet.
 */
export function getCodexContextWindow(model: string): number {
  return CODEX_MODEL_CONTEXT_WINDOWS[model as CodexModel] ?? 200_000;
}

/**
 * Per-model pricing in USD per million tokens, sourced from the vendored
 * models.dev cache (`src/be/modelsdev-cache.json`). The fallback below mirrors
 * that snapshot for known models and covers legacy models that models.dev no
 * longer lists.
 *
 * The Codex SDK does NOT report dollar cost in `Usage`, so this map is what
 * powers `totalCostUsd` on the `result` event. Refresh models.dev whenever
 * OpenAI changes pricing or adds new models.
 *
 * `gpt-5.2-codex` is not on the current pricing page (legacy / retired); it
 * inherits the `gpt-5.3-codex` rate as a best-effort fallback so old tasks
 * pinned to it still report a non-zero cost instead of silently $0.
 */
export interface CodexModelPricing {
  /** USD per million input tokens (uncached). */
  inputPerMillion: number;
  /** USD per million cached input tokens (typically ~10% of input). */
  cachedInputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
}

const FALLBACK_CODEX_MODEL_PRICING: Record<CodexModel, CodexModelPricing> = {
  "gpt-5.6-sol": {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30.0,
  },
  "gpt-5.6-terra": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15.0,
  },
  "gpt-5.6-luna": {
    inputPerMillion: 1.0,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6.0,
  },
  "gpt-5.5": {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30.0,
  },
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15.0,
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
  },
  "gpt-5.3-codex": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14.0,
  },
  // Legacy — not on the current pricing page; inherit from gpt-5.3-codex.
  "gpt-5.2-codex": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14.0,
  },
};

function getModelsDevCodexPricing(model: CodexModel): CodexModelPricing | undefined {
  const cost = MODELSDEV_OPENAI_MODELS[model]?.cost;
  if (
    typeof cost?.input !== "number" ||
    typeof cost.cache_read !== "number" ||
    typeof cost.output !== "number"
  ) {
    return undefined;
  }
  return {
    inputPerMillion: cost.input,
    cachedInputPerMillion: cost.cache_read,
    outputPerMillion: cost.output,
  };
}

export const CODEX_MODEL_PRICING: Record<CodexModel, CodexModelPricing> = Object.fromEntries(
  CODEX_MODELS.map((model) => [
    model,
    getModelsDevCodexPricing(model) ?? FALLBACK_CODEX_MODEL_PRICING[model],
  ]),
) as Record<CodexModel, CodexModelPricing>;

/**
 * Phase 6 — one-warning-per-process tracking so unknown models log once
 * instead of spamming the worker log on every turn.
 */
const _warnedUnknownCodexModels = new Set<string>();

/**
 * Compute USD cost from a Codex `Usage` payload. The Codex SDK reports
 * `input_tokens` as the TOTAL input fed to the model across the turn (cached
 * + uncached), so we subtract `cached_input_tokens` before billing the
 * uncached portion at the full rate.
 *
 * Phase 6: returns 0 for unknown models AND logs a one-time warning, so an
 * operator running `MODEL_OVERRIDE=gpt-future-2027` notices that the worker
 * is silently dropping cost. The server-side recompute path (Phase 2) tags
 * such rows `costSource='unpriced'`, which surfaces as a yellow UI badge.
 */
export function computeCodexCostUsd(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const pricing = CODEX_MODEL_PRICING[model as CodexModel];
  if (!pricing) {
    if (!_warnedUnknownCodexModels.has(model)) {
      _warnedUnknownCodexModels.add(model);
      console.warn(
        `[codex] unpriced model ${JSON.stringify(model)} — adapter cost will report $0; ` +
          "server-side recompute will tag costSource='unpriced' if the pricing table has no rows.",
      );
    }
    return 0;
  }
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const inputCost = (uncachedInput / 1_000_000) * pricing.inputPerMillion;
  const cachedCost = (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + cachedCost + outputCost;
}
