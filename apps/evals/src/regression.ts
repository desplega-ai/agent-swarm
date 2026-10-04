/**
 * Regression vs noise for the scheduled runs (Phase 9 of the swarm-evals plan).
 * Pure functions over attempt rows: no DB, no network, no clock. `api/run-completion.ts`
 * reads the rows and posts the result.
 *
 * A run is compared with the baseline: the same preset's last {@link BASELINE_RUNS}
 * finished runs, per config x scenario cell. Rules, per cell:
 *
 *   - Baseline pass rate < 50%: the scenario is `broken`, not flaky. No check.
 *   - 50% to 95%: `quarantine`, a non-paging tier. Reported, never flagged.
 *   - At least 95% (the paging tier):
 *       * pass/fail: with 3 repeats, 2 or more failures flag (false alarm ~0.7% per
 *         cell-night at a 95% baseline), 1 is noise, 3 of 3 pages at once. Other
 *         repeat counts use {@link flagThreshold}.
 *       * a flag asks for {@link RERUN_ATTEMPTS} reruns; the cell pages only when
 *         current + rerun attempts differ from the baseline by Fisher's exact test
 *         at p < {@link PAGE_ALPHA} after Holm correction across the run's flagged
 *         cells (and the pass rate is lower, not higher).
 *       * score: two-sample bootstrap of the mean score of the PASSING attempts
 *         against the baseline's (attempts resampled within the cell; failures are
 *         the pass/fail rule's, so one bad attempt never doubles as a score drop).
 *         It flags, without paging, when the 95% CI is entirely below 0 and the
 *         drop exceeds the minimum detectable effect measured from the baseline's
 *         own variance (and at least {@link MIN_SCORE_DROP}).
 *   - Cost drift: a config's metered or notional cost for the run is more than
 *     {@link COST_DRIFT_RATIO} x the median of its baseline runs.
 *   - Model change is not a regression: baseline rows from another `resolved_model`
 *     (or another scenario version) are set aside. A config with no baseline left
 *     starts a new one and reports `model-changed`.
 *
 * Attempts count only when graded (`passed` / `failed`, not excluded). `error`
 * attempts are infra: counted, never scored.
 */

import { bootstrapDiffCI, meanOrNull } from "./stats.ts";

/** Prior finished runs of the same preset that make up the baseline. */
export const BASELINE_RUNS = 14;
/** A cell needs this many graded baseline attempts (3 nightly runs) before it is judged. */
export const MIN_BASELINE_ATTEMPTS = 9;
/** Baseline pass rate from which a cell is in the paging tier. */
export const PAGING_BASELINE_RATE = 0.95;
/** Baseline pass rate under which a cell is broken, not flaky. */
export const BROKEN_BASELINE_RATE = 0.5;
/** Attempts per flagged cell in the automatic rerun. */
export const RERUN_ATTEMPTS = 6;
/** Page threshold: Holm-adjusted Fisher p-value. */
export const PAGE_ALPHA = 0.01;
/** Failure probability a healthy paging-tier cell is assumed to have (1 - 0.95). */
const HEALTHY_FAILURE_RATE = 1 - PAGING_BASELINE_RATE;
/** A flag may fire at most this often on a healthy cell (per cell-night). */
const FLAG_FALSE_ALARM_RATE = 0.01;
/** A config's run cost above this multiple of its baseline median is drift. */
export const COST_DRIFT_RATIO = 1.5;
/** Baseline runs needed before a cost median means anything. */
export const MIN_COST_BASELINE_RUNS = 3;
/** The score rule needs this many passing current attempts in the cell. */
export const MIN_SCORED_ATTEMPTS = 3;
/** A score drop smaller than this never flags, whatever the baseline variance says. */
export const MIN_SCORE_DROP = 0.05;
/** z(0.975) + z(0.80): the minimum detectable effect at 5% two-sided alpha and 80% power. */
const MDE_Z = 1.96 + 0.8416;

// ---- inputs ----

/** The slice of an attempt the rule reads. */
export interface RegressionAttempt {
  runId: string;
  scenarioId: string;
  configId: string;
  /** attempts.status */
  status: string;
  /** attempts.exclusion; a set value keeps the attempt out of every rate. */
  exclusion?: string | null;
  score: number | null;
  scenarioVersion?: number | null;
  /** Concrete model the attempt ran on; null on rows that never recorded one. */
  resolvedModel: string | null;
  /** Agent (when billed per token) + judge + sandbox estimate, USD. */
  meteredUsd: number;
  /** Agent cost as the harness reported it, USD (also for subscription configs). */
  notionalUsd: number;
  /** attempts.error, for the rate-limit count. */
  error?: string | null;
}

export interface RegressionInput {
  /** Attempts of the run being judged. */
  current: RegressionAttempt[];
  /**
   * Attempts of the previous runs of the same preset (at most {@link BASELINE_RUNS}
   * runs; the caller picks them). Must not include `current` or any rerun.
   */
  baseline: RegressionAttempt[];
  /** Attempts of the automatic reruns of `current`. */
  reruns?: RegressionAttempt[];
  /**
   * True once every rerun has finished. While false, a flagged cell stays `flag`
   * and is listed in `pendingReruns`; once true it resolves to `page` or `cleared`.
   */
  rerunsSettled?: boolean;
}

// ---- outputs ----

export type CellStatus =
  | "ok"
  /** Failures below the flag threshold. */
  | "noise"
  /** Flagged; the rerun is pending or did not finish, so nothing is confirmed. */
  | "flag"
  /** Flagged, rerun done, not different from the baseline. */
  | "cleared"
  /** All attempts failed, or the rerun confirmed the drop. */
  | "page"
  /** Score dropped beyond noise. Flags; never pages. */
  | "score-drop"
  | "quarantine"
  | "broken"
  /** Under {@link MIN_BASELINE_ATTEMPTS} graded baseline attempts. */
  | "no-baseline"
  /** The config's model changed; the baseline restarts. */
  | "model-changed"
  /** No graded attempt in the current run. */
  | "no-data";

export interface CellReport {
  configId: string;
  scenarioId: string;
  status: CellStatus;
  graded: number;
  passed: number;
  /** Infra `error` attempts, excluding cancelled ones. */
  errors: number;
  /** Attempts closed as cancelled (cost cap, dead run, cancel). */
  cancelled: number;
  passRate: number | null;
  meanScore: number | null;
  baseline: { graded: number; passRate: number | null; meanScore: number | null };
  /** Rerun attempts folded in, when the cell was flagged and the reruns settled. */
  rerun: { graded: number; passed: number } | null;
  /** Fisher p-value of current + rerun vs baseline, and its Holm-adjusted value. */
  pValue: number | null;
  pAdjusted: number | null;
  scoreDiff: { diff: number; lo: number; hi: number; mde: number } | null;
  /** One line for the report. */
  note: string;
}

export interface ConfigReport {
  configId: string;
  /** Model the current attempts ran on (the most common recorded one). */
  model: string | null;
  /** Model of the most recent baseline run, when it differs. */
  previousModel: string | null;
  modelChanged: boolean;
  /** Attempts run, excluding cancelled ones. */
  attempts: number;
  errors: number;
  /** Errors whose text reads as a rate limit (429, "rate limit", "usage limit"). */
  rateLimited: number;
  meteredUsd: number;
  notionalUsd: number;
  medianMeteredUsd: number | null;
  medianNotionalUsd: number | null;
  meteredDrift: boolean;
  notionalDrift: boolean;
}

export interface RerunRequest {
  configId: string;
  scenarioIds: string[];
  attemptsPerCell: number;
}

export interface RegressionReport {
  cells: CellReport[];
  configs: ConfigReport[];
  /** Cells to rerun, grouped by config. Empty once the reruns settled. */
  pendingReruns: RerunRequest[];
  /** Some cell pages. */
  page: boolean;
  /** Something wants a human look: a page, flag, score drop or cost drift. */
  flagged: boolean;
  /** Nothing left to wait for: no rerun is pending. */
  final: boolean;
  totals: {
    attempts: number;
    passed: number;
    failed: number;
    errors: number;
    cancelled: number;
    meteredUsd: number;
    notionalUsd: number;
  };
}

// ---- small numeric helpers ----

function isGraded(a: RegressionAttempt): boolean {
  return (a.status === "passed" || a.status === "failed") && !a.exclusion;
}

function isCancelled(a: RegressionAttempt): boolean {
  return a.exclusion === "cancelled";
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function sampleSd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const ss = values.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

/** P(X >= k) for X ~ Binomial(n, q). */
export function binomialTailAtLeast(n: number, k: number, q: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let tail = 0;
  let coeff = 1; // C(n, i), built up from i = 0
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += coeff * q ** i * (1 - q) ** (n - i);
    coeff = (coeff * (n - i)) / (i + 1);
  }
  return Math.min(1, tail);
}

/**
 * Failures out of `n` graded attempts at which a paging-tier cell flags: the
 * smallest count a healthy cell (5% failure rate) reaches at most 1% of the time.
 * n = 3 gives 2 (0.7% false alarm), n = 5 gives 3. `Infinity` when no count
 * qualifies (n < 2), i.e. the cell can never flag on failures alone.
 */
export function flagThreshold(n: number): number {
  for (let f = 1; f <= n; f++) {
    if (binomialTailAtLeast(n, f, HEALTHY_FAILURE_RATE) <= FLAG_FALSE_ALARM_RATE) return f;
  }
  return Number.POSITIVE_INFINITY;
}

/** ln(n!) table, grown on demand. */
const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++) {
    logFactorials.push(logFactorials[i - 1]! + Math.log(i));
  }
  return logFactorials[n]!;
}

/**
 * Two-sided Fisher's exact test on [[a, b], [c, d]]: the summed probability of every
 * table with the same margins that is no more likely than the observed one.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const total = row1 + row2;
  if (total === 0) return 1;
  const logDenominator = logFactorial(total) - logFactorial(col1) - logFactorial(total - col1);
  const logProb = (x: number): number =>
    logFactorial(row1) -
    logFactorial(x) -
    logFactorial(row1 - x) +
    (logFactorial(row2) - logFactorial(col1 - x) - logFactorial(row2 - (col1 - x))) -
    logDenominator;
  const lo = Math.max(0, col1 - row2);
  const hi = Math.min(row1, col1);
  const observed = logProb(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logProb(x);
    if (lp <= observed + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** Holm step-down adjustment of raw p-values; the result keeps the input order. */
export function holmAdjust(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

/**
 * Smallest drop in mean score the comparison can reliably see (80% power, 5%
 * two-sided), from the baseline's own spread: `2.8 x sd x sqrt(1/nCurrent + 1/nBaseline)`.
 * Null when the baseline has fewer than 2 scores.
 */
export function minimumDetectableEffect(baselineScores: number[], nCurrent: number): number | null {
  if (baselineScores.length < 2 || nCurrent < 1) return null;
  return MDE_Z * sampleSd(baselineScores) * Math.sqrt(1 / nCurrent + 1 / baselineScores.length);
}

const RATE_LIMIT_RE = /\b429\b|rate[\s_-]?limit|too many requests|usage limit|quota/i;

/** The most common non-null value; ties go to the first seen. */
function mode(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, count] of counts) {
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

const cellKey = (configId: string, scenarioId: string) => `${configId}\u0000${scenarioId}`;

/** A model (or scenario version) matches when either side never recorded one. */
function sameOrUnknown<T>(a: T | null | undefined, b: T | null | undefined): boolean {
  return a == null || b == null || a === b;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---- the rule ----

interface CellWork {
  report: CellReport;
  /** Flagged on failures and waiting for (or holding) rerun data. */
  flagged: boolean;
  combinedPassed: number;
  combinedGraded: number;
  baselinePassed: number;
  baselineGraded: number;
}

export function evaluateRegression(input: RegressionInput): RegressionReport {
  const { current, baseline } = input;
  const reruns = input.reruns ?? [];
  const settled = input.rerunsSettled ?? false;

  // Config-level facts: model in use, whether it moved, and the same-model baseline.
  const currentByConfig = groupBy(current, (a) => a.configId);
  const baselineByConfig = groupBy(baseline, (a) => a.configId);
  const configReports: ConfigReport[] = [];
  const usableBaseline = new Map<string, RegressionAttempt[]>();
  for (const [configId, rows] of currentByConfig) {
    const model = mode(rows.filter((a) => !isCancelled(a)).map((a) => a.resolvedModel));
    const priorRows = baselineByConfig.get(configId) ?? [];
    const sameModel = priorRows.filter((a) => sameOrUnknown(a.resolvedModel, model));
    const modelChanged = priorRows.length > 0 && sameModel.length === 0;
    usableBaseline.set(configId, sameModel);
    const latestPriorRunId = priorRows.at(-1)?.runId;
    const previousModel = modelChanged
      ? mode(priorRows.filter((a) => a.runId === latestPriorRunId).map((a) => a.resolvedModel))
      : null;

    const live = rows.filter((a) => !isCancelled(a));
    const errored = live.filter((a) => a.status === "error");
    const meteredUsd = rows.reduce((s, a) => s + a.meteredUsd, 0);
    const notionalUsd = rows.reduce((s, a) => s + a.notionalUsd, 0);
    const perRun = [...groupBy(sameModel, (a) => a.runId).values()];
    const medianMetered =
      perRun.length >= MIN_COST_BASELINE_RUNS
        ? median(perRun.map((r) => r.reduce((s, a) => s + a.meteredUsd, 0)))
        : null;
    const medianNotional =
      perRun.length >= MIN_COST_BASELINE_RUNS
        ? median(perRun.map((r) => r.reduce((s, a) => s + a.notionalUsd, 0)))
        : null;
    configReports.push({
      configId,
      model,
      previousModel,
      modelChanged,
      attempts: live.length,
      errors: errored.length,
      rateLimited: errored.filter((a) => a.error && RATE_LIMIT_RE.test(a.error)).length,
      meteredUsd,
      notionalUsd,
      medianMeteredUsd: medianMetered,
      medianNotionalUsd: medianNotional,
      meteredDrift:
        medianMetered !== null &&
        medianMetered > 0 &&
        meteredUsd > COST_DRIFT_RATIO * medianMetered,
      notionalDrift:
        medianNotional !== null &&
        medianNotional > 0 &&
        notionalUsd > COST_DRIFT_RATIO * medianNotional,
    });
  }
  const configById = new Map(configReports.map((c) => [c.configId, c]));

  // Cell-level pass over the current run.
  const currentByCell = groupBy(current, (a) => cellKey(a.configId, a.scenarioId));
  const rerunByCell = groupBy(reruns, (a) => cellKey(a.configId, a.scenarioId));
  const works: CellWork[] = [];
  for (const rows of currentByCell.values()) {
    const first = rows[0]!;
    const config = configById.get(first.configId)!;
    const scenarioVersion = first.scenarioVersion;
    const priorRows = (usableBaseline.get(first.configId) ?? []).filter(
      (a) => a.scenarioId === first.scenarioId,
    );
    const baseRows = priorRows.filter((a) => sameOrUnknown(a.scenarioVersion, scenarioVersion));
    const versionChanged = priorRows.length > 0 && baseRows.length === 0;
    works.push(
      assessCell({
        rows,
        baseRows,
        rerunRows: rerunByCell.get(cellKey(first.configId, first.scenarioId)) ?? [],
        modelChanged: config.modelChanged,
        versionChanged,
        settled,
      }),
    );
  }

  // Confirm flagged cells against their reruns: Fisher, then Holm across the family.
  const flaggedWorks = works.filter((w) => w.flagged);
  if (settled && flaggedWorks.length > 0) {
    const raw = flaggedWorks.map((w) =>
      w.combinedGraded === 0 || w.baselineGraded === 0
        ? 1
        : fisherExactTwoSided(
            w.combinedPassed,
            w.combinedGraded - w.combinedPassed,
            w.baselinePassed,
            w.baselineGraded - w.baselinePassed,
          ),
    );
    const adjusted = holmAdjust(raw);
    flaggedWorks.forEach((w, i) => {
      const r = w.report;
      if (w.report.rerun === null || w.report.rerun.graded === 0) {
        r.note = `${r.passed}/${r.graded} passed vs ${pct(r.baseline.passRate ?? 0)} baseline; the rerun did not produce a result, so nothing is confirmed`;
        return; // stays "flag"
      }
      r.pValue = raw[i]!;
      r.pAdjusted = adjusted[i]!;
      const combinedRate = w.combinedPassed / w.combinedGraded;
      const baselineRate = w.baselinePassed / w.baselineGraded;
      const combined = `${w.combinedPassed}/${w.combinedGraded} with the rerun`;
      if (adjusted[i]! < PAGE_ALPHA && combinedRate < baselineRate) {
        r.status = "page";
        r.note = `${combined} vs ${pct(baselineRate)} baseline (p=${formatP(adjusted[i]!)} after Holm)`;
      } else {
        r.status = "cleared";
        r.note = `${combined} vs ${pct(baselineRate)} baseline; not different (p=${formatP(adjusted[i]!)} after Holm)`;
      }
    });
  }

  const cells = works.map((w) => w.report);
  const pendingReruns: RerunRequest[] = [];
  if (!settled) {
    const byConfig = new Map<string, string[]>();
    for (const w of flaggedWorks) {
      const list = byConfig.get(w.report.configId) ?? [];
      list.push(w.report.scenarioId);
      byConfig.set(w.report.configId, list);
    }
    for (const [configId, scenarioIds] of byConfig) {
      pendingReruns.push({ configId, scenarioIds, attemptsPerCell: RERUN_ATTEMPTS });
    }
  }

  const graded = current.filter(isGraded);
  const totals = {
    attempts: current.filter((a) => !isCancelled(a)).length,
    passed: graded.filter((a) => a.status === "passed").length,
    failed: graded.filter((a) => a.status === "failed").length,
    errors: current.filter((a) => a.status === "error" && !isCancelled(a)).length,
    cancelled: current.filter(isCancelled).length,
    meteredUsd: current.reduce((s, a) => s + a.meteredUsd, 0),
    notionalUsd: current.reduce((s, a) => s + a.notionalUsd, 0),
  };
  const page = cells.some((c) => c.status === "page");
  return {
    cells,
    configs: configReports,
    pendingReruns,
    page,
    flagged:
      page ||
      cells.some((c) => c.status === "flag" || c.status === "score-drop") ||
      configReports.some((c) => c.meteredDrift || c.notionalDrift),
    final: pendingReruns.length === 0,
    totals,
  };
}

function formatP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

function assessCell(opts: {
  rows: RegressionAttempt[];
  baseRows: RegressionAttempt[];
  rerunRows: RegressionAttempt[];
  modelChanged: boolean;
  versionChanged: boolean;
  settled: boolean;
}): CellWork {
  const { rows, baseRows, rerunRows } = opts;
  const first = rows[0]!;
  const gradedRows = rows.filter(isGraded);
  const passed = gradedRows.filter((a) => a.status === "passed").length;
  const n = gradedRows.length;
  const failures = n - passed;
  const scores = gradedRows.map((a) => a.score).filter((s): s is number => s !== null);
  const passedScores = gradedRows
    .filter((a) => a.status === "passed")
    .map((a) => a.score)
    .filter((s): s is number => s !== null);
  const baseGraded = baseRows.filter(isGraded);
  const basePassed = baseGraded.filter((a) => a.status === "passed").length;
  const baseScores = baseGraded.map((a) => a.score).filter((s): s is number => s !== null);
  const basePassedScores = baseGraded
    .filter((a) => a.status === "passed")
    .map((a) => a.score)
    .filter((s): s is number => s !== null);
  const baseRate = baseGraded.length > 0 ? basePassed / baseGraded.length : null;

  const report: CellReport = {
    configId: first.configId,
    scenarioId: first.scenarioId,
    status: "ok",
    graded: n,
    passed,
    errors: rows.filter((a) => a.status === "error" && !isCancelled(a)).length,
    cancelled: rows.filter(isCancelled).length,
    passRate: n > 0 ? passed / n : null,
    meanScore: meanOrNull(scores),
    baseline: { graded: baseGraded.length, passRate: baseRate, meanScore: meanOrNull(baseScores) },
    rerun: null,
    pValue: null,
    pAdjusted: null,
    scoreDiff: null,
    note: "",
  };
  const work: CellWork = {
    report,
    flagged: false,
    combinedPassed: passed,
    combinedGraded: n,
    baselinePassed: basePassed,
    baselineGraded: baseGraded.length,
  };
  const score = `${passed}/${n} passed`;

  if (n === 0) {
    report.status = "no-data";
    report.note = "no graded attempt";
    return work;
  }
  if (opts.modelChanged) {
    report.status = "model-changed";
    report.note = `${score}; the model changed, so this run starts a new baseline`;
    return work;
  }
  if (baseGraded.length < MIN_BASELINE_ATTEMPTS || baseRate === null) {
    report.status = "no-baseline";
    report.note = opts.versionChanged
      ? `${score}; the scenario version changed, so this run starts a new baseline`
      : `${score}; baseline has ${baseGraded.length}/${MIN_BASELINE_ATTEMPTS} graded attempts`;
    return work;
  }
  if (baseRate < BROKEN_BASELINE_RATE) {
    report.status = "broken";
    report.note = `${score}; passes ${pct(baseRate)} of the baseline, so it is broken rather than flaky`;
    return work;
  }
  if (baseRate < PAGING_BASELINE_RATE) {
    report.status = "quarantine";
    report.note = `${score}; passes ${pct(baseRate)} of the baseline: non-paging, needs an owner`;
    return work;
  }

  // Paging tier.
  const versus = `vs ${pct(baseRate)} baseline`;
  if (failures === n && n >= 3) {
    report.status = "page";
    report.note = `${score} ${versus}: every attempt failed`;
    return work;
  }
  if (failures >= flagThreshold(n)) {
    report.status = "flag";
    work.flagged = true;
    const rerunGraded = rerunRows.filter(isGraded);
    const rerunPassed = rerunGraded.filter((a) => a.status === "passed").length;
    if (opts.settled) {
      report.rerun = { graded: rerunGraded.length, passed: rerunPassed };
      work.combinedGraded = n + rerunGraded.length;
      work.combinedPassed = passed + rerunPassed;
    }
    report.note = `${score} ${versus}: flagged, ${opts.settled ? "rerun done" : `${RERUN_ATTEMPTS} reruns pending`}`;
    return work;
  }

  // Score rule on the paging tier; failures below the flag threshold are noise.
  if (passedScores.length >= MIN_SCORED_ATTEMPTS) {
    const ci = bootstrapDiffCI(passedScores, basePassedScores);
    const mde = minimumDetectableEffect(basePassedScores, passedScores.length);
    if (mde !== null) {
      report.scoreDiff = { diff: ci.diff, lo: ci.lo, hi: ci.hi, mde };
      if (ci.hi < 0 && -ci.diff > Math.max(mde, MIN_SCORE_DROP)) {
        report.status = "score-drop";
        report.note = `${score}; mean score ${(ci.diff * 100).toFixed(0)} points against the baseline (CI ${(ci.lo * 100).toFixed(0)} to ${(ci.hi * 100).toFixed(0)}, detectable drop ${(Math.max(mde, MIN_SCORE_DROP) * 100).toFixed(0)})`;
        return work;
      }
    }
  }
  if (failures > 0) {
    report.status = "noise";
    report.note = `${score} ${versus}: within noise`;
  } else {
    report.note = `${score} ${versus}`;
  }
  return work;
}
