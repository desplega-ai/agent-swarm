import { describe, expect, test } from "bun:test";
import {
  defaultTrendConfigs,
  FLAG_MIN_CONFIGS,
  type HeatmapAnyRow,
  passRateColor,
  type ReliabilityConfig,
  type ReliabilityResponse,
  reliabilityRows,
  scenarioHealth,
  type TrendPoint,
  trendLine,
} from "../ui/src/lib/suite-analytics.ts";

function any(o: Partial<HeatmapAnyRow>): HeatmapAnyRow {
  return {
    scenarioId: "s",
    graded: 9,
    passed: 4,
    passRate: 4 / 9,
    configs: 3,
    configsPassing: 2,
    ...o,
  };
}

describe("scenarioHealth: what the any-config row says about a scenario", () => {
  test("no config passes it: broken or too hard", () => {
    expect(scenarioHealth(any({ passed: 0, passRate: 0, configsPassing: 0 }))).toBe(
      "broken-or-hard",
    );
  });

  test("every graded attempt passes: saturated", () => {
    expect(scenarioHealth(any({ passed: 9, passRate: 1, configsPassing: 3 }))).toBe("saturated");
  });

  test("a split result is mixed", () => {
    expect(scenarioHealth(any({}))).toBe("mixed");
  });

  test("fewer configs than the minimum is thin, whatever the colours say", () => {
    const row = any({ configs: FLAG_MIN_CONFIGS - 1, passed: 0, passRate: 0, configsPassing: 0 });
    expect(scenarioHealth(row)).toBe("thin");
    expect(scenarioHealth(undefined)).toBe("thin");
    expect(scenarioHealth(any({ graded: 0, passed: 0, passRate: null }))).toBe("thin");
  });
});

describe("passRateColor", () => {
  test("null is neutral, and the ends of the scale are the strongest red and green", () => {
    expect(passRateColor(null)).toBe("var(--panel-2)");
    expect(passRateColor(0)).toContain("var(--red) 76%");
    expect(passRateColor(1)).toContain("var(--green) 76%");
  });

  test("the midpoint is the faintest tint and out-of-range rates are clamped", () => {
    expect(passRateColor(0.5)).toContain("14%");
    expect(passRateColor(-3)).toBe(passRateColor(0));
    expect(passRateColor(7)).toBe(passRateColor(1));
  });
});

function point(o: Partial<TrendPoint> & { runId: string; createdAt: string }): TrendPoint {
  return {
    runName: null,
    scenarios: 6,
    attempts: 18,
    score: 0.7,
    scoreCi: { lo: 0.6, hi: 0.8 },
    passRate: 0.5,
    ...o,
  };
}

function cfg(id: string, o: Partial<ReliabilityConfig> = {}): ReliabilityConfig {
  return {
    configId: id,
    harness: "claude",
    resolvedModel: "m",
    fullCoverage: true,
    lowN: false,
    attempts: 18,
    passAt1: 0.8,
    curve: [
      { k: 1, passPowK: 0.8, passAtK: 0.8, scenarios: 6 },
      { k: 2, passPowK: 0.6, passAtK: 0.9, scenarios: 6 },
      { k: 3, passPowK: 0.5, passAtK: 0.95, scenarios: 4 },
    ],
    trend: [],
    ...o,
  };
}

function rel(configs: ReliabilityConfig[]): ReliabilityResponse {
  return { suiteVersion: "swarm-evals@1.0", generatedAt: "2026-09-30T00:00:00Z", maxK: 3, configs };
}

describe("reliabilityRows", () => {
  test("ranks by pass^k, then pass@1, and reports the gap repeating costs", () => {
    const { rows } = reliabilityRows(
      rel([
        cfg("steady", {
          passAt1: 0.7,
          curve: [
            { k: 1, passPowK: 0.7, passAtK: 0.7, scenarios: 6 },
            { k: 2, passPowK: 0.65, passAtK: 0.7, scenarios: 6 },
          ],
        }),
        cfg("flaky", { passAt1: 0.9 }),
      ]),
      2,
    );
    expect(rows.map((r) => r.configId)).toEqual(["steady", "flaky"]);
    expect(rows[0]?.gap).toBeCloseTo(0.05);
    expect(rows[1]?.gap).toBeCloseTo(0.3);
  });

  test("a config with no scenario at k repeats waits instead of getting a pass^k of zero", () => {
    const noK3 = cfg("thin", {
      curve: [
        { k: 1, passPowK: 0.8, passAtK: 0.8, scenarios: 6 },
        { k: 2, passPowK: null, passAtK: null, scenarios: 0 },
      ],
    });
    const { rows, waiting } = reliabilityRows(rel([noK3, cfg("ok")]), 2);
    expect(rows.map((r) => r.configId)).toEqual(["ok"]);
    expect(waiting.map((c) => c.configId)).toEqual(["thin"]);
  });

  test("scenarios counts the ones behind pass^k, out of every scenario that has a graded attempt", () => {
    const { rows } = reliabilityRows(rel([cfg("a")]), 3);
    expect(rows[0]?.scenarios).toBe(4);
    expect(rows[0]?.scenariosTotal).toBe(6);
  });
});

describe("trendLine", () => {
  const c = cfg("a", {
    trend: [
      point({ runId: "r2", createdAt: "2026-09-02T00:00:00Z", score: 0.8 }),
      point({ runId: "r1", createdAt: "2026-09-01T00:00:00Z", score: null, passRate: 0.4 }),
      point({
        runId: "r3",
        createdAt: "2026-09-03T00:00:00Z",
        score: 0.75,
        scoreCi: { lo: 0.75, hi: 0.75 },
      }),
    ],
  });

  test("the score line skips runs with no score and carries the band", () => {
    const line = trendLine(c, "score");
    expect(line.points.map((p) => p.point.runId)).toEqual(["r2", "r3"]);
    expect(line.points[0]).toMatchObject({ y: 0.8, lo: 0.6, hi: 0.8 });
  });

  test("a zero-width interval draws no band", () => {
    const r3 = trendLine(c, "score").points.find((p) => p.point.runId === "r3");
    expect(r3?.lo).toBeNull();
    expect(r3?.hi).toBeNull();
  });

  test("the pass-rate line has no band and keeps the run the score line dropped", () => {
    const line = trendLine(c, "passRate");
    expect(line.points).toHaveLength(3);
    expect(line.points.every((p) => p.lo === null && p.hi === null)).toBe(true);
  });
});

describe("defaultTrendConfigs", () => {
  const runs = (n: number, score: number): TrendPoint[] =>
    Array.from({ length: n }, (_, i) =>
      point({ runId: `r${i}`, createdAt: `2026-09-0${i + 1}T00:00:00Z`, score }),
    );

  test("draws the best configs that have a trend, best first, up to the limit", () => {
    const r = rel([
      cfg("one-run", { trend: runs(1, 0.99) }),
      cfg("mid", { trend: runs(3, 0.6) }),
      cfg("top", { trend: runs(2, 0.9) }),
      cfg("low", { trend: runs(2, 0.2) }),
    ]);
    expect(defaultTrendConfigs(r, 2)).toEqual(["top", "mid"]);
  });

  test("with no history anywhere it still offers configs rather than an empty chart", () => {
    expect(defaultTrendConfigs(rel([cfg("a"), cfg("b")]), 3).sort()).toEqual(["a", "b"]);
  });
});
