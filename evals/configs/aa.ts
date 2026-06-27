import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AaBenchmark } from "../src/types.ts";

/**
 * Artificial Analysis benchmark data for the config catalog (v7.6 item D —
 * mapping + parse rules FROZEN). The TSV (transcribed from
 * artificialanalysis.ai on 2026-06-12) stays the numeric source of record;
 * this module parses it synchronously at import and joins it against the
 * explicit per-config mapping below. `configs/index.ts` stays untouched —
 * registry.serializeConfig() merges `getAaForConfig(id)` into /api/configs.
 *
 * Parse rules (frozen):
 * - tab-separated; header is exactly the 8 columns in EXPECTED_HEADER.
 * - cell "--" → null.
 * - numeric cell matching /^(\d+(\.\d+)?)\*$/ (e.g. "35*") → keep the number,
 *   set `provisional: true` on the whole block.
 * - context_window / creator stay raw display strings ("1M", "922k").
 * - lookup key = the exact `model` cell. "(variant 2)" suffixes mark the
 *   LOWER-intelligence-index duplicate of an AA reasoning/non-reasoning pair
 *   (typically the non-reasoning twin) — none of our picks is a variant-2 row.
 */

const TSV_NAME = "aa-benchmarks-2026-06-12.tsv";

const EXPECTED_HEADER = [
  "model",
  "context_window",
  "creator",
  "aa_intelligence_index",
  "blended_usd_per_1m",
  "median_tokens_per_s",
  "latency_first_chunk_s",
  "total_response_s",
];

const PROVISIONAL_RE = /^(\d+(\.\d+)?)\*$/;

/** One parsed TSV row — the numeric block without the config-mapping fields. */
export interface AaTsvRow {
  model: string;
  contextWindow: string | null;
  creator: string | null;
  intelligenceIndex: number | null;
  blendedUsdPer1M: number | null;
  medianTokensPerS: number | null;
  latencyFirstChunkS: number | null;
  totalResponseS: number | null;
  /** True when any numeric cell carried the trailing-"*" provisional marker. */
  provisional: boolean;
}

/** Pure TSV parser (exported for parse-rule tests). Throws on shape drift. */
export function parseAaTsv(text: string): Map<string, AaTsvRow> {
  const [headerLine, ...dataLines] = text.split("\n").filter((line) => line.trim().length > 0);
  if (headerLine === undefined) throw new Error(`${TSV_NAME}: empty file`);
  if (headerLine !== EXPECTED_HEADER.join("\t")) {
    throw new Error(`${TSV_NAME}: unexpected header "${headerLine}"`);
  }
  const rows = new Map<string, AaTsvRow>();
  for (const line of dataLines) {
    const cells = line.split("\t");
    if (cells.length !== EXPECTED_HEADER.length) {
      throw new Error(`${TSV_NAME}: row "${line}" has ${cells.length} cells, expected 8`);
    }
    // Length is checked above; defaults only satisfy noUncheckedIndexedAccess.
    const [model = "", ctxCell = "", creatorCell = "", ...numCells] = cells;
    let provisional = false;
    const num = (cell = ""): number | null => {
      if (cell === "--") return null;
      const starred = PROVISIONAL_RE.exec(cell);
      if (starred) {
        provisional = true;
        return Number(starred[1]);
      }
      const n = Number(cell);
      if (cell.trim().length === 0 || !Number.isFinite(n)) {
        throw new Error(`${TSV_NAME}: non-numeric cell "${cell}" in row "${model}"`);
      }
      return n;
    };
    const str = (cell: string): string | null => (cell === "--" ? null : cell);
    if (rows.has(model)) throw new Error(`${TSV_NAME}: duplicate model row "${model}"`);
    rows.set(model, {
      model,
      contextWindow: str(ctxCell),
      creator: str(creatorCell),
      intelligenceIndex: num(numCells[0]),
      blendedUsdPer1M: num(numCells[1]),
      medianTokensPerS: num(numCells[2]),
      latencyFirstChunkS: num(numCells[3]),
      totalResponseS: num(numCells[4]),
      provisional,
    });
  }
  return rows;
}

/** Every TSV row keyed by the exact `model` cell (exported for tests). */
export const AA_ROWS_BY_MODEL: ReadonlyMap<string, AaTsvRow> = parseAaTsv(
  readFileSync(join(import.meta.dir, TSV_NAME), "utf8"),
);

/**
 * Explicit config-id → AA-row mapping (FROZEN — round-8 spec item D).
 * `matchedVariant` documents WHY that AA serving-config variant matches how
 * the eval harness actually runs the model; null when the row has no variant
 * siblings and no effort/serving qualifier to justify.
 *
 * Claude rows: Claude Code ships with extended thinking enabled by default and
 * the eval worker passes no disable flag → reasoning rows, not the
 * non-reasoning twins. DeepSeek "(High)": plain API usage through OpenRouter
 * with no effort param gets the standard/high serving config — "(Max)" rows
 * measure the max-reasoning-effort config. Codex "(medium)": Codex CLI's
 * default `model_reasoning_effort` is medium and the eval sandbox passes only
 * MODEL_OVERRIDE (configs carry no env), so no effort override applies.
 */
export const CONFIG_AA_ROWS: Record<string, { sourceRow: string; matchedVariant: string | null }> =
  {
    // [II 37] — "(variant 2)" [31, 0.90s first-chunk] is the non-reasoning twin, rejected.
    "claude-haiku": {
      sourceRow: "Claude 4.5 Haiku",
      matchedVariant:
        "Reasoning row — Claude Code runs with extended thinking on by default (the 21.8s " +
        'first-chunk latency marks the thinking measurement); "(variant 2)" is the non-reasoning twin.',
    },
    // [II 52] — Non-reasoning / Low-Effort rows [44/43] rejected (we run with thinking on).
    "claude-sonnet": {
      sourceRow: "Claude Sonnet 4.6 (max)",
      matchedVariant:
        "(max) — the only reasoning Sonnet 4.6 row; we run with thinking on. Claude Code's " +
        "default thinking budget may sit below AA's max effort.",
    },
    // [II 61] — spec-pinned; the alias `opus` resolves to claude-opus-4-8 today.
    "claude-opus": {
      sourceRow: "Claude Opus 4.8 (max)",
      matchedVariant:
        "(max) — the only Opus 4.8 row; reasoning measurement matches Claude Code's thinking-on default.",
    },
    // claude-opus-4.6 → UNMATCHED (no Opus 4.6 row in the TSV).
    // [II 57] — "(Non-reasoning, high)" [52] rejected.
    "claude-opus-4.7": {
      sourceRow: "Claude Opus 4.7 (max)",
      matchedVariant:
        "(max) — reasoning default matches Claude Code's thinking-on default; " +
        '"(Non-reasoning, high)" is the non-reasoning twin.',
    },
    // [II 61] — same row as claude-opus (two configs sharing one AA row is fine).
    "claude-opus-4.8": {
      sourceRow: "Claude Opus 4.8 (max)",
      matchedVariant:
        "(max) — the only Opus 4.8 row; reasoning measurement matches Claude Code's thinking-on default.",
    },
    // [II 65] — spec-pinned.
    "claude-fable": {
      sourceRow: "Claude Fable 5 (with fallback)",
      matchedVariant: "(with fallback) — the only Fable 5 row in the snapshot (spec-pinned).",
    },
    // [II 46; tok/s + latencies are "--" → null] — "(Max)" [47] and plain non-reasoning [36] rejected.
    "pi-deepseek-flash": {
      sourceRow: "DeepSeek V4 Flash (High)",
      matchedVariant:
        "(High) — plain OpenRouter API usage with no effort param gets the standard/high " +
        'serving config; "(Max)" measures max reasoning effort and the bare row is non-reasoning.',
    },
    // [II 50] — "(Max)" [52] and plain non-reasoning [39] rejected.
    "pi-deepseek-pro": {
      sourceRow: "DeepSeek V4 Pro (High)",
      matchedVariant:
        "(High) — plain OpenRouter API usage with no effort param gets the standard/high " +
        'serving config; "(Max)" measures max reasoning effort and the bare row is non-reasoning.',
    },
    // [II 55] — spec-pinned: AA carries no Gemini-3-Flash row; default row over effort variants.
    "pi-gemini-flash": {
      sourceRow: "Gemini 3.5 Flash",
      matchedVariant:
        "Default row (spec-pinned) — OpenRouter serves the default config, so the " +
        '"(medium)"/"(minimal)" effort variants are rejected. Note: AA has no Gemini-3-Flash ' +
        "row; the catalog model is gemini-3-flash-preview.",
    },
    // [II 57] — exact name match; the catalog model is the preview slug; no variant siblings.
    "pi-gemini-pro": { sourceRow: "Gemini 3.1 Pro Preview", matchedVariant: null },
    // pi-glm-flash → UNMATCHED (TSV has only GLM-5.x rows; never borrow newer-model numbers).
    // [II 28] — exact name match, no variants.
    "pi-qwen-coder": { sourceRow: "Qwen3 Coder Next", matchedVariant: null },
    // pi-minimax-m2.5 → UNMATCHED (TSV has MiniMax-M3 and M2.7 only).
    // pi-kimi-k2.5 → UNMATCHED (TSV has Kimi K2.6 only).
    // [II 33] — spec-pinned "(high)"; "(low)" [24] rejected.
    "pi-gpt-oss-120b": {
      sourceRow: "gpt-oss-120b (high)",
      matchedVariant: '(high) — spec-pinned; "(low)" rejected.',
    },
    // Round-8 OSS refresh rows below (AA snapshot 2026-06-12).
    // [II 54] — "(variant 2)" [43, 16.3s total vs 115.5s] is the non-reasoning twin, rejected.
    "pi-kimi-k2.6": {
      sourceRow: "Kimi K2.6",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 43] is the lower-II non-reasoning twin.',
    },
    // [II 51] — "(variant 2)" [44, 9.8s total vs 63.9s] is the non-reasoning twin, rejected.
    "pi-glm-5.1": {
      sourceRow: "GLM-5.1",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 44] is the lower-II non-reasoning twin.',
    },
    // [II 54] — "(variant 2)" [36, 14.4s total vs 65.0s] is the non-reasoning twin, rejected.
    "pi-mimo-v2.5-pro": {
      sourceRow: "MiMo-V2.5-Pro",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 36] is the lower-II non-reasoning twin.',
    },
    // [II 49] — exact name match, no variant siblings.
    "pi-mimo-v2.5": { sourceRow: "MiMo-V2.5", matchedVariant: null },
    // [II 48] — unique row ("NVIDIA Nemotron 3 Super"/"Nano" are different models, not variants).
    "pi-nemotron-3-ultra": { sourceRow: "Nemotron 3 Ultra", matchedVariant: null },
    // Round-9 expansion rows below (AA snapshot 2026-06-12, proprietary lift).
    // [II 55] — exact name match; MiniMax-M2.7 is a different model, not a variant.
    "pi-minimax-m3": { sourceRow: "MiniMax-M3", matchedVariant: null },
    // [II 57] — exact name match, no variant siblings.
    "pi-qwen3.7-max": { sourceRow: "Qwen3.7 Max", matchedVariant: null },
    // [II 53] — exact name match, no variant siblings.
    "pi-qwen3.7-plus": { sourceRow: "Qwen3.7 Plus", matchedVariant: null },
    // [II 53] — "(medium)" [49], "(low)" [44] and "(Non-reasoning)" [31] rejected.
    "pi-grok-4.3": {
      sourceRow: "Grok 4.3 (high)",
      matchedVariant:
        "(high) — plain OpenRouter API usage with no effort param gets the default/high " +
        'serving config; "(medium)"/"(low)" measure reduced-effort overrides and ' +
        '"(Non-reasoning)" [II 31] is the reasoning-off twin.',
    },
    // [II 39] — unique row (Magistral/Devstral/Small/Large are different models, not variants).
    "pi-mistral-medium-3.5": { sourceRow: "Mistral Medium 3.5", matchedVariant: null },
    // [II 42] — "(variant 2)" [34, 9.6s total vs 27.7s] is the non-reasoning twin, rejected.
    "pi-hy3-preview": {
      sourceRow: "Hy3-preview",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 34] is the lower-II non-reasoning twin.',
    },
    // [II 43] — unique row ("Step 3.5 Flash 2603" is the older model, not a variant).
    "pi-step-3.7-flash": { sourceRow: "Step 3.7 Flash", matchedVariant: null },
    // [II 33] — unique row, no variant siblings.
    "pi-mercury-2": { sourceRow: "Mercury 2", matchedVariant: null },
    // [II 34] — same row as the opencode twin (twin completion).
    "pi-gemini-flash-lite": { sourceRow: "Gemini 3.1 Flash-Lite", matchedVariant: null },
    // Round-10 leaderboard additions below (AA snapshot 2026-06-12).
    // pi-grok-build-0.1 / pi-owl-alpha → UNMATCHED (no rows in the TSV).
    // [II 55] — exact name match; same row pi-gemini-flash spec-pins, now joined natively.
    "pi-gemini-3.5-flash": {
      sourceRow: "Gemini 3.5 Flash",
      matchedVariant:
        "Default row — OpenRouter serves the default config, so the " +
        '"(medium)"/"(minimal)" effort variants are rejected.',
    },
    // [II 36] — unique row ("Nemotron 3 Ultra"/"Nano" are different models, not variants).
    "pi-nemotron-3-super": { sourceRow: "NVIDIA Nemotron 3 Super", matchedVariant: null },
    // [II 50] — exact name match; MiniMax-M3 is a different model, not a variant.
    "pi-minimax-m2.7": { sourceRow: "MiniMax-M2.7", matchedVariant: null },
    // [II 50] — exact name match (Qwen3.6 27B / 35B A3B are different models, not variants).
    "pi-qwen3.6-plus": { sourceRow: "Qwen3.6 Plus", matchedVariant: null },
    // Same rows as the pi- twins: identical OpenRouter model ids.
    "opencode-gemini-flash": {
      sourceRow: "Gemini 3.5 Flash",
      matchedVariant:
        "Default row (spec-pinned) — OpenRouter serves the default config, so the " +
        '"(medium)"/"(minimal)" effort variants are rejected. Note: AA has no Gemini-3-Flash ' +
        "row; the catalog model is gemini-3-flash-preview.",
    },
    "opencode-deepseek-flash": {
      sourceRow: "DeepSeek V4 Flash (High)",
      matchedVariant:
        "(High) — plain OpenRouter API usage with no effort param gets the standard/high " +
        'serving config; "(Max)" measures max reasoning effort and the bare row is non-reasoning.',
    },
    "opencode-deepseek-pro": {
      sourceRow: "DeepSeek V4 Pro (High)",
      matchedVariant:
        "(High) — plain OpenRouter API usage with no effort param gets the standard/high " +
        'serving config; "(Max)" measures max reasoning effort and the bare row is non-reasoning.',
    },
    // opencode-glm-flash → UNMATCHED (see pi-glm-flash).
    "opencode-qwen-coder": { sourceRow: "Qwen3 Coder Next", matchedVariant: null },
    // opencode-minimax-m2.5 / opencode-kimi-k2.5 → UNMATCHED (see the pi- twins).
    // [II 34] — exact name match, no variants.
    "opencode-gemini-flash-lite": { sourceRow: "Gemini 3.1 Flash-Lite", matchedVariant: null },
    // Round-8 OSS refresh — same rows/justifications as the pi- twins above.
    "opencode-kimi-k2.6": {
      sourceRow: "Kimi K2.6",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 43] is the lower-II non-reasoning twin.',
    },
    "opencode-glm-5.1": {
      sourceRow: "GLM-5.1",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 44] is the lower-II non-reasoning twin.',
    },
    "opencode-mimo-v2.5-pro": {
      sourceRow: "MiMo-V2.5-Pro",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 36] is the lower-II non-reasoning twin.',
    },
    "opencode-mimo-v2.5": { sourceRow: "MiMo-V2.5", matchedVariant: null },
    "opencode-nemotron-3-ultra": { sourceRow: "Nemotron 3 Ultra", matchedVariant: null },
    // Round-9 expansion — same rows/justifications as the pi- twins above.
    "opencode-minimax-m3": { sourceRow: "MiniMax-M3", matchedVariant: null },
    "opencode-qwen3.7-max": { sourceRow: "Qwen3.7 Max", matchedVariant: null },
    "opencode-qwen3.7-plus": { sourceRow: "Qwen3.7 Plus", matchedVariant: null },
    "opencode-grok-4.3": {
      sourceRow: "Grok 4.3 (high)",
      matchedVariant:
        "(high) — plain OpenRouter API usage with no effort param gets the default/high " +
        'serving config; "(medium)"/"(low)" measure reduced-effort overrides and ' +
        '"(Non-reasoning)" [II 31] is the reasoning-off twin.',
    },
    "opencode-mistral-medium-3.5": { sourceRow: "Mistral Medium 3.5", matchedVariant: null },
    "opencode-hy3-preview": {
      sourceRow: "Hy3-preview",
      matchedVariant:
        "Reasoning row — plain OpenRouter API usage with no effort param gets the default " +
        '(reasoning) serving config; "(variant 2)" [II 34] is the lower-II non-reasoning twin.',
    },
    "opencode-step-3.7-flash": { sourceRow: "Step 3.7 Flash", matchedVariant: null },
    "opencode-mercury-2": { sourceRow: "Mercury 2", matchedVariant: null },
    // Round-10 leaderboard additions — same rows/justifications as the pi- twins above.
    "opencode-gemini-3.5-flash": {
      sourceRow: "Gemini 3.5 Flash",
      matchedVariant:
        "Default row — OpenRouter serves the default config, so the " +
        '"(medium)"/"(minimal)" effort variants are rejected.',
    },
    "opencode-nemotron-3-super": { sourceRow: "NVIDIA Nemotron 3 Super", matchedVariant: null },
    "opencode-minimax-m2.7": { sourceRow: "MiniMax-M2.7", matchedVariant: null },
    "opencode-qwen3.6-plus": { sourceRow: "Qwen3.6 Plus", matchedVariant: null },
    // [II 38] — effort matching; "(xhigh)" [49] and bare "GPT-5.4 mini" [23] rejected.
    "codex-5.4-mini": {
      sourceRow: "GPT-5.4 mini (medium)",
      matchedVariant:
        "(medium) — Codex CLI's default model_reasoning_effort is medium and the eval sandbox " +
        'passes only MODEL_OVERRIDE (no effort override); "(xhigh)" and the bare row rejected.',
    },
    // codex-5.4 → UNMATCHED (TSV has no plain GPT-5.4 rows — only mini/nano).
    // [II 57] — effort matching; (xhigh)/(high)/(low)/(Non-reasoning)/Instant rejected.
    "codex-5.5": {
      sourceRow: "GPT-5.5 (medium)",
      matchedVariant:
        "(medium) — Codex CLI's default model_reasoning_effort is medium and the eval sandbox " +
        "passes only MODEL_OVERRIDE (no effort override); (xhigh)/(high)/(low)/(Non-reasoning)/" +
        "Instant rejected.",
    },
  };

/**
 * Catalog configs with NO AA row in the snapshot (documented, test-enforced:
 * mapped ∪ unmatched = the full catalog). Unmatched → getAaForConfig() = null
 * → the UI renders nothing. Never borrow numbers from a different model.
 */
export const AA_UNMATCHED_CONFIG_IDS: Record<string, string> = {
  "claude-opus-4.6": "no Claude Opus 4.6 row in the 2026-06-12 snapshot",
  "pi-glm-flash": "TSV has only GLM-5.x rows — no GLM 4.7 Flash",
  "opencode-glm-flash": "TSV has only GLM-5.x rows — no GLM 4.7 Flash",
  "pi-minimax-m2.5": "TSV has MiniMax-M3 and M2.7 only — no M2.5",
  "opencode-minimax-m2.5": "TSV has MiniMax-M3 and M2.7 only — no M2.5",
  "pi-kimi-k2.5": "TSV has Kimi K2.6 only — no K2.5",
  "opencode-kimi-k2.5": "TSV has Kimi K2.6 only — no K2.5",
  "codex-5.4": "TSV has no plain GPT-5.4 rows — only mini/nano",
  // Round-10 leaderboard additions.
  "pi-grok-build-0.1": "no Grok Build row in the 2026-06-12 snapshot — only Grok 4.3 effort rows",
  "opencode-grok-build-0.1":
    "no Grok Build row in the 2026-06-12 snapshot — only Grok 4.3 effort rows",
  "pi-owl-alpha": "no Owl Alpha row — AA does not benchmark the OpenRouter stealth model",
  "opencode-owl-alpha": "no Owl Alpha row — AA does not benchmark the OpenRouter stealth model",
};

/** Joined blocks, built eagerly so a mapping → missing-row typo fails at import. */
const AA_BY_CONFIG: ReadonlyMap<string, AaBenchmark> = new Map(
  Object.entries(CONFIG_AA_ROWS).map(([configId, { sourceRow, matchedVariant }]) => {
    const row = AA_ROWS_BY_MODEL.get(sourceRow);
    if (!row) {
      throw new Error(
        `configs/aa.ts: CONFIG_AA_ROWS["${configId}"] points at "${sourceRow}" — not a row in ${TSV_NAME}`,
      );
    }
    return [
      configId,
      {
        sourceRow,
        matchedVariant,
        contextWindow: row.contextWindow,
        creator: row.creator,
        intelligenceIndex: row.intelligenceIndex,
        blendedUsdPer1M: row.blendedUsdPer1M,
        medianTokensPerS: row.medianTokensPerS,
        latencyFirstChunkS: row.latencyFirstChunkS,
        totalResponseS: row.totalResponseS,
        provisional: row.provisional,
      },
    ];
  }),
);

/** AA benchmark block for a catalog config; null = unmatched (UI renders nothing). */
export function getAaForConfig(configId: string): AaBenchmark | null {
  return AA_BY_CONFIG.get(configId) ?? null;
}
