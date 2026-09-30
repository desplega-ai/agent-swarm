/**
 * Codex model facts, read from the model catalog (model-catalog phase 4).
 *
 * There is no hand-maintained Codex allowlist, context-window table or price
 * table any more: every lookup reads the runtime catalog
 * (`src/utils/runtime-model-catalog.ts` — the API's `model_catalog` + overlay
 * rows, pulled over HTTP; the vendored models.dev snapshot offline). A new
 * OpenAI model is therefore listed, windowed and priced as soon as it lands
 * in `model_catalog`, with no code change and no redeploy.
 *
 * Which OpenAI SKUs count as Codex-drivable is a rule, not a list:
 * `isHarnessCatalogModel("codex", ...)` in `@desplega/model-catalog`.
 *
 * Kept separate from the adapter so the onboarding UI and model selector can
 * import it without pulling in the SDK.
 */
import { harnessModelIds } from "@desplega/model-catalog";
import { DEFAULT_MODEL_TIER_MAP } from "../types";
import { runtimeCatalogModel, runtimeCatalogSection } from "../utils/runtime-model-catalog";

/** Codex models from the catalog, newest first. Drives selectors and pricing tests. */
export function listCodexModels(): string[] {
  return harnessModelIds("codex", runtimeCatalogSection("openai"));
}

/**
 * The baseline default when neither MODEL_OVERRIDE nor task.model is set:
 * the codex `regular` tier default (operators move it with
 * `MODEL_TIER_CODEX_REGULAR`, resolved server-side at claim time).
 */
export const CODEX_DEFAULT_MODEL: string = DEFAULT_MODEL_TIER_MAP.codex.regular;

/**
 * Claude-style shortnames (that flow through MODEL_OVERRIDE / task.model)
 * map to the codex tier with the same intent, so a task authored for Claude
 * works unchanged when pointed at a Codex worker.
 */
const CLAUDE_SHORTNAME_TIER = {
  fable: "ultra",
  opus: "smart",
  sonnet: "regular",
  haiku: "smol",
} as const;

/**
 * Resolve a model string (shortname or full Codex model id) into the literal
 * id we hand to the Codex SDK. Behavior:
 *   - empty/undefined → `CODEX_DEFAULT_MODEL`
 *   - claude shortname (opus/sonnet/haiku/fable) → codex tier default
 *   - anything else → passthrough (lowercased), so new OpenAI models work
 *     without a code change. The SDK is the source of truth for validity.
 */
export function resolveCodexModel(modelStr: string | undefined): string {
  if (!modelStr) return CODEX_DEFAULT_MODEL;
  const normalized = modelStr.toLowerCase();
  const tier = CLAUDE_SHORTNAME_TIER[normalized as keyof typeof CLAUDE_SHORTNAME_TIER];
  return tier ? DEFAULT_MODEL_TIER_MAP.codex[tier] : normalized;
}

const UNKNOWN_CONTEXT_WINDOW = 200_000;

/**
 * Context window in tokens for a Codex model, from the catalog. Unknown
 * models (passthrough strings) get 200k — keeps `context_usage` finite.
 */
export function getCodexContextWindow(model: string): number {
  const context = runtimeCatalogModel("openai", model)?.limit?.context;
  return typeof context === "number" && context > 0 ? context : UNKNOWN_CONTEXT_WINDOW;
}

export interface CodexModelPricing {
  /** USD per million input tokens (uncached). */
  inputPerMillion: number;
  /** USD per million cached input tokens (typically ~10% of input). */
  cachedInputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
}

/**
 * Per-model pricing from the catalog (USD per million tokens). Advisory only:
 * the canonical price is the API server's recompute against the pricing
 * table (`agentswarm.cost.drift.usd` watches the divergence). A catalog row
 * without a cache-read price bills cached input at 10% of input, OpenAI's
 * standard discount.
 */
export function getCodexModelPricing(model: string): CodexModelPricing | undefined {
  const cost = runtimeCatalogModel("openai", model)?.cost;
  if (typeof cost?.input !== "number" || typeof cost.output !== "number") return undefined;
  return {
    inputPerMillion: cost.input,
    cachedInputPerMillion: typeof cost.cache_read === "number" ? cost.cache_read : cost.input / 10,
    outputPerMillion: cost.output,
  };
}

/** Priced Codex models, keyed by id (every `listCodexModels()` entry the catalog prices). */
export function codexModelPricingTable(): Record<string, CodexModelPricing> {
  const table: Record<string, CodexModelPricing> = {};
  for (const model of listCodexModels()) {
    const pricing = getCodexModelPricing(model);
    if (pricing) table[model] = pricing;
  }
  return table;
}

/** One warning per model per process, so unpriced models don't spam the log. */
const _warnedUnknownCodexModels = new Set<string>();

/**
 * Compute USD cost from a Codex `Usage` payload. The Codex SDK reports
 * `input_tokens` as the TOTAL input fed to the model across the turn (cached
 * + uncached), so we subtract `cached_input_tokens` before billing the
 * uncached portion at the full rate.
 *
 * Returns 0 for models the catalog does not price AND logs a one-time
 * warning. The server-side recompute tags such rows `costSource='unpriced'`,
 * which surfaces as a yellow UI badge.
 */
export function computeCodexCostUsd(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const pricing = getCodexModelPricing(model);
  if (!pricing) {
    if (!_warnedUnknownCodexModels.has(model)) {
      _warnedUnknownCodexModels.add(model);
      console.warn(
        `[codex] unpriced model ${JSON.stringify(model)} — adapter cost will report $0; ` +
          "add it to the model catalog (refresh or overlay row). Server-side recompute will tag costSource='unpriced' if the pricing table has no rows.",
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
