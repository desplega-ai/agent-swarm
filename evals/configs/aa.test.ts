import { describe, expect, test } from "bun:test";
import {
  AA_ROWS_BY_MODEL,
  AA_UNMATCHED_CONFIG_IDS,
  CONFIG_AA_ROWS,
  getAaForConfig,
  parseAaTsv,
} from "./aa.ts";
import { configs } from "./index.ts";

const CATALOG_IDS = new Set(configs.map((c) => c.id));

describe("AA mapping completeness (v7.6 item D, frozen)", () => {
  test("every CONFIG_AA_ROWS key exists in the catalog", () => {
    for (const id of Object.keys(CONFIG_AA_ROWS)) {
      expect(CATALOG_IDS.has(id)).toBe(true);
    }
  });

  test("every unmatched id exists in the catalog", () => {
    for (const id of Object.keys(AA_UNMATCHED_CONFIG_IDS)) {
      expect(CATALOG_IDS.has(id)).toBe(true);
    }
  });

  test("mapped and unmatched are disjoint and together cover the full catalog", () => {
    const mapped = new Set(Object.keys(CONFIG_AA_ROWS));
    const unmatched = new Set(Object.keys(AA_UNMATCHED_CONFIG_IDS));
    for (const id of mapped) expect(unmatched.has(id)).toBe(false);
    for (const id of CATALOG_IDS) {
      expect(mapped.has(id) || unmatched.has(id)).toBe(true);
    }
    expect(mapped.size + unmatched.size).toBe(configs.length);
  });

  test("frozen counts: 59 matched, 22 unmatched, 32 distinct AA rows", () => {
    expect(Object.keys(CONFIG_AA_ROWS).length).toBe(59);
    expect(Object.keys(AA_UNMATCHED_CONFIG_IDS).length).toBe(22);
    // 32: Haiku, Sonnet 4.6 (max), Opus 4.8 (max), Opus 4.7 (max), Fable 5,
    // DS Flash (High), DS Pro (High), Gemini 3.5 Flash, Gemini 3.1 Pro Preview
    // (v7.7 item 1), Qwen3 Coder Next, gpt-oss-120b (high),
    // Gemini 3.1 Flash-Lite, GPT-5.4 mini (medium), GPT-5.5 (medium), the
    // round-8 OSS refresh: Kimi K2.6, GLM-5.1, MiMo-V2.5-Pro, MiMo-V2.5,
    // Nemotron 3 Ultra, plus the round-9 expansion: MiniMax-M3, Qwen3.7 Max,
    // Qwen3.7 Plus, Grok 4.3 (high), Mistral Medium 3.5, Hy3-preview,
    // Step 3.7 Flash, Mercury 2 (each shared by a pi/opencode twin pair;
    // Gemini 3.1 Flash-Lite gained its pi twin without adding a row), plus the
    // round-10 leaderboard additions: NVIDIA Nemotron 3 Super, MiniMax-M2.7,
    // Qwen3.6 Plus (Gemini 3.5 Flash was already a row via the gemini-flash
    // spec-pin; grok-build-0.1 / owl-alpha have no rows), plus round-11 rows:
    // Qwen3.5 397B A17B and Mistral Large 3.
    expect(new Set(Object.values(CONFIG_AA_ROWS).map((m) => m.sourceRow)).size).toBe(32);
  });

  test("every sourceRow exists in the TSV", () => {
    for (const { sourceRow } of Object.values(CONFIG_AA_ROWS)) {
      expect(AA_ROWS_BY_MODEL.has(sourceRow)).toBe(true);
    }
  });

  test("none of our picks is a '(variant 2)' row", () => {
    for (const { sourceRow } of Object.values(CONFIG_AA_ROWS)) {
      expect(sourceRow).not.toContain("(variant 2)");
    }
  });

  test("getAaForConfig: matched ids carry the block, unmatched + unknown ids are null", () => {
    for (const [id, { sourceRow }] of Object.entries(CONFIG_AA_ROWS)) {
      expect(getAaForConfig(id)?.sourceRow).toBe(sourceRow);
    }
    for (const id of Object.keys(AA_UNMATCHED_CONFIG_IDS)) {
      expect(getAaForConfig(id)).toBeNull();
    }
    expect(getAaForConfig("no-such-config")).toBeNull();
  });

  test("matchedVariant is null only for rows without variant choices", () => {
    expect(getAaForConfig("pi-qwen-coder")?.matchedVariant).toBeNull();
    expect(getAaForConfig("opencode-qwen-coder")?.matchedVariant).toBeNull();
    expect(getAaForConfig("opencode-gemini-flash-lite")?.matchedVariant).toBeNull();
    // v7.7 item 1: "Preview" is the model identity (the catalog model IS the
    // preview slug), not a serving variant — the snapshot's only 3.1 Pro row.
    expect(getAaForConfig("pi-gemini-pro")?.matchedVariant).toBeNull();
    // Round-8 OSS refresh: MiMo-V2.5 and Nemotron 3 Ultra are unique rows.
    for (const short of ["mimo-v2.5", "nemotron-3-ultra"]) {
      expect(getAaForConfig(`pi-${short}`)?.matchedVariant).toBeNull();
      expect(getAaForConfig(`opencode-${short}`)?.matchedVariant).toBeNull();
    }
    // Round-9 expansion: unique rows without variant/effort siblings.
    for (const short of [
      "minimax-m3",
      "qwen3.7-max",
      "qwen3.7-plus",
      "mistral-medium-3.5",
      "step-3.7-flash",
      "mercury-2",
    ]) {
      expect(getAaForConfig(`pi-${short}`)?.matchedVariant).toBeNull();
      expect(getAaForConfig(`opencode-${short}`)?.matchedVariant).toBeNull();
    }
    // Twin completion: same unique row as the pre-existing opencode config.
    expect(getAaForConfig("pi-gemini-flash-lite")?.matchedVariant).toBeNull();
    // Round-10 leaderboard additions: unique rows without variant/effort siblings.
    for (const short of ["nemotron-3-super", "minimax-m2.7", "qwen3.6-plus"]) {
      expect(getAaForConfig(`pi-${short}`)?.matchedVariant).toBeNull();
      expect(getAaForConfig(`opencode-${short}`)?.matchedVariant).toBeNull();
    }
    // Variant/effort picks document their justification.
    for (const id of ["claude-haiku", "claude-sonnet", "pi-deepseek-flash", "codex-5.5"]) {
      expect(getAaForConfig(id)?.matchedVariant).toBeTruthy();
    }
    // Round-10: Gemini 3.5 Flash default-row pick justifies rejecting the effort rows.
    expect(getAaForConfig("pi-gemini-3.5-flash")?.matchedVariant).toContain("(medium)");
    expect(getAaForConfig("opencode-gemini-3.5-flash")?.matchedVariant).toContain("(medium)");
    // Round-9: Grok 4.3 effort pick justifies rejecting the other effort rows.
    expect(getAaForConfig("pi-grok-4.3")?.matchedVariant).toContain("(high)");
    expect(getAaForConfig("opencode-grok-4.3")?.matchedVariant).toContain("(high)");
    // Picks with a "(variant 2)" sibling justify rejecting it.
    for (const short of ["kimi-k2.6", "glm-5.1", "mimo-v2.5-pro", "hy3-preview"]) {
      expect(getAaForConfig(`pi-${short}`)?.matchedVariant).toContain("(variant 2)");
      expect(getAaForConfig(`opencode-${short}`)?.matchedVariant).toContain("(variant 2)");
    }
  });

  test("configs sharing a model share the AA row (pi/opencode twins, opus alias)", () => {
    expect(getAaForConfig("claude-opus")?.sourceRow).toBe(
      getAaForConfig("claude-opus-4.8")?.sourceRow ?? "",
    );
    for (const short of [
      "deepseek-flash",
      "deepseek-pro",
      "gemini-flash",
      "qwen-coder",
      "kimi-k2.6",
      "glm-5.1",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "nemotron-3-ultra",
      // Round-9 expansion (gemini-flash-lite: the pi twin joined in round 9).
      "minimax-m3",
      "qwen3.7-max",
      "qwen3.7-plus",
      "grok-4.3",
      "mistral-medium-3.5",
      "hy3-preview",
      "step-3.7-flash",
      "mercury-2",
      "gemini-flash-lite",
      // Round-10 leaderboard additions.
      "gemini-3.5-flash",
      "nemotron-3-super",
      "minimax-m2.7",
      "qwen3.6-plus",
    ]) {
      expect(getAaForConfig(`pi-${short}`)?.sourceRow).toBe(
        getAaForConfig(`opencode-${short}`)?.sourceRow ?? "",
      );
    }
  });
});

describe("AA TSV parse rules (frozen)", () => {
  test("spot-check: Claude Fable 5 row parses with full numerics", () => {
    const aa = getAaForConfig("claude-fable");
    expect(typeof aa?.matchedVariant).toBe("string");
    expect(aa).toMatchObject({
      sourceRow: "Claude Fable 5 (with fallback)",
      contextWindow: "1M",
      creator: "Anthropic",
      intelligenceIndex: 65,
      blendedUsdPer1M: 7.7,
      medianTokensPerS: 62,
      latencyFirstChunkS: 109.12,
      totalResponseS: 117.15,
      provisional: false,
    });
  });

  test("spot-check: pi-gemini-pro joins the Gemini 3.1 Pro Preview row (v7.7 item 1)", () => {
    expect(getAaForConfig("pi-gemini-pro")).toEqual({
      sourceRow: "Gemini 3.1 Pro Preview",
      matchedVariant: null,
      contextWindow: "1M",
      creator: "Google",
      intelligenceIndex: 57,
      blendedUsdPer1M: 1.74,
      medianTokensPerS: 125,
      latencyFirstChunkS: 25.81,
      totalResponseS: 29.8,
      provisional: false,
    });
  });

  test('"--" cells → null (DeepSeek V4 Flash (High) exercises null-safe rendering)', () => {
    const aa = getAaForConfig("pi-deepseek-flash");
    expect(aa?.intelligenceIndex).toBe(46);
    expect(aa?.blendedUsdPer1M).toBe(0.08);
    expect(aa?.medianTokensPerS).toBeNull();
    expect(aa?.latencyFirstChunkS).toBeNull();
    expect(aa?.totalResponseS).toBeNull();
    expect(aa?.provisional).toBe(false);
  });

  test('provisional marker: "35*" keeps the number and flags the block (Nova fixture)', () => {
    const nova = AA_ROWS_BY_MODEL.get("Nova 2.0 Lite (high)");
    expect(nova?.intelligenceIndex).toBe(35);
    expect(nova?.provisional).toBe(true);
    // Currently the Nova row is the only provisional measurement in the snapshot.
    const provisional = [...AA_ROWS_BY_MODEL.values()].filter((r) => r.provisional);
    expect(provisional.map((r) => r.model)).toEqual(["Nova 2.0 Lite (high)"]);
  });

  test("'0.00' parses as 0, not null — '--' is the only null marker", () => {
    expect(AA_ROWS_BY_MODEL.get("Command A+")?.blendedUsdPer1M).toBe(0);
  });

  test("parseAaTsv: inline fixture covers '--', provisional and raw strings", () => {
    const tsv = [
      "model\tcontext_window\tcreator\taa_intelligence_index\tblended_usd_per_1m\tmedian_tokens_per_s\tlatency_first_chunk_s\ttotal_response_s",
      "Fixture Model\t922k\tAcme\t35*\t0.52\t--\t1.25\t--",
    ].join("\n");
    const rows = parseAaTsv(tsv);
    expect(rows.get("Fixture Model")).toEqual({
      model: "Fixture Model",
      contextWindow: "922k",
      creator: "Acme",
      intelligenceIndex: 35,
      blendedUsdPer1M: 0.52,
      medianTokensPerS: null,
      latencyFirstChunkS: 1.25,
      totalResponseS: null,
      provisional: true,
    });
  });

  test("parseAaTsv rejects header drift, bad cells and duplicate rows", () => {
    expect(() => parseAaTsv("model\tonly_two_cols\nA\t1")).toThrow("unexpected header");
    const header =
      "model\tcontext_window\tcreator\taa_intelligence_index\tblended_usd_per_1m\tmedian_tokens_per_s\tlatency_first_chunk_s\ttotal_response_s";
    expect(() => parseAaTsv(`${header}\nA\t1M\tAcme\tnope\t1\t1\t1\t1`)).toThrow("non-numeric");
    expect(() => parseAaTsv(`${header}\nA\t1M\tAcme\t1\t1\t1\t1`)).toThrow("cells");
    const row = "A\t1M\tAcme\t1\t1\t1\t1\t1";
    expect(() => parseAaTsv(`${header}\n${row}\n${row}`)).toThrow("duplicate");
  });
});
