import { describe, expect, test } from "bun:test";
import type { Registry } from "../runner/index.ts";
import { type AnalyticsSourceRow, buildAnalytics } from "./analytics.ts";

/** Real dirty fixture from evals.db — CLI cursor-restore escape after the version. */
const DIRTY_WORKER_VERSION = "agent-swarm v1.85.0\n\u001b[?25h";

const registry: Registry = {
  scenarios: new Map(),
  configs: new Map([
    ["pi-deepseek", { id: "pi-deepseek", provider: "pi", model: "deepseek/deepseek-chat" }],
    // No model field — modelKey falls back to "(claude-tier)".
    ["claude-tier", { id: "claude-tier", provider: "claude", modelTier: "regular" }],
  ]),
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
    apiVersion: null,
    workerVersion: null,
    runName: null,
    runCreatedAt: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
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
