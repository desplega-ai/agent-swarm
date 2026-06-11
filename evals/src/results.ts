import type { AttemptRow, EvalRunRow } from "./types.ts";

export interface CellSummary {
  scenarioId: string;
  configId: string;
  attempts: number;
  finished: number;
  /** best@n: did any attempt pass? */
  passedAny: boolean;
  /** pass@1: did the first attempt pass? */
  passedFirst: boolean | null;
  bestScore: number | null;
  avgScore: number | null;
  totalCostUsd: number | null;
  avgDurationMs: number | null;
  errors: number;
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
        avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        totalCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
        avgDurationMs: durations.length
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : null,
        errors: cellAttempts.filter((a) => a.status === "error").length,
      });
    }
  }
  const costsAll = cells.map((c) => c.totalCostUsd).filter((c): c is number => c !== null);
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
      totalDurationMs: durationsAll.length ? durationsAll.reduce((a, b) => a + b, 0) : null,
      passedAttempts: attempts.filter((a) => a.status === "passed").length,
      errorAttempts: attempts.filter((a) => a.status === "error").length,
      unpricedAttempts: finishedAttempts.filter(
        (a) => a.costUsd === null || a.costSource === "unpriced",
      ).length,
    },
  };
}
