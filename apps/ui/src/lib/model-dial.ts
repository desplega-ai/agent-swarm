import type { ReasoningEffortLevel } from "@/api/types";
import {
  findKnownModel,
  findModelOption,
  type LocalHarnessProvider,
  type ModelGroup,
  modelGroupsForHarness,
  nearestSupportedLevel,
} from "./agent-runtime-models";

/**
 * The per-agent model dial of `/setup` step 4 (Agents): three levels per harness,
 * each a concrete `MODEL_OVERRIDE` plus a `REASONING_EFFORT_OVERRIDE`.
 * Values approved by Taras on 2026-09-24.
 */
export type DialLevel = "cheap" | "optimal" | "max";

export const DIAL_LEVELS: readonly DialLevel[] = ["cheap", "optimal", "max"];

export const DIAL_LEVEL_LABEL: Record<DialLevel, string> = {
  cheap: "Cheap",
  optimal: "Optimal",
  max: "Max",
};

/** Where an agent's stored model sits on the dial. `custom` = any other model. */
export type DialPosition = DialLevel | "custom";

/** Harnesses with a dial. Devin, Claude Managed, and ACP pick their own model. */
export type DialHarness = "claude" | "codex" | "pi" | "opencode" | "dsh";

const DIAL_HARNESSES: readonly DialHarness[] = ["claude", "codex", "pi", "opencode", "dsh"];

type EffortHarness = Exclude<DialHarness, "dsh">;

interface Preset {
  model: string;
  /** The intended effort. `dialSetting` clamps it to what the model supports. */
  effort: ReasoningEffortLevel;
}

const OPEN_HARNESS_PRESETS: Record<DialLevel, Preset> = {
  cheap: { model: "openrouter/deepseek/deepseek-v4.1-flash", effort: "low" },
  optimal: { model: "openrouter/z-ai/glm-5.3", effort: "medium" },
  max: { model: "openrouter/anthropic/claude-opus-5.5", effort: "high" },
};

const PRESETS: Record<EffortHarness, Record<DialLevel, Preset>> = {
  claude: {
    cheap: { model: "claude-sonnet-5", effort: "medium" },
    optimal: { model: "claude-opus-5-5", effort: "high" },
    max: { model: "claude-fable-5-1", effort: "high" },
  },
  codex: {
    cheap: { model: "gpt-6-luna", effort: "medium" },
    optimal: { model: "gpt-6-sol", effort: "high" },
    max: { model: "gpt-6-astra", effort: "xhigh" },
  },
  pi: OPEN_HARNESS_PRESETS,
  opencode: OPEN_HARNESS_PRESETS,
};

/**
 * dsh reads `openrouter/<id>` with an OpenRouter key, or a bare DeepSeek id
 * with `DEEPSEEK_API_KEY` (`src/providers/dsh-adapter.ts`). No effort.
 */
const DSH_MODELS: Record<"openrouter" | "deepseek", Record<DialLevel, string>> = {
  openrouter: {
    cheap: "openrouter/deepseek/deepseek-v4.1-flash",
    optimal: "openrouter/deepseek/deepseek-v4-pro",
    max: "openrouter/deepseek/deepseek-v4-pro",
  },
  deepseek: {
    cheap: "deepseek-v4-flash",
    optimal: "deepseek-v4-pro",
    max: "deepseek-v4-pro",
  },
};

/** What a dial level writes for one harness. */
export interface DialSetting {
  harness: DialHarness;
  model: string;
  /** `null` clears `REASONING_EFFORT_OVERRIDE` (dsh, or no effort data for the model). */
  effort: ReasoningEffortLevel | null;
  /** The bundled catalog does not list the model: the API stores it as a custom model. */
  custom: boolean;
}

export interface DialContext {
  /** An OpenRouter key is present, so dsh routes through OpenRouter. */
  openrouter: boolean;
}

export function dialHarness(harness: string | null | undefined): DialHarness | null {
  return DIAL_HARNESSES.find((h) => h === harness) ?? null;
}

/**
 * The supported level nearest to `level` (`nearestSupportedLevel`, the same
 * rule as the runtime settings). `null` when the model has no effort data:
 * the API rejects any level then.
 */
function clampEffort(
  level: ReasoningEffortLevel,
  levels: ReadonlyArray<ReasoningEffortLevel> | undefined,
): ReasoningEffortLevel | null {
  return levels ? nearestSupportedLevel(level, levels) : null;
}

// The API validates effort against the bundled snapshot
// (`src/providers/reasoning-effort.ts`), not the live catalog, so the clamp
// reads the same snapshot: no live catalog here. Built once per harness.
const snapshotGroups = new Map<LocalHarnessProvider, ModelGroup[]>();

function snapshotOption(harness: EffortHarness, model: string) {
  let groups = snapshotGroups.get(harness);
  if (!groups) {
    groups = modelGroupsForHarness(harness, undefined, undefined, null, null);
    snapshotGroups.set(harness, groups);
  }
  return findModelOption(model, groups);
}

// The inputs are static (table + snapshot), so every setting is computed once.
const settings = new Map<string, DialSetting>();

export function dialSetting(
  harness: DialHarness,
  level: DialLevel,
  context: DialContext,
): DialSetting {
  const key = `${harness}:${level}:${harness === "dsh" && context.openrouter}`;
  let setting = settings.get(key);
  if (!setting) {
    setting = computeSetting(harness, level, context);
    settings.set(key, setting);
  }
  return setting;
}

function computeSetting(harness: DialHarness, level: DialLevel, context: DialContext): DialSetting {
  if (harness === "dsh") {
    const model = DSH_MODELS[context.openrouter ? "openrouter" : "deepseek"][level];
    return { harness, model, effort: null, custom: true };
  }
  const preset = PRESETS[harness][level];
  const option = snapshotOption(harness, preset.model);
  return {
    harness,
    model: preset.model,
    effort: clampEffort(preset.effort, option?.reasoningLevels),
    custom: option === null,
  };
}

/**
 * The stored model and effort equal exactly what `setting` writes. A setting
 * without effort (dsh, or no effort data) matches only a cleared effort.
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
 * Optimal and Max). dsh matches only the id form it writes in `context`.
 */
export function dialMatches(
  harness: DialHarness,
  model: string | null | undefined,
  effort: string | null | undefined,
  context: DialContext,
): DialLevel[] {
  if (!model) return [];
  return DIAL_LEVELS.filter((level) =>
    dialSettingApplied(dialSetting(harness, level, context), model, effort),
  );
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

/** USD per 1M tokens from the bundled catalog. `null` when the catalog has no price. */
export function dialPrice(setting: DialSetting): { input?: number; output?: number } | null {
  // Direct models are listed without a provider prefix; the snapshot keys them by provider.
  const id =
    setting.harness === "claude"
      ? `anthropic/${setting.model}`
      : setting.harness === "codex"
        ? `openai/${setting.model}`
        : setting.model;
  const cost = findKnownModel(id)?.cost;
  return cost && (cost.input != null || cost.output != null) ? cost : null;
}
