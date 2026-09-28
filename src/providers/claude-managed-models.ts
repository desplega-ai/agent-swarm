/**
 * Anthropic-managed Claude model facts, read from the model catalog
 * (model-catalog phase 4). Rates are USD per million tokens (Mtok).
 *
 * There is no hand-maintained model list or price table any more: both come
 * from the runtime catalog (`src/utils/runtime-model-catalog.ts` — the API's
 * `model_catalog` + overlay rows, pulled over HTTP; the vendored models.dev
 * snapshot offline). A new Claude model is listed and priced as soon as it
 * lands in `model_catalog`, with no code change and no redeploy.
 *
 * The managed-agents API does NOT report dollar cost on the
 * `span.model_request_end` event — only token counts. The adapter computes
 * USD locally via {@link computeClaudeManagedCostUsd}, then folds in
 * Anthropic's $0.08/session-hour runtime fee. The API server recomputes the
 * canonical price against the pricing table.
 *
 * Cache nomenclature mapping:
 * - `cache_read_input_tokens`        → catalog `cache_read`
 * - `cache_creation_input_tokens`    → catalog `cache_write` (5-minute TTL)
 * - regular `input_tokens` (uncached) → catalog `input`
 */
import { harnessModelIds } from "@desplega/model-catalog";
import { runtimeCatalogModel, runtimeCatalogSection } from "../utils/runtime-model-catalog";

/** Managed-agents-selectable Claude models from the catalog, newest first. */
export function listClaudeManagedModels(): string[] {
  return harnessModelIds("claude-managed", runtimeCatalogSection("anthropic"));
}

export interface ClaudeManagedTokenPricing {
  /** USD per million uncached input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  /** USD per million tokens read from prompt cache. */
  cacheReadPerMillion: number;
  /** USD per million tokens written to prompt cache (5-minute TTL). */
  cacheWritePerMillion: number;
}

export type ClaudeManagedModelPricing = ClaudeManagedTokenPricing;

/**
 * Catalog pricing for a managed model. Dated ids fall back to their undated
 * family id. Missing cache rates follow Anthropic's published multipliers
 * (read = 0.1 × input, 5-minute write = 1.25 × input).
 */
export function getClaudeManagedModelPricing(model: string): ClaudeManagedModelPricing | undefined {
  const cost =
    runtimeCatalogModel("anthropic", model)?.cost ??
    runtimeCatalogModel("anthropic", model.replace(/-\d{8}$/, ""))?.cost;
  if (typeof cost?.input !== "number" || typeof cost.output !== "number") return undefined;
  return {
    inputPerMillion: cost.input,
    outputPerMillion: cost.output,
    cacheReadPerMillion: typeof cost.cache_read === "number" ? cost.cache_read : cost.input * 0.1,
    cacheWritePerMillion:
      typeof cost.cache_write === "number" ? cost.cache_write : cost.input * 1.25,
  };
}

/** One warning per model per process for unpriced models. */
const warnedUnknownModels = new Set<string>();

/**
 * Compute USD cost for one Claude managed-agents session, given the SDK's
 * accumulated token counts.
 *
 * Returns `0` (with a deduplicated `console.warn`) for models the catalog does
 * not price — we'd rather under-report than make up a number on a typo.
 *
 * Note: the runtime $0.08/session-hour fee is NOT folded in here; the adapter
 * computes it from the session's wallclock.
 */
export function computeClaudeManagedCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const pricing = getClaudeManagedModelPricing(model);
  if (!pricing) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(
        `[claude-managed-models] Unpriced model "${model}" — returning $0 cost. ` +
          "Add it to the model catalog (refresh or overlay row).",
      );
    }
    return 0;
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
