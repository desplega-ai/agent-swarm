/**
 * calibration-report — round-11 ship-gate report.
 *
 * Given a runId, reads the run's attempts (via the existing `getRun` +
 * `listAttempts` + `summarizeRun`) and prints, per scenario, the
 * frontier/budget means and the gap vs the `>= 0.2` ship gate.
 *
 * Ship gate (see evals/docs/calibration.md):
 *   frontierAvg - budgetAvg >= 0.2   → PASS
 *   gap 0.1 .. 0.3                    → BORDERLINE (run +2 attempts/anchor before verdict)
 *
 *   frontier anchors = { claude-opus-4.8, codex-5.6-sol }
 *   budget   anchors = { pi-deepseek-flash, claude-haiku }
 *
 * The gap math is a pure function (`computeScenarioGaps`) that consumes a
 * `RunSummary` so it is unit-testable with synthetic attempts; the DB I/O
 * lives in `main()`.
 *
 * Usage: cd evals && bun scripts/calibration-report.ts <runId>
 */
import { initDb } from "../src/db/client.ts";
import { getRun, listAttempts } from "../src/db/queries.ts";
import { type RunSummary, summarizeRun } from "../src/results.ts";
import { bootstrapDiffCI } from "../src/stats.ts";
import type { AttemptRow } from "../src/types.ts";

/** Frontier calibration anchors (resolved — opus pinned to the 4.8 build). */
export const FRONTIER_ANCHORS = ["claude-opus-4.8", "codex-5.6-sol"] as const;
/** Budget calibration anchors (1 pi + 1 claude, symmetric with frontier). */
export const BUDGET_ANCHORS = ["pi-deepseek-flash", "claude-haiku"] as const;

/** Ship-gate threshold: frontierAvg - budgetAvg must clear this. */
export const SHIP_GATE_GAP = 0.2;
/** Borderline band: gaps in [low, high] warrant +2 attempts/anchor before verdict. */
export const BORDERLINE_LOW = 0.1;
export const BORDERLINE_HIGH = 0.3;

export interface AnchorScore {
  configId: string;
  /** Mean score over that anchor's attempts in the cell; null if no scored attempt. */
  avgScore: number | null;
}

/** Bootstrap CI for the frontier−budget gap + whether it excludes 0. */
export interface GapCI {
  lo: number;
  hi: number;
  /** CI excludes 0 → the gap is significant at this run's n. */
  significant: boolean;
  /** Total scored attempts behind the gap (frontier + budget cohorts). */
  n: number;
}

export interface ScenarioGap {
  scenarioId: string;
  frontier: AnchorScore[];
  budget: AnchorScore[];
  /** Mean over frontier anchors that produced a score; null if none scored. */
  frontierAvg: number | null;
  /** Mean over budget anchors that produced a score; null if none scored. */
  budgetAvg: number | null;
  /** frontierAvg - budgetAvg; null when either side is unscored. */
  gap: number | null;
  /** PASS when gap >= SHIP_GATE_GAP. */
  pass: boolean;
  /** Borderline when gap is in [BORDERLINE_LOW, BORDERLINE_HIGH]. */
  borderline: boolean;
  /**
   * Bootstrap CI of the gap (difference of cohort means) + significance flag.
   * null when the caller did not supply per-attempt scores (summary-only path)
   * or either cohort had no scored attempt.
   */
  gapCI: GapCI | null;
}

/** Mean of the non-null entries; null when every entry is null. */
function meanScored(scores: AnchorScore[]): number | null {
  const vals = scores.map((s) => s.avgScore).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Pure ship-gate computation over a `RunSummary` (no I/O). For each scenario in
 * the run, pull the per-(scenario, config) `avgScore` for the frontier/budget
 * anchors, average each cohort, and apply the `>= 0.2` gate.
 */
export function computeScenarioGaps(
  summary: RunSummary,
  opts: {
    frontier?: readonly string[];
    budget?: readonly string[];
    gateGap?: number;
    /**
     * Per-attempt rows for the run. When supplied, the gap also gets a bootstrap
     * CI + significance flag (over the per-cohort score distributions). Omit for
     * the summary-only path (gapCI stays null).
     */
    attempts?: AttemptRow[];
  } = {},
): ScenarioGap[] {
  const frontierIds = opts.frontier ?? FRONTIER_ANCHORS;
  const budgetIds = opts.budget ?? BUDGET_ANCHORS;
  const gateGap = opts.gateGap ?? SHIP_GATE_GAP;
  const attempts = opts.attempts;

  const cellScore = (scenarioId: string, configId: string): number | null =>
    summary.cells.find((c) => c.scenarioId === scenarioId && c.configId === configId)?.avgScore ??
    null;

  /** All scored per-attempt values for the given anchors within one scenario. */
  const cohortScores = (scenarioId: string, configIds: readonly string[]): number[] => {
    if (!attempts) return [];
    const ids = new Set(configIds);
    return attempts
      .filter((a) => a.scenarioId === scenarioId && ids.has(a.configId) && a.score !== null)
      .map((a) => a.score as number);
  };

  return summary.run.scenarioIds.map((scenarioId) => {
    const frontier: AnchorScore[] = frontierIds.map((configId) => ({
      configId,
      avgScore: cellScore(scenarioId, configId),
    }));
    const budget: AnchorScore[] = budgetIds.map((configId) => ({
      configId,
      avgScore: cellScore(scenarioId, configId),
    }));
    const frontierAvg = meanScored(frontier);
    const budgetAvg = meanScored(budget);
    const gap = frontierAvg !== null && budgetAvg !== null ? frontierAvg - budgetAvg : null;

    let gapCI: GapCI | null = null;
    if (attempts) {
      const fScores = cohortScores(scenarioId, frontierIds);
      const bScores = cohortScores(scenarioId, budgetIds);
      if (fScores.length > 0 && bScores.length > 0) {
        const ci = bootstrapDiffCI(fScores, bScores, { seed: 0xc0ffee });
        gapCI = {
          lo: ci.lo,
          hi: ci.hi,
          significant: ci.significant,
          n: fScores.length + bScores.length,
        };
      }
    }

    return {
      scenarioId,
      frontier,
      budget,
      frontierAvg,
      budgetAvg,
      gap,
      pass: gap !== null && gap >= gateGap,
      borderline: gap !== null && gap >= BORDERLINE_LOW && gap <= BORDERLINE_HIGH,
      gapCI,
    };
  });
}

function fmt(n: number | null): string {
  return n === null ? "  n/a" : n.toFixed(3);
}

/** Render the per-scenario gap table as a printable string. */
export function formatGapReport(gaps: ScenarioGap[]): string {
  const lines: string[] = [];
  const scenW = Math.max(8, ...gaps.map((g) => g.scenarioId.length)) + 2;
  lines.push(
    `${"scenario".padEnd(scenW)}${"frontier".padEnd(10)}${"budget".padEnd(10)}${"gap".padEnd(10)}verdict`,
  );
  lines.push("-".repeat(scenW + 30 + 10));
  for (const g of gaps) {
    let verdict: string;
    if (g.gap === null) verdict = "INCOMPLETE";
    else if (g.pass) verdict = "PASS";
    else if (g.borderline) verdict = "BORDERLINE (+2 attempts/anchor)";
    else verdict = "FAIL";
    if (g.gapCI) {
      const sig = g.gapCI.significant
        ? `significant at n=${g.gapCI.n}`
        : `NOT significant at n=${g.gapCI.n}`;
      verdict += `  [gap CI ${fmt(g.gapCI.lo)}..${fmt(g.gapCI.hi)}, ${sig}]`;
    }
    lines.push(
      `${g.scenarioId.padEnd(scenW)}${fmt(g.frontierAvg).padEnd(10)}${fmt(g.budgetAvg).padEnd(10)}${fmt(g.gap).padEnd(10)}${verdict}`,
    );
  }
  const passing = gaps.filter((g) => g.pass).length;
  lines.push("-".repeat(scenW + 30 + 10));
  lines.push(`${passing}/${gaps.length} scenarios clear the >= ${SHIP_GATE_GAP} ship gate`);
  lines.push(`frontier anchors: ${FRONTIER_ANCHORS.join(", ")}`);
  lines.push(`budget anchors:   ${BUDGET_ANCHORS.join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: bun scripts/calibration-report.ts <runId>");
    process.exit(2);
  }
  const db = await initDb();
  const run = await getRun(db, runId);
  if (!run) {
    console.error(`run ${runId} not found`);
    process.exit(1);
  }
  const attempts = await listAttempts(db, runId);
  const summary = summarizeRun(run, attempts);
  const gaps = computeScenarioGaps(summary, { attempts });
  console.log(`\n${run.id} [${run.status}] — round-11 calibration ship gate\n`);
  console.log(formatGapReport(gaps));
}

if (import.meta.main) {
  await main();
}
