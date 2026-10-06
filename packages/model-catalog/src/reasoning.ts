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

/** The local harnesses with an effort control (Devin, claude-managed and ACP have none). */
export const REASONING_HARNESSES = ["claude", "codex", "pi", "opencode", "dsh", "cursor", "amp"] as const;
export type ReasoningHarnessName = (typeof REASONING_HARNESSES)[number];

/**
 * A dsh model string is either `openrouter/<vendor>/<id>` (OpenRouter route) or
 * a bare DeepSeek API id such as `deepseek-v4-pro` (direct route). Its catalog
 * entry lives in the `openrouter` section for the former and the `deepseek`
 * section for the latter.
 */
export function dshCatalogRef(model: string): { providerId: string; modelId: string } {
  if (model.startsWith("openrouter/")) {
    return { providerId: "openrouter", modelId: model.slice("openrouter/".length) };
  }
  return { providerId: "deepseek", modelId: model };
}

/**
 * A cursor model string is a bare Cursor model id (`gpt-5.4-nano`,
 * `claude-sonnet-5-5`, `composer-2.5`). Cursor names the vendor models it
 * hosts by their vendor ids, so the vendor follows from the id prefix. Ids
 * with no catalog vendor (Cursor's own `composer-*`, `default`) map to the
 * `cursor` section, which the catalog does not carry.
 */
export function cursorCatalogRef(model: string): { providerId: string; modelId: string } {
  const id = model.trim().toLowerCase();
  if (/^(gpt-|o\d)/.test(id)) return { providerId: "openai", modelId: id };
  if (id.startsWith("claude-")) return { providerId: "anthropic", modelId: id };
  if (id.startsWith("gemini-")) return { providerId: "google", modelId: id };
  if (id.startsWith("grok-")) return { providerId: "xai", modelId: id };
  return { providerId: "cursor", modelId: id };
}

/** Direct DeepSeek API ids carry no vendor slash; OpenRouter ids always do. */
function isDshDirectModel(catalogId: string): boolean {
  return !catalogId.includes("/");
}

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

  if (harness === "dsh") {
    // dsh passes `max` through on both routes. The DeepSeek API's thinking
    // toggle is a real `off` there (`thinking: disabled`); on an OpenRouter
    // route an undeclared `off` sends no reasoning field at all, so the
    // model's own default (thinking on) applies and `off` would be a lie.
    const direct = isDshDirectModel(modelId);
    const hasToggle = facts.reasoning_options?.some((o) => o.type === "toggle") ?? false;
    if (direct && hasToggle && !result.includes("off")) result = ["off", ...result];
    if (!direct) result = result.filter((l) => l !== "off");
  } else if (harness !== "codex" && harness !== "cursor") {
    // cursor passes the model's own effort values through (`max` included),
    // see `src/providers/cursor-adapter.ts`.
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

/** A catalog whose provider sections hold models with reasoning facts (models.dev shape). */
export type ReasoningCatalog = Record<
  string,
  { models?: Record<string, ReasoningModelFacts & HarnessCatalogModel> } | undefined
>;

/**
 * The effort levels `harness` accepts for `model`, read from `catalog`.
 *
 * `model` is the string the harness stores: a bare id for `claude` and `codex`
 * (a Claude CLI shortname such as `opus` resolves to the newest model of its
 * family), `openrouter/<id>` or a bare DeepSeek id for `dsh` ({@link dshCatalogRef}),
 * `<providerId>/<model-id>` for `pi` and `opencode`, split on the FIRST
 * slash because the id may hold more (`openrouter/google/gemini-3-flash-preview`).
 * Empty for a harness with no effort control, a model the catalog does not
 * list, and a model that does not reason. Callers that hold two catalogs (a
 * live one over a bundled snapshot) merge them first.
 */
export function reasoningLevelsForModel(
  harness: string,
  model: string | null | undefined,
  catalog: ReasoningCatalog | null | undefined,
): ReasoningEffortLevel[] {
  if (!model || !isReasoningHarness(harness)) return [];
  let providerId: string;
  let catalogId: string;
  if (harness === "claude") {
    providerId = "anthropic";
    catalogId = claudeCatalogModelId(model, catalog?.[providerId]?.models);
  } else if (harness === "codex") {
    providerId = "openai";
    catalogId = model;
  } else if (harness === "dsh") {
    ({ providerId, modelId: catalogId } = dshCatalogRef(model));
  } else if (harness === "cursor") {
    ({ providerId, modelId: catalogId } = cursorCatalogRef(model));
  } else {
    const slash = model.indexOf("/");
    if (slash <= 0) return [];
    providerId = model.slice(0, slash);
    catalogId = model.slice(slash + 1);
  }
  return reasoningLevelsFor(harness, catalogId, catalog?.[providerId]?.models?.[catalogId]);
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
