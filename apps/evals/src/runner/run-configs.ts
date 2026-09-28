import type { Client } from "@libsql/client";
import { getCatalog, getResolutionCatalog, type ModelsDevCatalog } from "../cost/catalog.ts";
import { resolveAlias } from "../cost/resolve-alias.ts";
import type { HarnessConfig } from "../types.ts";
import type { Registry } from "./index.ts";

/**
 * Run-level pinning of alias configs (`HarnessConfig.modelAlias`).
 *
 * Every alias config a run touches resolves ONCE, when the run is created, and
 * the concrete id lands in `eval_run_configs`. Attempts read the pin, never the
 * live catalog, so one run grades one model even if the catalog moves mid-run
 * or the run is resumed days later. Pins are insert-only (INSERT OR IGNORE).
 */

export interface RunConfigPin {
  configId: string;
  modelAlias: string;
  resolvedModel: string;
  catalogFetchedAt: string | null;
}

/** The run's matrix configs plus any config a scenario member references by id. */
export function referencedConfigIds(
  registry: Registry,
  scenarioIds: string[],
  configIds: string[],
): string[] {
  const ids = new Set(configIds);
  for (const scenarioId of scenarioIds) {
    const scenario = registry.scenarios.get(scenarioId);
    if (!scenario) continue;
    const members = [...(Array.isArray(scenario.workers) ? scenario.workers : [])];
    if (scenario.lead) members.push(scenario.lead);
    for (const member of members) if (member.configId) ids.add(member.configId);
  }
  return [...ids];
}

/**
 * Resolve the alias configs among `configIds`. Throws naming every alias that
 * matches nothing in the reviewed catalog, so a run is never created half-pinned.
 */
export function planRunConfigPins(
  configs: HarnessConfig[],
  catalog: ModelsDevCatalog,
  catalogFetchedAt: string | null,
): RunConfigPin[] {
  const pins: RunConfigPin[] = [];
  const unresolved: string[] = [];
  for (const config of configs) {
    if (!config.modelAlias) continue;
    const resolvedModel = resolveAlias(config.modelAlias, catalog);
    if (!resolvedModel) unresolved.push(`${config.id} (${config.modelAlias})`);
    else
      pins.push({
        configId: config.id,
        modelAlias: config.modelAlias,
        resolvedModel,
        catalogFetchedAt,
      });
  }
  if (unresolved.length > 0) {
    throw new Error(`model alias matches no reviewed catalog model: ${unresolved.join(", ")}`);
  }
  return pins;
}

async function readPins(db: Client, runId: string): Promise<Map<string, RunConfigPin>> {
  const res = await db.execute({
    sql: `SELECT config_id, model_alias, resolved_model, catalog_fetched_at
          FROM eval_run_configs WHERE run_id = ?`,
    args: [runId],
  });
  return new Map(
    res.rows.map((r) => [
      String(r.config_id),
      {
        configId: String(r.config_id),
        modelAlias: String(r.model_alias),
        resolvedModel: String(r.resolved_model),
        catalogFetchedAt: r.catalog_fetched_at == null ? null : String(r.catalog_fetched_at),
      },
    ]),
  );
}

/**
 * Pin every not-yet-pinned alias config the run references, then return all
 * pins for the run. Idempotent: existing pins are never re-resolved.
 */
export async function ensureRunConfigPins(
  db: Client,
  runId: string,
  registry: Registry,
  scenarioIds: string[],
  configIds: string[],
): Promise<Map<string, RunConfigPin>> {
  const existing = await readPins(db, runId);
  const missing = referencedConfigIds(registry, scenarioIds, configIds)
    .map((id) => registry.configs.get(id))
    .filter((c): c is HarnessConfig => !!c?.modelAlias && !existing.has(c.id));
  if (missing.length === 0) return existing;
  const pins = planRunConfigPins(
    missing,
    await getResolutionCatalog(),
    (await getCatalog()).fetchedAt,
  );
  for (const pin of pins) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO eval_run_configs
              (run_id, config_id, model_alias, resolved_model, catalog_fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [runId, pin.configId, pin.modelAlias, pin.resolvedModel, pin.catalogFetchedAt],
    });
  }
  return readPins(db, runId);
}

/** Registry copy whose alias configs carry their pinned concrete `model`. */
export function applyRunConfigPins(registry: Registry, pins: Map<string, RunConfigPin>): Registry {
  const configs = new Map<string, HarnessConfig>();
  for (const [id, config] of registry.configs) {
    const pin = pins.get(id);
    configs.set(id, pin ? { ...config, model: pin.resolvedModel } : config);
  }
  return { scenarios: registry.scenarios, configs };
}

/** Pre-flight for run creation: throws when any referenced alias config cannot resolve. */
export async function assertRunConfigsResolve(
  registry: Registry,
  scenarioIds: string[],
  configIds: string[],
): Promise<void> {
  const configs = referencedConfigIds(registry, scenarioIds, configIds)
    .map((id) => registry.configs.get(id))
    .filter((c): c is HarnessConfig => !!c);
  planRunConfigPins(configs, await getResolutionCatalog(), null);
}
