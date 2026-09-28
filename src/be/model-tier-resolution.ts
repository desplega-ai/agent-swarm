/**
 * Claim-time model resolution (model-catalog phase 3).
 *
 * The API server resolves which concrete model a task runs with at the moment
 * a worker claims it, against the catalog it owns, and records the answer on
 * the task row (`resolvedModel`, `modelSource`, `modelAlias`).
 *
 * Precedence (first hit wins):
 *   1. task `model`                         → modelSource "model"
 *   2. the claiming worker's MODEL_TIER_*   → "worker-env"  (agents.modelTierOverrides)
 *   3. swarm_config MODEL_TIER_<PROV>_<TIER> → "tier-config"
 *   4. DEFAULT_MODEL_TIER_MAP                → "tier-default"
 *
 * Any layer may hold a `latest:` alias. An alias that resolves to nothing
 * (empty catalog, everything filtered) falls through to the next layer.
 *
 * Guardrails for `latest:` aliases:
 *   - `@stable` (default) drops preview/experimental ids and models younger
 *     than MODEL_LATEST_SOAK_DAYS (default 2).
 *   - Unpriced catalog models are never picked.
 *   - MODEL_AUTO_UPGRADE=false freezes each alias at its last recorded
 *     resolution (resolves normally only the first time).
 *   - Every change of an alias's resolution writes one
 *     `model_alias_resolutions` row and logs one notice after commit.
 *
 * See runbooks/model-tiers.md.
 */
import {
  harnessCatalogSection,
  isAlias,
  type ModelsDevCatalog,
  type ModelsDevModel,
  parseAlias,
  resolveAlias,
} from "@desplega/model-catalog";
import { z } from "zod";
import {
  DEFAULT_MODEL_TIER_MAP,
  MODEL_TIERS,
  type ModelTier,
  type ModelTierOverrides,
  type ProviderName,
  ProviderNameSchema,
  parseModelTier,
} from "../types";
import { getDbClient } from "./db";
import {
  CLI_PINNED_HARNESSES,
  fallbackForUnsupportedModel,
  getAgentHarnessCliVersion,
  getHarnessModelSupport,
  noticeCliUnsupported,
  unsupportedModelMessage,
} from "./harness-model-support";
import {
  buildCatalogEntries,
  listModelCatalog,
  listModelCatalogOverlay,
  type ModelCatalogEntry,
  type ModelCatalogFacts,
} from "./model-catalog-store";
import { tierConfigKey } from "./model-tier-keys";
import { loadModelsDevCache } from "./modelsdev-cache";

export { isTierConfigKey, tierConfigKey, validateTierConfigValue } from "./model-tier-keys";

export type ModelSource =
  | "model"
  | "worker-env"
  | "tier-config"
  | "tier-default"
  | "fallback:cli-unsupported";

export interface TaskModelResolution {
  resolvedModel: string;
  modelSource: ModelSource;
  modelAlias: string | null;
}

export const DEFAULT_MODEL_LATEST_SOAK_DAYS = 2;

// ─── Worker overrides (agents.modelTierOverrides) ────────────────────────────

const OverridesSchema = z.record(z.string(), z.record(z.string(), z.string()));

/** Keep only known providers/tiers and sane values. */
export function sanitizeModelTierOverrides(raw: unknown): ModelTierOverrides {
  const parsed = OverridesSchema.safeParse(raw);
  if (!parsed.success) return {};
  const result: ModelTierOverrides = {};
  for (const [provider, tiers] of Object.entries(parsed.data)) {
    if (!ProviderNameSchema.safeParse(provider).success) continue;
    const clean: Partial<Record<ModelTier, string>> = {};
    for (const [tier, value] of Object.entries(tiers)) {
      const t = parseModelTier(tier);
      const v = value.trim();
      if (t && t === tier && v && v.length <= 200 && !/\s/.test(v)) clean[t] = v;
    }
    if (Object.keys(clean).length > 0) result[provider] = clean;
  }
  return result;
}

/** Parse the `X-Model-Tier-Overrides` poll header (URL-encoded JSON). */
export function parseModelTierOverridesHeader(
  header: string | null | undefined,
): ModelTierOverrides | undefined {
  if (header === null || header === undefined || header === "") return undefined;
  try {
    return sanitizeModelTierOverrides(JSON.parse(decodeURIComponent(header)));
  } catch {
    return undefined;
  }
}

export async function getAgentModelTierOverrides(agentId: string): Promise<ModelTierOverrides> {
  const row = await getDbClient().get<{ modelTierOverrides: string | null }>(
    "SELECT modelTierOverrides FROM agents WHERE id = ?",
    [agentId],
  );
  if (!row?.modelTierOverrides) return {};
  try {
    return sanitizeModelTierOverrides(JSON.parse(row.modelTierOverrides));
  } catch {
    return {};
  }
}

/** Store the worker's overrides; no write when unchanged. Empty object clears. */
export async function setAgentModelTierOverrides(
  agentId: string,
  overrides: ModelTierOverrides,
): Promise<void> {
  const next = Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : null;
  await getDbClient().run(
    "UPDATE agents SET modelTierOverrides = ? WHERE id = ? AND modelTierOverrides IS NOT ?",
    [next, agentId, next],
  );
}

// ─── Catalog for alias resolution ────────────────────────────────────────────

const CATALOG_TTL_MS = 30_000;
let cachedCatalog: { at: number; catalog: ModelsDevCatalog; priced: Set<string> } | null = null;

export function invalidateTierResolutionCatalog(): void {
  cachedCatalog = null;
}

function mergeFacts(base: ModelCatalogFacts, overlay: ModelCatalogFacts): ModelCatalogFacts {
  const merged: ModelCatalogFacts = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== null && value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * Catalog view for `resolveAlias`: `model_catalog` + overlay (overlay wins per
 * non-null field). Empty table → the vendored models.dev snapshot.
 */
async function loadResolutionCatalog(): Promise<{
  catalog: ModelsDevCatalog;
  priced: Set<string>;
}> {
  const now = Date.now();
  if (cachedCatalog && now - cachedCatalog.at < CATALOG_TTL_MS) return cachedCatalog;

  let entries: ModelCatalogEntry[] = await listModelCatalog();
  if (entries.length === 0) {
    const snapshot = loadModelsDevCache();
    entries = snapshot ? buildCatalogEntries(snapshot, 0) : [];
  }
  const facts = new Map<string, { provider: string; modelId: string; facts: ModelCatalogFacts }>();
  for (const entry of entries) {
    facts.set(`${entry.provider}/${entry.modelId}`, {
      provider: entry.provider,
      modelId: entry.modelId,
      facts: entry,
    });
  }
  for (const overlay of await listModelCatalogOverlay()) {
    const key = `${overlay.provider}/${overlay.modelId}`;
    const existing = facts.get(key);
    facts.set(key, {
      provider: overlay.provider,
      modelId: overlay.modelId,
      facts: existing ? mergeFacts(existing.facts, overlay) : overlay,
    });
  }

  const catalog: ModelsDevCatalog = {};
  const priced = new Set<string>();
  for (const { provider, modelId, facts: f } of facts.values()) {
    catalog[provider] ??= { id: provider, name: provider, models: {} };
    const model: ModelsDevModel = {
      ...(f.name ? { name: f.name } : {}),
      ...(f.releaseDate ? { release_date: f.releaseDate } : {}),
      ...(f.contextWindow ? { limit: { context: f.contextWindow } } : {}),
      ...(f.pricing ? { cost: f.pricing } : {}),
    };
    catalog[provider].models[modelId] = model;
    const p = f.pricing;
    if (p && (typeof p.input === "number" || typeof p.output === "number")) {
      priced.add(`${provider}/${modelId}`);
    }
  }
  cachedCatalog = { at: now, catalog, priced };
  return cachedCatalog;
}

// ─── Alias resolution + change log ───────────────────────────────────────────

function soakDays(): number {
  const raw = process.env.MODEL_LATEST_SOAK_DAYS?.trim();
  if (!raw) return DEFAULT_MODEL_LATEST_SOAK_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MODEL_LATEST_SOAK_DAYS;
}

function autoUpgradeEnabled(): boolean {
  const raw = process.env.MODEL_AUTO_UPGRADE?.trim().toLowerCase();
  return !(raw === "false" || raw === "0");
}

async function lastAliasResolution(alias: string): Promise<string | null> {
  const row = await getDbClient().get<{ newModel: string }>(
    "SELECT newModel FROM model_alias_resolutions WHERE alias = ? ORDER BY id DESC LIMIT 1",
    [alias],
  );
  return row?.newModel ?? null;
}

/**
 * Resolve a `latest:` alias with the guardrails above. Returns null when the
 * alias is invalid or nothing in the catalog qualifies.
 */
export async function resolveLatestAlias(
  alias: string,
  now: Date = new Date(),
  opts: { record?: boolean } = {},
): Promise<string | null> {
  const parsed = parseAlias(alias);
  if (!parsed) return null;
  const key = alias.trim().toLowerCase();
  const previous = await lastAliasResolution(key);
  if (previous && !autoUpgradeEnabled()) return previous;

  const { catalog, priced } = await loadResolutionCatalog();
  const section = parsed.kind;
  const resolved = resolveAlias(key, catalog, {
    soakDays: soakDays(),
    now,
    isSupported: (id) => priced.has(`${section}/${id}`),
  });
  if (!resolved) return null;

  if (resolved !== previous && opts.record !== false) {
    await getDbClient().run(
      "INSERT INTO model_alias_resolutions (alias, previousModel, newModel, changedAt) VALUES (?, ?, ?, ?)",
      [key, previous, resolved, now.getTime()],
    );
    getDbClient().afterCommit(() => {
      console.info(
        `[model-tiers] alias ${key} now resolves to ${resolved}${previous ? ` (was ${previous})` : ""}`,
      );
    });
  }
  return resolved;
}

// ─── Task resolution ─────────────────────────────────────────────────────────

export interface ResolveTaskModelInput {
  model?: string | null;
  modelTier?: string | null;
  harnessProvider: ProviderName | null | undefined;
  workerOverrides?: ModelTierOverrides;
  /** Where tier-config values are read from. Default `process.env` (global swarm_config is hydrated into it). */
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Default true. False resolves `latest:` aliases without writing `model_alias_resolutions` (previews). */
  record?: boolean;
}

/** Ordered candidates by precedence; no IO. */
export function taskModelCandidates(
  input: ResolveTaskModelInput,
): { value: string; source: ModelSource }[] {
  const candidates: { value: string; source: ModelSource }[] = [];
  const model = input.model?.trim();
  if (model) candidates.push({ value: model, source: "model" });
  const tier = parseModelTier(input.modelTier);
  const provider = input.harnessProvider;
  if (tier && provider) {
    const worker = input.workerOverrides?.[provider]?.[tier]?.trim();
    if (worker) candidates.push({ value: worker, source: "worker-env" });
    const env = input.env ?? process.env;
    const configured = env[tierConfigKey(provider, tier)]?.trim();
    if (configured) candidates.push({ value: configured, source: "tier-config" });
    const fallback = DEFAULT_MODEL_TIER_MAP[provider]?.[tier];
    if (fallback) candidates.push({ value: fallback, source: "tier-default" });
  }
  return candidates;
}

/** Resolve a task's model at claim time. Null when the task names neither model nor tier. */
export async function resolveTaskModel(
  input: ResolveTaskModelInput,
): Promise<TaskModelResolution | null> {
  for (const candidate of taskModelCandidates(input)) {
    if (!isAlias(candidate.value)) {
      return { resolvedModel: candidate.value, modelSource: candidate.source, modelAlias: null };
    }
    const resolved = await resolveLatestAlias(candidate.value, input.now, {
      record: input.record,
    });
    if (resolved) {
      return {
        resolvedModel: resolved,
        modelSource: candidate.source,
        modelAlias: candidate.value.trim().toLowerCase(),
      };
    }
    console.warn(
      `[model-tiers] ${candidate.source} alias ${candidate.value} resolved to nothing; trying next layer`,
    );
  }
  return null;
}

// ─── Tier preview ────────────────────────────────────────────────────────────

export interface ModelTierPreview {
  provider: ProviderName;
  tier: ModelTier;
  /** swarm_config / env key that overrides this tier globally. */
  key: string;
  /** The built-in DEFAULT_MODEL_TIER_MAP value. */
  defaultValue: string;
  /** The value stored for `key`, or null when unset. */
  configured: string | null;
  /** Layer that wins today: the configured value, else the built-in default. */
  source: "tier-config" | "tier-default";
  /** What that layer resolves to right now (`latest:` aliases resolved). Null when nothing qualifies. */
  resolvedModel: string | null;
  /** The `latest:` alias behind `resolvedModel`, when any. */
  alias: string | null;
}

/**
 * Every provider x tier with its default, configured value and the model it
 * resolves to now. Read-only: `latest:` aliases resolve without writing
 * `model_alias_resolutions`. Ignores per-worker overrides and per-task models,
 * so it answers "what does a `modelTier=<tier>` task get on a fresh <provider>
 * worker".
 */
export async function previewModelTiers(
  opts: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<ModelTierPreview[]> {
  const env = opts.env ?? process.env;
  const rows: ModelTierPreview[] = [];
  for (const provider of ProviderNameSchema.options) {
    // A provider with no portable tier mapping (acp) has nothing to preview.
    if (MODEL_TIERS.every((tier) => !DEFAULT_MODEL_TIER_MAP[provider][tier])) continue;
    for (const tier of MODEL_TIERS) {
      const key = tierConfigKey(provider, tier);
      const configured = env[key]?.trim() || null;
      const resolution = await resolveTaskModel({
        modelTier: tier,
        harnessProvider: provider,
        env,
        now: opts.now,
        record: false,
      });
      rows.push({
        provider,
        tier,
        key,
        defaultValue: DEFAULT_MODEL_TIER_MAP[provider][tier],
        configured,
        source: resolution?.modelSource === "tier-config" ? "tier-config" : "tier-default",
        resolvedModel: resolution?.resolvedModel ?? null,
        alias: resolution?.modelAlias ?? null,
      });
    }
  }
  return rows;
}

/**
 * Apply the claiming worker's CLI support (harness_model_support). Returns the
 * resolution to use, or `{ unsupported }` when an explicit task `model` is
 * rejected by this CLI and must fail fast.
 */
async function applyCliSupport(
  resolution: TaskModelResolution,
  harness: string | null,
  cliVersion: string | null,
): Promise<TaskModelResolution | { unsupported: string }> {
  if (!harness || !cliVersion || !CLI_PINNED_HARNESSES.has(harness)) return resolution;
  const status = await getHarnessModelSupport(harness, cliVersion, resolution.resolvedModel);
  if (status !== "unsupported") return resolution;
  if (resolution.modelSource === "model") {
    return { unsupported: unsupportedModelMessage(harness, cliVersion, resolution.resolvedModel) };
  }
  const section = harnessCatalogSection(harness);
  const { catalog } = await loadResolutionCatalog();
  const fallback = await fallbackForUnsupportedModel(
    harness,
    cliVersion,
    resolution.resolvedModel,
    (section && catalog[section]?.models) || {},
  );
  if (!fallback) return resolution;
  noticeCliUnsupported(harness, cliVersion, resolution.resolvedModel, fallback);
  return { ...resolution, resolvedModel: fallback, modelSource: "fallback:cli-unsupported" };
}

export type ClaimModelFields = Partial<TaskModelResolution> & {
  /** Set when the task's explicit model is rejected by this worker's CLI; the worker fails the task. */
  modelUnsupported?: string;
};

/**
 * Resolve and record the model for a task the given agent is claiming. Runs
 * inside the claim transaction. Returns the fields to merge into the trigger.
 */
export async function recordClaimModelResolution(
  task: { id: string; model?: string | null; modelTier?: string | null },
  agent: { id: string; harnessProvider?: ProviderName | null; provider?: ProviderName | null },
): Promise<ClaimModelFields> {
  const harnessProvider = agent.harnessProvider ?? agent.provider ?? null;
  const resolved = await resolveTaskModel({
    model: task.model,
    modelTier: task.modelTier,
    harnessProvider,
    workerOverrides: await getAgentModelTierOverrides(agent.id),
  });
  if (!resolved) return {};
  const checked = await applyCliSupport(
    resolved,
    harnessProvider,
    await getAgentHarnessCliVersion(agent.id),
  );
  if ("unsupported" in checked) {
    return { modelUnsupported: checked.unsupported };
  }
  const resolution = checked;
  await getDbClient().run(
    "UPDATE agent_tasks SET resolvedModel = ?, modelSource = ?, modelAlias = ? WHERE id = ?",
    [resolution.resolvedModel, resolution.modelSource, resolution.modelAlias, task.id],
  );
  return resolution.modelAlias
    ? resolution
    : { resolvedModel: resolution.resolvedModel, modelSource: resolution.modelSource };
}
