import { canarySuiteScenarioIds, SUITE_SCENARIO_VERSIONS } from "../scenarios/suite.ts";
import type { ConfigPreset } from "../src/types.ts";

/**
 * Named quick-run config sets (v7.7 item 1 — shape FROZEN in src/types.ts).
 * Array order = display order in the new-run dialog (frontier, challengers,
 * oss, claude-family, budget). Served verbatim as GET /api/presets; the CLI
 * expands `--preset <id>` through expandPresetSelection() below. Membership
 * is enforced by src/registry.test.ts: ids unique, configIds non-empty, every
 * entry resolves in the catalog.
 */
export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    id: "frontier",
    label: "Frontier",
    description: "Strongest current models across all four harnesses.",
    configIds: [
      "claude-fable",
      "claude-opus",
      "claude-sonnet",
      "pi-deepseek-pro",
      "pi-gemini-pro",
      // Round-9 expansion: top proprietary-API additions (AA II 57 / 55).
      "pi-qwen3.7-max",
      "pi-minimax-m3",
      "codex-5.6-sol",
    ],
  },
  {
    // Round-9 expansion: the proprietary-API lift's strongest new entries.
    id: "challengers",
    label: "Challengers",
    description: "New proprietary-API contenders (Alibaba, MiniMax, xAI, Mistral) — pi variants.",
    configIds: [
      "pi-qwen3.7-max",
      "pi-minimax-m3",
      "pi-qwen3.7-plus",
      "pi-grok-4.3",
      "pi-mistral-medium-3.5",
    ],
  },
  {
    id: "oss",
    label: "OSS",
    description: "Newest open-weight models across pi + opencode (gemini excluded — proprietary).",
    configIds: [
      "pi-deepseek-pro",
      "pi-deepseek-flash",
      "pi-gpt-oss-120b",
      "pi-kimi-k2.5",
      "pi-minimax-m2.5",
      "pi-qwen-coder",
      "pi-glm-flash",
      // Round-8 OSS refresh (AA snapshot 2026-06-12).
      "pi-kimi-k2.6",
      "pi-glm-5.1",
      "pi-mimo-v2.5-pro",
      "pi-mimo-v2.5",
      "pi-nemotron-3-ultra",
      // Round-9 expansion: open-weight additions (MiniMax-M3, Qwen3.7 Max/Plus,
      // Grok 4.3, Mistral Medium 3.5 and Mercury 2 are open_weights: false).
      "pi-hy3-preview",
      "pi-step-3.7-flash",
      // Round-10 leaderboard additions: the open-weight pair (Gemini 3.5 Flash,
      // Qwen3.6 Plus, Grok Build 0.1 and Owl Alpha are open_weights: false).
      "pi-nemotron-3-super",
      "pi-minimax-m2.7",
      "opencode-deepseek-flash",
      "opencode-deepseek-pro",
      "opencode-kimi-k2.5",
      "opencode-minimax-m2.5",
      "opencode-qwen-coder",
      "opencode-glm-flash",
      "opencode-kimi-k2.6",
      "opencode-glm-5.1",
      "opencode-mimo-v2.5-pro",
      "opencode-mimo-v2.5",
      "opencode-nemotron-3-ultra",
      "opencode-hy3-preview",
      "opencode-step-3.7-flash",
      // Round-10 leaderboard additions — opencode twins.
      "opencode-nemotron-3-super",
      "opencode-minimax-m2.7",
    ],
  },
  {
    id: "claude-family",
    label: "Claude Family",
    description: "Same-family tier ladder — haiku up through fable 5.",
    configIds: [
      "claude-haiku",
      "claude-sonnet",
      "claude-opus-4.7",
      "claude-opus-4.8",
      "claude-fable",
    ],
  },
  {
    id: "budget",
    label: "Budget",
    description: "Cheap smoke set for quick sanity runs.",
    configIds: ["claude-haiku", "pi-deepseek-flash", "pi-gemini-flash", "codex-5.6-luna"],
  },
  // Phase 3 (swarm-evals plan v2): the scheduled tiers. Pinned config ids, not
  // `latest:` aliases, so a model change is a deliberate edit here. No config
  // carries a default reasoning effort, so each runs at its harness default and
  // the attempt records the effort the harness reported applying. The caps are
  // enforced by the runner (see src/cost/billing.ts for what counts as metered).
  {
    id: "nightly-canary",
    label: "Nightly canary",
    description:
      "Opus 5.5 + Codex 6 luna on the 9 public single-run scenarios, 3 repeats, $2 metered cap.",
    configIds: ["claude-opus-5.5", "codex-6-luna"],
    runDefaults: { attemptsPerCell: 3, maxMeteredUsd: 2 },
    scenarioSet: "canary",
  },
  {
    id: "weekly-matrix",
    label: "Weekly matrix",
    description:
      "Canary configs + Codex 6.1 sol + Codex 6 astra + DeepSeek V4.1 Flash on the whole suite (solo baselines and held-out included), 5 repeats, $37 metered cap.",
    // Claude and Codex run on subscription, so the cap is mostly E2B time:
    // ~375 attempts: E2B ~$19 (measured $0.02-0.10 each) + judge ~$11 (~$0.03
    // each) + DeepSeek tokens ~$1 = ~$31, plus 20%.
    configIds: [
      "claude-opus-5.5",
      "codex-6.1-sol",
      "codex-6-luna",
      "codex-6-astra",
      "pi-deepseek-v4.1-flash",
    ],
    runDefaults: { attemptsPerCell: 5, maxMeteredUsd: 37 },
  },
];

/**
 * Presets whose runs get the regression check and one Slack summary when they
 * finish (Phase 9). A run started from any other preset is an ordinary run.
 */
export const SCHEDULED_PRESET_IDS: readonly string[] = ["nightly-canary", "weekly-matrix"];

/** Scenario ids POST /api/runs runs for a preset when the caller names none. */
export function presetScenarioIds(presetId: string): string[] {
  const preset = CONFIG_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset "${presetId}"`);
  return preset.scenarioSet === "canary"
    ? canarySuiteScenarioIds()
    : Object.keys(SUITE_SCENARIO_VERSIONS);
}

/**
 * Run plan implied by the named presets: per field, the first preset (flag
 * order) that sets it wins. Unknown ids throw, like expandPresetSelection.
 */
export function presetRunDefaults(presetIds: string[]): {
  attemptsPerCell?: number;
  maxMeteredUsd?: number;
} {
  const byId = new Map(CONFIG_PRESETS.map((p) => [p.id, p]));
  const out: { attemptsPerCell?: number; maxMeteredUsd?: number } = {};
  for (const id of presetIds) {
    const preset = byId.get(id);
    if (!preset) {
      throw new Error(
        `unknown preset "${id}" (available: ${CONFIG_PRESETS.map((p) => p.id).join(", ")})`,
      );
    }
    out.attemptsPerCell ??= preset.runDefaults?.attemptsPerCell;
    out.maxMeteredUsd ??= preset.runDefaults?.maxMeteredUsd;
  }
  return out;
}

/**
 * Frozen CLI expansion (v7.7 item 1): flag-order presets' config ids first
 * (flattened), then explicit --configs ids; deduped keeping the FIRST
 * occurrence. Unknown preset ids throw — callers validate before any DB write.
 */
export function expandPresetSelection(presetIds: string[], explicitConfigIds: string[]): string[] {
  const byId = new Map(CONFIG_PRESETS.map((p) => [p.id, p]));
  const expanded: string[] = [];
  for (const id of presetIds) {
    const preset = byId.get(id);
    if (!preset) {
      throw new Error(
        `unknown preset "${id}" (available: ${CONFIG_PRESETS.map((p) => p.id).join(", ")})`,
      );
    }
    expanded.push(...preset.configIds);
  }
  // Set iteration preserves first-insertion order → dedupe-keep-first.
  return [...new Set([...expanded, ...explicitConfigIds])];
}
