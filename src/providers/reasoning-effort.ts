/**
 * Normalized per-agent reasoning/effort control, shared across the four
 * local harnesses (`claude`, `codex`, `pi`, `opencode`).
 *
 * Pure module — no DB import, no network I/O at runtime. Capability data is
 * read from the slim, checked-in `modelsdev-reasoning.json` snapshot (derived
 * from the canonical `src/be/modelsdev-cache.json` by
 * `scripts/refresh-modelsdev-pricing.ts`), layered with a small
 * harness-specific override table for quirks the cache can't encode. See
 * `thoughts/taras/plans/2026-07-01-agent-reasoning-effort-runtime-control.md`
 * (Phase 1) and `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md`
 * for the design rationale.
 */

import reasoningSnapshotJson from "./modelsdev-reasoning.json";

/** Closed, normalized enum. `minimal` and `max` are intentionally out of scope for v1 (see plan). */
export const REASONING_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

/** The four local harnesses this feature covers (Devin / claude-managed are out of scope). */
export type ReasoningHarness = "claude" | "codex" | "pi" | "opencode";

export interface ReasoningCapability {
  supported: boolean;
  levels: ReasoningEffort[];
  default: ReasoningEffort | null;
}

/**
 * Discriminated union telling each adapter where to write the resolved
 * level. `noop` covers both "capability rejected this (harness, model,
 * level)" and legitimate no-transport-change cases (e.g. Opencode `off`,
 * which simply omits reasoning keys).
 */
export type ReasoningEffortApplication =
  | { kind: "claude-env"; env: Record<string, string> }
  | { kind: "codex-config"; config: Record<string, unknown> }
  | { kind: "pi-session"; sessionOptions: Record<string, unknown> }
  | {
      kind: "opencode-options";
      providerId: string;
      modelId: string;
      options: Record<string, unknown>;
    }
  | { kind: "noop" };

// --- Slim capability snapshot ------------------------------------------------

interface SlimReasoningOption {
  type: string;
  values?: string[];
}

interface SlimModelEntry {
  id: string;
  reasoning: boolean;
  reasoningOptions?: SlimReasoningOption[];
}

/**
 * Providers the snapshot covers — mirrors `SNAPSHOT_ORDER` +
 * `BEDROCK_SNAPSHOT_ID` in `ui/src/lib/agent-runtime-models.ts`. Direct
 * `claude`/`codex` model strings (no provider prefix) resolve against
 * `anthropic`/`openai` respectively; `pi`/`opencode` model strings are always
 * `<providerId>/<model-id>` (see `splitProviderModel`).
 */
type SnapshotProviderId = "anthropic" | "openai" | "openrouter" | "amazon-bedrock";

type ReasoningSnapshot = Partial<Record<SnapshotProviderId, Record<string, SlimModelEntry>>>;

const SNAPSHOT = reasoningSnapshotJson as ReasoningSnapshot;

/** Shared-safe subset accepted by all four harnesses on at least their default models (see research doc). */
const FALLBACK_LEVELS: ReasoningEffort[] = ["low", "medium", "high"];

/** models.dev `reasoning_options[].type === "effort"` value → our normalized enum. `minimal`/`max` intentionally dropped. */
const EFFORT_VALUE_MAP: Partial<Record<string, ReasoningEffort>> = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

function splitProviderModel(model: string): { providerId: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerId: "", modelId: model };
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function lookupModelEntry(harness: ReasoningHarness, model: string): SlimModelEntry | undefined {
  if (!model) return undefined;
  if (harness === "claude") return SNAPSHOT.anthropic?.[model];
  if (harness === "codex") return SNAPSHOT.openai?.[model];
  // pi / opencode model strings are always "<provider>/<model-id...>" — the
  // model id itself may contain further slashes (e.g. openrouter's
  // "google/gemini-3-flash-preview"), so split on the FIRST slash only.
  const { providerId, modelId } = splitProviderModel(model);
  if (!providerId) return undefined;
  return SNAPSHOT[providerId as SnapshotProviderId]?.[modelId];
}

function levelsFromReasoningOptions(options: SlimReasoningOption[] | undefined): ReasoningEffort[] {
  const effortEntry = options?.find((o) => o.type === "effort");
  if (!effortEntry?.values?.length) return [];
  const mapped = new Set(
    effortEntry.values
      .map((v) => EFFORT_VALUE_MAP[v])
      .filter((v): v is ReasoningEffort => v !== undefined),
  );
  // Preserve canonical ordering rather than whatever order models.dev lists them in.
  return REASONING_EFFORT_LEVELS.filter((level) => mapped.has(level));
}

function hasBudgetTokensOption(entry: SlimModelEntry): boolean {
  return Boolean(entry.reasoningOptions?.some((o) => o.type === "budget_tokens"));
}

/**
 * Harness-specific quirks the cache doesn't (fully) encode. Kept small — this
 * patches gaps, it does not duplicate the cache. Applied on top of whichever
 * levels resolution step 2/3 already produced.
 */
function applyHarnessOverrides(
  harness: ReasoningHarness,
  model: string,
  entry: SlimModelEntry,
  levels: ReasoningEffort[],
): ReasoningEffort[] {
  let result = levels;

  if (harness === "claude") {
    // Claude's native vocabulary has no "off" (see research doc) — we
    // implement it as a synthetic level via `MAX_THINKING_TOKENS=0`, which
    // only exists on legacy (non-adaptive-only) models that still expose a
    // numeric thinking-budget knob (`reasoning_options` carries a
    // `budget_tokens` entry). Opus 4.7+ models are adaptive-only — effort
    // only, no `budget_tokens` — so `off` is naturally never added for them,
    // rather than hardcoding "Opus 4.7" by name.
    if (hasBudgetTokensOption(entry) && !result.includes("off")) {
      result = ["off", ...result];
    }
  }

  if (harness === "codex") {
    // The cache already tends to encode this correctly per model (verified:
    // `gpt-5.1-codex` excludes xhigh, `gpt-5.1-codex-max` includes it). This
    // rule is defense-in-depth for models missing from the snapshot (the
    // {low,medium,high} fallback path), where naming alone should still
    // decide xhigh eligibility for `*-codex` family models.
    const isCodexMax = /-codex-max$/.test(model);
    const isCodexNonMax = /-codex$/.test(model) && !isCodexMax;
    if (isCodexMax && !result.includes("xhigh")) {
      result = [...result, "xhigh"];
    }
    if (isCodexNonMax) {
      result = result.filter((l) => l !== "xhigh");
    }
  }

  return REASONING_EFFORT_LEVELS.filter((level) => result.includes(level));
}

function pickDefault(levels: ReasoningEffort[]): ReasoningEffort | null {
  if (levels.length === 0) return null;
  return levels.includes("medium") ? "medium" : (levels[0] ?? null);
}

/**
 * Resolution order:
 *  1. No capability data for (harness, model) at all (custom model strings,
 *     models absent from the snapshot) → unsupported.
 *  2. `reasoning: false` → unsupported, regardless of the override table.
 *  3. `reasoning_options` has a usable `type: "effort"` entry → levels come
 *     from its `values` (mapped/filtered — `none`→`off`, `minimal`/`max` dropped).
 *  4. Otherwise (`reasoning: true`, no usable effort entry) → the shared-safe
 *     fallback subset `{low, medium, high}`.
 *  5. Harness-specific override table applied on top for known quirks.
 */
export function reasoningCapability(harness: ReasoningHarness, model: string): ReasoningCapability {
  const entry = lookupModelEntry(harness, model);
  if (!entry || !entry.reasoning) {
    return { supported: false, levels: [], default: null };
  }

  let levels = levelsFromReasoningOptions(entry.reasoningOptions);
  if (levels.length === 0) {
    levels = [...FALLBACK_LEVELS];
  }

  levels = applyHarnessOverrides(harness, model, entry, levels);

  if (levels.length === 0) {
    return { supported: false, levels: [], default: null };
  }

  return { supported: true, levels, default: pickDefault(levels) };
}

// --- Per-harness translation --------------------------------------------------

function applyClaudeEffort(level: ReasoningEffort): ReasoningEffortApplication {
  if (level === "off") {
    // Only reachable when capability resolution added `off` (i.e. the model
    // has a `budget_tokens` reasoning option) — set the numeric budget to
    // zero and leave `CLAUDE_CODE_EFFORT_LEVEL` unset (omitted) rather than
    // sending an empty value.
    return { kind: "claude-env", env: { MAX_THINKING_TOKENS: "0" } };
  }
  return { kind: "claude-env", env: { CLAUDE_CODE_EFFORT_LEVEL: level } };
}

function applyCodexEffort(level: ReasoningEffort): ReasoningEffortApplication {
  const value = level === "off" ? "none" : level;
  return { kind: "codex-config", config: { model_reasoning_effort: value } };
}

function applyPiEffort(level: ReasoningEffort): ReasoningEffortApplication {
  // Pi's native vocabulary already includes `off` as a top-level `thinkingLevel`.
  return { kind: "pi-session", sessionOptions: { thinkingLevel: level } };
}

/** Level → numeric thinking budget, only used for Opencode's Anthropic provider (see below). Internal transport detail, not a user-facing knob. */
const ANTHROPIC_BUDGET_TOKENS_BY_LEVEL: Record<Exclude<ReasoningEffort, "off">, number> = {
  low: 4096,
  medium: 10240,
  high: 32768,
  xhigh: 65536,
};

function buildOpencodeReasoningOptions(
  providerId: string,
  level: Exclude<ReasoningEffort, "off">,
): Record<string, unknown> {
  if (providerId === "anthropic") {
    // Opencode's Anthropic provider takes a numeric thinking budget, not a
    // qualitative level — translate internally (see "What We're NOT Doing" in
    // the plan: no numeric budget surface for operators, only this
    // adapter-internal transport detail).
    return { thinking: { type: "enabled", budgetTokens: ANTHROPIC_BUDGET_TOKENS_BY_LEVEL[level] } };
  }
  if (providerId === "openrouter") {
    return { reasoning: { effort: level } };
  }
  // OpenAI / Azure / OpenAI-compatible (and any other provider) default to
  // the `reasoningEffort` key, matching Opencode's OpenAI-compatible shape.
  return { reasoningEffort: level };
}

function applyOpencodeEffort(model: string, level: ReasoningEffort): ReasoningEffortApplication {
  if (level === "off") {
    // Opencode has no explicit "off" switch — omit reasoning keys entirely so
    // the provider's own default applies (usually no extended thinking).
    return { kind: "noop" };
  }
  const { providerId, modelId } = splitProviderModel(model);
  return {
    kind: "opencode-options",
    providerId,
    modelId,
    options: buildOpencodeReasoningOptions(providerId, level),
  };
}

/**
 * Translate a normalized level into the harness-specific shape the adapter
 * should merge into its transport. Returns `noop` when `level` is undefined,
 * or when `(harness, model)` has no capability data / doesn't support the
 * requested level — defense-in-depth; primary rejection lives at the API
 * layer (Phase 2).
 */
export function applyReasoningEffort(
  harness: ReasoningHarness,
  model: string,
  level: ReasoningEffort | undefined,
): ReasoningEffortApplication {
  if (level === undefined) return { kind: "noop" };

  const capability = reasoningCapability(harness, model);
  if (!capability.supported || !capability.levels.includes(level)) {
    return { kind: "noop" };
  }

  switch (harness) {
    case "claude":
      return applyClaudeEffort(level);
    case "codex":
      return applyCodexEffort(level);
    case "pi":
      return applyPiEffort(level);
    case "opencode":
      return applyOpencodeEffort(model, level);
    default: {
      const _exhaustive: never = harness;
      return _exhaustive;
    }
  }
}
