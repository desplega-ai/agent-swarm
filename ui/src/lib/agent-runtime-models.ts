import type { ProviderName, SwarmConfig } from "@/api/types";
import modelsCache from "./modelsdev-cache.json";

export type LocalHarnessProvider = "claude" | "codex" | "pi" | "opencode";

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  providerId: ProviderIconKey;
  requiredKey: string;
  cost?: { input?: number; output?: number };
  contextWindow?: number;
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

interface CachedModel {
  id: string;
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
}

interface CachedProvider {
  id: string;
  name: string;
  models: Record<string, CachedModel>;
}

const CACHE = modelsCache as Record<SnapshotProviderId, CachedProvider | undefined>;

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

const DIRECT_MODELS: Record<"claude" | "codex", ModelOption[]> = {
  claude: [
    { id: "claude-fable-5", label: "Claude Fable 5", ...ANTHROPIC_META },
    { id: "claude-mythos-5", label: "Claude Mythos 5", ...ANTHROPIC_META },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", ...ANTHROPIC_META },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", ...ANTHROPIC_META },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", ...ANTHROPIC_META },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6", ...ANTHROPIC_META },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", ...ANTHROPIC_META },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", ...ANTHROPIC_META },
  ],
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5", ...OPENAI_META },
    { id: "gpt-5.4", label: "GPT-5.4", ...OPENAI_META },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", ...OPENAI_META },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", ...OPENAI_META },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", ...OPENAI_META },
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
  codex: "gpt-5.4",
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
      // Worker has reported live models — prefer this list.
      bedrockModels = liveBedrockStatus.models.map((m) => ({
        id: `amazon-bedrock/${m.id}`,
        label: m.name,
        provider: bedrockMeta.label,
        providerId: bedrockMeta.iconKey,
        requiredKey: bedrockMeta.requiredKey,
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
