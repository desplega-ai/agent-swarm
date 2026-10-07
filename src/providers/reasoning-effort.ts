/**
 * Normalized per-agent reasoning/effort control, shared across the four
 * local harnesses (`claude`, `codex`, `pi`, `opencode`).
 *
 * Pure module — no DB import, no network I/O of its own. Capability data is
 * read from the model catalog (`src/utils/runtime-model-catalog.ts`: live
 * `model_catalog` + overlay rows, vendored models.dev snapshot offline),
 * layered with a small harness-specific override table for quirks the
 * catalog can't encode. A new model's reasoning levels arrive with its
 * catalog row (model-catalog phase 4). See
 * `thoughts/taras/plans/2026-07-01-agent-reasoning-effort-runtime-control.md`
 * (Phase 1) and `thoughts/taras/research/2026-05-26-agent-reasoning-effort-runtime-control.md`
 * for the design rationale.
 */

import {
  claudeCatalogModelId,
  cursorCatalogRef,
  dshCatalogRef,
  grokCatalogRef,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
  reasoningLevelsFor,
} from "@desplega/model-catalog";
import { runtimeCatalogModel, runtimeCatalogSection } from "../utils/runtime-model-catalog";

/** Closed, normalized enum. `minimal` remains out of scope; GPT-5.6 Codex adds `max`. */
export { REASONING_EFFORT_LEVELS };
export type ReasoningEffort = ReasoningEffortLevel;

/** The local harnesses this feature covers (Devin / claude-managed / ACP are out of scope). */
export type ReasoningHarness =
  | "claude"
  | "codex"
  | "pi"
  | "opencode"
  | "dsh"
  | "cursor"
  | "amp"
  | "grok";

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
  | { kind: "dsh-effort"; reasoningEffort: ReasoningEffort }
  | { kind: "amp-effort"; reasoningEffort: ReasoningEffort }
  | { kind: "cursor-effort"; reasoningEffort: ReasoningEffort }
  | { kind: "grok-effort"; reasoningEffort: ReasoningEffort }
  | { kind: "noop" };

// --- Capability lookup --------------------------------------------------------

function splitProviderModel(model: string): { providerId: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerId: "", modelId: model };
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/**
 * The (catalog id, catalog facts) a harness's model string names. Direct
 * `claude`/`codex` strings (no provider prefix) resolve against
 * `anthropic`/`openai`; a Claude CLI shortname (`opus`, the tier default)
 * resolves to the newest model of its family. `pi`/`opencode` strings are
 * always `<providerId>/<model-id>`, and the id may hold more slashes (openrouter's
 * `google/gemini-3-flash-preview`), so split on the FIRST slash only.
 */
function lookupModel(
  harness: ReasoningHarness,
  model: string,
): { id: string; facts: ReturnType<typeof runtimeCatalogModel> } | undefined {
  if (!model) return undefined;
  let providerId: string;
  let modelId: string;
  if (harness === "claude") {
    providerId = "anthropic";
    modelId = claudeCatalogModelId(model, runtimeCatalogSection("anthropic"));
  } else if (harness === "codex") {
    providerId = "openai";
    modelId = model;
  } else if (harness === "dsh") {
    ({ providerId, modelId } = dshCatalogRef(model));
  } else if (harness === "cursor") {
    ({ providerId, modelId } = cursorCatalogRef(model));
  } else if (harness === "grok") {
    ({ providerId, modelId } = grokCatalogRef(model));
  } else {
    ({ providerId, modelId } = splitProviderModel(model));
    if (!providerId) return undefined;
  }
  const facts = runtimeCatalogModel(providerId, modelId);
  return facts ? { id: modelId, facts } : undefined;
}

function pickDefault(levels: ReasoningEffort[]): ReasoningEffort | null {
  if (levels.length === 0) return null;
  return levels.includes("medium") ? "medium" : (levels[0] ?? null);
}

/**
 * The levels `(harness, model)` accepts, from the catalog facts
 * (`reasoningLevelsFor`, shared with the swarm app's effort pickers). Unknown
 * models (custom strings, ids the catalog lacks) and non-reasoning models are
 * unsupported.
 */
export function reasoningCapability(harness: ReasoningHarness, model: string): ReasoningCapability {
  const entry = lookupModel(harness, model);
  const levels = entry ? reasoningLevelsFor(harness, entry.id, entry.facts) : [];
  if (levels.length === 0) return { supported: false, levels: [], default: null };
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
const ANTHROPIC_BUDGET_TOKENS_BY_LEVEL: Record<Exclude<ReasoningEffort, "off" | "max">, number> = {
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
    if (level === "max") return { reasoningEffort: level };
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
    case "dsh":
      // dsh's own level names match the normalized enum; the adapter decides
      // the per-route transport (see `src/providers/dsh-adapter.ts`).
      return { kind: "dsh-effort", reasoningEffort: level };
    case "amp":
      // The adapter hands this to the per-task plugin agent (`off` -> `none`);
      // see `src/providers/amp-adapter.ts`. Amp has no effort flag.
      return { kind: "amp-effort", reasoningEffort: level };
    case "cursor":
      // Each Cursor model names its effort parameter and values itself
      // (`reasoning`, `reasoning_effort`, `effort`); the adapter maps the
      // level onto the live model list (see `src/providers/cursor-adapter.ts`).
      return { kind: "cursor-effort", reasoningEffort: level };
    case "grok":
      // Grok's `--reasoning-effort` takes the normalized names as-is; see
      // `src/providers/grok-adapter.ts`.
      return { kind: "grok-effort", reasoningEffort: level };
    default: {
      const _exhaustive: never = harness;
      return _exhaustive;
    }
  }
}
