import type { ModelsDevCatalog } from "../cost/catalog.ts";
import { effortError, isEffortLevel } from "../cost/effort.ts";
import type { HarnessConfig, ReasoningEffortLevel } from "../types.ts";
import type { Registry } from "./index.ts";
import { referencedConfigIds } from "./run-configs.ts";

/**
 * Run-level reasoning effort. A config carries a default (`reasoningEffort`); a
 * run may override it per config. The effective value is snapshotted into
 * `eval_runs.efforts_json` when the run is created and attempts read only that
 * snapshot, never the live config, so one run grades one effort even if the
 * config is edited mid-run or the run is resumed days later (same rule as the
 * alias pins in run-configs.ts).
 */

/** Per-run overrides as sent by the API/CLI: a level, or null to run that config at the harness default. */
export type EffortOverrides = Record<string, ReasoningEffortLevel | null>;

/**
 * Normalize an untrusted overrides value (JSON body). Throws on anything that is
 * not an object of `configId → level | null`.
 */
export function parseEffortOverrides(raw: unknown): EffortOverrides {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("efforts must be an object of configId → effort level");
  }
  const out: EffortOverrides = {};
  for (const [configId, value] of Object.entries(raw)) {
    if (value === null || value === "") out[configId] = null;
    else if (isEffortLevel(value)) out[configId] = value;
    else throw new Error(`efforts["${configId}"] must be a reasoning effort level or null`);
  }
  return out;
}

/**
 * The effort each config the run touches will run at: the override, else the
 * config default, checked against the harness + model the run will use. Throws
 * naming every config whose effort its pair does not take, so a run is never
 * created with an effort the worker would silently ignore. Configs at the
 * harness default are absent from the result.
 */
export function planRunEfforts(opts: {
  registry: Registry;
  scenarioIds: string[];
  configIds: string[];
  overrides?: EffortOverrides;
  /** `getResolutionCatalog()`. */
  catalog: ModelsDevCatalog;
}): Record<string, ReasoningEffortLevel> {
  const overrides = opts.overrides ?? {};
  const errors: string[] = [];
  for (const id of Object.keys(overrides)) {
    if (!opts.configIds.includes(id))
      errors.push(`effort override for "${id}": config is not in this run`);
  }
  const efforts: Record<string, ReasoningEffortLevel> = {};
  for (const id of referencedConfigIds(opts.registry, opts.scenarioIds, opts.configIds)) {
    const config = opts.registry.configs.get(id);
    if (!config) continue;
    const level = id in overrides ? overrides[id] : config.reasoningEffort;
    if (!level) continue;
    const error = effortError(config, level, opts.catalog);
    if (error) errors.push(`${id}: ${error}`);
    else efforts[id] = level;
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return efforts;
}

/**
 * Registry copy whose configs carry exactly the run's snapshotted effort: a
 * config default the snapshot does not list is dropped, so a run created
 * before efforts existed (`efforts` null) is never changed by a later edit.
 */
export function applyRunEfforts(
  registry: Registry,
  efforts: Record<string, ReasoningEffortLevel> | null | undefined,
): Registry {
  const configs = new Map<string, HarnessConfig>();
  for (const [id, config] of registry.configs) {
    const { reasoningEffort: _default, ...rest } = config;
    const level = efforts?.[id];
    configs.set(id, level ? { ...rest, reasoningEffort: level } : rest);
  }
  return { scenarios: registry.scenarios, configs };
}
