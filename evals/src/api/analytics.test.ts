import { describe, expect, test } from "bun:test";
import type { Registry } from "../runner/index.ts";
import { type AnalyticsSourceRow, buildAnalytics, vendorOfModelKey } from "./analytics.ts";

/** Real dirty fixture from evals.db — CLI cursor-restore escape after the version. */
const DIRTY_WORKER_VERSION = "agent-swarm v1.85.0\n\u001b[?25h";

const registry: Registry = {
  scenarios: new Map(),
  configs: new Map([
    ["pi-deepseek", { id: "pi-deepseek", provider: "pi", model: "deepseek/deepseek-chat" }],
    // No model field — modelKey falls back to "(claude-tier)".
    ["claude-tier", { id: "claude-tier", provider: "claude", modelTier: "regular" }],
    // Bare-alias config model (the real claude-haiku catalog entry shape).
    ["claude-haiku", { id: "claude-haiku", provider: "claude", model: "haiku" }],
  ]),
};

/** Mirrors the frozen §8 rule output for the committed snapshot (subset). */
const ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5",
  opus: "claude-opus-4-8",
};

/** Fixture row: an OLD attempt — every nullable metric null (pre-cost-tracking DB rows). */
function row(partial: Partial<AnalyticsSourceRow> = {}): AnalyticsSourceRow {
  return {
    runId: "run-1",
    scenarioId: "s1",
    configId: "pi-deepseek",
    status: "passed",
    score: null,
    costUsd: null,
    costSource: null,
    judgeCostUsd: null,
    durationMs: null,
    tokenModel: null,
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    apiVersion: null,
    workerVersion: null,
    runName: null,
    runCreatedAt: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
}

/** Deep walk: every number anywhere in the payload must be finite (hard rule). */
function nonFinitePaths(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  }
  return [];
}

describe("buildAnalytics — empty input", () => {
  test("returns the empty shape, never throws", () => {
    const res = buildAnalytics([], registry);
    expect(Number.isNaN(Date.parse(res.generatedAt))).toBe(false);
    expect(res.scenarioIds).toEqual([]);
    expect(res.configIds).toEqual([]);
    expect(res.matrix).toEqual([]);
    expect(res.models).toEqual([]);
    expect(res.series).toEqual([]);
    expect(res.harnesses).toEqual([]);
    expect(res.vendors).toEqual([]);
    expect(res.scatter).toEqual([]);
  });
});

describe("buildAnalytics — matrix cells", () => {
  test("old null-field rows still contribute counts; every ratio is null, never NaN", () => {
    const res = buildAnalytics([row(), row({ status: "error" })], registry);
    expect(res.matrix).toHaveLength(1);
    const cell = res.matrix[0]!;
    expect(cell.attempts).toBe(2);
    expect(cell.graded).toBe(1); // error attempts are infra, not graded
    expect(cell.passed).toBe(1);
    expect(cell.errors).toBe(1);
    expect(cell.passRate).toBe(1);
    expect(cell.pricedAttempts).toBe(0);
    expect(cell.totalCostUsd).toBeNull();
    expect(cell.avgCostUsd).toBeNull();
    expect(cell.judgePricedAttempts).toBe(0);
    expect(cell.totalJudgeCostUsd).toBeNull();
    expect(cell.avgJudgeCostUsd).toBeNull();
    expect(cell.avgDurationMs).toBeNull();
    expect(cell.avgScore).toBeNull();
    expect(cell.lastRunAt).toBe("2026-06-01T00:00:00.000Z");
  });

  test("zero graded → passRate null (not NaN)", () => {
    const res = buildAnalytics([row({ status: "error" }), row({ status: "running" })], registry);
    const cell = res.matrix[0]!;
    expect(cell.attempts).toBe(2);
    expect(cell.graded).toBe(0);
    expect(cell.passRate).toBeNull();
  });

  test("priced aggregation: $0 counts as priced; nulls excluded from totals and means", () => {
    const res = buildAnalytics(
      [
        row({ costUsd: 0, judgeCostUsd: 0.01, durationMs: 60_000, score: 0.8 }),
        row({ costUsd: 1.5, status: "failed", score: 0.2 }),
        row({ costUsd: null, durationMs: 30_000 }),
      ],
      registry,
    );
    const cell = res.matrix[0]!;
    expect(cell.attempts).toBe(3);
    expect(cell.graded).toBe(3);
    expect(cell.passRate).toBeCloseTo(2 / 3);
    expect(cell.pricedAttempts).toBe(2);
    expect(cell.totalCostUsd).toBeCloseTo(1.5);
    expect(cell.avgCostUsd).toBeCloseTo(0.75);
    expect(cell.judgePricedAttempts).toBe(1);
    expect(cell.totalJudgeCostUsd).toBeCloseTo(0.01);
    expect(cell.avgJudgeCostUsd).toBeCloseTo(0.01);
    expect(cell.avgDurationMs).toBeCloseTo(45_000);
    expect(cell.avgScore).toBeCloseTo(0.5);
  });

  test("lastRunAt is the newest run createdAt touching the cell", () => {
    const res = buildAnalytics(
      [
        row({ runId: "run-2", runCreatedAt: "2026-06-05T00:00:00.000Z" }),
        row({ runId: "run-1", runCreatedAt: "2026-06-01T00:00:00.000Z" }),
      ],
      registry,
    );
    expect(res.matrix[0]!.lastRunAt).toBe("2026-06-05T00:00:00.000Z");
  });

  test("scenario/config ids keep first-seen order; one cell per pair with ≥1 attempt", () => {
    const res = buildAnalytics(
      [
        row({ scenarioId: "s2", configId: "claude-tier" }),
        row({ scenarioId: "s1", configId: "pi-deepseek" }),
        row({ scenarioId: "s2", configId: "claude-tier" }),
      ],
      registry,
    );
    expect(res.scenarioIds).toEqual(["s2", "s1"]);
    expect(res.configIds).toEqual(["claude-tier", "pi-deepseek"]);
    expect(res.matrix).toHaveLength(2);
    expect(res.series).toHaveLength(2);
  });
});

describe("buildAnalytics — model rollups", () => {
  test("model key precedence: tokens.model → registry config.model → (configId)", () => {
    const res = buildAnalytics(
      [
        row({ tokenModel: "claude-opus-4-7", configId: "claude-tier" }),
        row({ tokenModel: null, configId: "pi-deepseek" }),
        row({ tokenModel: null, configId: "claude-tier" }),
        row({ tokenModel: null, configId: "ghost-config" }), // removed from the registry
      ],
      registry,
    );
    const names = res.models.map((m) => m.model).sort();
    expect(names).toEqual([
      "(claude-tier)",
      "(ghost-config)",
      "claude-opus-4-7",
      "deepseek/deepseek-chat",
    ]);
    const ghost = res.models.find((m) => m.model === "(ghost-config)")!;
    expect(ghost.providers).toEqual([]); // unknown config: provider lookup skips
    expect(ghost.configIds).toEqual(["ghost-config"]);
    const opus = res.models.find((m) => m.model === "claude-opus-4-7")!;
    expect(opus.providers).toEqual(["claude"]);
  });

  test("costPerMinute uses only attempts having BOTH cost and duration", () => {
    const res = buildAnalytics(
      [
        row({ tokenModel: "m1", costUsd: 1, durationMs: 60_000 }),
        row({ tokenModel: "m1", costUsd: 2, durationMs: 120_000 }),
        row({ tokenModel: "m1", costUsd: 5, durationMs: null }), // excluded from BOTH sums
        row({ tokenModel: "m1", costUsd: null, durationMs: 999_000 }),
      ],
      registry,
    );
    const m = res.models.find((x) => x.model === "m1")!;
    expect(m.costPerMinute).toBeCloseTo(1); // $3 over 3 minutes
    expect(m.pricedAttempts).toBe(3);
    expect(m.totalCostUsd).toBeCloseTo(8);
  });

  test("costPerMinute is null when the paired subset is empty or Σduration is 0", () => {
    const res = buildAnalytics(
      [
        row({ tokenModel: "m1", costUsd: 1, durationMs: null }),
        row({ tokenModel: "m2", costUsd: 1, durationMs: 0 }),
      ],
      registry,
    );
    expect(res.models.find((x) => x.model === "m1")!.costPerMinute).toBeNull();
    expect(res.models.find((x) => x.model === "m2")!.costPerMinute).toBeNull();
  });

  test("avgCostPerRun divides by distinct runs with ≥1 priced attempt", () => {
    const res = buildAnalytics(
      [
        row({ tokenModel: "m1", runId: "run-a", costUsd: 2 }),
        row({ tokenModel: "m1", runId: "run-a", costUsd: 4 }),
        row({ tokenModel: "m1", runId: "run-b", costUsd: null }), // unpriced run
      ],
      registry,
    );
    const m = res.models.find((x) => x.model === "m1")!;
    expect(m.runs).toBe(2);
    expect(m.avgCostPerRun).toBeCloseTo(6); // $6 over 1 priced run, not 2
    expect(m.avgCostPerAttempt).toBeCloseTo(3);
  });

  test("zero-priced model: every cost field null, counts intact", () => {
    const res = buildAnalytics([row({ tokenModel: "m1" }), row({ tokenModel: "m1" })], registry);
    const m = res.models.find((x) => x.model === "m1")!;
    expect(m.attempts).toBe(2);
    expect(m.pricedAttempts).toBe(0);
    expect(m.totalCostUsd).toBeNull();
    expect(m.avgCostPerAttempt).toBeNull();
    expect(m.avgCostPerRun).toBeNull();
    expect(m.costPerMinute).toBeNull();
  });

  test("models sorted by attempts desc", () => {
    const res = buildAnalytics(
      [row({ tokenModel: "rare" }), row({ tokenModel: "common" }), row({ tokenModel: "common" })],
      registry,
    );
    expect(res.models.map((m) => m.model)).toEqual(["common", "rare"]);
  });
});

describe("buildAnalytics — series + version events", () => {
  test("single-run series: one point, first-capture events only", () => {
    const res = buildAnalytics(
      [row({ apiVersion: "1.85.0", workerVersion: DIRTY_WORKER_VERSION, score: 0.9 })],
      registry,
    );
    expect(res.series).toHaveLength(1);
    const s = res.series[0]!;
    expect(s.points).toHaveLength(1);
    expect(s.points[0]!.apiVersion).toBe("1.85.0");
    expect(s.points[0]!.workerVersion).toBe("1.85.0"); // dirty value re-cleaned on read
    expect(s.points[0]!.avgScore).toBeCloseTo(0.9);
    expect(s.versionEvents).toEqual([
      {
        runId: "run-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        kind: "api",
        from: null,
        to: "1.85.0",
      },
      {
        runId: "run-1",
        createdAt: "2026-06-01T00:00:00.000Z",
        kind: "worker",
        from: null,
        to: "1.85.0",
      },
    ]);
  });

  test("points ascend by run createdAt; version changes emit events; nulls neither emit nor reset", () => {
    const rows: AnalyticsSourceRow[] = [
      // Deliberately out of order — buildAnalytics must not rely on caller ordering.
      row({
        runId: "run-3",
        runCreatedAt: "2026-06-03T00:00:00.000Z",
        workerVersion: "agent-swarm v1.86.0",
      }),
      row({ runId: "run-1", runCreatedAt: "2026-06-01T00:00:00.000Z" }), // old row, no version
      row({
        runId: "run-2",
        runCreatedAt: "2026-06-02T00:00:00.000Z",
        workerVersion: DIRTY_WORKER_VERSION,
      }),
      row({ runId: "run-4", runCreatedAt: "2026-06-04T00:00:00.000Z" }), // gap — no reset
      row({
        runId: "run-5",
        runCreatedAt: "2026-06-05T00:00:00.000Z",
        workerVersion: "agent-swarm v1.86.0",
      }),
    ];
    const res = buildAnalytics(rows, registry);
    const s = res.series[0]!;
    expect(s.points.map((p) => p.runId)).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
    expect(s.points.map((p) => p.workerVersion)).toEqual([
      null,
      "1.85.0",
      "1.86.0",
      null,
      "1.86.0",
    ]);
    // run-2: first capture (from null); run-3: upgrade; run-4 null + run-5 same → no events.
    expect(s.versionEvents).toEqual([
      {
        runId: "run-2",
        createdAt: "2026-06-02T00:00:00.000Z",
        kind: "worker",
        from: null,
        to: "1.85.0",
      },
      {
        runId: "run-3",
        createdAt: "2026-06-03T00:00:00.000Z",
        kind: "worker",
        from: "1.85.0",
        to: "1.86.0",
      },
    ]);
  });

  test("point versions take the first non-null among the run's attempts", () => {
    const res = buildAnalytics(
      [
        row({ apiVersion: null }),
        row({ apiVersion: "v1.90.0" }),
        row({ apiVersion: "v1.91.0" }), // later attempt — ignored, first non-null wins
      ],
      registry,
    );
    expect(res.series[0]!.points[0]!.apiVersion).toBe("1.90.0");
  });

  test("per-point metrics aggregate within the run only", () => {
    const res = buildAnalytics(
      [
        row({ runId: "run-a", costUsd: 1, status: "passed" }),
        row({ runId: "run-a", costUsd: 3, status: "failed" }),
        row({
          runId: "run-b",
          runCreatedAt: "2026-06-02T00:00:00.000Z",
          costUsd: null,
          status: "error",
        }),
      ],
      registry,
    );
    const [a, b] = res.series[0]!.points;
    expect(a!.totalCostUsd).toBeCloseTo(4);
    expect(a!.avgCostUsd).toBeCloseTo(2);
    expect(a!.passRate).toBeCloseTo(0.5);
    expect(b!.totalCostUsd).toBeNull();
    expect(b!.passRate).toBeNull(); // error-only run: graded 0 → null, not NaN
    expect(b!.graded).toBe(0);
  });
});

// ---- v7 spec §6.1 / §7 / §11 coverage ----

describe("buildAnalytics — token sums (v7 §11)", () => {
  test("token-bearing attempts sum; null/zero-token attempts excluded; avgTotalTokens", () => {
    const res = buildAnalytics(
      [
        row({ tokenInput: 100, tokenOutput: 20, tokenCacheRead: 5, tokenCacheWrite: 1 }),
        row({ tokenInput: 50, tokenOutput: 10, tokenCacheRead: null, tokenCacheWrite: null }),
        row({ tokenInput: 0, tokenOutput: 0, tokenCacheRead: 0, tokenCacheWrite: 0 }), // all-zero blob
        row(), // no token capture at all
      ],
      registry,
    );
    const cell = res.matrix[0]!;
    expect(cell.tokens).toEqual({
      tokenAttempts: 2,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      totalTokens: 186,
      avgTotalTokens: 93,
    });
    // The cell's single series point carries the same sums.
    expect(res.series[0]!.points[0]!.tokens).toEqual(cell.tokens!);
    // Model rollup (same group here) too.
    expect(res.models[0]!.tokens).toEqual(cell.tokens!);
  });

  test("group with zero token-bearing attempts → tokens null (not a zeroed object)", () => {
    const res = buildAnalytics([row(), row({ status: "failed" })], registry);
    expect(res.matrix[0]!.tokens).toBeNull();
    expect(res.models[0]!.tokens).toBeNull();
    expect(res.series[0]!.points[0]!.tokens).toBeNull();
    expect(res.harnesses![0]!.tokens).toBeNull();
    expect(res.vendors![0]!.tokens).toBeNull();
  });

  test("negative/garbage token values are defensively clamped to 0", () => {
    const res = buildAnalytics(
      [
        row({ tokenInput: -5, tokenOutput: 0 }), // not token-bearing after clamping
        row({ tokenInput: Number.NaN as unknown as number, tokenOutput: 10 }),
      ],
      registry,
    );
    const tokens = res.matrix[0]!.tokens!;
    expect(tokens.tokenAttempts).toBe(1);
    expect(tokens.inputTokens).toBe(0);
    expect(tokens.outputTokens).toBe(10);
    expect(tokens.totalTokens).toBe(10);
    expect(nonFinitePaths(res)).toEqual([]);
  });
});

describe("buildAnalytics — min/max cost (v7 §6.1)", () => {
  test("min/max over priced attempts on cells, points, models; $0 counts", () => {
    const res = buildAnalytics(
      [
        row({ costUsd: 0, tokenModel: "m1" }),
        row({ costUsd: 1.5, tokenModel: "m1" }),
        row({ costUsd: 0.25, tokenModel: "m1" }),
        row({ costUsd: null, tokenModel: "m1" }),
      ],
      registry,
    );
    const cell = res.matrix[0]!;
    expect(cell.minCostUsd).toBe(0);
    expect(cell.maxCostUsd).toBe(1.5);
    expect(res.series[0]!.points[0]!.minCostUsd).toBe(0);
    expect(res.series[0]!.points[0]!.maxCostUsd).toBe(1.5);
    const m = res.models.find((x) => x.model === "m1")!;
    expect(m.minCostUsd).toBe(0);
    expect(m.maxCostUsd).toBe(1.5);
    expect(res.harnesses![0]!.minCostUsd).toBe(0);
    expect(res.harnesses![0]!.maxCostUsd).toBe(1.5);
  });

  test("zero priced attempts → min/max null everywhere (never NaN/Infinity)", () => {
    const res = buildAnalytics([row(), row()], registry);
    expect(res.matrix[0]!.minCostUsd).toBeNull();
    expect(res.matrix[0]!.maxCostUsd).toBeNull();
    expect(res.models[0]!.minCostUsd).toBeNull();
    expect(res.models[0]!.maxCostUsd).toBeNull();
    expect(res.series[0]!.points[0]!.minCostUsd).toBeNull();
    expect(res.vendors![0]!.minCostUsd).toBeNull();
    expect(nonFinitePaths(res)).toEqual([]);
  });

  test("single priced attempt → min === max", () => {
    const res = buildAnalytics([row({ costUsd: 0.42 })], registry);
    expect(res.matrix[0]!.minCostUsd).toBe(0.42);
    expect(res.matrix[0]!.maxCostUsd).toBe(0.42);
  });
});

describe("vendorOfModelKey (v7 §7.1 — frozen rule)", () => {
  test("slash ids take the vendor segment; the openrouter/ routing prefix is skipped", () => {
    expect(vendorOfModelKey("deepseek/deepseek-v4-flash")).toBe("deepseek");
    expect(vendorOfModelKey("openrouter/deepseek/deepseek-v4-flash")).toBe("deepseek");
    expect(vendorOfModelKey("openrouter/z-ai/glm-4.7-flash")).toBe("z-ai");
    expect(vendorOfModelKey("Google/Gemini-3-Flash")).toBe("google");
  });

  test("prefix families", () => {
    expect(vendorOfModelKey("claude-fable-5")).toBe("anthropic");
    expect(vendorOfModelKey("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(vendorOfModelKey("gpt-5.4-mini")).toBe("openai");
    expect(vendorOfModelKey("o3-mini")).toBe("openai");
    expect(vendorOfModelKey("codex-mini-latest")).toBe("openai");
    expect(vendorOfModelKey("davinci-002")).toBe("openai");
    expect(vendorOfModelKey("gemini-3-flash-preview")).toBe("google");
  });

  test("parenthesized config fallback and unknowns", () => {
    expect(vendorOfModelKey("(ghost-config)")).toBe("(unknown)");
    expect(vendorOfModelKey("<synthetic>")).toBe("(unknown)");
    expect(vendorOfModelKey("glm-4.7-flash")).toBe("(unknown)");
    expect(vendorOfModelKey("")).toBe("(unknown)");
  });
});

describe("buildAnalytics — claude alias resolution (v7 §8)", () => {
  test("bare aliases in tokenModel AND config fallbacks group under the latest id", () => {
    const res = buildAnalytics(
      [
        row({ tokenModel: "fable", configId: "claude-haiku" }), // historical token model
        row({ tokenModel: "claude-fable-5", configId: "claude-haiku" }), // concrete capture
        row({ tokenModel: null, configId: "claude-haiku" }), // falls to config model "haiku"
      ],
      registry,
      ALIASES,
    );
    const names = res.models.map((m) => m.model).sort();
    expect(names).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
    const fable = res.models.find((m) => m.model === "claude-fable-5")!;
    expect(fable.attempts).toBe(2); // alias + concrete merged into one key
    expect(fable.vendor).toBe("anthropic");
    expect(res.vendors!.map((v) => v.group)).toEqual(["anthropic"]);
  });

  test("no alias map (pre-v7 callers) degrades to raw keys", () => {
    const res = buildAnalytics([row({ tokenModel: "fable" })], registry);
    expect(res.models[0]!.model).toBe("fable");
  });

  test("concrete and non-claude ids pass through the alias map untouched", () => {
    const res = buildAnalytics(
      [row({ tokenModel: "deepseek/deepseek-v4-flash" }), row({ tokenModel: "claude-opus-4-7" })],
      registry,
      ALIASES,
    );
    const names = res.models.map((m) => m.model).sort();
    expect(names).toEqual(["claude-opus-4-7", "deepseek/deepseek-v4-flash"]);
  });
});

describe("buildAnalytics — harness/vendor rollups (v7 §7.2)", () => {
  test("harness key: registry provider, configId-prefix fallback, rollup aggregates", () => {
    const res = buildAnalytics(
      [
        row({ configId: "pi-deepseek", costUsd: 1, score: 0.8, runId: "run-a" }),
        row({ configId: "pi-deepseek", costUsd: 3, score: 0.4, status: "failed", runId: "run-b" }),
        row({ configId: "ghost-config", tokenModel: "mystery" }), // left the catalog → prefix
      ],
      registry,
      ALIASES,
    );
    expect(res.harnesses!.map((h) => h.group)).toEqual(["pi", "ghost"]);
    const pi = res.harnesses![0]!;
    expect(pi.attempts).toBe(2);
    expect(pi.graded).toBe(2);
    expect(pi.passed).toBe(1);
    expect(pi.passRate).toBeCloseTo(0.5);
    expect(pi.avgScore).toBeCloseTo(0.6);
    expect(pi.pricedAttempts).toBe(2);
    expect(pi.totalCostUsd).toBeCloseTo(4);
    expect(pi.avgCostPerAttempt).toBeCloseTo(2);
    expect(pi.minCostUsd).toBe(1);
    expect(pi.maxCostUsd).toBe(3);
    expect(pi.models).toEqual(["deepseek/deepseek-chat"]);
    expect(pi.configIds).toEqual(["pi-deepseek"]);
    expect(pi.runs).toBe(2);
    const ghost = res.harnesses![1]!;
    expect(ghost.models).toEqual(["mystery"]);
  });

  test("vendor rollups group across harnesses by the resolved model vendor", () => {
    const res = buildAnalytics(
      [
        row({ configId: "claude-haiku" }), // → claude-haiku-4-5 → anthropic
        row({ configId: "claude-tier", tokenModel: "claude-opus-4-7" }), // anthropic too
        row({ configId: "pi-deepseek" }), // deepseek/deepseek-chat → deepseek
      ],
      registry,
      ALIASES,
    );
    expect(res.vendors!.map((v) => v.group)).toEqual(["anthropic", "deepseek"]);
    const anthropic = res.vendors![0]!;
    expect(anthropic.attempts).toBe(2);
    expect(anthropic.models.sort()).toEqual(["claude-haiku-4-5", "claude-opus-4-7"]);
    expect(anthropic.configIds.sort()).toEqual(["claude-haiku", "claude-tier"]);
  });

  test("rollups sorted by attempts desc, group asc on ties", () => {
    const res = buildAnalytics(
      [
        row({ configId: "claude-haiku" }),
        row({ configId: "pi-deepseek" }),
        row({ configId: "pi-deepseek" }),
      ],
      registry,
      ALIASES,
    );
    expect(res.harnesses!.map((h) => h.group)).toEqual(["pi", "claude"]);
  });
});

describe("buildAnalytics — scatter (v7 §7.2/§11)", () => {
  test("one point per model key with tokens-vs-accuracy material", () => {
    const res = buildAnalytics(
      [
        row({
          tokenModel: "m1",
          score: 0.9,
          costUsd: 0.5,
          durationMs: 60_000,
          tokenInput: 1000,
          tokenOutput: 200,
        }),
        row({
          tokenModel: "m1",
          score: 0.7,
          status: "failed",
          costUsd: 0.3,
          tokenInput: 800,
          tokenOutput: 100,
        }),
        row({ tokenModel: "m2" }), // no tokens, no price — point with null axes material
      ],
      registry,
      ALIASES,
    );
    expect(res.scatter!).toHaveLength(2);
    const p1 = res.scatter!.find((p) => p.model === "m1")!;
    expect(p1.attempts).toBe(2);
    expect(p1.graded).toBe(2);
    expect(p1.passRate).toBeCloseTo(0.5);
    expect(p1.avgScore).toBeCloseTo(0.8);
    expect(p1.avgCostUsd).toBeCloseTo(0.4);
    expect(p1.avgDurationMs).toBeCloseTo(60_000);
    expect(p1.avgTotalTokens).toBeCloseTo(1050); // (1200 + 900) / 2
    expect(p1.totalTokens).toBe(2100);
    expect(p1.harnesses).toEqual(["pi"]);
    expect(p1.vendor).toBe("(unknown)");
    const p2 = res.scatter!.find((p) => p.model === "m2")!;
    expect(p2.avgTotalTokens).toBeNull(); // UI omits the point
    expect(p2.totalTokens).toBe(0);
    expect(p2.avgScore).toBeNull();
    expect(p2.avgCostUsd).toBeNull();
  });

  test("scatter order matches models (attempts desc) and carries every harness", () => {
    const res = buildAnalytics(
      [
        row({ tokenModel: "shared", configId: "pi-deepseek" }),
        row({ tokenModel: "shared", configId: "claude-tier" }),
        row({ tokenModel: "rare", configId: "pi-deepseek" }),
      ],
      registry,
      ALIASES,
    );
    expect(res.scatter!.map((p) => p.model)).toEqual(res.models.map((m) => m.model));
    expect(res.scatter![0]!.harnesses.sort()).toEqual(["claude", "pi"]);
  });
});

describe("buildAnalytics — global filter (v7.6 §C3)", () => {
  /** pi ×2 (one run each), claude ×1, plus a removed config ("ghost-" prefix). */
  const FILTER_ROWS: AnalyticsSourceRow[] = [
    row({ configId: "pi-deepseek", runId: "run-a", score: 0.2, costUsd: 1 }),
    row({
      configId: "pi-deepseek",
      runId: "run-b",
      runCreatedAt: "2026-06-02T00:00:00.000Z",
      score: 0.4,
      costUsd: 3,
      status: "failed",
    }),
    row({ scenarioId: "s2", configId: "claude-haiku", runId: "run-a", score: 1.0, costUsd: 5 }),
    row({ scenarioId: "s2", configId: "ghost-config", runId: "run-a", tokenModel: "mystery" }),
  ];

  test("no filter / empty axes → unfiltered aggregation, appliedFilter null, options filled", () => {
    for (const res of [
      buildAnalytics(FILTER_ROWS, registry, ALIASES),
      buildAnalytics(FILTER_ROWS, registry, ALIASES, null),
      buildAnalytics(FILTER_ROWS, registry, ALIASES, { harnesses: [], configIds: [] }),
    ]) {
      expect(res.appliedFilter).toBeNull();
      expect(res.matrix.reduce((acc, c) => acc + c.attempts, 0)).toBe(4);
      // first-seen order over ALL source rows
      expect(res.filterOptions).toEqual({
        harnesses: ["pi", "claude", "ghost"],
        configIds: ["pi-deepseek", "claude-haiku", "ghost-config"],
      });
    }
  });

  test("harness filter re-aggregates every section over the kept rows", () => {
    const filter = { harnesses: ["pi"], configIds: [] };
    const res = buildAnalytics(FILTER_ROWS, registry, ALIASES, filter);
    expect(res.appliedFilter).toEqual(filter);
    expect(res.scenarioIds).toEqual(["s1"]);
    expect(res.configIds).toEqual(["pi-deepseek"]);
    expect(res.matrix).toHaveLength(1);
    expect(res.matrix[0]!.attempts).toBe(2);
    expect(res.matrix[0]!.totalCostUsd).toBeCloseTo(4);
    expect(res.models.map((m) => m.model)).toEqual(["deepseek/deepseek-chat"]);
    expect(res.models[0]!.avgScore).toBeCloseTo(0.3); // (0.2 + 0.4) / 2 — pi rows only
    expect(res.series).toHaveLength(1);
    expect(res.series[0]!.points).toHaveLength(2);
    expect(res.harnesses!.map((h) => h.group)).toEqual(["pi"]);
    expect(res.vendors!.map((v) => v.group)).toEqual(["deepseek"]);
    expect(res.scatter!.map((p) => p.model)).toEqual(["deepseek/deepseek-chat"]);
  });

  test("harness filter reaches removed configs via the configId-prefix fallback", () => {
    const res = buildAnalytics(FILTER_ROWS, registry, ALIASES, {
      harnesses: ["ghost"],
      configIds: [],
    });
    expect(res.configIds).toEqual(["ghost-config"]);
    expect(res.matrix).toHaveLength(1);
    expect(res.models.map((m) => m.model)).toEqual(["mystery"]);
    expect(res.harnesses!.map((h) => h.group)).toEqual(["ghost"]);
  });

  test("config filter recomputes per-model aggregates across configs (no mean-of-means)", () => {
    const rows = [
      row({ configId: "pi-deepseek", tokenModel: "m1", score: 0.2 }),
      row({ configId: "claude-tier", tokenModel: "m1", score: 1.0 }),
    ];
    const unfiltered = buildAnalytics(rows, registry, ALIASES);
    expect(unfiltered.models[0]!.avgScore).toBeCloseTo(0.6);
    const res = buildAnalytics(rows, registry, ALIASES, {
      harnesses: [],
      configIds: ["claude-tier"],
    });
    expect(res.models.map((m) => m.model)).toEqual(["m1"]);
    expect(res.models[0]!.avgScore).toBeCloseTo(1.0); // per-attempt over the kept rows only
    expect(res.models[0]!.attempts).toBe(1);
    expect(res.harnesses!.map((h) => h.group)).toEqual(["claude"]);
  });

  test("combined axes AND together", () => {
    const keep = buildAnalytics(FILTER_ROWS, registry, ALIASES, {
      harnesses: ["pi"],
      configIds: ["pi-deepseek"],
    });
    expect(keep.matrix[0]!.attempts).toBe(2);
    // configId matches but its harness is "pi", not "claude" → nothing survives.
    const cross = buildAnalytics(FILTER_ROWS, registry, ALIASES, {
      harnesses: ["claude"],
      configIds: ["pi-deepseek"],
    });
    expect(cross.matrix).toEqual([]);
    expect(cross.models).toEqual([]);
    expect(cross.series).toEqual([]);
    expect(cross.harnesses).toEqual([]);
    expect(cross.vendors).toEqual([]);
    expect(cross.scatter).toEqual([]);
    expect(cross.appliedFilter).toEqual({ harnesses: ["claude"], configIds: ["pi-deepseek"] });
  });

  test("unknown filter values match nothing — empty aggregates, never an error", () => {
    const res = buildAnalytics(FILTER_ROWS, registry, ALIASES, {
      harnesses: ["nope"],
      configIds: ["never-existed"],
    });
    expect(res.matrix).toEqual([]);
    expect(res.scenarioIds).toEqual([]);
    expect(res.configIds).toEqual([]);
    expect(nonFinitePaths(res)).toEqual([]);
  });

  test("filterOptions stays complete (first-seen order) while a filter is active", () => {
    const res = buildAnalytics(FILTER_ROWS, registry, ALIASES, {
      harnesses: ["claude"],
      configIds: [],
    });
    expect(res.configIds).toEqual(["claude-haiku"]); // filtered-row semantics
    expect(res.filterOptions).toEqual({
      harnesses: ["pi", "claude", "ghost"],
      configIds: ["pi-deepseek", "claude-haiku", "ghost-config"],
    });
  });

  test("filtered payload survives JSON.stringify with no NaN/Infinity anywhere", () => {
    const messy = [
      ...FILTER_ROWS,
      row({ configId: "pi-deepseek", status: "error" }),
      row({ configId: "pi-deepseek", costUsd: 0, durationMs: 0, score: 0 }),
      row({ configId: "pi-deepseek", tokenInput: Number.NaN as unknown as number }),
    ];
    const res = buildAnalytics(messy, registry, ALIASES, { harnesses: ["pi"], configIds: [] });
    expect(nonFinitePaths(res)).toEqual([]);
    const text = JSON.stringify(res);
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
  });
});

describe("buildAnalytics — no NaN/Infinity anywhere (hard rule)", () => {
  test("messy mixed fixture (old rows, zero denominators, garbage) stays finite", () => {
    const res = buildAnalytics(
      [
        row(), // all-null old row
        row({ status: "error" }),
        row({ status: "running" }),
        row({ costUsd: 0, durationMs: 0, score: 0 }),
        row({ configId: "ghost-config" }),
        row({ tokenModel: "fable", tokenInput: -1 }),
        row({ tokenModel: "<synthetic>", configId: "claude-haiku" }),
        row({ tokenInput: Number.POSITIVE_INFINITY as unknown as number }),
      ],
      registry,
      ALIASES,
    );
    expect(nonFinitePaths(res)).toEqual([]);
  });
});
