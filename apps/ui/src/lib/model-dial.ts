import {
  compareNewestFirst,
  nearestReasoningLevel,
  type ReasoningEffortLevel,
} from "@desplega/model-catalog";
import type { ModelTier, ModelTierPreview } from "@/api/types";
import {
  claudeModelId,
  deepseekCatalogModels,
  effortLevelsFor,
  findKnownModel,
  findModelOption,
  type LiveModelsCatalog,
  type LocalHarnessProvider,
  type ModelCost,
  type ModelGroup,
  modelGroupsForHarness,
} from "./agent-runtime-models";
import { tierRowModel } from "./model-tiers";

/**
 * The per-agent model dial of `/setup` step 4 (Agents): three levels per harness,
 * each a concrete `MODEL_OVERRIDE` plus a `REASONING_EFFORT_OVERRIDE`.
 *
 * The model of a level is the model of a Model Tier for that harness
 * (`DIAL_TIER`, read from `GET /api/models-catalog/tiers`), so retuning a
 * `MODEL_TIER_<PROVIDER>_<TIER>` key moves the dial with no code change. Only
 * the effort intent per level is data here (`EFFORT_INTENT`), clamped to what
 * the model accepts. Until the tier rows load the dial cannot answer: every
 * lookup returns `null` and callers wait rather than write a guessed model.
 */
export type DialLevel = "cheap" | "optimal" | "max";

export const DIAL_LEVELS: readonly DialLevel[] = ["cheap", "optimal", "max"];

export const DIAL_LEVEL_LABEL: Record<DialLevel, string> = {
  cheap: "Cheap",
  optimal: "Optimal",
  max: "Max",
};

/** The Model Tier whose model each dial level runs. */
export const DIAL_TIER: Record<DialLevel, ModelTier> = {
  cheap: "regular",
  optimal: "smart",
  max: "ultra",
};

/** Where an agent's stored model sits on the dial. `custom` = any other model. */
export type DialPosition = DialLevel | "custom";

/** Harnesses with a dial. Devin, Claude Managed, and ACP pick their own model. */
export type DialHarness = "claude" | "codex" | "pi" | "opencode" | "dsh";

const DIAL_HARNESSES: readonly DialHarness[] = ["claude", "codex", "pi", "opencode", "dsh"];

type EffortHarness = Exclude<DialHarness, "dsh">;

/**
 * The effort each level asks for. A product choice, not a model fact: the dial
 * clamps it to the nearest level the model accepts (`effortLevelsFor`), so two
 * levels can share a model and still differ by effort.
 */
const OPEN_HARNESS_EFFORT: Record<DialLevel, ReasoningEffortLevel> = {
  cheap: "low",
  optimal: "medium",
  max: "high",
};

const EFFORT_INTENT: Record<EffortHarness, Record<DialLevel, ReasoningEffortLevel>> = {
  claude: { cheap: "medium", optimal: "high", max: "high" },
  codex: { cheap: "medium", optimal: "high", max: "xhigh" },
  pi: OPEN_HARNESS_EFFORT,
  opencode: OPEN_HARNESS_EFFORT,
};

/**
 * Every id of the catalog's `deepseek` section (the bare ids dsh reads with
 * `DEEPSEEK_API_KEY`, `src/providers/dsh-adapter.ts`) starts with it.
 */
const DEEPSEEK_PREFIX = "deepseek-";

/** What a dial level writes for one harness. */
export interface DialSetting {
  harness: DialHarness;
  model: string;
  /** `null` clears `REASONING_EFFORT_OVERRIDE` (dsh, or a model that takes no effort). */
  effort: ReasoningEffortLevel | null;
  /** The catalog does not list the model: the API stores it as a custom model. */
  custom: boolean;
}

export interface DialContext {
  /** An OpenRouter key is present, so dsh routes through OpenRouter. */
  openrouter: boolean;
  /**
   * The live catalog (`GET /api/models-catalog`), so the effort clamp reads what
   * the API validates against. Absent while it loads: the bundled snapshot.
   */
  catalog?: LiveModelsCatalog | null;
  /**
   * The model tier rows (`GET /api/models-catalog/tiers`, `useModelTiers`).
   * Absent while they load: the dial has no answer (`dialSetting` is `null`).
   */
  tiers?: readonly ModelTierPreview[] | null;
}

export function dialHarness(harness: string | null | undefined): DialHarness | null {
  return DIAL_HARNESSES.find((h) => h === harness) ?? null;
}

/** The model a dial level runs on `harness`: its tier's model. `null` when the tier names none. */
function tierModel(
  tiers: readonly ModelTierPreview[] | null | undefined,
  harness: DialHarness,
  level: DialLevel,
): string | null {
  return tierRowModel(tiers, harness, DIAL_TIER[level]);
}

/**
 * The DeepSeek-direct model for a dsh tier value: the newest model of the
 * catalog's `deepseek` section that ends with the same family token (`flash`,
 * `pro`) as the value. `null` when the value is not a DeepSeek model.
 */
function deepseekModelFor(
  value: string,
  models: ReturnType<typeof deepseekCatalogModels>,
): string | null {
  const own = value.split("/").pop() ?? value;
  if (!own.startsWith(DEEPSEEK_PREFIX)) return null;
  const usable = Object.entries(models)
    .filter(([id, model]) => id.startsWith(DEEPSEEK_PREFIX) && model.status !== "deprecated")
    .map(([id, model]) => ({ id, release_date: model.release_date ?? null }));
  const families = new Set(usable.map((model) => model.id.split("-").pop()));
  // The last token of the value that names a family: `…-v4.1-flash` is flash,
  // `…-v4-pro-0813` is pro.
  const family = own
    .split("-")
    .reverse()
    .find((token) => families.has(token));
  if (!family) return null;
  return (
    usable.filter((model) => model.id.endsWith(`-${family}`)).sort(compareNewestFirst)[0]?.id ??
    null
  );
}

/**
 * dsh without an OpenRouter key runs a bare DeepSeek id. A level whose tier is
 * not a DeepSeek model (Max defaults to a Claude route) takes the nearest lower
 * level's DeepSeek model.
 */
function deepseekDirectModel(level: DialLevel, context: DialContext): string | null {
  const models = deepseekCatalogModels(context.catalog);
  for (let i = DIAL_LEVELS.indexOf(level); i >= 0; i--) {
    const value = tierModel(context.tiers, "dsh", DIAL_LEVELS[i]);
    const model = value ? deepseekModelFor(value, models) : null;
    if (model) return model;
  }
  return null;
}

// The API validates effort against the runtime catalog (the live `model_catalog`
// plus overlay rows, the bundled snapshot offline: `src/providers/reasoning-effort.ts`),
// so the clamp reads the live catalog when the context carries one. The answer
// depends on the catalog AND the tier rows, so the settings cache is keyed by
// both objects: a refetched catalog or tier list with new data is a new object,
// and react-query keeps the same object while the data is unchanged.
const NO_CATALOG = {};
const NO_TIERS = {};

const groupCaches = new WeakMap<object, Map<LocalHarnessProvider, ModelGroup[]>>();
const settingCaches = new WeakMap<object, WeakMap<object, Map<string, DialSetting | null>>>();

function groupCacheFor(catalog: LiveModelsCatalog | null | undefined) {
  const key = catalog ?? NO_CATALOG;
  let cache = groupCaches.get(key);
  if (!cache) {
    cache = new Map();
    groupCaches.set(key, cache);
  }
  return cache;
}

function settingCacheFor(context: DialContext) {
  const catalogKey = context.catalog ?? NO_CATALOG;
  let byTiers = settingCaches.get(catalogKey);
  if (!byTiers) {
    byTiers = new WeakMap();
    settingCaches.set(catalogKey, byTiers);
  }
  const tiersKey = context.tiers ?? NO_TIERS;
  let cache = byTiers.get(tiersKey);
  if (!cache) {
    cache = new Map();
    byTiers.set(tiersKey, cache);
  }
  return cache;
}

function catalogOption(
  harness: EffortHarness,
  model: string,
  catalog: LiveModelsCatalog | null | undefined,
) {
  const cached = groupCacheFor(catalog);
  let groups = cached.get(harness);
  if (!groups) {
    groups = modelGroupsForHarness(harness, undefined, undefined, null, catalog);
    cached.set(harness, groups);
  }
  return findModelOption(model, groups);
}

/**
 * What `level` writes for `harness`, or `null` when the tier rows are not
 * loaded, or the level's tier has no model for the harness (no row, or a
 * `latest:` alias that resolves to nothing).
 */
export function dialSetting(
  harness: DialHarness,
  level: DialLevel,
  context: DialContext,
): DialSetting | null {
  const settings = settingCacheFor(context);
  const key = `${harness}:${level}:${harness === "dsh" && context.openrouter}`;
  let setting = settings.get(key);
  if (setting === undefined) {
    setting = computeSetting(harness, level, context);
    settings.set(key, setting);
  }
  return setting;
}

function computeSetting(
  harness: DialHarness,
  level: DialLevel,
  context: DialContext,
): DialSetting | null {
  if (harness === "dsh") {
    const model = context.openrouter
      ? tierModel(context.tiers, harness, level)
      : deepseekDirectModel(level, context);
    return model ? { harness, model, effort: null, custom: true } : null;
  }
  const value = tierModel(context.tiers, harness, level);
  if (!value) return null;
  // The Claude tiers name CLI shortnames (`opus`): store the catalog id they stand for.
  const model = harness === "claude" ? claudeModelId(value, context.catalog) : value;
  const option = catalogOption(harness, model, context.catalog);
  return {
    harness,
    model,
    // `null` when the model takes no effort: the API rejects any level then.
    effort: nearestReasoningLevel(
      EFFORT_INTENT[harness][level],
      effortLevelsFor(harness, model, context.catalog),
    ),
    custom: option === null,
  };
}

/**
 * The stored model and effort equal exactly what `setting` writes. A setting
 * without effort (dsh, or a model that takes none) matches only a cleared effort.
 */
export function dialSettingApplied(
  setting: DialSetting,
  model: string | null | undefined,
  effort: string | null | undefined,
): boolean {
  return setting.model === (model ?? "") && setting.effort === (effort || null);
}

/**
 * Every level whose setting (in `context`) equals the stored model and
 * effort, in dial order. More than one when two levels write the same (dsh
 * Optimal and Max). dsh matches only the id form it writes in `context`. None
 * while the tier rows are not loaded.
 */
export function dialMatches(
  harness: DialHarness,
  model: string | null | undefined,
  effort: string | null | undefined,
  context: DialContext,
): DialLevel[] {
  if (!model) return [];
  return DIAL_LEVELS.filter((level) => {
    const setting = dialSetting(harness, level, context);
    return setting !== null && dialSettingApplied(setting, model, effort);
  });
}

/**
 * The level of any harness's dial that the stored model matches. After the
 * operator switches an agent's harness, this level carries over to the new one.
 */
export function dialLevelOfAnyHarness(
  model: string | null | undefined,
  effort: string | null | undefined,
  context: DialContext,
): DialLevel | null {
  for (const harness of DIAL_HARNESSES) {
    const matches = dialMatches(harness, model, effort, context);
    if (matches.length > 0) return matches[0];
  }
  return null;
}

/**
 * USD per 1M tokens from the catalog (the live one when passed, else the
 * bundled snapshot). `null` when the catalog has no price.
 */
export function dialPrice(
  setting: DialSetting,
  catalog?: LiveModelsCatalog | null,
): ModelCost | null {
  // Direct models are listed without a provider prefix; the catalog keys them by provider.
  const id =
    setting.harness === "claude"
      ? `anthropic/${setting.model}`
      : setting.harness === "codex"
        ? `openai/${setting.model}`
        : setting.model;
  const cost = findKnownModel(id, catalog ?? undefined)?.cost;
  return cost && (cost.input != null || cost.output != null) ? cost : null;
}
