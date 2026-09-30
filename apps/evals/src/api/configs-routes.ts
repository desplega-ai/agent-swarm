import { REASONING_EFFORT_LEVELS } from "@desplega/model-catalog";
import type { Client } from "@libsql/client";
import { configs as seedConfigs } from "../../configs/index.ts";
import { getResolutionCatalog, type ModelsDevCatalog } from "../cost/catalog.ts";
import {
  configModelId,
  effortError,
  effortLevelsForConfig,
  isEffortLevel,
} from "../cost/effort.ts";
import { resolveAlias, validateConfigResolves } from "../cost/resolve-alias.ts";
import {
  getHarnessConfig,
  insertUserConfig,
  listHarnessConfigs,
  syncSeedConfigs,
  updateUserConfig,
} from "../db/harness-configs.ts";
import { serializeConfig, setDbConfigs } from "../registry.ts";
import type { HarnessConfig, HarnessProvider, ReasoningEffortLevel } from "../types.ts";

const PROVIDERS = new Set<HarnessProvider>(["claude", "pi", "codex", "opencode"]);
/** Same id contract as configs/index.ts. */
export const CONFIG_ID_RE = /^(claude|pi|opencode|codex)-[a-z0-9][a-z0-9.-]*$/;
const MAX_LABEL = 120;

export type ConfigMutationResult =
  | { ok: true; status: 200 | 201; config: HarnessConfig }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** Reload harness_configs into the registry overlay. */
export async function reloadDbConfigs(db: Client): Promise<void> {
  const rows = await listHarnessConfigs(db);
  setDbConfigs(
    rows.map((r) => r.config),
    rows.filter((r) => r.archived).map((r) => r.config.id),
  );
}

/** Boot: upsert code seeds, then load the table into the registry. */
export async function initHarnessConfigs(db: Client): Promise<void> {
  await syncSeedConfigs(db, seedConfigs);
  await reloadDbConfigs(db);
}

/**
 * The `/api/configs` row: `serializeConfig` plus `resolvedModel`, what a
 * `modelAlias` resolves to in the reviewed catalog right now (the id a run
 * created today would pin), and `effortLevels`, the reasoning efforts the
 * config's harness takes for that model (empty when it takes none). Null
 * `resolvedModel` for pinned-`model` configs and for an alias that matches
 * nothing. Pass `getResolutionCatalog()`.
 */
export function serializeConfigResolved(config: HarnessConfig, catalog: ModelsDevCatalog) {
  return {
    ...serializeConfig(config),
    resolvedModel: config.modelAlias ? resolveAlias(config.modelAlias, catalog) : null,
    effortLevels: effortLevelsForConfig(config, catalog),
  };
}

/** `claude` + `latest:anthropic/opus` → `claude-opus`; `pi` + `openrouter/x/y-1.5` → `pi-y-1.5`. */
export function deriveConfigId(provider: string, modelOrAlias: string): string {
  const tail = modelOrAlias.split("/").pop() ?? modelOrAlias;
  const slug = tail
    .toLowerCase()
    .replace(/^claude-/, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
  return `${provider}-${slug}`;
}

function optionalString(value: unknown, field: string): string | undefined | Error {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function checkResolves(config: HarnessConfig): Promise<string | null> {
  const errors = validateConfigResolves(config, await getResolutionCatalog());
  return errors.length > 0 ? errors.join("; ") : null;
}

/** The body's `reasoningEffort`: a level, or null/"" to clear. Undefined when absent. */
function parseEffortField(value: unknown): ReasoningEffortLevel | null | undefined | Error {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (isEffortLevel(value)) return value;
  return new Error(`reasoningEffort must be one of ${REASONING_EFFORT_LEVELS.join(", ")}`);
}

/** POST /api/configs body: { provider, model | modelAlias, reasoningEffort?, label?, id? }. */
export async function createConfig(db: Client, body: unknown): Promise<ConfigMutationResult> {
  if (!body || typeof body !== "object")
    return { ok: false, status: 400, error: "JSON body required" };
  const b = body as Record<string, unknown>;
  if (typeof b.provider !== "string" || !PROVIDERS.has(b.provider as HarnessProvider)) {
    return { ok: false, status: 400, error: "provider must be one of claude, pi, codex, opencode" };
  }
  const provider = b.provider as HarnessProvider;
  const model = optionalString(b.model, "model");
  const modelAlias = optionalString(b.modelAlias, "modelAlias");
  const label = optionalString(b.label, "label");
  const rawId = optionalString(b.id, "id");
  for (const v of [model, modelAlias, label, rawId]) {
    if (v instanceof Error) return { ok: false, status: 400, error: v.message };
  }
  if (typeof label === "string" && label.length > MAX_LABEL) {
    return { ok: false, status: 400, error: `label must be at most ${MAX_LABEL} characters` };
  }
  const target = (modelAlias ?? model) as string | undefined;
  if (!target) return { ok: false, status: 400, error: "set either model or modelAlias" };
  const id = (rawId as string | undefined) ?? deriveConfigId(provider, target);
  if (!CONFIG_ID_RE.test(id) || !id.startsWith(`${provider}-`)) {
    return {
      ok: false,
      status: 400,
      error: `id "${id}" must match ${CONFIG_ID_RE} for ${provider}`,
    };
  }
  const effort = parseEffortField(b.reasoningEffort);
  if (effort instanceof Error) return { ok: false, status: 400, error: effort.message };
  const config: HarnessConfig = { id, provider };
  if (label) config.label = label as string;
  if (model) config.model = model as string;
  if (modelAlias) config.modelAlias = modelAlias as string;
  if (effort) config.reasoningEffort = effort;
  const invalid = await checkResolves(config);
  if (invalid) return { ok: false, status: 400, error: invalid };
  const badEffort = effort ? effortError(config, effort, await getResolutionCatalog()) : null;
  if (badEffort) return { ok: false, status: 400, error: badEffort };
  if (!(await insertUserConfig(db, config))) {
    return { ok: false, status: 409, error: `config "${id}" already exists` };
  }
  await reloadDbConfigs(db);
  return { ok: true, status: 201, config };
}

/**
 * PATCH /api/configs/:id body: any of { label, model, modelAlias, reasoningEffort,
 * archived }. Setting `model` clears `modelAlias` and vice versa; `reasoningEffort`
 * null clears the effort. A model change that leaves the stored effort unsupported
 * is refused: send `reasoningEffort` with it. Any edit marks the row
 * `source='user'`, so boot seeding stops overwriting it.
 */
export async function patchConfig(
  db: Client,
  id: string,
  body: unknown,
): Promise<ConfigMutationResult> {
  const existing = await getHarnessConfig(db, id);
  if (!existing) return { ok: false, status: 404, error: `unknown config "${id}"` };
  if (!body || typeof body !== "object")
    return { ok: false, status: 400, error: "JSON body required" };
  const b = body as Record<string, unknown>;
  const next: HarnessConfig = { ...existing.config };
  if ("label" in b) {
    const label = optionalString(b.label, "label");
    if (label instanceof Error) return { ok: false, status: 400, error: label.message };
    if (label && label.length > MAX_LABEL) {
      return { ok: false, status: 400, error: `label must be at most ${MAX_LABEL} characters` };
    }
    if (label) next.label = label;
    else delete next.label;
  }
  if ("model" in b && "modelAlias" in b && b.model != null && b.modelAlias != null) {
    return { ok: false, status: 400, error: "sets both model and modelAlias; pick one" };
  }
  if ("model" in b && b.model != null) {
    const model = optionalString(b.model, "model");
    if (model instanceof Error) return { ok: false, status: 400, error: model.message };
    if (model) {
      next.model = model;
      delete next.modelAlias;
    }
  }
  if ("modelAlias" in b && b.modelAlias != null) {
    const alias = optionalString(b.modelAlias, "modelAlias");
    if (alias instanceof Error) return { ok: false, status: 400, error: alias.message };
    if (alias) {
      next.modelAlias = alias;
      delete next.model;
    }
  }
  if ("reasoningEffort" in b) {
    const effort = parseEffortField(b.reasoningEffort);
    if (effort instanceof Error) return { ok: false, status: 400, error: effort.message };
    if (effort) next.reasoningEffort = effort;
    else delete next.reasoningEffort;
  }
  let archived = existing.archived;
  if ("archived" in b) {
    if (typeof b.archived !== "boolean") {
      return { ok: false, status: 400, error: "archived must be a boolean" };
    }
    archived = b.archived;
  }
  const modelChanged =
    next.model !== existing.config.model || next.modelAlias !== existing.config.modelAlias;
  if (modelChanged) {
    const invalid = await checkResolves(next);
    if (invalid) return { ok: false, status: 400, error: invalid };
  }
  const effortChanged = next.reasoningEffort !== existing.config.reasoningEffort;
  if (next.reasoningEffort && (modelChanged || effortChanged)) {
    const badEffort = effortError(next, next.reasoningEffort, await getResolutionCatalog());
    if (badEffort) return { ok: false, status: 400, error: badEffort };
  }
  await updateUserConfig(db, next, archived);
  await reloadDbConfigs(db);
  return { ok: true, status: 200, config: next };
}

/**
 * GET /api/effort-levels?provider=&model=|modelAlias=: the reasoning efforts a
 * harness takes for a model (or the model an alias resolves to today), so a
 * config form offers exactly those. `model` is null for an alias that matches
 * nothing; `levels` is empty when the pair takes no effort. Pass
 * `getResolutionCatalog()`.
 */
export function effortLevelsFor(
  params: URLSearchParams,
  catalog: ModelsDevCatalog,
):
  | { ok: true; body: { model: string | null; levels: ReasoningEffortLevel[] } }
  | { ok: false; status: 400; error: string } {
  const provider = params.get("provider");
  if (!provider || !PROVIDERS.has(provider as HarnessProvider)) {
    return { ok: false, status: 400, error: "provider must be one of claude, pi, codex, opencode" };
  }
  const model = params.get("model")?.trim() || undefined;
  const modelAlias = params.get("modelAlias")?.trim() || undefined;
  if (!model && !modelAlias) return { ok: false, status: 400, error: "set model or modelAlias" };
  const config: HarnessConfig = { id: `${provider}-draft`, provider: provider as HarnessProvider };
  if (model) config.model = model;
  else if (modelAlias) config.modelAlias = modelAlias;
  return {
    ok: true,
    body: {
      model: configModelId(config, catalog) ?? null,
      levels: effortLevelsForConfig(config, catalog),
    },
  };
}
