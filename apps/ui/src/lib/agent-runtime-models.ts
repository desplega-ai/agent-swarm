import type { ProviderName, ReasoningEffortLevel, SwarmConfig } from "@/api/types";
import modelsCache from "./modelsdev-cache.json";

/**
 * Local mirror of the value in `@/api/types` (kept type-only there). This
 * module is imported directly (via a relative path, no bundler) by backend
 * unit tests (`src/tests/agents-list-model-display.test.ts`,
 * `src/tests/bedrock-model-groups.test.ts`) — every other `@/api/types`
 * import in `ui/src/lib/` is `import type` for exactly this reason: a
 * non-type-only import needs the `@/` alias resolved at runtime, which plain
 * Bun module resolution (no Vite bundler) can't do.
 */
const REASONING_EFFORT_LEVELS: readonly ReasoningEffortLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type LocalHarnessProvider = "claude" | "codex" | "pi" | "opencode";

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  providerId: ProviderIconKey;
  requiredKey: string;
  cost?: { input?: number; output?: number };
  contextWindow?: number;
  /**
   * Reasoning-effort levels this model supports, client-side mirror of the
   * server's hybrid capability lookup (`src/providers/reasoning-effort.ts`).
   * `undefined` means no capability data was found (custom/unknown model) —
   * the effort selector should NOT grey out any segment in that case.
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

type SnapshotProviderId = "openrouter" | "anthropic" | "openai" | "amazon-bedrock";

interface CachedReasoningOption {
  type: string;
  values?: string[];
}

interface CachedModel {
  id: string;
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  reasoning?: boolean;
  reasoning_options?: CachedReasoningOption[];
}

interface CachedProvider {
  id: string;
  name: string;
  models: Record<string, CachedModel>;
}

const CACHE = modelsCache as Record<SnapshotProviderId, CachedProvider | undefined>;

// --- Reasoning-effort capability mirror ---------------------------------------
// Client-side mirror of the resolution order in `reasoningCapability()`
// (`src/providers/reasoning-effort.ts`, Phase 1). Kept in sync by hand — see
// that module's doc comment for the accepted-tradeoff rationale (same
// duplication already accepted for the harness/model registry itself).

/** Shared-safe subset accepted by all four harnesses on at least their default models (see research doc). */
const REASONING_FALLBACK_LEVELS: ReasoningEffortLevel[] = ["low", "medium", "high"];

/** models.dev `reasoning_options[].type === "effort"` value → our normalized enum. `minimal` intentionally dropped. */
const REASONING_EFFORT_VALUE_MAP: Partial<Record<string, ReasoningEffortLevel>> = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

function levelsFromReasoningOptions(
  options: CachedReasoningOption[] | undefined,
): ReasoningEffortLevel[] {
  const effortEntry = options?.find((o) => o.type === "effort");
  if (!effortEntry?.values?.length) return [];
  const mapped = new Set(
    effortEntry.values
      .map((v) => REASONING_EFFORT_VALUE_MAP[v])
      .filter((v): v is ReasoningEffortLevel => v !== undefined),
  );
  return REASONING_EFFORT_LEVELS.filter((level) => mapped.has(level));
}

function hasBudgetTokensOption(model: CachedModel): boolean {
  return Boolean(model.reasoning_options?.some((o) => o.type === "budget_tokens"));
}

/**
 * Harness-specific quirks the cache doesn't (fully) encode — mirrors
 * `applyHarnessOverrides()` server-side. Only fires for the literal `claude`/
 * `codex` harness values (direct models); `pi`/`opencode` selecting an
 * underlying Anthropic/OpenAI model never triggers these, matching the
 * backend (its override table also keys off the harness param, not the
 * model's provider).
 */
function applyReasoningHarnessOverrides(
  harness: LocalHarnessProvider,
  modelId: string,
  model: CachedModel,
  levels: ReasoningEffortLevel[],
): ReasoningEffortLevel[] {
  let result = levels;

  if (harness === "claude" && hasBudgetTokensOption(model) && !result.includes("off")) {
    result = ["off", ...result];
  }

  if (harness !== "codex") {
    result = result.filter((l) => l !== "max");
  }

  if (harness === "codex") {
    const isCodexMax = /-codex-max$/.test(modelId);
    const isCodexNonMax = /-codex$/.test(modelId) && !isCodexMax;
    if (isCodexMax && !result.includes("xhigh")) {
      result = [...result, "xhigh"];
    }
    if (isCodexNonMax) {
      result = result.filter((l) => l !== "xhigh");
    }
  }

  return REASONING_EFFORT_LEVELS.filter((level) => result.includes(level));
}

/**
 * Client-side mirror of `reasoningCapability().levels` — returns `undefined`
 * when there's no usable capability data (unknown model, or `reasoning:
 * false`), which the effort selector treats as "don't grey out anything".
 */
function reasoningLevelsFromCache(
  harness: LocalHarnessProvider,
  modelId: string,
  model: CachedModel | undefined,
): ReadonlyArray<ReasoningEffortLevel> | undefined {
  if (!model?.reasoning) return undefined;

  let levels = levelsFromReasoningOptions(model.reasoning_options);
  if (levels.length === 0) levels = [...REASONING_FALLBACK_LEVELS];
  levels = applyReasoningHarnessOverrides(harness, modelId, model, levels);

  return levels.length > 0 ? levels : undefined;
}

export const LOCAL_HARNESSES: LocalHarnessProvider[] = ["claude", "codex", "pi", "opencode"];

export const HARNESS_LABEL: Record<ProviderName | string, string> = {
  claude: "Claude",
  "claude-managed": "Claude (managed)",
  codex: "Codex",
  devin: "Devin",
  opencode: "Opencode",
  pi: "Pi-Mono",
};

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

/** Builds a direct-registry `ModelOption`, populating `reasoningLevels` from the same cache snapshot the picker's `cost`/`contextWindow` already read. */
function directModel(
  harness: "claude" | "codex",
  id: string,
  label: string,
  meta: typeof ANTHROPIC_META | typeof OPENAI_META,
): ModelOption {
  const snapshotProviderId: SnapshotProviderId = harness === "claude" ? "anthropic" : "openai";
  return {
    id,
    label,
    ...meta,
    reasoningLevels: reasoningLevelsFromCache(harness, id, CACHE[snapshotProviderId]?.models[id]),
  };
}

const DIRECT_MODELS: Record<"claude" | "codex", ModelOption[]> = {
  claude: [
    directModel("claude", "claude-fable-5", "Claude Fable 5", ANTHROPIC_META),
    directModel("claude", "claude-mythos-5", "Claude Mythos 5", ANTHROPIC_META),
    directModel("claude", "claude-sonnet-5", "Claude Sonnet 5", ANTHROPIC_META),
    directModel("claude", "claude-opus-4-8", "Claude Opus 4.8", ANTHROPIC_META),
    directModel("claude", "claude-opus-4-7", "Claude Opus 4.7", ANTHROPIC_META),
    directModel("claude", "claude-opus-4-6", "Claude Opus 4.6", ANTHROPIC_META),
    directModel("claude", "claude-sonnet-4-6", "Claude Sonnet 4.6", ANTHROPIC_META),
    directModel("claude", "claude-haiku-4-5", "Claude Haiku 4.5", ANTHROPIC_META),
  ],
  codex: [
    directModel("codex", "gpt-5.6-sol", "GPT-5.6 Sol", OPENAI_META),
    directModel("codex", "gpt-5.6-terra", "GPT-5.6 Terra", OPENAI_META),
    directModel("codex", "gpt-5.6-luna", "GPT-5.6 Luna", OPENAI_META),
    directModel("codex", "gpt-5.5", "GPT-5.5", OPENAI_META),
    directModel("codex", "gpt-5.4", "GPT-5.4", OPENAI_META),
    directModel("codex", "gpt-5.4-mini", "GPT-5.4 Mini", OPENAI_META),
    directModel("codex", "gpt-5.3-codex", "GPT-5.3 Codex", OPENAI_META),
    directModel("codex", "gpt-5.2-codex", "GPT-5.2 Codex", OPENAI_META),
  ],
};

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

const FALLBACK_MODEL: Record<LocalHarnessProvider, string> = {
  claude: "claude-opus-4-8",
  codex: "gpt-5.6-terra",
  pi: "openrouter/google/gemini-3-flash-preview",
  opencode: "openrouter/qwen/qwen3-coder-flash",
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
): ModelGroup[] {
  if (harness === "claude" || harness === "codex") {
    const models = DIRECT_MODELS[harness];
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

  const snapshotGroups = SNAPSHOT_ORDER.map((providerId) => {
    const meta = SNAPSHOT_META[providerId];
    const cache = CACHE[providerId];
    const models: ModelOption[] = Object.values(cache?.models ?? {})
      .map((m) => ({
        id: `${providerId}/${m.id}`,
        label: m.name ?? m.id,
        provider: meta.label,
        providerId: meta.iconKey,
        requiredKey: meta.requiredKey,
        cost: m.cost,
        contextWindow: m.limit?.context,
        reasoningLevels: reasoningLevelsFromCache(harness, m.id, m),
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
    const bedrockCache = CACHE[BEDROCK_SNAPSHOT_ID];

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
        label: m.name,
        provider: bedrockMeta.label,
        providerId: bedrockMeta.iconKey,
        requiredKey: bedrockMeta.requiredKey,
        reasoningLevels: reasoningLevelsFromCache("pi", m.id, bedrockCache?.models[m.id]),
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
          label: m.name ?? m.id,
          provider: bedrockMeta.label,
          providerId: bedrockMeta.iconKey,
          requiredKey: bedrockMeta.requiredKey,
          cost: m.cost,
          contextWindow: m.limit?.context,
          reasoningLevels: reasoningLevelsFromCache("pi", m.id, m),
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
// may report these verbatim — we map them to the canonical id so the row reads
// "Claude Sonnet 5" instead of a bare "sonnet".
const ANTHROPIC_SHORTNAME_TO_ID: Record<string, string> = {
  fable: "claude-fable-5",
  mythos: "claude-mythos-5",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

/**
 * Stateless lookup across every known harness/snapshot — for read-only surfaces
 * (agent list, telemetry rows) that don't have configs/env presence in scope.
 * Returns `null` for custom or unknown model ids.
 */
export function findKnownModel(model: string | null | undefined): ModelOption | null {
  if (!model) return null;
  const aliased = ANTHROPIC_SHORTNAME_TO_ID[model] ?? model;
  for (const arr of Object.values(DIRECT_MODELS)) {
    const found = arr.find((m) => m.id === aliased);
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
        label: cached.name ?? cached.id,
        provider: meta.label,
        providerId: meta.iconKey,
        requiredKey: meta.requiredKey,
        cost: cached.cost,
        contextWindow: cached.limit?.context,
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
  const byLabel = findByLabel(model);
  if (byLabel) return byLabel;
  return null;
}

function findByLabel(raw: string): ModelOption | null {
  const candidates = new Set<string>();
  candidates.add(raw);
  const colonIdx = raw.indexOf(": ");
  if (colonIdx >= 0) candidates.add(raw.slice(colonIdx + 2));
  const lowered = [...candidates].map((c) => c.toLowerCase().trim());
  for (const providerId of SNAPSHOT_ORDER) {
    const meta = SNAPSHOT_META[providerId];
    const cache = CACHE[providerId];
    for (const cached of Object.values(cache?.models ?? {})) {
      const name = (cached.name ?? "").toLowerCase().trim();
      if (!name) continue;
      if (!lowered.includes(name)) continue;
      return {
        id: `${providerId}/${cached.id}`,
        label: cached.name ?? cached.id,
        provider: meta.label,
        providerId: meta.iconKey,
        requiredKey: meta.requiredKey,
        cost: cached.cost,
        contextWindow: cached.limit?.context,
      };
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
  return last.charAt(0).toUpperCase() + last.slice(1);
}

export function pickDefaultModelForHarness(
  harness: LocalHarnessProvider,
  groups: ModelGroup[],
): string {
  const fallback = FALLBACK_MODEL[harness];
  const fallbackGroup = groups.find((g) => g.enabled && g.models.some((m) => m.id === fallback));
  if (fallbackGroup) return fallback;
  return groups.find((g) => g.enabled)?.models[0]?.id ?? fallback;
}

export function isLocalHarness(
  value: ProviderName | string | null | undefined,
): value is LocalHarnessProvider {
  return value === "claude" || value === "codex" || value === "pi" || value === "opencode";
}
