/**
 * Validates an EXPLICIT model id (a task, schedule, workflow node or agent
 * runtime `model`) against the model catalog, so a typo fails at the call that
 * made it instead of running as an unknown string ("claude-nonexistent-9").
 *
 * Known:
 *   - a `latest:<provider>/<family>` alias that is valid grammar and resolves to a catalog model;
 *   - a catalog id, bare (`claude-opus-5-5`, `gpt-5.6-sol`) or provider-qualified
 *     (`openrouter/deepseek/deepseek-v4.1-flash`, `amazon-bedrock/...`);
 *   - a Claude CLI shortname (`opus`, `sonnet`, ...), which the CLI resolves itself.
 *
 * Escape hatch: `allowCustomModel: true` on the call (tools, REST bodies, workflow node
 * config, the agent runtime PATCH). Custom ids skip the check and are stored as given, for
 * models the catalog cannot list yet (a fresh launch not in models.dev, a private
 * deployment, an ACP-only model). Harnesses whose model namespace the catalog does not
 * describe (`acp`, `devin`, `dsh`, `cursor`: its catalog is per account) skip the check when the caller names the harness.
 *
 * Harness compatibility: when the harness is known, a concrete id or `latest:` alias must
 * belong to the catalog section that harness's CLI talks to (`harnessModelError`). The
 * escape hatch does not bypass this for an id the catalog files under another section:
 * the flag means "the catalog does not know this id yet", not "run an Anthropic id in
 * Codex". Claim time re-checks the harness (see `resolveTaskModel`).
 */
import {
  buildClaudeShortnameMap,
  type HarnessCatalogSections,
  harnessModelMismatch,
  isAlias,
  type ModelsDevCatalog,
  parseAlias,
} from "@desplega/model-catalog";
import { ampModelError } from "../utils/amp-models";
import { getAgentById, getAllAgents } from "./db";
import { loadModelsCatalog } from "./model-catalog-store";
import { resolveLatestAlias } from "./model-tier-resolution";

/** Harnesses whose model ids the catalog does not describe. */
const FREE_FORM_HARNESSES = new Set(["acp", "devin", "dsh", "cursor"]);

/** Claude CLI context-window suffix (`sonnet[1m]`): the CLI reads it, the catalog does not list it. */
const CONTEXT_SUFFIX_RE = /\[1m\]$/i;
/** Bedrock cross-region inference profile prefix (`us.anthropic.claude-...`). */
const BEDROCK_REGION_PREFIX_RE = /^(?:us|eu|apac|global|us-gov)\./;

type CatalogSections = Record<string, { models?: Record<string, unknown> } | undefined>;

function hasModel(catalog: CatalogSections, provider: string, modelId: string): boolean {
  const models = catalog[provider]?.models;
  return Boolean(models && Object.hasOwn(models, modelId));
}

/** Whether `model` names something in the catalog (see the module doc). Pure. */
export function isKnownCatalogModel(model: string, catalog: CatalogSections): boolean {
  const id = model.trim().replace(CONTEXT_SUFFIX_RE, "");
  if (!id) return false;
  const slash = id.indexOf("/");
  if (slash > 0) {
    const provider = id.slice(0, slash);
    const rest = id.slice(slash + 1);
    if (hasModel(catalog, provider, rest)) return true;
    if (provider === "amazon-bedrock") {
      return hasModel(catalog, provider, rest.replace(BEDROCK_REGION_PREFIX_RE, ""));
    }
  }
  for (const provider of Object.keys(catalog)) {
    if (hasModel(catalog, provider, id)) return true;
  }
  const anthropic = catalog.anthropic?.models as ModelsDevCatalog[string]["models"] | undefined;
  return Object.hasOwn(buildClaudeShortnameMap(anthropic), id);
}

export interface ExplicitModelCheck {
  /** The model the caller named. Empty or absent values pass: there is nothing to check. */
  model: string | null | undefined;
  /** Skip the check: the caller vouches for a custom id. */
  allowCustomModel?: boolean;
  /** The harness the model is for, when known (the assignee or the agent being configured). */
  harnessProvider?: string | null;
  /** The assignee, when known: named in the harness mismatch message. */
  agentId?: string | null;
  agentName?: string | null;
}

/** Null when `model` runs on `harness`, else the reason. Pure; only judges claude, claude-managed, codex. */
export const harnessModelError = harnessModelMismatch;

/** `harnessModelError` against the current catalog, for callers with no agent row (claim path). */
export async function harnessModelErrorFor(
  model: string,
  harness: string | null | undefined,
): Promise<string | null> {
  const { providers } = await loadModelsCatalog();
  return harnessModelMismatch(model, harness, providers as HarnessCatalogSections, {});
}

/**
 * Pool claim filter: false when an unassigned task pins a `model` that `harness` cannot
 * run, so an incompatible worker skips it and a compatible one takes it. `isAgentEligibleForTask`
 * stays sync and catalog-free; this runs next to it.
 */
export async function poolTaskRunsOnHarness(
  task: { model?: string | null } | null | undefined,
  harness: string | null | undefined,
): Promise<boolean> {
  const model = task?.model?.trim();
  if (!model) return true;
  return (await harnessModelErrorFor(model, harness)) === null;
}

/**
 * The error message for an unknown explicit model, or null when it is fine.
 * An empty catalog (nothing to judge against) passes.
 */
export async function explicitModelError(check: ExplicitModelCheck): Promise<string | null> {
  const model = check.model?.trim();
  if (!model) return null;
  if (check.harnessProvider && FREE_FORM_HARNESSES.has(check.harnessProvider)) return null;
  // Amp runs a mode or a provider/model pin, nothing else; the catalog does not describe either.
  if (check.harnessProvider === "amp") return ampModelError(model);

  const { providers } = await loadModelsCatalog();
  const catalog = providers as CatalogSections;
  if (check.harnessProvider) {
    const mismatch = harnessModelMismatch(
      model,
      check.harnessProvider,
      catalog as HarnessCatalogSections,
      { agentId: check.agentId, agentName: check.agentName },
    );
    if (mismatch) return mismatch;
  }
  if (check.allowCustomModel) return null;

  if (isAlias(model)) {
    if (!parseAlias(model)) {
      return `Invalid model alias "${model}". Use latest:<provider>/<family>[@stable|@any], e.g. latest:anthropic/opus.`;
    }
    const resolved = await resolveLatestAlias(model, new Date(), { record: false });
    return resolved
      ? null
      : `Model alias "${model}" matches no model in the catalog. Check the provider and family, or use a concrete model id.`;
  }

  if (Object.keys(catalog).length === 0) return null;
  if (isKnownCatalogModel(model, catalog)) return null;
  return `Unknown model "${model}": it is not in the model catalog. Use a catalog model id, a Claude CLI shortname (opus, sonnet, haiku, fable), a latest:<provider>/<family> alias, or modelTier. To run a custom model id anyway, set allowCustomModel: true (allow_custom_model on the agent runtime).`;
}

/**
 * `explicitModelError` for a model that will run on `agentId` (or on whichever
 * worker claims it when there is none): the assignee's harness decides whether
 * the catalog describes its models, and whether the model runs on it.
 *
 * Pool task (no agent): a concrete model must run on the harness of at least one
 * registered agent, else no claim can ever succeed. With no agents registered
 * there is nothing to judge against, and the check passes.
 */
export async function explicitModelErrorForAgent(
  check: Omit<ExplicitModelCheck, "harnessProvider" | "agentName">,
): Promise<string | null> {
  const model = check.model?.trim();
  if (!model) return null;
  const agent = check.agentId ? await getAgentById(check.agentId) : null;
  if (agent) {
    return explicitModelError({
      ...check,
      agentId: agent.id,
      agentName: agent.name,
      harnessProvider: agent.harnessProvider ?? agent.provider ?? null,
    });
  }
  if (!check.agentId && !isAlias(model)) {
    const poolError = await poolHarnessModelError(model);
    if (poolError) return poolError;
  }
  return explicitModelError({ ...check, harnessProvider: null });
}

async function poolHarnessModelError(model: string): Promise<string | null> {
  const agents = await getAllAgents({ slim: true });
  if (agents.length === 0) return null;
  const { providers } = await loadModelsCatalog();
  const sections = providers as HarnessCatalogSections;
  const harnesses = new Set<string>();
  for (const agent of agents) {
    const harness = agent.harnessProvider ?? agent.provider ?? null;
    if (!harnessModelMismatch(model, harness, sections)) return null;
    if (harness) harnesses.add(harness);
  }
  return `Model "${model}" does not run on any registered agent harness (${[...harnesses].sort().join(", ")}). Use modelTier (smol, regular, smart, ultra) for portable intent, or omit model and let the claiming agent resolve it.`;
}
