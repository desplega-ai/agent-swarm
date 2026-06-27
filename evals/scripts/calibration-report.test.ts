import { describe, expect, test } from "bun:test";
import { summarizeRun } from "../src/results.ts";
import type { AttemptRow, EvalRunRow } from "../src/types.ts";
import {
  BUDGET_ANCHORS,
  computeScenarioGaps,
  FRONTIER_ANCHORS,
  formatGapReport,
} from "./calibration-report.ts";

function run(partial: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: "run-cal",
    name: "round11-calibration",
    status: "done",
    scenarioIds: ["sql-audit"],
    configIds: [...FRONTIER_ANCHORS, ...BUDGET_ANCHORS],
    attemptsPerCell: 3,
    concurrency: 2,
    judgeModel: null,
    createdAt: "2026-06-13T00:00:00.000Z",
    finishedAt: null,
    ...partial,
  };
}

function attempt(partial: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: crypto.randomUUID(),
    runId: "run-cal",
    scenarioId: "sql-audit",
    configId: "claude-opus-4.8",
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

/** 3 attempts of one config in one scenario, averaging to ~`avg`. */
function cohort(
  scenarioId: string,
  configId: string,
  scores: [number, number, number],
): AttemptRow[] {
  return scores.map((score, attemptIndex) =>
    attempt({ scenarioId, configId, attemptIndex, status: "passed", score }),
  );
}

describe("computeScenarioGaps — round-11 ship gate", () => {
  test("3 frontier ~0.9, 3 budget ~0.4 → gap 0.5 PASS", () => {
    const attempts = [
      ...cohort("sql-audit", "claude-opus-4.8", [0.88, 0.9, 0.92]),
      ...cohort("sql-audit", "codex-5.5", [0.89, 0.91, 0.9]),
      ...cohort("sql-audit", "pi-deepseek-flash", [0.38, 0.4, 0.42]),
      ...cohort("sql-audit", "claude-haiku", [0.41, 0.4, 0.39]),
    ];
    const summary = summarizeRun(run(), attempts);
    const gaps = computeScenarioGaps(summary);
    expect(gaps).toHaveLength(1);
    const g = gaps[0]!;
    expect(g.scenarioId).toBe("sql-audit");
    expect(g.frontierAvg).toBeCloseTo(0.9, 2);
    expect(g.budgetAvg).toBeCloseTo(0.4, 2);
    expect(g.gap).toBeCloseTo(0.5, 5);
    expect(g.pass).toBe(true);
    expect(g.borderline).toBe(false);
  });

  test("gap below 0.2 → FAIL, not borderline", () => {
    const attempts = [
      ...cohort("sql-audit", "claude-opus-4.8", [0.5, 0.5, 0.5]),
      ...cohort("sql-audit", "codex-5.5", [0.5, 0.5, 0.5]),
      ...cohort("sql-audit", "pi-deepseek-flash", [0.46, 0.46, 0.46]),
      ...cohort("sql-audit", "claude-haiku", [0.46, 0.46, 0.46]),
    ];
    const g = computeScenarioGaps(summarizeRun(run(), attempts))[0]!;
    expect(g.gap).toBeCloseTo(0.04, 5);
    expect(g.pass).toBe(false);
    expect(g.borderline).toBe(false);
  });

  test("gap in [0.1, 0.3] flagged borderline (still not PASS)", () => {
    const attempts = [
      ...cohort("sql-audit", "claude-opus-4.8", [0.7, 0.7, 0.7]),
      ...cohort("sql-audit", "codex-5.5", [0.7, 0.7, 0.7]),
      ...cohort("sql-audit", "pi-deepseek-flash", [0.55, 0.55, 0.55]),
      ...cohort("sql-audit", "claude-haiku", [0.55, 0.55, 0.55]),
    ];
    const g = computeScenarioGaps(summarizeRun(run(), attempts))[0]!;
    expect(g.gap).toBeCloseTo(0.15, 5);
    expect(g.pass).toBe(false);
    expect(g.borderline).toBe(true);
  });

  test("missing budget anchor scores → gap null, INCOMPLETE (never NaN)", () => {
    const attempts = [
      ...cohort("sql-audit", "claude-opus-4.8", [0.9, 0.9, 0.9]),
      ...cohort("sql-audit", "codex-5.5", [0.9, 0.9, 0.9]),
      // budget anchors absent from the run entirely
    ];
    const g = computeScenarioGaps(summarizeRun(run(), attempts))[0]!;
    expect(g.frontierAvg).toBeCloseTo(0.9, 5);
    expect(g.budgetAvg).toBeNull();
    expect(g.gap).toBeNull();
    expect(g.pass).toBe(false);
    expect(g.borderline).toBe(false);
  });

  test("formatGapReport renders a PASS verdict and the anchor legend", () => {
    const attempts = [
      ...cohort("sql-audit", "claude-opus-4.8", [0.9, 0.9, 0.9]),
      ...cohort("sql-audit", "codex-5.5", [0.9, 0.9, 0.9]),
      ...cohort("sql-audit", "pi-deepseek-flash", [0.4, 0.4, 0.4]),
      ...cohort("sql-audit", "claude-haiku", [0.4, 0.4, 0.4]),
    ];
    const out = formatGapReport(computeScenarioGaps(summarizeRun(run(), attempts)));
    expect(out).toContain("PASS");
    expect(out).toContain("sql-audit");
    expect(out).toContain("claude-opus-4.8");
    expect(out).toContain("pi-deepseek-flash");
    expect(out).toContain("1/1 scenarios clear");
  });
});

describe("computeScenarioGaps — gap significance (bootstrap diff CI)", () => {
  // Frontier ~0.9 vs budget ~0.4, tight within-cohort spread → significant gap.
  const clearGap = (): AttemptRow[] => [
    ...cohort("sql-audit", "claude-opus-4.8", [0.88, 0.9, 0.92]),
    ...cohort("sql-audit", "codex-5.5", [0.89, 0.91, 0.9]),
    ...cohort("sql-audit", "pi-deepseek-flash", [0.38, 0.4, 0.42]),
    ...cohort("sql-audit", "claude-haiku", [0.41, 0.4, 0.39]),
  ];

  test("attempts supplied → gapCI populated and significant for a clear gap", () => {
    const attempts = clearGap();
    const g = computeScenarioGaps(summarizeRun(run(), attempts), { attempts })[0]!;
    expect(g.gapCI).not.toBeNull();
    expect(g.gapCI?.significant).toBe(true);
    expect(g.gapCI?.lo).toBeGreaterThan(0);
    // 2 frontier + 2 budget anchors × 3 attempts each.
    expect(g.gapCI?.n).toBe(12);
  });

  test("attempts omitted → gapCI null (summary-only path)", () => {
    const g = computeScenarioGaps(summarizeRun(run(), clearGap()))[0]!;
    expect(g.gapCI).toBeNull();
  });

  test("formatGapReport surfaces the significance flag when gapCI present", () => {
    const attempts = clearGap();
    const out = formatGapReport(computeScenarioGaps(summarizeRun(run(), attempts), { attempts }));
    expect(out).toContain("gap CI");
    expect(out).toContain("significant at n=12");
  });
});
