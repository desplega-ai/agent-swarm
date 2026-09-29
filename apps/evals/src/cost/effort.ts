import {
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
  reasoningLevelsForModel,
} from "@desplega/model-catalog";
import type { HarnessConfig } from "../types.ts";
import type { ModelsDevCatalog } from "./catalog.ts";
import { resolveAlias } from "./resolve-alias.ts";

/**
 * Reasoning effort for harness configs. Which levels a (harness, model) pair
 * takes is the shared catalog rule (`reasoningLevelsForModel`, the same one the
 * swarm API validates with and the swarm app's pickers offer); nothing is
 * listed per model here. Pass `getResolutionCatalog()`.
 */

export function isEffortLevel(value: unknown): value is ReasoningEffortLevel {
  return (REASONING_EFFORT_LEVELS as readonly unknown[]).includes(value);
}

/**
 * The model string the worker receives for `config`: the pinned `model`, else
 * what the alias resolves to now. Undefined for a harness-default config.
 */
export function configModelId(
  config: HarnessConfig,
  catalog: ModelsDevCatalog,
): string | undefined {
  if (config.model) return config.model;
  if (config.modelAlias) return resolveAlias(config.modelAlias, catalog) ?? undefined;
  return undefined;
}

/** Levels the config's harness accepts for its model; empty when the pair takes no effort. */
export function effortLevelsForConfig(
  config: HarnessConfig,
  catalog: ModelsDevCatalog,
): ReasoningEffortLevel[] {
  return reasoningLevelsForModel(config.provider, configModelId(config, catalog), catalog);
}

/** Why `level` cannot run on `config`, or null when it can. */
export function effortError(
  config: HarnessConfig,
  level: ReasoningEffortLevel,
  catalog: ModelsDevCatalog,
): string | null {
  const model = configModelId(config, catalog);
  if (!model) {
    return `config ${config.id} runs the harness default model, so its effort cannot be checked; pin a model first`;
  }
  const levels = reasoningLevelsForModel(config.provider, model, catalog);
  if (levels.includes(level)) return null;
  return levels.length === 0
    ? `${config.provider} + ${model} takes no reasoning effort`
    : `${config.provider} + ${model} does not take effort "${level}" (supported: ${levels.join(", ")})`;
}
