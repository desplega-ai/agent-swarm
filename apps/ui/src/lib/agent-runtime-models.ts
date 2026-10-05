import {
  buildClaudeShortnameMap,
  claudeCatalogModelId,
  cursorCatalogRef,
  dshCatalogRef,
  harnessModelIds,
  isReasoningHarness,
  modelDisplayName,
  type ReasoningEffortLevel,
  reasoningLevelsFor,
} from "@desplega/model-catalog";
import type { ProviderName, SwarmConfig } from "@/api/types";
import modelsCache from "./modelsdev-cache.json";

// Every `@/api/types` import here is `import type`: backend unit tests import
// this module by relative path with no bundler (`src/tests/agents-list-model-display.test.ts`,
// `src/tests/bedrock-model-groups.test.ts`), and a runtime `@/` import cannot
// resolve there.

export type LocalHarnessProvider =
  | "claude"
  | "codex"
  | "pi"
  | "opencode"
  | "acp"
  | "dsh"
  | "cursor";

/** USD per 1M tokens, as models.dev names the rates. Cache rates are absent for models without prompt caching. */
export interface ModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  providerId: ProviderIconKey | null;
  requiredKey: string;
  cost?: ModelCost;
  contextWindow?: number;
  /** Catalog lifecycle flag (`deprecated`, `legacy`, `beta`, `alpha`); absent for a stable model. */
  status?: string;
  /** ISO release date from the catalog, when it has one. */
  releaseDate?: string;
  /**
   * The effort levels the harness this option was listed for accepts on this
   * model (`reasoningLevelsFor`, the rule the API validates with). Empty when
   * the model takes no effort. Absent on options built outside a harness list
   * (`findKnownModel`): use `effortLevelsFor` when the harness is known.
   */
  reasoningLevels?: ReadonlyArray<ReasoningEffortLevel>;
}

export type ProviderIconKey = "anthropic" | "openai" | "openrouter" | "amazon-bedrock";

export interface ModelGroup {
  provider: string;
  models: ModelOption[];
  requiredKey: string;
  enabled: boolean;
  /**
   * Optional reason this group is disabled, surfaced as picker subtext. Used by
   * the Bedrock group when a worker has reported but its probe failed
   * (ready:false) — e.g. an expired token or a missing AWS_REGION — so the
   * operator sees WHY instead of a silently disabled group.
   */
  disabledReason?: string;
}

export type SnapshotProviderId = "openrouter" | "anthropic" | "openai" | "amazon-bedrock";

type CatalogProviderId = SnapshotProviderId | "opencode" | "deepseek";

interface CachedReasoningOption {
  type: string;
  values?: string[];
}

interface CachedModel {
  id: string;
  name?: string;
  cost?: ModelCost;
  limit?: { context?: number };
  release_date?: string;
  status?: string;
  reasoning?: boolean;
  reasoning_options?: CachedReasoningOption[];
}

interface CachedProvider {
  id: string;
  name?: string;
  models: Record<string, CachedModel>;
}

/**
 * Live catalog fetched from `GET /api/models-catalog` (see
 * `src/be/models-catalog.ts`) — same shape and field names as the bundled
 * snapshot, so live and static data flow through identical code. When a
 * provider is present here it is preferred over the build-time snapshot;
 * when the fetch hasn't resolved the snapshot keeps the picker non-blank.
 */
export type LiveModelsCatalog = Partial<Record<CatalogProviderId, CachedProvider>>;

const CACHE = modelsCache as unknown as Record<string, CachedProvider | undefined>;

/** A provider section of `source`, or undefined for a key it does not own (never a prototype member). */
function sectionOf(
  source: Partial<Record<string, CachedProvider>> | null | undefined,
  providerId: string,
): CachedProvider | undefined {
  return source && Object.hasOwn(source, providerId) ? source[providerId] : undefined;
}

/** The catalog facts every `ModelOption` carries, read from one catalog row. */
function catalogFacts(
  model: CachedModel,
): Pick<ModelOption, "cost" | "contextWindow" | "status" | "releaseDate"> {
  return {
    cost: model.cost,
    contextWindow: model.limit?.context,
    status: model.status,
    releaseDate: model.release_date,
  };
}

// --- Reasoning-effort capability --------------------------------------------
// The rule lives in `@desplega/model-catalog` (`reasoningLevelsFor`), shared with
// the API, which rejects an effort outside it. This is only the catalog lookup.

/**
 * A provider section as the API's runtime catalog holds it: the bundled
 * snapshot overlaid by the live catalog, the live row winning per model id.
 */
function runtimeSectionModels(
  providerId: string,
  liveCatalog: LiveModelsCatalog | null | undefined,
): Record<string, CachedModel> {
  const snapshot = sectionOf(CACHE, providerId)?.models;
  const live = sectionOf(liveCatalog, providerId)?.models;
  return live ? { ...snapshot, ...live } : (snapshot ?? {});
}

/**
 * The reasoning-effort levels `harness` accepts for `modelId`: exactly what
 * `PATCH /api/agents/:id/runtime` allows, so an effort picker offers these and
 * nothing else. Empty for a harness with no effort control (acp, devin,
 * claude-managed), a model the catalog does not list (custom strings), and a
 * model that does not reason.
 *
 * `modelId` is the string the harness stores: a bare id for claude and codex
 * (a Claude CLI shortname such as `opus` resolves to the newest model of its
 * family), `<provider>/<id>` for pi and opencode, `openrouter/<id>` or a bare
 * DeepSeek API id for dsh, a bare Cursor model id for cursor.
 */
export function effortLevelsFor(
  harness: string,
  modelId: string | null | undefined,
  liveCatalog?: LiveModelsCatalog | null,
): ReasoningEffortLevel[] {
  if (!modelId || !isReasoningHarness(harness)) return [];
  let providerId: string;
  let catalogId: string;
  if (harness === "claude") {
    providerId = "anthropic";
    catalogId = claudeCatalogModelId(modelId, runtimeSectionModels(providerId, liveCatalog));
  } else if (harness === "codex") {
    providerId = "openai";
    catalogId = modelId;
  } else if (harness === "dsh") {
    ({ providerId, modelId: catalogId } = dshCatalogRef(modelId));
  } else if (harness === "cursor") {
    ({ providerId, modelId: catalogId } = cursorCatalogRef(modelId));
  } else {
    // The id may hold more slashes (`openrouter/google/gemini-3-flash-preview`).
    const slash = modelId.indexOf("/");
    if (slash <= 0) return [];
    providerId = modelId.slice(0, slash);
    catalogId = modelId.slice(slash + 1);
  }
  const facts =
    sectionOf(liveCatalog, providerId)?.models?.[catalogId] ??
    sectionOf(CACHE, providerId)?.models?.[catalogId];
  return reasoningLevelsFor(harness, catalogId, facts);
}

/**
 * The effort to keep when the harness or model changes: `current` when the new
 * (harness, model) pair takes it, else `""` (Auto, no override). An effort the
 * pair cannot take resets to Auto and is never coerced to a neighbour, so the
 * operator sees the change instead of a level they did not pick.
 */
export function effortAfterChange(
  current: ReasoningEffortLevel | "",
  harness: string,
  modelId: string | null | undefined,
  liveCatalog?: LiveModelsCatalog | null,
): ReasoningEffortLevel | "" {
  if (!current) return "";
  return effortLevelsFor(harness, modelId, liveCatalog).includes(current) ? current : "";
}

/**
 * The catalog id a Claude CLI shortname (`opus`, `sonnet`, `fable`) stands for:
 * the newest model of that family. A catalog id comes back unchanged.
 */
export function claudeModelId(modelId: string, liveCatalog?: LiveModelsCatalog | null): string {
  return claudeCatalogModelId(modelId, runtimeSectionModels("anthropic", liveCatalog));
}

/**
 * The DeepSeek-direct catalog section (the bare ids dsh reads with
 * `DEEPSEEK_API_KEY`). The API's live catalog does not carry it, so this is
 * the bundled snapshot until it does.
 */
export function deepseekCatalogModels(
  liveCatalog?: LiveModelsCatalog | null,
): Record<string, CachedModel> {
  return runtimeSectionModels("deepseek", liveCatalog);
}

export const LOCAL_HARNESSES: LocalHarnessProvider[] = [
  "claude",
  "codex",
  "pi",
  "opencode",
  "dsh",
  "cursor",
  "acp",
];

/**
 * The Cursor models the picker offers: a curated subset of what
 * `Cursor.models.list()` returns. The real list is per account, so a custom
 * id still goes through; labels and rates come from the vendor's catalog row.
 */
export const CURSOR_MODELS = [
  "composer-2.5",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "grok-4.6",
] as const;

/**
 * The models dsh's DeepSeek-direct route serves out of the box (its bundled
 * `deepseek-official` catalog). dsh rejects other bare ids, so the picker
 * offers only these; anything else goes through OpenRouter or a custom id.
 */
export const DSH_DIRECT_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;

export const HARNESS_LABEL: Record<ProviderName | string, string> = {
  claude: "Claude",
  "claude-managed": "Claude (managed)",
  codex: "Codex",
  devin: "Devin",
  opencode: "Opencode",
  pi: "Pi-Mono",
  acp: "ACP",
  dsh: "DeepSeek (dsh)",
  cursor: "Cursor",
} satisfies Record<ProviderName, string>;

export function harnessSupportsModelSelection(harness: LocalHarnessProvider): boolean {
  return harness !== "acp";
}

const ANTHROPIC_META = {
  provider: "Anthropic",
  providerId: "anthropic" as const,
  requiredKey: "ANTHROPIC_API_KEY",
};
const OPENAI_META = {
  provider: "OpenAI",
  providerId: "openai" as const,
  requiredKey: "OPENAI_API_KEY",
};

/** Builds a direct-registry `ModelOption` from one catalog row (live or snapshot). */
function directModel(
  harness: "claude" | "codex",
  model: CachedModel,
  meta: typeof ANTHROPIC_META | typeof OPENAI_META,
): ModelOption {
  return {
    id: model.id,
    label: modelDisplayName(model.name) ?? humanizeModelId(model.id),
    ...meta,
    ...catalogFacts(model),
    reasoningLevels: reasoningLevelsFor(harness, model.id, model),
  };
}

/**
 * Direct-harness picker options, derived from the catalog (newest first). No
 * hand-maintained list: a model added to the API's `model_catalog` (refresh
 * or overlay row) shows up here on the next catalog fetch.
 */
function directModels(
  harness: "claude" | "codex",
  liveCatalog?: LiveModelsCatalog | null,
): ModelOption[] {
  const section: SnapshotProviderId = harness === "claude" ? "anthropic" : "openai";
  const models = (liveCatalog?.[section] ?? CACHE[section])?.models ?? {};
  const meta = harness === "claude" ? ANTHROPIC_META : OPENAI_META;
  return harnessModelIds(harness, models).map((id) =>
    directModel(harness, { ...models[id], id }, meta),
  );
}

// Mirrors the any-of credential checks in the harness adapters:
// `claude-adapter.ts` accepts `CLAUDE_CODE_OAUTH_TOKEN` OR `ANTHROPIC_API_KEY`;
// `codex-adapter.ts` accepts `OPENAI_API_KEY` OR `CODEX_OAUTH`.
const DIRECT_HARNESS_ACCEPTED_KEYS: Record<"claude" | "codex", string[]> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_OAUTH"],
};

const SNAPSHOT_ORDER: SnapshotProviderId[] = ["openrouter", "anthropic", "openai"];

/** Bedrock-specific snapshot ID — kept separate from SNAPSHOT_ORDER since it is
 *  only shown for the pi harness, not for opencode. */
const BEDROCK_SNAPSHOT_ID: SnapshotProviderId = "amazon-bedrock";

const SNAPSHOT_META: Record<
  SnapshotProviderId,
  { label: string; requiredKey: string; iconKey: ProviderIconKey }
> = {
  openrouter: {
    label: "OpenRouter",
    requiredKey: "OPENROUTER_API_KEY",
    iconKey: "openrouter",
  },
  anthropic: { label: "Anthropic", requiredKey: "ANTHROPIC_API_KEY", iconKey: "anthropic" },
  openai: { label: "OpenAI", requiredKey: "OPENAI_API_KEY", iconKey: "openai" },
  /**
   * Amazon Bedrock — credentials come from the AWS SDK default chain, not a
   * single env var. `requiredKey` is a human label (not an env key); the group's
   * enabled state is driven by the worker's live `ready` flag, not by presence
   * of any one variable. `AWS_REGION` only selects which region is enumerated.
   */
  "amazon-bedrock": {
    label: "Amazon Bedrock",
    requiredKey: "AWS credential chain",
    iconKey: "amazon-bedrock",
  },
};

/** Preferred picker default per harness; empty = the newest catalog model (Opus for claude). */
const FALLBACK_MODEL: Record<LocalHarnessProvider, string> = {
  claude: "",
  codex: "",
  pi: "openrouter/google/gemini-3-flash-preview",
  opencode: "openrouter/qwen/qwen3-coder-flash",
  // The dsh regular-tier default (DEFAULT_MODEL_TIER_MAP.dsh in src/types.ts).
  dsh: "openrouter/deepseek/deepseek-v4.1-flash",
  // The cursor regular-tier default (DEFAULT_MODEL_TIER_MAP.cursor in src/types.ts).
  cursor: "claude-sonnet-5-5",
  acp: "",
};

function hasConfigKey(configs: SwarmConfig[] | undefined, key: string): boolean {
  return Boolean(configs?.some((c) => c.key === key && c.value !== ""));
}

// Codex OAuth is the only credential whose swarm_config key shape diverges
// from the env-var name. Storage uses `codex_oauth_0`, `codex_oauth_1`, …
// per slot (plus the legacy single-slot `codex_oauth`). See
// `src/providers/codex-oauth/storage.ts`.
const CODEX_OAUTH_SLOT_RE = /^codex_oauth(_\d+)?$/;

function hasCodexOAuthSlot(configs: SwarmConfig[] | undefined): boolean {
  return Boolean(configs?.some((c) => CODEX_OAUTH_SLOT_RE.test(c.key) && c.value !== ""));
}

export function hasRuntimeCredential(
  key: string,
  configs: SwarmConfig[] | undefined,
  envPresence: Record<string, boolean> | undefined,
): boolean {
  if (envPresence?.[key]) return true;
  if (hasConfigKey(configs, key)) return true;
  if (key === "CODEX_OAUTH") return hasCodexOAuthSlot(configs);
  return false;
}

/**
 * Live Bedrock status reported by the pi worker (from `agent.credStatus.bedrock`).
 * When present, the live model list is preferred over the static snapshot.
 * When absent (worker hasn't reported yet), the static `modelsdev-cache.json`
 * snapshot is used as a fallback — the picker is NEVER blank.
 */
export interface LiveBedrockStatus {
  ready: boolean;
  models: Array<{ id: string; name: string }>;
  /** Probe failure reason (e.g. expired token, unset AWS_REGION) when ready:false. */
  error?: string;
}

export function modelGroupsForHarness(
  harness: LocalHarnessProvider,
  configs: SwarmConfig[] | undefined,
  envPresence: Record<string, boolean> | undefined,
  liveBedrockStatus?: LiveBedrockStatus | null,
  liveCatalog?: LiveModelsCatalog | null,
): ModelGroup[] {
  if (harness === "acp") return [];

  const providerCache = (providerId: SnapshotProviderId): CachedProvider | undefined =>
    liveCatalog?.[providerId] ?? CACHE[providerId];

  if (harness === "claude" || harness === "codex") {
    const models = directModels(harness, liveCatalog);
    const requiredKey = models[0]?.requiredKey ?? "";
    const acceptedKeys = DIRECT_HARNESS_ACCEPTED_KEYS[harness];
    return [
      {
        provider: models[0]?.provider ?? HARNESS_LABEL[harness],
        models,
        requiredKey,
        enabled: acceptedKeys.some((k) => hasRuntimeCredential(k, configs, envPresence)),
      },
    ];
  }

  if (harness === "dsh") return dshModelGroups(configs, envPresence, liveCatalog);
  if (harness === "cursor") return cursorModelGroups(configs, envPresence, liveCatalog);

  const snapshotGroups = SNAPSHOT_ORDER.map((providerId) => {
    const meta = SNAPSHOT_META[providerId];
    const cache = providerCache(providerId);
    const models: ModelOption[] = Object.values(cache?.models ?? {})
      .map((m) => ({
        id: `${providerId}/${m.id}`,
        label: modelDisplayName(m.name) ?? m.id,
        provider: meta.label,
        providerId: meta.iconKey,
        requiredKey: meta.requiredKey,
        ...catalogFacts(m),
        reasoningLevels: reasoningLevelsFor(harness, m.id, m),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      provider: meta.label,
      models,
      requiredKey: meta.requiredKey,
      enabled: hasRuntimeCredential(meta.requiredKey, configs, envPresence),
    };
  });

  // For the pi harness, also expose Amazon Bedrock models.
  if (harness === "pi") {
    const bedrockMeta = SNAPSHOT_META[BEDROCK_SNAPSHOT_ID];
    const bedrockCache = providerCache(BEDROCK_SNAPSHOT_ID);

    let bedrockModels: ModelOption[];
    let bedrockEnabled: boolean;
    let bedrockDisabledReason: string | undefined;

    if (liveBedrockStatus != null) {
      // Worker has reported live models — prefer this list. The live probe
      // only reports `{id, name}`; cross-reference the static snapshot by id
      // for reasoning capability data (best-effort — `undefined` for models
      // the snapshot doesn't know, which the selector treats as unrestricted).
      bedrockModels = liveBedrockStatus.models.map((m) => ({
        id: `amazon-bedrock/${m.id}`,
        label: modelDisplayName(m.name),
        provider: bedrockMeta.label,
        providerId: bedrockMeta.iconKey,
        requiredKey: bedrockMeta.requiredKey,
        reasoningLevels: reasoningLevelsFor("pi", m.id, bedrockCache?.models[m.id]),
      }));
      bedrockEnabled = liveBedrockStatus.ready;
      // Probe ran but failed — surface the reason instead of a silent disable.
      if (!liveBedrockStatus.ready) {
        bedrockDisabledReason =
          liveBedrockStatus.error ?? "Bedrock probe failed — check AWS credentials and AWS_REGION.";
      }
    } else {
      // No worker report yet — fall back to static snapshot (NEVER blank).
      bedrockModels = Object.values(bedrockCache?.models ?? {})
        .map((m) => ({
          id: `amazon-bedrock/${m.id}`,
          label: modelDisplayName(m.name) ?? m.id,
          provider: bedrockMeta.label,
          providerId: bedrockMeta.iconKey,
          requiredKey: bedrockMeta.requiredKey,
          ...catalogFacts(m),
          reasoningLevels: reasoningLevelsFor("pi", m.id, m),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      // Unknown auth state before first worker report — treat as not enabled.
      bedrockEnabled = false;
      bedrockDisabledReason = "Awaiting worker probe — showing the catalog snapshot.";
    }

    const bedrockGroup: ModelGroup = {
      provider: bedrockMeta.label,
      models: bedrockModels,
      requiredKey: bedrockMeta.requiredKey,
      enabled: bedrockEnabled,
      disabledReason: bedrockEnabled ? undefined : bedrockDisabledReason,
    };

    return [...snapshotGroups, bedrockGroup];
  }

  return snapshotGroups;
}

/**
 * dsh reaches models two ways: `openrouter/<id>` with OPENROUTER_API_KEY, or a
 * bare DeepSeek API id with DEEPSEEK_API_KEY (see `src/providers/dsh-adapter.ts`).
 */
function dshModelGroups(
  configs: SwarmConfig[] | undefined,
  envPresence: Record<string, boolean> | undefined,
  liveCatalog?: LiveModelsCatalog | null,
): ModelGroup[] {
  const openrouterMeta = SNAPSHOT_META.openrouter;
  const openrouter = Object.values((liveCatalog?.openrouter ?? CACHE.openrouter)?.models ?? {})
    .map((m) => ({
      id: `openrouter/${m.id}`,
      label: modelDisplayName(m.name) ?? m.id,
      provider: openrouterMeta.label,
      providerId: openrouterMeta.iconKey,
      requiredKey: openrouterMeta.requiredKey,
      ...catalogFacts(m),
      reasoningLevels: reasoningLevelsFor("dsh", m.id, m),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const deepseek = deepseekCatalogModels(liveCatalog);
  const direct: ModelOption[] = DSH_DIRECT_MODELS.map((id) => {
    const m = deepseek[id];
    return {
      id,
      label: m ? (modelDisplayName(m.name) ?? id) : id,
      provider: "DeepSeek",
      providerId: null,
      requiredKey: "DEEPSEEK_API_KEY",
      ...(m ? catalogFacts(m) : {}),
      reasoningLevels: m ? reasoningLevelsFor("dsh", id, m) : [],
    };
  });
  return [
    {
      provider: openrouterMeta.label,
      models: openrouter,
      requiredKey: openrouterMeta.requiredKey,
      enabled: hasRuntimeCredential(openrouterMeta.requiredKey, configs, envPresence),
    },
    {
      provider: "DeepSeek",
      models: direct,
      requiredKey: "DEEPSEEK_API_KEY",
      enabled: hasRuntimeCredential("DEEPSEEK_API_KEY", configs, envPresence),
    },
  ];
}

/** Cursor serves every model through one key; see `src/providers/cursor-adapter.ts`. */
function cursorModelGroups(
  configs: SwarmConfig[] | undefined,
  envPresence: Record<string, boolean> | undefined,
  liveCatalog?: LiveModelsCatalog | null,
): ModelGroup[] {
  const models: ModelOption[] = CURSOR_MODELS.map((id) => {
    const { providerId, modelId } = cursorCatalogRef(id);
    const m = runtimeSectionModels(providerId, liveCatalog)[modelId];
    return {
      id,
      label: m ? (modelDisplayName(m.name) ?? id) : id,
      provider: "Cursor",
      providerId: null,
      requiredKey: "CURSOR_API_KEY",
      ...(m ? catalogFacts(m) : {}),
      reasoningLevels: m ? reasoningLevelsFor("cursor", modelId, m) : [],
    };
  });
  return [
    {
      provider: "Cursor",
      models,
      requiredKey: "CURSOR_API_KEY",
      enabled: hasRuntimeCredential("CURSOR_API_KEY", configs, envPresence),
    },
  ];
}

/**
 * Best-effort model suggestions for ACP targets whose model namespace is known.
 * The value remains free-form because ACP servers can expose models outside
 * models.dev and custom targets have no catalog we can infer safely.
 */
export function modelGroupsForAcpTarget(
  target: "opencode" | "custom",
  liveCatalog?: LiveModelsCatalog | null,
): ModelGroup[] {
  if (target !== "opencode") return [];

  const opencodeCache = liveCatalog?.opencode ?? CACHE.opencode;
  const opencodeModels: ModelOption[] = Object.values(opencodeCache?.models ?? {})
    .map((model) => ({
      id: `opencode/${model.id}`,
      label: modelDisplayName(model.name) ?? model.id,
      provider: opencodeCache?.name ?? "OpenCode Zen",
      providerId: null,
      requiredKey: "",
      ...catalogFacts(model),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const providerGroups = modelGroupsForHarness(
    "opencode",
    undefined,
    undefined,
    null,
    liveCatalog,
  ).map((group) => ({ ...group, enabled: true, disabledReason: undefined }));

  return [
    {
      provider: opencodeCache?.name ?? "OpenCode Zen",
      models: opencodeModels,
      requiredKey: "",
      enabled: true,
    },
    ...providerGroups,
  ];
}

/**
 * Every model a schedule can name, across harnesses, for a picker that is not
 * tied to one agent: the Claude CLI shortnames (`opus` = the newest Opus, kept
 * because existing schedules store them), then the Claude, Codex and OpenRouter
 * catalog models. No group is credential-gated: the schedule runs on whichever
 * worker claims it.
 */
export function modelGroupsForSchedule(liveCatalog?: LiveModelsCatalog | null): ModelGroup[] {
  const anthropic = (liveCatalog?.anthropic ?? CACHE.anthropic)?.models ?? {};
  const aliasOptions: ModelOption[] = Object.entries(buildClaudeShortnameMap(anthropic)).map(
    ([alias, target]) => {
      const model = anthropic[target];
      return {
        id: alias,
        label: `${alias[0].toUpperCase()}${alias.slice(1)} (${modelDisplayName(model?.name) ?? humanizeModelId(target)})`,
        ...ANTHROPIC_META,
        provider: "Claude CLI alias",
        requiredKey: "",
        ...(model ? catalogFacts(model) : {}),
      };
    },
  );
  const groups: ModelGroup[] = [
    { provider: "Claude CLI alias", models: aliasOptions, requiredKey: "", enabled: true },
    ...modelGroupsForHarness("claude", undefined, undefined, null, liveCatalog),
    ...modelGroupsForHarness("codex", undefined, undefined, null, liveCatalog),
    ...modelGroupsForHarness("opencode", undefined, undefined, null, liveCatalog).filter(
      (group) => group.requiredKey === SNAPSHOT_META.openrouter.requiredKey,
    ),
  ];
  return groups
    .filter((group) => group.models.length > 0)
    .map((group) => ({ ...group, enabled: true, disabledReason: undefined }));
}

/**
 * Catalog models as the pricing table keys them (`claude-opus-5-5`, `gpt-5.6`,
 * `deepseek/deepseek-v4.1-flash`), for the rate dialog's suggestions. Empty for
 * a provider the pricing table has no catalog section for.
 */
export function pricingModelOptions(
  provider: string,
  liveCatalog?: LiveModelsCatalog | null,
): ModelOption[] {
  if (provider === "claude" || provider === "codex") {
    return modelGroupsForHarness(provider, undefined, undefined, null, liveCatalog)[0].models;
  }
  if (provider === "pi") {
    // Routed through OpenRouter: the table keys them without the router prefix.
    return modelGroupsForHarness("pi", undefined, undefined, null, liveCatalog)
      .filter((group) => group.requiredKey === SNAPSHOT_META.openrouter.requiredKey)
      .flatMap((group) => group.models)
      .map((model) => ({ ...model, id: model.id.replace(/^openrouter\//, "") }));
  }
  return [];
}

export function findModelOption(
  model: string | null | undefined,
  groups: ModelGroup[],
): ModelOption | null {
  if (!model) return null;
  for (const group of groups) {
    const found = group.models.find((m) => m.id === model);
    if (found) return found;
  }
  return null;
}

// CLI shortnames Anthropic ships in their tools (`--model opus`, etc.). Workers
// may report these verbatim — map them to the newest canonical id in the
// catalog so the row reads "Claude Sonnet 5.5" instead of a bare "sonnet".
function anthropicShortnameToId(liveCatalog?: LiveModelsCatalog | null): Record<string, string> {
  return buildClaudeShortnameMap((liveCatalog?.anthropic ?? CACHE.anthropic)?.models);
}

/**
 * Lookup across the live catalog first, then every known harness/snapshot — for
 * read-only surfaces (agent list, telemetry rows) that don't have configs/env
 * presence in scope. Returns `null` for custom or unknown model ids.
 */
export function findKnownModel(
  model: string | null | undefined,
  liveCatalog?: LiveModelsCatalog,
): ModelOption | null {
  if (!model) return null;
  const live = findLiveModel(model, liveCatalog);
  if (live) return live;
  const aliased = anthropicShortnameToId(liveCatalog)[model] ?? model;
  for (const harness of ["claude", "codex"] as const) {
    const found = directModels(harness, liveCatalog).find((m) => m.id === aliased);
    if (found) return found;
  }
  for (const providerId of SNAPSHOT_ORDER) {
    const meta = SNAPSHOT_META[providerId];
    const cache = CACHE[providerId];
    const prefix = `${providerId}/`;
    if (!model.startsWith(prefix)) continue;
    const tail = model.slice(prefix.length);
    const cached = cache?.models[tail];
    if (cached) {
      return {
        id: model,
        label: modelDisplayName(cached.name) ?? cached.id,
        provider: meta.label,
        providerId: meta.iconKey,
        requiredKey: meta.requiredKey,
        ...catalogFacts(cached),
      };
    }
    // Provider prefix matched but model not in the snapshot (e.g. brand-new
    // OpenRouter route). Still surface the provider logo + a tidier label
    // by humanizing the tail instead of falling back to the raw composite id.
    return {
      id: model,
      label: humanizeModelTail(tail),
      provider: meta.label,
      providerId: meta.iconKey,
      requiredKey: meta.requiredKey,
    };
  }
  // Reverse-label fallback. Some adapters report a human label (e.g.
  // pi-mono historically reported `"DeepSeek: DeepSeek V4 Flash"`) instead
  // of a slug. Match against snapshot `name` directly, and against the
  // suffix after the first `": "` (handles the `${vendor}: ${name}` form).
  const byLabel = findByLabel(model, liveCatalog);
  if (byLabel) return byLabel;
  return null;
}

function findLiveModel(model: string, catalog?: LiveModelsCatalog): ModelOption | null {
  if (!catalog) return null;
  const separator = model.indexOf("/");
  const providerId = separator < 0 ? null : model.slice(0, separator);
  const tail = separator < 0 ? model : model.slice(separator + 1);

  // Provider-qualified IDs are resolved first, preserving nested OpenRouter
  // IDs such as `openrouter/deepseek/deepseek-v4.1-flash`.
  if (providerId && Object.hasOwn(catalog, providerId)) {
    const provider = catalog[providerId as keyof LiveModelsCatalog];
    const cached = provider?.models[tail];
    if (cached && provider) return liveModelOption(model, providerId, provider, cached);
  }

  // Bare model IDs can be reported by harnesses that omit the provider.
  for (const [id, provider] of Object.entries(catalog)) {
    if (!provider) continue;
    const cached = provider.models[model];
    if (cached) return liveModelOption(model, id, provider, cached);
  }
  return null;
}

function liveModelOption(
  id: string,
  providerId: string,
  provider: CachedProvider,
  model: CachedModel,
): ModelOption {
  const iconByProvider: Partial<Record<string, ProviderIconKey>> = {
    anthropic: "anthropic",
    openai: "openai",
    openrouter: "openrouter",
    "amazon-bedrock": "amazon-bedrock",
  };
  return {
    id,
    label: modelDisplayName(model.name) ?? model.id,
    provider: provider.name ?? providerId,
    providerId: iconByProvider[providerId] ?? null,
    requiredKey: "",
    ...catalogFacts(model),
  };
}

function findByLabel(raw: string, liveCatalog?: LiveModelsCatalog | null): ModelOption | null {
  const candidates = new Set<string>();
  candidates.add(raw);
  const colonIdx = raw.indexOf(": ");
  if (colonIdx >= 0) candidates.add(raw.slice(colonIdx + 2));
  const lowered = [...candidates].map((c) => c.toLowerCase().trim());
  // The live catalog first (it names models the snapshot does not know yet),
  // then the bundled snapshot for anything the live sections dropped.
  for (const source of liveCatalog ? [liveCatalog, CACHE] : [CACHE]) {
    for (const providerId of SNAPSHOT_ORDER) {
      const meta = SNAPSHOT_META[providerId];
      for (const cached of Object.values(source[providerId]?.models ?? {})) {
        const name = (cached.name ?? "").toLowerCase().trim();
        if (!name) continue;
        // A harness reports "Claude Haiku 4.5" for models.dev's "Claude Haiku 4.5 (latest)".
        const shown = (modelDisplayName(cached.name) ?? "").toLowerCase().trim();
        if (!lowered.includes(name) && !lowered.includes(shown)) continue;
        return {
          id: `${providerId}/${cached.id}`,
          label: modelDisplayName(cached.name) ?? cached.id,
          provider: meta.label,
          providerId: meta.iconKey,
          requiredKey: meta.requiredKey,
          ...catalogFacts(cached),
        };
      }
    }
  }
  return null;
}

/**
 * Best-effort prettifier for model ids not in the snapshot cache. Drops the
 * vendor prefix segment (`qwen/qwen3.6-35b-a3b` → `qwen3.6-35b-a3b`) and
 * upper-cases the leading letter so it reads like a name.
 */
function humanizeModelTail(tail: string): string {
  const last = tail.split("/").pop() ?? tail;
  if (!last) return tail;
  return humanizeModelId(last);
}

/** Title-case slug segments while preserving dotted numeric versions. */
export function humanizeModelId(id: string): string {
  const words = id.match(/[a-z]+\d+(?:\.\d+)+|[a-z]+\d*|\d+(?:\.\d+)+|[A-Z]+\d*|\d+/g) ?? [id];
  return words
    .map((word) => (/[a-z]/i.test(word) ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * The model a harness starts on when nothing is configured: the harness's
 * preferred model when the catalog lists it under an enabled provider, else the
 * first model of the first enabled provider that has no lifecycle status
 * (deprecated, beta, ...). Claude prefers the newest Opus, read from the live
 * catalog when one is passed. The open harnesses prefer `FALLBACK_MODEL`: a
 * catalog rule (newest, first, cheapest) picks an obscure OpenRouter model
 * there, and the live groups already drop a preferred id the catalog lost.
 */
export function pickDefaultModelForHarness(
  harness: LocalHarnessProvider,
  groups: ModelGroup[],
  liveCatalog?: LiveModelsCatalog | null,
): string {
  const preferred =
    FALLBACK_MODEL[harness] ||
    (harness === "claude" ? (anthropicShortnameToId(liveCatalog).opus ?? "") : "");
  const enabled = groups.filter((g) => g.enabled);
  if (enabled.some((g) => g.models.some((m) => m.id === preferred))) return preferred;
  const first = enabled[0]?.models;
  return (first?.find((m) => !m.status) ?? first?.[0])?.id ?? preferred;
}

export function isLocalHarness(
  value: ProviderName | string | null | undefined,
): value is LocalHarnessProvider {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "pi" ||
    value === "opencode" ||
    value === "dsh" ||
    value === "cursor" ||
    value === "acp"
  );
}
