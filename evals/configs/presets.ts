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
      "codex-5.5",
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
    configIds: ["claude-haiku", "pi-deepseek-flash", "pi-gemini-flash", "codex-5.4-mini"],
  },
];

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
