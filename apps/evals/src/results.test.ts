import { describe, expect, test } from "bun:test";
import { summarizeRun } from "./results.ts";
import type { AttemptRow, EvalRunRow } from "./types.ts";

function run(partial: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: "run-1",
    name: null,
    status: "done",
    scenarioIds: ["s1"],
    configIds: ["c1"],
    attemptsPerCell: 3,
    concurrency: 2,
    judgeModel: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    finishedAt: null,
    ...partial,
  };
}

function attempt(partial: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: crypto.randomUUID(),
    runId: "run-1",
    scenarioId: "s1",
    configId: "c1",
    attemptIndex: 0,
    status: "passed",
    retries: 0,
    sandboxId: null,
    apiUrl: null,
    taskIds: [],
    score: null,
    passed: null,
    error: null,
    costUsd: null,
    costSource: null,
    judgeCostUsd: null,
    tokens: null,
    sandbox: null,
    timings: null,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
    ...partial,
  };
}

describe("summarizeRun — v7 §2.1 cell additions", () => {
  test("passed count, pricedAttempts and avgCostUsd aggregate across N attempts", () => {
    const attempts = [
      attempt({ attemptIndex: 0, status: "passed", costUsd: 0.5, score: 0.9 }),
      attempt({ attemptIndex: 1, status: "failed", costUsd: 0.25, score: 0.3 }),
      attempt({ attemptIndex: 2, status: "passed", costUsd: null, score: 0.8 }),
    ];
    const cell = summarizeRun(run(), attempts).cells[0]!;
    expect(cell.attempts).toBe(3);
    expect(cell.passed).toBe(2);
    expect(cell.passedAny).toBe(true);
    expect(cell.pricedAttempts).toBe(2);
    expect(cell.totalCostUsd).toBeCloseTo(0.75);
    expect(cell.avgCostUsd).toBeCloseTo(0.375); // ÷ priced attempts, not all 3
    expect(cell.bestScore).toBeCloseTo(0.9);
  });

  test("unpriced cell: pricedAttempts 0, avgCostUsd null (never NaN)", () => {
    const attempts = [attempt({ status: "failed" }), attempt({ attemptIndex: 1, status: "error" })];
    const cell = summarizeRun(run(), attempts).cells[0]!;
    expect(cell.passed).toBe(0);
    expect(cell.pricedAttempts).toBe(0);
    expect(cell.totalCostUsd).toBeNull();
    expect(cell.avgCostUsd).toBeNull();
  });

  test("$0 harness cost counts as priced", () => {
    const cell = summarizeRun(run(), [attempt({ costUsd: 0 })]).cells[0]!;
    expect(cell.pricedAttempts).toBe(1);
    expect(cell.totalCostUsd).toBe(0);
    expect(cell.avgCostUsd).toBe(0);
  });

  test("empty cell (no attempts yet): zeroed counts, null aggregates", () => {
    const summary = summarizeRun(run(), []);
    const cell = summary.cells[0]!;
    expect(cell.attempts).toBe(0);
    expect(cell.passed).toBe(0);
    expect(cell.pricedAttempts).toBe(0);
    expect(cell.avgCostUsd).toBeNull();
    expect(cell.meanScore).toBeNull();
    expect(cell.scoreCI).toBeNull();
    expect(cell.passRate).toBeNull();
    expect(cell.passRateCI).toBeNull();
    JSON.stringify(summary, (_key, value) => {
      if (typeof value === "number") expect(value).toBeFinite();
      return value;
    });
  });
});

describe("summarizeRun — Phase 3 convergent reliability metric", () => {
  // 5 distinct scores → mean 0.62, pass-rate 3/5.
  const scores5 = [0.9, 0.8, 0.55, 0.45, 0.4];
  const passed5 = [true, true, true, false, false];

  function cohort(scores: number[], passed: boolean[]): AttemptRow[] {
    return scores.map((score, i) =>
      attempt({ attemptIndex: i, status: passed[i] ? "passed" : "failed", score }),
    );
  }

  test("multi-attempt cell exposes meanScore / scoreCI / passRate / passRateCI", () => {
    const config = run({ attemptsPerCell: 5 });
    const cell = summarizeRun(config, cohort(scores5, passed5)).cells[0]!;
    const reversed = summarizeRun(config, cohort(scores5, passed5).reverse()).cells[0]!;
    expect(reversed.scoreCI).toEqual(cell.scoreCI);
    // meanScore is the headline (and equals the avgScore alias).
    expect(cell.meanScore).toBeCloseTo(0.62, 5);
    expect(cell.avgScore).toBe(cell.meanScore);
    // bootstrap CI present, bracketing the mean, inside [0, 1].
    expect(cell.scoreCI).not.toBeNull();
    expect(cell.scoreCI!.method).toBe("bootstrap");
    expect(cell.scoreCI!.lo).toBeLessThanOrEqual(cell.meanScore!);
    expect(cell.scoreCI!.hi).toBeGreaterThanOrEqual(cell.meanScore!);
    expect(cell.scoreCI!.lo).toBeGreaterThanOrEqual(0);
    expect(cell.scoreCI!.hi).toBeLessThanOrEqual(1);
    // pass-rate 3/5 and Wilson companion ≈ [0.23, 0.88].
    expect(cell.passRate).toBeCloseTo(0.6, 5);
    expect(cell.passRateCI).not.toBeNull();
    expect(cell.passRateCI!.lo).toBeCloseTo(0.231, 2);
    expect(cell.passRateCI!.hi).toBeCloseTo(0.882, 2);
    // drill-down fields preserved.
    expect(cell.bestScore).toBeCloseTo(0.9, 5);
    expect(cell.passedAny).toBe(true);
  });

  test("scoreCI narrows when the same score distribution appears twice", () => {
    const failed = scores5.map(() => false);
    const small = summarizeRun(run({ attemptsPerCell: 5 }), cohort(scores5, failed)).cells[0]!;
    const large = summarizeRun(
      run({ attemptsPerCell: 10 }),
      cohort([...scores5, ...scores5], [...failed, ...failed]),
    ).cells[0]!;
    expect(large.scoreCI!.hi - large.scoreCI!.lo).toBeLessThan(
      small.scoreCI!.hi - small.scoreCI!.lo,
    );
  });

  test("all-error cell (nothing finished with a score) → reliability fields null", () => {
    const cell = summarizeRun(run(), [attempt({ attemptIndex: 0, status: "error", score: null })])
      .cells[0]!;
    expect(cell.meanScore).toBeNull();
    expect(cell.scoreCI).toBeNull();
    // finished includes "error", but pass-rate is 0/1 here.
    expect(cell.passRate).toBe(0);
    expect(cell.passRateCI).not.toBeNull();
  });
});
