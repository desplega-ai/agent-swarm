import { describe, expect, test } from "bun:test";
import { SUITE_SCENARIO_VERSIONS, SUITE_VERSION } from "../../scenarios/suite.ts";
import type { Registry } from "../runner/index.ts";
import type { AnalyticsSourceRow } from "./analytics.ts";
import {
  buildCompare,
  buildFrontier,
  buildHeatmap,
  buildLeaderboard,
  buildReliability,
  LOW_N,
  MIN_COMPARE_SCENARIOS,
  type SuiteAnalyticsInput,
  TREND_LIMIT,
} from "./suite-analytics.ts";

const registry: Registry = {
  scenarios: new Map(),
  configs: new Map([
    ["claude-a", { id: "claude-a", provider: "claude", model: "claude-opus-5-5" }],
    ["claude-b", { id: "claude-b", provider: "claude", model: "claude-sonnet-5-5" }],
    ["claude-c", { id: "claude-c", provider: "claude", model: "claude-haiku-4-5" }],
    ["pi-a", { id: "pi-a", provider: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash" }],
    ["pi-opus", { id: "pi-opus", provider: "pi", model: "claude-opus-5-5" }],
    ["codex-a", { id: "codex-a", provider: "codex", model: "gpt-6-luna" }],
  ]),
};

const SCENARIOS = ["s1", "s2", "s3"];
const SUITE = "1.0";

interface Outcome {
  pass?: boolean;
  score?: number;
  cost?: number | null;
  judge?: number | null;
  agentMs?: number | null;
  status?: string;
  tokens?: number;
  run?: string;
  createdAt?: string;
  effort?: string | null;
  model?: string | null;
  exclusion?: string | null;
  suite?: string | null;
}

let seq = 0;

/** attempts of one config on one scenario. */
function cell(configId: string, scenarioId: string, outcomes: Outcome[]): AnalyticsSourceRow[] {
  return outcomes.map((o) => {
    const pass = o.pass ?? true;
    seq += 1;
    return {
      runId: o.run ?? "run-1",
      scenarioId,
      configId,
      status: o.status ?? (pass ? "passed" : "failed"),
      exclusion: o.exclusion ?? null,
      score: o.status === "error" ? null : (o.score ?? (pass ? 1 : 0)),
      costUsd: o.cost === undefined ? 0.1 : o.cost,
      costSource: null,
      judgeCostUsd: o.judge === undefined ? 0.01 : o.judge,
      durationMs: 100_000,
      agentMs: o.agentMs === undefined ? 60_000 : o.agentMs,
      resolvedModel: o.model ?? null,
      reasoningEffort: o.effort ?? null,
      suiteVersion: o.suite === undefined ? SUITE : o.suite,
      tokenModel: null,
      tokenInput: o.tokens ?? 1000,
      tokenOutput: 0,
      tokenCacheRead: 0,
      tokenCacheWrite: 0,
      apiVersion: null,
      workerVersion: null,
      runName: `name-${o.run ?? "run-1"}`,
      runCreatedAt: o.createdAt ?? `2026-09-30T00:00:${String(seq % 60).padStart(2, "0")}Z`,
    };
  });
}

const rep = (n: number, o: Outcome): Outcome[] => Array.from({ length: n }, () => ({ ...o }));

/** One config over all of `scenarios`, n attempts each, all with the same outcome shape. */
function config(
  configId: string,
  o: Outcome,
  n = 3,
  scenarios: string[] = SCENARIOS,
): AnalyticsSourceRow[] {
  return scenarios.flatMap((s) => cell(configId, s, rep(n, o)));
}

function input(
  rows: AnalyticsSourceRow[],
  extra: Partial<SuiteAnalyticsInput> = {},
): SuiteAnalyticsInput {
  return {
    rows,
    registry,
    suiteVersion: SUITE,
    expectedScenarioIds: SCENARIOS,
    generatedAt: "2026-09-30T12:00:00.000Z",
    ...extra,
  };
}

/** Every number anywhere in a payload must be finite. */
function nonFinitePaths(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  }
  return [];
}

describe("frontier", () => {
  // A dominates B (better score, cheaper); C is the best score at a high price; D is cheap and weak.
  const rows = [
    ...config("claude-a", { score: 0.9, pass: true, cost: 1 }),
    ...config("claude-b", { score: 0.8, pass: true, cost: 2 }),
    ...config("claude-c", { score: 0.95, pass: true, cost: 3 }),
    ...config("pi-a", { score: 0.5, pass: false, cost: 0.1 }),
  ];

  test("a dominated config is never on the frontier; the rest are, ordered by cost", () => {
    const res = buildFrontier(input(rows));
    expect(res.status).toBe("ok");
    expect(res.frontier.cost).toEqual(["pi-a", "claude-a", "claude-c"]);
    expect(res.frontier.cost).not.toContain("claude-b");
    const b = res.points.find((p) => p.configId === "claude-b");
    expect(b?.fullCoverage).toBe(true);
    expect(nonFinitePaths(res)).toEqual([]);
  });

  test("points carry score, CI, cost, judge cost, time and coverage", () => {
    const res = buildFrontier(input(rows));
    expect(res.points.map((p) => p.configId)).toEqual(["claude-c", "claude-a", "claude-b", "pi-a"]);
    const a = res.points.find((p) => p.configId === "claude-a");
    expect(a?.score).toBeCloseTo(0.9, 12);
    expect(a?.scoreCi.lo).toBeCloseTo(0.9, 12);
    expect(a?.avgCostUsd).toBeCloseTo(1, 12);
    expect(a?.avgJudgeCostUsd).toBeCloseTo(0.01, 12);
    expect(a?.medianAgentMs).toBe(60_000);
    expect(a?.attempts).toBe(9);
    expect(a?.scenarios).toEqual({ covered: 3, expected: 3 });
    expect(a?.lowN).toBe(false);
    expect(a?.harness).toBe("claude");
    expect(a?.resolvedModel).toBe("claude-opus-5-5");
    expect(a?.vendor).toBe("anthropic");
  });

  test("a partial-coverage config is excluded from the pooled frontier but kept in the per-scenario one", () => {
    const partial = config("codex-a", { score: 1, pass: true, cost: 0.01 }, 3, ["s1"]);
    const res = buildFrontier(input([...rows, ...partial]));
    expect(res.frontier.cost).not.toContain("codex-a");
    expect(res.frontier.time).not.toContain("codex-a");
    const point = res.points.find((p) => p.configId === "codex-a");
    expect(point?.fullCoverage).toBe(false);
    expect(point?.scenarios).toEqual({ covered: 1, expected: 3 });
    const s1 = res.scenarios.find((s) => s.scenarioId === "s1");
    expect(s1?.frontier.cost).toEqual(["codex-a"]);
    const s2 = res.scenarios.find((s) => s.scenarioId === "s2");
    expect(s2?.points.map((p) => p.configId)).not.toContain("codex-a");
    expect(res.warnings.join(" ")).toContain("did not run the full suite");
  });

  test("a config with a cell under LOW_N is flagged and left off the pooled frontier", () => {
    const thin = [
      ...cell("codex-a", "s1", rep(LOW_N - 1, { score: 1, cost: 0.01 })),
      ...cell("codex-a", "s2", rep(5, { score: 1, cost: 0.01 })),
      ...cell("codex-a", "s3", rep(5, { score: 1, cost: 0.01 })),
    ];
    const res = buildFrontier(input([...rows, ...thin]));
    const point = res.points.find((p) => p.configId === "codex-a");
    expect(point?.lowN).toBe(true);
    expect(point?.fullCoverage).toBe(true);
    expect(res.frontier.cost).not.toContain("codex-a");
    expect(res.frontier.cost).toContain("claude-a");
    const s1 = res.scenarios.find((s) => s.scenarioId === "s1");
    expect(s1?.points.find((p) => p.configId === "codex-a")?.lowN).toBe(true);
    expect(s1?.frontier.cost).not.toContain("codex-a");
  });

  test("before a real matrix exists: low-n flags and no frontier, never a misleading one", () => {
    const res = buildFrontier(input(config("claude-a", { score: 1 }, 1)));
    expect(res.status).toBe("low-n");
    expect(res.frontier).toEqual({ cost: [], time: [] });
    expect(res.points).toHaveLength(1);
    expect(res.points[0]?.lowN).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  test("status: empty and no-full-coverage", () => {
    expect(buildFrontier(input([])).status).toBe("empty");
    const partial = buildFrontier(input(config("claude-a", { score: 1 }, 5, ["s1"])));
    expect(partial.status).toBe("no-full-coverage");
    expect(partial.frontier).toEqual({ cost: [], time: [] });
  });

  test("unpriced configs stay off the cost frontier but can sit on the time frontier", () => {
    const unpriced = config("codex-a", { score: 0.99, cost: null, agentMs: 1000 });
    const res = buildFrontier(input([...rows, ...unpriced]));
    const point = res.points.find((p) => p.configId === "codex-a");
    expect(point?.costComplete).toBe(false);
    expect(point?.avgCostUsd).toBeNull();
    expect(res.frontier.cost).not.toContain("codex-a");
    expect(res.frontier.time).toEqual(["codex-a"]);
  });

  test("time frontier reads agent time (tasksMs), not total duration", () => {
    const fast = config("claude-a", { score: 0.8, cost: 1, agentMs: 10_000 });
    const slow = config("claude-b", { score: 0.8, cost: 1, agentMs: 90_000 });
    const res = buildFrontier(input([...fast, ...slow]));
    expect(res.points.find((p) => p.configId === "claude-a")?.medianAgentMs).toBe(10_000);
    expect(res.frontier.time).toEqual(["claude-a"]);
    // Equal score and equal cost: neither dominates, both stay on the cost frontier.
    expect(res.frontier.cost.sort()).toEqual(["claude-a", "claude-b"]);
  });

  test("rows outside the suite, off-suite rows and cancelled attempts are ignored", () => {
    const noise = [
      ...config("codex-a", { score: 1, suite: "0.9" }),
      ...config("pi-a", { score: 1, suite: null }),
      ...config("claude-c", { score: 1, exclusion: "cancelled", status: "error" }),
    ];
    const res = buildFrontier(input([...config("claude-a", { score: 0.7 }), ...noise]));
    expect(res.points.map((p) => p.configId)).toEqual(["claude-a"]);
  });

  test("default expected scenarios for the current suite come from the manifest", () => {
    const ids = Object.keys(SUITE_SCENARIO_VERSIONS);
    const full = config("claude-a", { score: 1 }, 3, ids).map((r) => ({
      ...r,
      suiteVersion: SUITE_VERSION,
    }));
    const missingOne = config("claude-b", { score: 1 }, 3, ids.slice(1)).map((r) => ({
      ...r,
      suiteVersion: SUITE_VERSION,
    }));
    const res = buildFrontier({
      rows: [...full, ...missingOne],
      registry,
      suiteVersion: SUITE_VERSION,
    });
    expect(res.expectedScenarios).toEqual(ids);
    expect(res.points.find((p) => p.configId === "claude-a")?.fullCoverage).toBe(true);
    expect(res.points.find((p) => p.configId === "claude-b")?.fullCoverage).toBe(false);
  });

  test("a non-current suite defines the full suite from what it observed", () => {
    const rows2 = [
      ...config("claude-a", { score: 1, suite: "0.5" }, 3, ["x1", "x2"]),
      ...config("claude-b", { score: 1, suite: "0.5" }, 3, ["x1"]),
    ];
    const res = buildFrontier({ rows: rows2, registry, suiteVersion: "0.5" });
    expect(res.expectedScenarios).toEqual(["x1", "x2"]);
    expect(res.points.find((p) => p.configId === "claude-b")?.fullCoverage).toBe(false);
  });
});

describe("leaderboard", () => {
  test("pass@1 and pass^k against a hand-computed fixture", () => {
    // s1: 4 of 5 pass -> pass^3 = C(4,3)/C(5,3) = 0.4. s2: 3 of 3 -> 1. s3: 2 of 2, n < k, skipped.
    const rows = [
      ...cell("claude-a", "s1", [...rep(4, { pass: true }), ...rep(1, { pass: false })]),
      ...cell("claude-a", "s2", rep(3, { pass: true })),
      ...cell("claude-a", "s3", rep(2, { pass: true })),
    ];
    const res = buildLeaderboard(input(rows), 3);
    const row = res.tracks.fixedHarness[0]?.rows[0];
    expect(res.k).toBe(3);
    expect(row?.passAt1).toBeCloseTo((0.8 + 1 + 1) / 3, 12);
    expect(row?.passPowK).toBeCloseTo((0.4 + 1) / 2, 12);
    expect(row?.passPowKScenarios).toBe(2);
    expect(row?.lowN).toBe(true);

    const k2 = buildLeaderboard(input(rows), 2).tracks.fixedHarness[0]?.rows[0];
    // s1: C(4,2)/C(5,2) = 0.6; s2: 1; s3: C(2,2)/C(2,2) = 1.
    expect(k2?.passPowK).toBeCloseTo((0.6 + 1 + 1) / 3, 12);
    expect(k2?.passPowKScenarios).toBe(3);
  });

  test("score is the mean of scenario means: an over-sampled scenario does not dominate", () => {
    const rows = [
      ...cell("claude-a", "s1", rep(10, { score: 1 })),
      ...cell("claude-a", "s2", rep(1, { score: 0 })),
      ...cell("claude-a", "s3", rep(3, { score: 0.5 })),
    ];
    const row = buildLeaderboard(input(rows)).tracks.fixedHarness[0]?.rows[0];
    expect(row?.score).toBeCloseTo(0.5, 12);
    expect(row?.attempts).toBe(14);
  });

  test("ranks by score, ties share a rank, the spread brackets the rank, partial rows are unranked", () => {
    const rows = [
      ...config("claude-a", { score: 0.9 }, 4),
      ...config("claude-b", { score: 0.9 }, 4),
      ...config("claude-c", { score: 0.4, pass: false }, 4),
      ...config("pi-a", { score: 1 }, 4, ["s1"]),
    ];
    const res = buildLeaderboard(input(rows));
    const claude = res.tracks.fixedHarness.find((g) => g.harness === "claude");
    expect(claude?.rows.map((r) => [r.configId, r.rank])).toEqual([
      ["claude-a", 1],
      ["claude-b", 1],
      ["claude-c", 3],
    ]);
    for (const r of claude?.rows ?? []) {
      expect(r.rankSpread).not.toBeNull();
      expect(r.rankSpread?.lo).toBeLessThanOrEqual(r.rank as number);
      expect(r.rankSpread?.hi).toBeGreaterThanOrEqual(r.rank as number);
    }
    const pi = res.tracks.fixedHarness.find((g) => g.harness === "pi");
    expect(pi?.rows[0]?.rank).toBeNull();
    expect(pi?.rows[0]?.rankSpread).toBeNull();
    expect(pi?.rows[0]?.fullCoverage).toBe(false);
    expect(nonFinitePaths(res)).toEqual([]);
  });

  test("rank spread widens when scores are close and noisy, and is exact when they are far apart", () => {
    const noisy = (id: string, pattern: number[]) =>
      SCENARIOS.flatMap((s) =>
        cell(
          id,
          s,
          pattern.map((score) => ({ score, pass: score >= 0.5 })),
        ),
      );
    const close = buildLeaderboard(
      input([...noisy("claude-a", [1, 0, 1, 0, 1, 0]), ...noisy("claude-b", [0, 1, 0, 1, 0, 1])]),
    );
    const closeRows = close.tracks.fixedHarness[0]?.rows ?? [];
    expect(closeRows.every((r) => r.rankSpread?.lo === 1 && r.rankSpread?.hi === 2)).toBe(true);
    const far = buildLeaderboard(
      input([
        ...config("claude-a", { score: 1 }, 4),
        ...config("claude-b", { score: 0, pass: false }, 4),
      ]),
    );
    expect(far.tracks.fixedHarness[0]?.rows.map((r) => r.rankSpread)).toEqual([
      { lo: 1, hi: 1 },
      { lo: 2, hi: 2 },
    ]);
  });

  test("two tracks: per-harness ranking and the best harness per model", () => {
    // Same model on two harnesses: the claude harness beats pi. A different model only on codex.
    const rows = [
      ...config("claude-a", { score: 0.9, model: "claude-opus-5-5" }, 4),
      ...config("pi-opus", { score: 0.6, pass: false, model: "claude-opus-5-5" }, 4),
      ...config("codex-a", { score: 0.7, model: "gpt-6-luna" }, 4),
    ];
    const res = buildLeaderboard(input(rows));
    expect(res.tracks.fixedHarness.map((g) => g.harness)).toEqual(["claude", "codex", "pi"]);
    // Each harness ranks its own models: pi-opus is rank 1 within pi.
    expect(res.tracks.fixedHarness.find((g) => g.harness === "pi")?.rows[0]?.rank).toBe(1);
    const best = res.tracks.bestHarnessPerModel.rows;
    expect(best.map((r) => [r.configId, r.rank])).toEqual([
      ["claude-a", 1],
      ["codex-a", 2],
    ]);
    expect(best.map((r) => r.configId)).not.toContain("pi-opus");
  });

  test("best harness per model prefers a full-suite config over a higher-scoring partial one", () => {
    const rows = [
      ...config("claude-a", { score: 0.5, pass: false, model: "claude-opus-5-5" }, 3),
      ...config("pi-opus", { score: 1, model: "claude-opus-5-5" }, 3, ["s1"]),
    ];
    const best = buildLeaderboard(input(rows)).tracks.bestHarnessPerModel.rows;
    expect(best).toHaveLength(1);
    expect(best[0]?.configId).toBe("claude-a");
    expect(best[0]?.rank).toBe(1);
  });

  test("error attempts are counted but never scored; cancelled ones vanish", () => {
    const rows = [
      ...config("claude-a", { score: 0.8 }, 3),
      ...cell("claude-a", "s1", [
        { status: "error", exclusion: "harness-error" },
        { status: "error", exclusion: null },
        { status: "error", exclusion: "cancelled" },
      ]),
    ];
    const row = buildLeaderboard(input(rows)).tracks.fixedHarness[0]?.rows[0];
    expect(row?.score).toBeCloseTo(0.8, 12);
    expect(row?.errors).toBe(2);
    expect(row?.attempts).toBe(9);
    expect(row?.passAt1).toBe(1);
  });

  test("model, effort, tokens and cost columns", () => {
    const rows = [
      ...cell("claude-a", "s1", [
        { model: "claude-opus-5-5", effort: "high", tokens: 1000, cost: 1 },
        { model: "claude-opus-5-5", effort: "high", tokens: 3000, cost: 3 },
        { model: "claude-opus-5-6", effort: null, tokens: 2000, cost: 2 },
      ]),
      ...cell("claude-a", "s2", rep(3, { model: "claude-opus-5-5", effort: "high", cost: 5 })),
      ...cell("claude-a", "s3", rep(3, { model: "claude-opus-5-5", effort: "high", cost: 5 })),
    ];
    const row = buildLeaderboard(input(rows)).tracks.fixedHarness[0]?.rows[0];
    expect(row?.resolvedModel).toBe("claude-opus-5-5");
    expect(row?.resolvedModels).toEqual(["claude-opus-5-5", "claude-opus-5-6"]);
    expect(row?.efforts).toEqual(["default", "high"]);
    expect(row?.avgCostUsd).toBeCloseTo((2 + 5 + 5) / 3, 12);
    expect(row?.avgTotalTokens).toBeCloseTo((1000 + 3000 + 2000 + 6 * 1000) / 9, 12);
    expect(row?.suiteVersion).toBe(SUITE);
  });

  test("deterministic across calls", () => {
    const rows = [
      ...config("claude-a", { score: 0.7, pass: true }, 4),
      ...config("claude-b", { score: 0.6, pass: false }, 4),
    ];
    expect(buildLeaderboard(input(rows))).toEqual(buildLeaderboard(input(rows)));
  });

  test("the filter narrows the rows without changing what counts as the full suite", () => {
    const rows = [...config("claude-a", { score: 0.9 }), ...config("pi-a", { score: 0.5 })];
    const res = buildLeaderboard(
      input(rows, { filter: { harnesses: ["pi"], configIds: [], efforts: [] } }),
    );
    expect(res.tracks.fixedHarness.map((g) => g.harness)).toEqual(["pi"]);
    expect(res.expectedScenarios).toEqual(SCENARIOS);
  });

  test("empty input gives empty tracks", () => {
    const res = buildLeaderboard(input([]));
    expect(res.tracks.fixedHarness).toEqual([]);
    expect(res.tracks.bestHarnessPerModel.rows).toEqual([]);
  });
});

describe("heatmap", () => {
  test("scenario x config cells plus an any-config row that exposes a scenario nobody passes", () => {
    const rows = [
      ...cell("claude-a", "s1", [...rep(2, { pass: true }), ...rep(1, { pass: false })]),
      ...cell("claude-a", "s2", rep(3, { pass: false })),
      ...cell("claude-a", "s3", rep(3, { pass: true })),
      ...cell("pi-a", "s1", rep(3, { pass: true })),
      ...cell("pi-a", "s2", rep(3, { pass: false })),
      // An errors-only cell still shows up, with no pass rate.
      ...cell("pi-a", "s3", [{ status: "error", exclusion: "harness-error" }]),
      ...cell("pi-a", "s3", rep(1, { pass: false })),
    ];
    const res = buildHeatmap(input(rows));
    expect(res.scenarioIds).toEqual(SCENARIOS);
    const get = (c: string, s: string) =>
      res.cells.find((x) => x.configId === c && x.scenarioId === s);
    expect(get("claude-a", "s1")?.passRate).toBeCloseTo(2 / 3, 12);
    expect(get("claude-a", "s1")?.lowN).toBe(false);
    expect(get("pi-a", "s3")).toMatchObject({ graded: 1, errors: 1, passed: 0, lowN: true });

    const any = (s: string) => res.anyConfig.find((x) => x.scenarioId === s);
    expect(any("s2")).toMatchObject({
      graded: 6,
      passed: 0,
      passRate: 0,
      configs: 2,
      configsPassing: 0,
    });
    expect(any("s1")).toMatchObject({ graded: 6, passed: 5, configs: 2, configsPassing: 2 });
    expect(any("s1")?.passRate).toBeCloseTo(5 / 6, 12);
    expect(nonFinitePaths(res)).toEqual([]);
  });

  test("a scenario with no data has an empty any-config row, never NaN", () => {
    const res = buildHeatmap(input(config("claude-a", { score: 1 }, 3, ["s1"])));
    expect(res.anyConfig.find((x) => x.scenarioId === "s3")).toEqual({
      scenarioId: "s3",
      graded: 0,
      passed: 0,
      passRate: null,
      configs: 0,
      configsPassing: 0,
    });
    expect(nonFinitePaths(res)).toEqual([]);
  });

  test("full-suite configs are listed before partial ones", () => {
    const rows = [
      ...config("pi-a", { score: 1 }, 3, ["s1"]),
      ...config("claude-a", { score: 0.5, pass: false }, 3),
    ];
    expect(buildHeatmap(input(rows)).configIds).toEqual(["claude-a", "pi-a"]);
  });
});

describe("reliability", () => {
  test("pass^k falls with k for a flaky cell while pass@k rises", () => {
    // s1: 3 of 5 pass. s2, s3: always pass.
    const rows = [
      ...cell("claude-a", "s1", [...rep(3, { pass: true }), ...rep(2, { pass: false })]),
      ...cell("claude-a", "s2", rep(5, { pass: true })),
      ...cell("claude-a", "s3", rep(5, { pass: true })),
    ];
    const res = buildReliability(input(rows), 5);
    const cfg = res.configs[0];
    expect(cfg?.passAt1).toBeCloseTo((0.6 + 1 + 1) / 3, 12);
    expect(cfg?.curve).toHaveLength(5);
    const pow = cfg?.curve.map((p) => p.passPowK as number) ?? [];
    // k=2: s1 C(3,2)/C(5,2) = 0.3; k=3: 1/10; k=4: 0; k=5: 0.
    expect(pow[0]).toBeCloseTo(0.8667, 3);
    expect(pow[1]).toBeCloseTo((0.3 + 1 + 1) / 3, 12);
    expect(pow[2]).toBeCloseTo((0.1 + 1 + 1) / 3, 12);
    expect(pow[3]).toBeCloseTo(2 / 3, 12);
    expect(pow[4]).toBeCloseTo(2 / 3, 12);
    const at = cfg?.curve.map((p) => p.passAtK as number) ?? [];
    expect(at[0]).toBeCloseTo(pow[0] as number, 12);
    expect(at[4]).toBe(1);
    expect(cfg?.curve.every((p) => p.scenarios === 3)).toBe(true);
  });

  test("k beyond the attempts a scenario has drops that scenario; no scenario left gives null", () => {
    const res = buildReliability(input(config("claude-a", { score: 1 }, 2)), 4);
    const curve = res.configs[0]?.curve ?? [];
    expect(curve[1]?.passPowK).toBe(1);
    expect(curve[2]).toEqual({ k: 3, passPowK: null, passAtK: null, scenarios: 0 });
    expect(nonFinitePaths(res)).toEqual([]);
  });

  test("trend: one point per run, oldest first, with a CI band and per-run coverage", () => {
    const run = (id: string, at: string, score: number, n: number) =>
      SCENARIOS.flatMap((s) =>
        cell("claude-a", s, rep(n, { run: id, createdAt: at, score, pass: score >= 0.5 })),
      );
    const rows = [
      ...run("run-b", "2026-09-02T00:00:00Z", 0.4, 3),
      ...run("run-a", "2026-09-01T00:00:00Z", 0.9, 3),
      ...cell("claude-a", "s1", [{ run: "run-c", createdAt: "2026-09-03T00:00:00Z", score: 1 }]),
    ];
    const trend = buildReliability(input(rows)).configs[0]?.trend ?? [];
    expect(trend.map((t) => t.runId)).toEqual(["run-a", "run-b", "run-c"]);
    expect(trend[0]).toMatchObject({
      runName: "name-run-a",
      scenarios: 3,
      attempts: 9,
      passRate: 1,
    });
    expect(trend[0]?.score).toBeCloseTo(0.9, 12);
    expect(trend[1]?.passRate).toBe(0);
    expect(trend[2]).toMatchObject({ scenarios: 1, attempts: 1 });
    expect(trend[0]?.scoreCi?.lo).toBeLessThanOrEqual(0.9);
  });

  test("trend keeps only the most recent TREND_LIMIT runs", () => {
    const rows = Array.from({ length: TREND_LIMIT + 5 }, (_, i) =>
      cell("claude-a", "s1", [
        {
          run: `run-${String(i).padStart(3, "0")}`,
          createdAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        },
      ]),
    ).flat();
    const trend = buildReliability(input(rows)).configs[0]?.trend ?? [];
    expect(trend).toHaveLength(TREND_LIMIT);
    expect(trend[trend.length - 1]?.runId).toBe(`run-${String(TREND_LIMIT + 4).padStart(3, "0")}`);
  });
});

describe("compare", () => {
  const six = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const build = (a: number[], b: number[]) =>
    buildCompare(
      input(
        [
          ...six.flatMap((s, i) =>
            cell("claude-a", s, rep(3, { score: a[i] as number, pass: (a[i] as number) >= 0.5 })),
          ),
          ...six.flatMap((s, i) =>
            cell("claude-b", s, rep(3, { score: b[i] as number, pass: (b[i] as number) >= 0.5 })),
          ),
        ],
        { expectedScenarioIds: six },
      ),
      "claude-a",
      "claude-b",
    );

  test("paired difference over scenarios: a steady edge is significant despite hard/easy scenarios", () => {
    const b = [0.1, 0.3, 0.5, 0.7, 0.9, 0.2];
    const res = build(
      b.map((x) => x + 0.05),
      b,
    );
    expect(res.comparable).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.score.diff).toBeCloseTo(0.05, 12);
    expect(res.score.ci?.lo).toBeCloseTo(0.05, 9);
    expect(res.score.significant).toBe(true);
    expect(res.score).toMatchObject({ wins: 6, losses: 0, ties: 0, scenarios: 6 });
    expect(res.scenarios).toHaveLength(6);
    expect(res.scenarios[0]).toMatchObject({ scenarioId: "s1", scoreDiff: expect.any(Number) });
    expect(res.scenarios[0]?.a.attempts).toBe(3);
  });

  test("mixed wins and losses are not significant; ties are counted", () => {
    const res = build([0.9, 0.1, 0.8, 0.2, 0.5, 0.5], [0.1, 0.9, 0.2, 0.8, 0.5, 0.5]);
    expect(res.score.significant).toBe(false);
    expect(res.score).toMatchObject({ wins: 2, losses: 2, ties: 2 });
    expect(res.score.ci?.lo).toBeLessThan(0);
    expect(res.score.ci?.hi).toBeGreaterThan(0);
    expect(res.passRate.diff).toBeCloseTo(0, 12);
  });

  test("below the minimum shared scenarios it reports the diff but no CI", () => {
    const rows = [
      ...config("claude-a", { score: 0.9 }, 3, ["s1", "s2", "s3"]),
      ...config("claude-b", { score: 0.4, pass: false }, 3, ["s1", "s2", "s3"]),
    ];
    const res = buildCompare(input(rows), "claude-a", "claude-b");
    expect(res.comparable).toBe(false);
    expect(res.reason).toContain(`at least ${MIN_COMPARE_SCENARIOS}`);
    expect(res.score.diff).toBeCloseTo(0.5, 12);
    expect(res.score.ci).toBeNull();
    expect(res.score.significant).toBe(false);
  });

  test("scenarios only one side ran are listed, not compared", () => {
    const rows = [
      ...config("claude-a", { score: 0.9 }, 3, ["s1", "s2", "s3"]),
      ...config("claude-b", { score: 0.4, pass: false }, 3, ["s1"]),
    ];
    const res = buildCompare(input(rows), "claude-a", "claude-b");
    expect(res.scenarios.map((r) => r.scenarioId)).toEqual(["s1"]);
    expect(res.onlyA).toEqual(["s2", "s3"]);
    expect(res.onlyB).toEqual([]);
  });

  test("a config with no data in the suite is a reason, not an error", () => {
    const res = buildCompare(input(config("claude-a", { score: 1 })), "claude-a", "pi-a");
    expect(res.comparable).toBe(false);
    expect(res.reason).toContain("pi-a");
    expect(res.b).toMatchObject({ configId: "pi-a", attempts: 0, score: null, harness: "pi" });
    expect(res.scenarios).toEqual([]);
    expect(res.score.diff).toBeNull();
    expect(nonFinitePaths(res)).toEqual([]);
  });
});
