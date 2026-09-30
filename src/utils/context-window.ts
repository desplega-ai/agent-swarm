/**
 * Context window size lookup and usage computation utilities.
 *
 * This module is safe for both API and worker code — it has NO database imports.
 *
 * Phase 4 + Phase 9 of the cost-tracking plan:
 *   - Model-catalog phase 4: windows come from the model catalog (no
 *     per-model table). A new model gets the right window as soon as it
 *     lands in `model_catalog`.
 *   - `getContextWindowSize` resolves shortnames, family-versioned ids
 *     (`claude-sonnet-4-6`), AND dated full ids (`claude-sonnet-4-6-20251004`)
 *     by stripping the trailing date suffix. Previously the dated form fell
 *     to the 200k default — wildly wrong for sonnet/opus 4.x.
 *   - `computeContextUsedUnified` is the canonical formula every adapter
 *     should use when emitting a `context_usage` event:
 *       contextUsedTokens = input + cache_read + cache_create + output
 *     The matching `CONTEXT_FORMULA` constant is what adapters stamp onto
 *     the snapshot's `contextFormula` field.
 *   - The legacy `computeContextUsed` stays for back-compat reads but is
 *     deprecated; new code should use `computeContextUsedUnified`.
 */

import { buildClaudeShortnameMap } from "@desplega/model-catalog";
import { runtimeCatalogModel, runtimeCatalogSection } from "./runtime-model-catalog";

/**
 * Phase 9: stamp this onto every `context_usage` event the adapter emits.
 * Callers that compute their own number for legacy reasons (e.g. pi-mono
 * delegates to the pi-ai SDK) use a different value — see `ContextFormula`
 * in `src/types.ts`.
 */
export const CONTEXT_FORMULA = "input-cache-output" as const;

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Strip a trailing date suffix from a Claude model id so dated full ids
 * resolve to the same window as the family-versioned id.
 *
 * `claude-sonnet-4-6-20251004` → `claude-sonnet-4-6`
 */
function stripAnthropicDateSuffix(model: string): string {
  return model.replace(/-(\d{8})$/, "");
}

let shortnameMap: { section: Record<string, unknown>; map: Record<string, string> } | null = null;

/** Claude CLI shortnames (`opus`, `sonnet`, ...) → newest catalog id. */
function resolveClaudeShortname(model: string): string | undefined {
  const section = runtimeCatalogSection("anthropic");
  if (!shortnameMap || shortnameMap.section !== section) {
    shortnameMap = { section, map: buildClaudeShortnameMap(section) };
  }
  return shortnameMap.map[model.trim().toLowerCase()];
}

function catalogContext(provider: string, model: string): number | undefined {
  const context = runtimeCatalogModel(provider, model)?.limit?.context;
  return typeof context === "number" && context > 0 ? context : undefined;
}

/**
 * Context window (tokens) for a model id, read from the model catalog
 * (`src/utils/runtime-model-catalog.ts`: live `model_catalog` + overlay,
 * vendored models.dev snapshot offline). Accepts Anthropic ids (dated or
 * not), Claude CLI shortnames, OpenAI/Codex ids and `provider/model` ids.
 * Unknown models get a conservative 200k so percent math stays finite.
 */
export function getContextWindowSize(model: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const slash = model.indexOf("/");
  if (slash > 0) {
    const scoped = catalogContext(model.slice(0, slash), model.slice(slash + 1));
    if (scoped) return scoped;
  }
  for (const provider of ["anthropic", "openai"]) {
    const exact = catalogContext(provider, model);
    if (exact) return exact;
  }
  const stripped = stripAnthropicDateSuffix(model);
  if (stripped !== model) {
    const dated = catalogContext("anthropic", stripped);
    if (dated) return dated;
  }
  const shortname = resolveClaudeShortname(model);
  if (shortname) {
    const resolved = catalogContext("anthropic", shortname);
    if (resolved) return resolved;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Compute the total context tokens used from a Claude API usage object.
 * Sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
 *
 * @deprecated Phase 9 — use {@link computeContextUsedUnified} instead. This
 * variant excludes output tokens, which is the wrong number when the goal is
 * "how full is the model's context window right now."
 */
export function computeContextUsed(usage: {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

/**
 * Phase 9: the unified context-used formula adapters should use when emitting
 * `context_usage` events. Sums input + cache_read + cache_create + output,
 * which is the number the Claude Code status line shows. Cross-provider
 * comparisons (claude vs codex vs pi) are only meaningful when every adapter
 * agrees on this formula.
 *
 * Returns 0 if every field is missing; callers should check the `contextTotal`
 * separately and emit `null` for `contextPercent` when the window is unknown.
 */
export function computeContextUsedUnified(parts: {
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreateTokens?: number | null;
  outputTokens?: number | null;
}): number {
  return (
    (parts.inputTokens ?? 0) +
    (parts.cacheReadTokens ?? 0) +
    (parts.cacheCreateTokens ?? 0) +
    (parts.outputTokens ?? 0)
  );
}

/**
 * Phase 9: clamp a raw context-percent value to [0, 100]. Returns null when
 * `total` is missing or 0 so callers can show "unknown" instead of a
 * divide-by-zero NaN/∞.
 */
export function clampContextPercent(used: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  const raw = (used / total) * 100;
  if (!Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, raw));
}
