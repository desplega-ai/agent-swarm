import { describe, expect, test } from "bun:test";
import {
  BASELINE_RUNS,
  binomialTailAtLeast,
  evaluateRegression,
  fisherExactTwoSided,
  flagThreshold,
  holmAdjust,
  median,
  minimumDetectableEffect,
  RERUN_ATTEMPTS,
  type RegressionAttempt,
} from "./regression.ts";

const OPUS = "claude-opus-5.5";
const LUNA = "codex-6-luna";
const MODEL = "claude-opus-5-5";

interface Opts {
  model?: string | null;
  score?: number;
  metered?: number;
  notional?: number;
  scenarioVersion?: number;
  error?: string;
  exclusion?: string;
}

function attempt(
  runId: string,
  configId: string,
  scenarioId: string,
  status: "passed" | "failed" | "error",
  o: Opts = {},
): RegressionAttempt {
  return {
    runId,
    scenarioId,
    configId,
    status,
    exclusion: o.exclusion ?? null,
    score: status === "error" ? null : (o.score ?? (status === "passed" ? 0.9 : 0.2)),
    scenarioVersion: o.scenarioVersion ?? 1,
    resolvedModel: o.model === undefined ? MODEL : o.model,
    meteredUsd: o.metered ?? 0.05,
    notionalUsd: o.notional ?? 0.1,
    error: o.error ?? null,
  };
}

/** `passed` of `n` attempts pass, in one run. */
function cellRun(
  runId: string,
  configId: string,
  scenarioId: string,
  passed: number,
  n = 3,
  o: Opts = {},
): RegressionAttempt[] {
  return Array.from({ length: n }, (_, i) =>
    attempt(runId, configId, scenarioId, i < passed ? "passed" : "failed", o),
  );
}

/** `nights` earlier runs where every attempt of the cell passed. */
function healthyBaseline(
  configId: string,
  scenarioId: string,
  nights = BASELINE_RUNS,
  o: Opts = {},
): RegressionAttempt[] {
  return Array.from({ length: nights }, (_, i) =>
    cellRun(`night-${i}`, configId, scenarioId, 3, 3, {
      ...o,
      // deterministic spread so the score rule has a real variance to read
      score: 0.9 + ((i % 3) - 1) * 0.03,
    }),
  ).flat();
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe("numeric helpers", () => {
  test("binomial tail: 2+ failures of 3 at a 5% failure rate is ~0.7% (the plan's false-alarm rate)", () => {
    expect(binomialTailAtLeast(3, 2, 0.05)).toBeCloseTo(0.00725, 5);
    expect(binomialTailAtLeast(3, 1, 0.05)).toBeCloseTo(0.142625, 5);
    expect(binomialTailAtLeast(3, 0, 0.05)).toBe(1);
    expect(binomialTailAtLeast(3, 4, 0.05)).toBe(0);
  });

  test("flagThreshold: 2 of 3 repeats, 3 of 5, never for a single attempt", () => {
    expect(flagThreshold(3)).toBe(2);
    expect(flagThreshold(5)).toBe(3);
    expect(flagThreshold(2)).toBe(2);
    expect(flagThreshold(1)).toBe(Number.POSITIVE_INFINITY);
  });

  test("Fisher exact, two-sided, against textbook values", () => {
    // Lady tasting tea: [[3,1],[1,3]] -> 0.4857
    expect(fisherExactTwoSided(3, 1, 1, 3)).toBeCloseTo(0.4857, 3);
    // Wikipedia's men/women example: [[1,9],[11,3]] -> 0.002759
    expect(fisherExactTwoSided(1, 9, 11, 3)).toBeCloseTo(0.002759, 5);
    // identical margins and proportions: nothing to see
    expect(fisherExactTwoSided(5, 5, 5, 5)).toBeCloseTo(1, 9);
    expect(fisherExactTwoSided(0, 0, 0, 0)).toBe(1);
  });

  test("Holm adjustment is monotone, capped at 1, and keeps input order", () => {
    expect(holmAdjust([0.04, 0.001, 0.02])).toEqual([0.04, 0.003, 0.04]);
    expect(holmAdjust([0.6, 0.9])).toEqual([1, 1]);
    expect(holmAdjust([])).toEqual([]);
  });

  test("minimum detectable effect grows with baseline spread and shrinks with more attempts", () => {
    const tight = [0.9, 0.91, 0.89, 0.9, 0.9, 0.91, 0.89, 0.9];
    const loose = [0.5, 0.9, 0.7, 1, 0.4, 0.95, 0.6, 0.85];
    const mdeTight = minimumDetectableEffect(tight, 3)!;
    const mdeLoose = minimumDetectableEffect(loose, 3)!;
    expect(mdeLoose).toBeGreaterThan(mdeTight);
    expect(minimumDetectableEffect(loose, 12)!).toBeLessThan(mdeLoose);
    expect(minimumDetectableEffect([0.9], 3)).toBeNull();
  });

  test("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("regression rule: the four plan cases", () => {
  test("a 3/3 -> 0/3 drop pages immediately, with no rerun", () => {
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 0),
      baseline: healthyBaseline(OPUS, "sql-audit"),
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("page");
    expect(cell.note).toContain("every attempt failed");
    expect(report.page).toBe(true);
    expect(report.pendingReruns).toEqual([]);
    expect(report.final).toBe(true);
  });

  test("1 of 3 failing is noise and flags nothing", () => {
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 2),
      baseline: healthyBaseline(OPUS, "sql-audit"),
    });
    expect(only(report.cells).status).toBe("noise");
    expect(report.page).toBe(false);
    expect(report.flagged).toBe(false);
    expect(report.pendingReruns).toEqual([]);
    expect(report.final).toBe(true);
  });

  test("2 of 3 failing flags and asks for 6 reruns of that cell", () => {
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 1),
      baseline: healthyBaseline(OPUS, "sql-audit"),
    });
    expect(only(report.cells).status).toBe("flag");
    expect(report.page).toBe(false);
    expect(report.flagged).toBe(true);
    expect(report.pendingReruns).toEqual([
      { configId: OPUS, scenarioIds: ["sql-audit"], attemptsPerCell: RERUN_ATTEMPTS },
    ]);
    expect(RERUN_ATTEMPTS).toBe(6);
    expect(report.final).toBe(false);
  });

  test("a model change resets the baseline instead of flagging", () => {
    const report = evaluateRegression({
      // 0 of 3 would page on the old model
      current: cellRun("tonight", OPUS, "sql-audit", 0, 3, { model: "claude-opus-5-6" }),
      baseline: healthyBaseline(OPUS, "sql-audit", BASELINE_RUNS, { model: "claude-opus-5-5" }),
    });
    expect(only(report.cells).status).toBe("model-changed");
    expect(report.page).toBe(false);
    expect(report.flagged).toBe(false);
    const config = only(report.configs);
    expect(config.modelChanged).toBe(true);
    expect(config.model).toBe("claude-opus-5-6");
    expect(config.previousModel).toBe("claude-opus-5-5");
  });
});

describe("reruns", () => {
  const flagged = () => cellRun("tonight", OPUS, "sql-audit", 1);

  test("a flag the rerun confirms pages", () => {
    const report = evaluateRegression({
      current: flagged(),
      baseline: healthyBaseline(OPUS, "sql-audit"),
      reruns: cellRun("rerun", OPUS, "sql-audit", 2, 6), // 3/9 overall vs 42/42
      rerunsSettled: true,
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("page");
    expect(cell.rerun).toEqual({ graded: 6, passed: 2 });
    expect(cell.pAdjusted!).toBeLessThan(0.01);
    expect(report.page).toBe(true);
    expect(report.final).toBe(true);
    expect(report.pendingReruns).toEqual([]);
  });

  test("a flag the rerun does not confirm is cleared", () => {
    const report = evaluateRegression({
      current: flagged(),
      baseline: healthyBaseline(OPUS, "sql-audit"),
      reruns: cellRun("rerun", OPUS, "sql-audit", 6, 6), // 7/9 overall
      rerunsSettled: true,
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("cleared");
    expect(cell.pAdjusted!).toBeGreaterThanOrEqual(0.01);
    expect(report.page).toBe(false);
    expect(report.final).toBe(true);
  });

  test("the rerun cutting out (no graded attempts) leaves the flag unconfirmed, not a page", () => {
    const report = evaluateRegression({
      current: flagged(),
      baseline: healthyBaseline(OPUS, "sql-audit"),
      reruns: [],
      rerunsSettled: true,
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("flag");
    expect(cell.note).toContain("nothing is confirmed");
    expect(report.page).toBe(false);
    expect(report.flagged).toBe(true);
    expect(report.pendingReruns).toEqual([]);
  });

  test("Holm counts every flagged cell: one borderline p-value survives alone, not in a crowd", () => {
    const scenarios = ["a", "b", "c", "d", "e", "f"];
    const mk = (n: number) => {
      const ids = scenarios.slice(0, n);
      return evaluateRegression({
        current: ids.flatMap((s) => cellRun("tonight", OPUS, s, 1)),
        baseline: ids.flatMap((s) => healthyBaseline(OPUS, s)),
        // 1/3 passed + 5/6 on the rerun = 6/9 overall against 42/42: Fisher p = 0.004
        reruns: ids.flatMap((s) => cellRun("rerun", OPUS, s, 5, 6)),
        rerunsSettled: true,
      });
    };
    const alone = only(mk(1).cells);
    const crowd = mk(6).cells[0]!;
    expect(alone.pValue).toBeCloseTo(0.00403, 4);
    expect(crowd.pValue).toBeCloseTo(alone.pValue!, 12);
    expect(alone.status).toBe("page"); // 0.004 < 0.01
    expect(crowd.pAdjusted!).toBeCloseTo(alone.pValue! * 6, 9); // 0.024 > 0.01
    expect(crowd.status).toBe("cleared");
  });

  test("groups pending reruns by config", () => {
    const report = evaluateRegression({
      current: [
        ...cellRun("tonight", OPUS, "sql-audit", 1),
        ...cellRun("tonight", OPUS, "tool-routing", 1),
        ...cellRun("tonight", LUNA, "sql-audit", 1),
      ],
      baseline: [
        ...healthyBaseline(OPUS, "sql-audit"),
        ...healthyBaseline(OPUS, "tool-routing"),
        ...healthyBaseline(LUNA, "sql-audit"),
      ],
    });
    expect(report.pendingReruns).toEqual([
      { configId: OPUS, scenarioIds: ["sql-audit", "tool-routing"], attemptsPerCell: 6 },
      { configId: LUNA, scenarioIds: ["sql-audit"], attemptsPerCell: 6 },
    ]);
  });
});

describe("tiers and baselines", () => {
  test("a scenario passing 50% to 95% of the baseline is quarantined and never flags", () => {
    // 12 of 14 nights fully pass, 2 nights fail 2 of 3: 38/42 = 90%
    const baseline = [
      ...healthyBaseline(OPUS, "sql-audit", 12),
      ...cellRun("late-1", OPUS, "sql-audit", 1),
      ...cellRun("late-2", OPUS, "sql-audit", 1),
    ];
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 0),
      baseline,
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("quarantine");
    expect(cell.note).toContain("non-paging");
    expect(report.page).toBe(false);
    expect(report.flagged).toBe(false);
  });

  test("a scenario under 50% is broken, not flaky", () => {
    const baseline = Array.from({ length: 6 }, (_, i) =>
      cellRun(`night-${i}`, OPUS, "script-authoring", 1),
    ).flat(); // 6/18
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "script-authoring", 0),
      baseline,
    });
    expect(only(report.cells).status).toBe("broken");
    expect(report.page).toBe(false);
  });

  test("under 9 graded baseline attempts, nothing is judged", () => {
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 0),
      baseline: healthyBaseline(OPUS, "sql-audit", 2), // 6 attempts
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("no-baseline");
    expect(cell.note).toContain("6/9");
    expect(report.page).toBe(false);
  });

  test("a new scenario version starts a new baseline", () => {
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 0, 3, { scenarioVersion: 2 }),
      baseline: healthyBaseline(OPUS, "sql-audit", BASELINE_RUNS, { scenarioVersion: 1 }),
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("no-baseline");
    expect(cell.note).toContain("scenario version changed");
  });

  test("baseline rows of a config the run did not use, or of other scenarios, are ignored", () => {
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 3),
      baseline: [...healthyBaseline(LUNA, "sql-audit"), ...healthyBaseline(OPUS, "tool-routing")],
    });
    expect(only(report.cells).status).toBe("no-baseline");
    expect(only(report.configs).modelChanged).toBe(false);
  });

  test("error and cancelled attempts are counted apart and never scored", () => {
    const report = evaluateRegression({
      current: [
        ...cellRun("tonight", OPUS, "sql-audit", 3),
        attempt("tonight", OPUS, "sql-audit", "error", { error: "HTTP 429 rate limit" }),
        attempt("tonight", OPUS, "sql-audit", "error", { error: "sandbox died" }),
        attempt("tonight", OPUS, "sql-audit", "error", {
          exclusion: "cancelled",
          error: "cost cap",
        }),
      ],
      baseline: healthyBaseline(OPUS, "sql-audit"),
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("ok");
    expect(cell.graded).toBe(3);
    expect(cell.errors).toBe(2);
    expect(cell.cancelled).toBe(1);
    const config = only(report.configs);
    expect(config.errors).toBe(2);
    expect(config.rateLimited).toBe(1);
    expect(config.attempts).toBe(5);
    expect(report.totals).toMatchObject({
      attempts: 5,
      passed: 3,
      failed: 0,
      errors: 2,
      cancelled: 1,
    });
  });

  test("a cell with no graded attempt reports no-data, not a page", () => {
    const report = evaluateRegression({
      current: [attempt("tonight", OPUS, "sql-audit", "error", { error: "boom" })],
      baseline: healthyBaseline(OPUS, "sql-audit"),
    });
    expect(only(report.cells).status).toBe("no-data");
    expect(report.page).toBe(false);
  });
});

describe("score rule", () => {
  test("a drop past the detectable effect flags, without paging or rerunning", () => {
    // every attempt still "passes", but the mean score fell from ~0.9 to ~0.6
    const current = Array.from({ length: 3 }, () =>
      attempt("tonight", OPUS, "sql-audit", "passed", { score: 0.6 }),
    );
    const report = evaluateRegression({
      current,
      baseline: healthyBaseline(OPUS, "sql-audit"),
    });
    const cell = only(report.cells);
    expect(cell.status).toBe("score-drop");
    expect(cell.scoreDiff!.diff).toBeLessThan(-0.25);
    expect(cell.scoreDiff!.hi).toBeLessThan(0);
    expect(cell.scoreDiff!.mde).toBeGreaterThan(0);
    expect(report.page).toBe(false);
    expect(report.flagged).toBe(true);
    expect(report.pendingReruns).toEqual([]);
  });

  test("a small dip inside the detectable effect is not a flag", () => {
    const current = Array.from({ length: 3 }, () =>
      attempt("tonight", OPUS, "sql-audit", "passed", { score: 0.86 }),
    );
    const report = evaluateRegression({ current, baseline: healthyBaseline(OPUS, "sql-audit") });
    expect(only(report.cells).status).toBe("ok");
    expect(report.flagged).toBe(false);
  });

  test("one failed attempt is the pass/fail rule's business: it never doubles as a score flag", () => {
    const constantBaseline = Array.from({ length: 14 }, (_, i) =>
      cellRun(`night-${i}`, OPUS, "sql-audit", 3, 3, { score: 0.9 }),
    ).flat();
    const report = evaluateRegression({
      current: cellRun("tonight", OPUS, "sql-audit", 2),
      baseline: constantBaseline,
    });
    expect(only(report.cells).status).toBe("noise");
    expect(only(report.cells).scoreDiff).toBeNull();
    expect(report.flagged).toBe(false);
  });

  test("a dip under 5 points never flags, even when the baseline never varied", () => {
    const constantBaseline = Array.from({ length: 14 }, (_, i) =>
      cellRun(`night-${i}`, OPUS, "sql-audit", 3, 3, { score: 0.9 }),
    ).flat();
    const current = Array.from({ length: 3 }, () =>
      attempt("tonight", OPUS, "sql-audit", "passed", { score: 0.86 }),
    );
    const report = evaluateRegression({ current, baseline: constantBaseline });
    expect(only(report.cells).status).toBe("ok");
    expect(only(report.cells).scoreDiff!.mde).toBeCloseTo(0, 9);
  });

  test("a higher score is never a regression", () => {
    const current = Array.from({ length: 3 }, () =>
      attempt("tonight", OPUS, "sql-audit", "passed", { score: 1 }),
    );
    const report = evaluateRegression({ current, baseline: healthyBaseline(OPUS, "sql-audit") });
    expect(only(report.cells).status).toBe("ok");
  });
});

describe("cost drift", () => {
  const runsAt = (metered: number, notional: number) =>
    Array.from({ length: 5 }, (_, i) =>
      attempt(`night-${i}`, OPUS, "sql-audit", "passed", { metered, notional }),
    );

  test("flags a config above 1.5x its baseline median, on either measure", () => {
    const report = evaluateRegression({
      current: [attempt("tonight", OPUS, "sql-audit", "passed", { metered: 1.6, notional: 0.4 })],
      baseline: runsAt(1, 0.4),
    });
    const config = only(report.configs);
    expect(config.medianMeteredUsd).toBe(1);
    expect(config.meteredDrift).toBe(true);
    expect(config.notionalDrift).toBe(false);
    expect(report.flagged).toBe(true);
    expect(report.page).toBe(false);
  });

  test("exactly 1.5x is not drift; fewer than 3 baseline runs is not enough to judge", () => {
    const atLimit = evaluateRegression({
      current: [attempt("tonight", OPUS, "sql-audit", "passed", { metered: 1.5 })],
      baseline: runsAt(1, 0.1),
    });
    expect(only(atLimit.configs).meteredDrift).toBe(false);

    const young = evaluateRegression({
      current: [attempt("tonight", OPUS, "sql-audit", "passed", { metered: 9 })],
      baseline: runsAt(1, 0.1).slice(0, 2),
    });
    const config = only(young.configs);
    expect(config.medianMeteredUsd).toBeNull();
    expect(config.meteredDrift).toBe(false);
  });
});
