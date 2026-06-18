import { bootstrapCI, wilsonInterval } from "./stats.ts";
import type { AttemptRow, EvalRunRow } from "./types.ts";

/** Bootstrap percentile CI over the cell's per-attempt dimension scores. */
export interface ScoreCI {
  lo: number;
  hi: number;
  method: "bootstrap";
}

/** Wilson score interval over the cell's pass-rate. */
export interface PassRateCI {
  lo: number;
  hi: number;
}

export interface CellSummary {
  scenarioId: string;
  configId: string;
  attempts: number;
  finished: number;
  /** best@n: did any attempt pass? (drill-down — no longer the headline). */
  passedAny: boolean;
  /** pass@1: did the first attempt pass? (drill-down). */
  passedFirst: boolean | null;
  /** best@n score (drill-down — no longer the headline). */
  bestScore: number | null;
  avgScore: number | null;
  /**
   * Phase 3 headline: mean of the cell's per-attempt dimension scores. Same
   * value as `avgScore` — `avgScore` is kept as a back-compat alias so older
   * readers (calibration report, analytics, UI) keep working.
   */
  meanScore: number | null;
  /**
   * Phase 3 headline: bootstrap percentile CI over the per-attempt scores. The
   * discrimination band — tightens ~1/√n. null when no attempt produced a score.
   */
  scoreCI: ScoreCI | null;
  /** Phase 3 companion: pass-rate (passed / finished). null when nothing finished. */
  passRate: number | null;
  /** Phase 3 companion: Wilson interval over the pass-rate. null when nothing finished. */
  passRateCI: PassRateCI | null;
  totalCostUsd: number | null;
  avgDurationMs: number | null;
  errors: number;
  /** v7 §2: COUNT of passed attempts in the cell. */
  passed: number;
  /** v7 §2: attempts with costUsd !== null. */
  pricedAttempts: number;
  /** v7 §2: totalCostUsd / pricedAttempts; null when 0 priced. */
  avgCostUsd: number | null;
}

export interface RunSummary {
  run: EvalRunRow;
  cells: CellSummary[];
  totals: {
    attempts: number;
    finished: number;
    passedCells: number;
    totalCells: number;
    totalCostUsd: number | null;
    /** Judge LLM cost (harness overhead) — kept SEPARATE from totalCostUsd. */
    judgeCostUsd: number | null;
    /** Sum of non-null attempt durationMs. */
    totalDurationMs: number | null;
    passedAttempts: number;
    errorAttempts: number;
    /** Finished attempts with costUsd === null or costSource === "unpriced". */
    unpricedAttempts: number;
  };
}

export function summarizeRun(run: EvalRunRow, attempts: AttemptRow[]): RunSummary {
  const cells: CellSummary[] = [];
  for (const scenarioId of run.scenarioIds) {
    for (const configId of run.configIds) {
      const cellAttempts = attempts
        .filter((a) => a.scenarioId === scenarioId && a.configId === configId)
        .sort((a, b) => a.attemptIndex - b.attemptIndex);
      const finished = cellAttempts.filter((a) => ["passed", "failed", "error"].includes(a.status));
      const scores = cellAttempts.map((a) => a.score).filter((s): s is number => s !== null);
      const costs = cellAttempts.map((a) => a.costUsd).filter((c): c is number => c !== null);
      const durations = cellAttempts
        .map((a) => a.durationMs)
        .filter((d): d is number => d !== null);
      const first = cellAttempts.find((a) => a.attemptIndex === 0);
      const totalCostUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
      const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const passedCount = cellAttempts.filter((a) => a.status === "passed").length;
      // Deterministic seed per cell so CI bounds are reproducible run-to-run.
      const scoreCI = scores.length ? bootstrapCI(scores, { seed: 0xc0ffee }) : null;
      const passRate = finished.length ? passedCount / finished.length : null;
      const passRateCI = finished.length ? wilsonInterval(passedCount, finished.length) : null;
      cells.push({
        scenarioId,
        configId,
        attempts: cellAttempts.length,
        finished: finished.length,
        passedAny: cellAttempts.some((a) => a.status === "passed"),
        passedFirst:
          first && ["passed", "failed", "error"].includes(first.status)
            ? first.status === "passed"
            : null,
        bestScore: scores.length ? Math.max(...scores) : null,
        avgScore: meanScore,
        meanScore,
        scoreCI,
        passRate,
        passRateCI,
        totalCostUsd,
        avgDurationMs: durations.length
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : null,
        errors: cellAttempts.filter((a) => a.status === "error").length,
        passed: passedCount,
        pricedAttempts: costs.length,
        avgCostUsd: totalCostUsd === null ? null : totalCostUsd / costs.length,
      });
    }
  }
  const costsAll = cells.map((c) => c.totalCostUsd).filter((c): c is number => c !== null);
  const judgeCosts = attempts.map((a) => a.judgeCostUsd).filter((c): c is number => c !== null);
  const durationsAll = attempts.map((a) => a.durationMs).filter((d): d is number => d !== null);
  const finishedAttempts = attempts.filter((a) => ["passed", "failed", "error"].includes(a.status));
  return {
    run,
    cells,
    totals: {
      attempts: attempts.length,
      finished: finishedAttempts.length,
      passedCells: cells.filter((c) => c.passedAny).length,
      totalCells: cells.length,
      totalCostUsd: costsAll.length ? costsAll.reduce((a, b) => a + b, 0) : null,
      judgeCostUsd: judgeCosts.length ? judgeCosts.reduce((a, b) => a + b, 0) : null,
      totalDurationMs: durationsAll.length ? durationsAll.reduce((a, b) => a + b, 0) : null,
      passedAttempts: attempts.filter((a) => a.status === "passed").length,
      errorAttempts: attempts.filter((a) => a.status === "error").length,
      unpricedAttempts: finishedAttempts.filter(
        (a) => a.costUsd === null || a.costSource === "unpriced",
      ).length,
    },
  };
}
