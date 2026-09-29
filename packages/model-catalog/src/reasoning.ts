/**
 * Which reasoning-effort levels a (harness, model) pair accepts, derived from
 * the catalog's `reasoning` / `reasoning_options` facts.
 *
 * One implementation for both sides: the API validates a stored effort with it
 * (`src/providers/reasoning-effort.ts`), the workers apply it, and the swarm
 * app offers exactly these levels in every effort picker. A new model's levels
 * arrive with its catalog row; nothing is listed per model here.
 *
 * Pure module: no IO, no Bun APIs.
 */
import { buildClaudeShortnameMap, type HarnessCatalogModel } from "./harness-models.ts";

/** Closed, normalized enum. `minimal` stays out of scope; GPT-5.6 Codex adds `max`. */
export const REASONING_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

/** The four local harnesses with an effort control (Devin, claude-managed, dsh and ACP have none). */
export const REASONING_HARNESSES = ["claude", "codex", "pi", "opencode"] as const;
export type ReasoningHarnessName = (typeof REASONING_HARNESSES)[number];

/** The catalog facts effort support reads (models.dev field names). */
export interface ReasoningModelFacts {
  reasoning?: boolean | null;
  reasoning_options?: { type?: string; values?: string[] }[] | null;
}

/** Shared-safe subset accepted by all four harnesses on at least their default models. */
const FALLBACK_LEVELS: ReasoningEffortLevel[] = ["low", "medium", "high"];

/** models.dev `reasoning_options[].type === "effort"` value → the normalized enum. `minimal` is dropped. */
const EFFORT_VALUE_MAP: Partial<Record<string, ReasoningEffortLevel>> = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function isReasoningHarness(harness: string): harness is ReasoningHarnessName {
  return (REASONING_HARNESSES as readonly string[]).includes(harness);
}

function levelsFromReasoningOptions(
  options: ReasoningModelFacts["reasoning_options"],
): ReasoningEffortLevel[] {
  const effortEntry = options?.find((o) => o.type === "effort");
  if (!effortEntry?.values?.length) return [];
  const mapped = new Set(
    effortEntry.values
      .map((v) => EFFORT_VALUE_MAP[v])
      .filter((v): v is ReasoningEffortLevel => v !== undefined),
  );
  // Canonical order, not whatever order models.dev lists them in.
  return REASONING_EFFORT_LEVELS.filter((level) => mapped.has(level));
}

/**
 * Harness quirks the catalog does not (fully) encode. Patches gaps, does not
 * duplicate the catalog.
 */
function applyHarnessOverrides(
  harness: ReasoningHarnessName,
  modelId: string,
  facts: ReasoningModelFacts,
  levels: ReasoningEffortLevel[],
): ReasoningEffortLevel[] {
  let result = levels;

  if (harness === "claude") {
    // Claude's native vocabulary has no "off". It is a synthetic level
    // (`MAX_THINKING_TOKENS=0`) that only exists on models that still expose a
    // numeric thinking budget (`budget_tokens`). Adaptive-only models (Opus
    // 4.7+) never get it, without naming any model.
    if (
      facts.reasoning_options?.some((o) => o.type === "budget_tokens") &&
      !result.includes("off")
    ) {
      result = ["off", ...result];
    }
  }

  if (harness !== "codex") {
    result = result.filter((l) => l !== "max");
  }

  if (harness === "codex") {
    // The catalog already tends to get this right per model. This is
    // defense-in-depth for `*-codex` ids missing from it (the fallback path),
    // where the name alone decides xhigh eligibility.
    const isCodexMax = /-codex-max$/.test(modelId);
    const isCodexNonMax = /-codex$/.test(modelId) && !isCodexMax;
    if (isCodexMax && !result.includes("xhigh")) result = [...result, "xhigh"];
    if (isCodexNonMax) result = result.filter((l) => l !== "xhigh");
  }

  return REASONING_EFFORT_LEVELS.filter((level) => result.includes(level));
}

/**
 * Effort levels `harness` accepts for a model with these catalog facts. Empty
 * when the model is unknown (`facts` undefined), not a reasoning model, or the
 * harness has no effort control.
 *
 *  1. No facts, or `reasoning: false` → none.
 *  2. A usable `type: "effort"` option → its values (`none` → `off`, `minimal` dropped).
 *  3. `reasoning: true` with no usable effort option → `low`, `medium`, `high`.
 *  4. Harness quirks on top.
 */
export function reasoningLevelsFor(
  harness: string,
  modelId: string,
  facts: ReasoningModelFacts | undefined | null,
): ReasoningEffortLevel[] {
  if (!isReasoningHarness(harness) || !facts || !facts.reasoning) return [];
  let levels = levelsFromReasoningOptions(facts.reasoning_options);
  if (levels.length === 0) levels = [...FALLBACK_LEVELS];
  return applyHarnessOverrides(harness, modelId, facts, levels);
}

/**
 * The catalog id a Claude CLI shortname (`opus`, `sonnet`, `haiku`, `fable`)
 * stands for: the newest non-deprecated model of that family in `models`. A
 * canonical id, or a name that is not a shortname, comes back unchanged. The
 * tier defaults name the CLI shortnames, so effort has to resolve them too.
 */
export function claudeCatalogModelId(
  modelId: string,
  models: Record<string, HarnessCatalogModel> | undefined,
): string {
  if (!modelId || models?.[modelId]) return modelId;
  return buildClaudeShortnameMap(models)[modelId] ?? modelId;
}

/**
 * The supported level nearest to `level` by canonical-order distance; on a tie
 * the lower one. Null when `levels` is empty.
 */
export function nearestReasoningLevel(
  level: ReasoningEffortLevel,
  levels: ReadonlyArray<ReasoningEffortLevel>,
): ReasoningEffortLevel | null {
  if (levels.length === 0) return null;
  const idx = REASONING_EFFORT_LEVELS.indexOf(level);
  return (
    [...levels].sort(
      (a, b) =>
        Math.abs(REASONING_EFFORT_LEVELS.indexOf(a) - idx) -
        Math.abs(REASONING_EFFORT_LEVELS.indexOf(b) - idx),
    )[0] ?? null
  );
}
