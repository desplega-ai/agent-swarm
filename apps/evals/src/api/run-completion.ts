/**
 * What happens when a scheduled run finishes (Phase 9): read its attempts and its
 * baseline, run the regression rule, start the automatic reruns a flag asks for, and
 * post one Slack summary once nothing is left to wait for.
 *
 * `onRunFinished` is called by the server every time a run's execution ends. It is
 * idempotent: a run that already posted (`summary_posted_at`) does nothing, and a
 * rerun finishing only acts for its parent. Runs of any other preset, and runs with
 * no preset, are ignored.
 */

import type { Client } from "@libsql/client";
import { SCHEDULED_PRESET_IDS } from "../../configs/presets.ts";
import { SUITE_SCENARIO_VERSIONS } from "../../scenarios/suite.ts";
import { attemptMeteredUsd, configBilling, e2bUsdPerSandboxHour } from "../cost/billing.ts";
import {
  type AttemptWithModel,
  createRun,
  getRun,
  listAttempts,
  listAttemptsForRuns,
  listBaselineRunIds,
  listRerunRuns,
  markSummaryPosted,
  newRunId,
  setRunStatus,
} from "../db/queries.ts";
import {
  BASELINE_RUNS,
  evaluateRegression,
  RERUN_ATTEMPTS,
  type RegressionAttempt,
  type RegressionReport,
  type RerunRequest,
} from "../regression.ts";
import {
  formatRunFailureSummary,
  formatRunSummary,
  type SummaryRun,
} from "../regression-summary.ts";
import type { Registry } from "../runner/index.ts";
import { assertRunConfigsResolve, ensureRunConfigPins } from "../runner/run-configs.ts";
import type { EvalRunRow } from "../types.ts";

/** Metered cap on the automatic rerun of a flagged cell, USD. */
export const RERUN_MAX_METERED_USD = 2;

const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
const DEFAULT_PUBLIC_URL = "https://evals.agent-swarm.dev";

export interface RunCompletionDeps {
  db: Client;
  registry: Registry;
  /** Start a run's execution in this process. False when it is already running. */
  startRun: (runId: string) => boolean;
  /** Post to Slack; null when no webhook is configured (the summary is logged instead). */
  postSlack: ((text: string) => Promise<void>) | null;
  /** Base URL of the evals UI, for the run link. */
  publicUrl?: string;
  log?: (msg: string) => void;
}

export function isScheduledPreset(preset: string | null | undefined): preset is string {
  return preset != null && SCHEDULED_PRESET_IDS.includes(preset);
}

/** Slack incoming-webhook poster, or null when the URL is unset. */
export function slackWebhookPoster(
  webhookUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): ((text: string) => Promise<void>) | null {
  if (!webhookUrl) return null;
  return async (text) => {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Slack webhook answered ${res.status}`);
  };
}

function runUrl(publicUrl: string | undefined, runId: string): string {
  const base = (publicUrl || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  return `${base}/#/runs/${runId}`;
}

function toRegressionAttempt(a: AttemptWithModel, registry: Registry): RegressionAttempt {
  const billing = configBilling(registry.configs.get(a.configId) ?? { provider: "pi" });
  return {
    runId: a.runId,
    scenarioId: a.scenarioId,
    configId: a.configId,
    status: a.status,
    exclusion: a.exclusion ?? null,
    score: a.score,
    scenarioVersion: a.scenarioVersion ?? null,
    resolvedModel: a.resolvedModel,
    meteredUsd: attemptMeteredUsd(a, billing, e2bUsdPerSandboxHour()),
    notionalUsd: a.costUsd ?? 0,
    error: a.error,
  };
}

export interface RunRegression {
  report: RegressionReport;
  rerunRuns: EvalRunRow[];
  /** Every rerun has finished. False while none exists yet or one is still running. */
  settled: boolean;
}

/**
 * The regression report of a finished scheduled run, computed from the database as it
 * is now. `settled: false` with cells to rerun is the state the hook acts on.
 */
export async function buildRunRegression(
  deps: Pick<RunCompletionDeps, "db" | "registry">,
  run: EvalRunRow,
  opts: { forceSettled?: boolean } = {},
): Promise<RunRegression> {
  const { db, registry } = deps;
  const baselineRunIds = run.preset
    ? await listBaselineRunIds(db, {
        preset: run.preset,
        beforeCreatedAt: run.createdAt,
        limit: BASELINE_RUNS,
      })
    : [];
  const rerunRuns = await listRerunRuns(db, run.id);
  const [current, baseline, reruns] = await Promise.all([
    listAttemptsForRuns(db, [run.id]),
    listAttemptsForRuns(db, baselineRunIds),
    listAttemptsForRuns(
      db,
      rerunRuns.map((r) => r.id),
    ),
  ]);
  const settled =
    opts.forceSettled === true ||
    (rerunRuns.length > 0 && rerunRuns.every((r) => TERMINAL.has(r.status)));
  const report = evaluateRegression({
    current: current.map((a) => toRegressionAttempt(a, registry)),
    baseline: baseline.map((a) => toRegressionAttempt(a, registry)),
    reruns: reruns.map((a) => toRegressionAttempt(a, registry)),
    rerunsSettled: settled,
  });
  return { report, rerunRuns, settled };
}

function summaryRun(run: EvalRunRow, publicUrl: string | undefined): SummaryRun {
  return {
    id: run.id,
    name: run.name,
    preset: run.preset ?? "",
    status: run.status,
    maxMeteredUsd: run.maxMeteredUsd ?? null,
    url: runUrl(publicUrl, run.id),
  };
}

/** Scenario order for the summary table: the suite manifest's. */
export function summaryScenarioOrder(): string[] {
  return Object.keys(SUITE_SCENARIO_VERSIONS);
}

/** The Slack text for a scheduled run in its current state, and whether it is final. */
export async function buildRunSummaryText(
  deps: Pick<RunCompletionDeps, "db" | "registry" | "publicUrl">,
  run: EvalRunRow,
  opts: { forceSettled?: boolean } = {},
): Promise<{ text: string; final: boolean; report: RegressionReport | null }> {
  const meta = summaryRun(run, deps.publicUrl);
  if (run.status !== "done") {
    const attempts = await listAttempts(deps.db, run.id);
    const text = formatRunFailureSummary(meta, {
      attempts: attempts.length,
      passed: attempts.filter((a) => a.status === "passed").length,
      errors: attempts.filter((a) => a.status === "error" && a.exclusion !== "cancelled").length,
      cancelled: attempts.filter((a) => a.exclusion === "cancelled").length,
    });
    return { text, final: TERMINAL.has(run.status), report: null };
  }
  const { report } = await buildRunRegression(deps, run, opts);
  return {
    text: formatRunSummary(meta, report, summaryScenarioOrder()),
    final: report.final,
    report,
  };
}

async function startReruns(
  deps: RunCompletionDeps,
  parent: EvalRunRow,
  pending: RerunRequest[],
): Promise<string> {
  // One run for every flagged cell: its scenarios x configs. A pair nobody flagged gets
  // reruns too; flags are rare, and one run keeps the concurrent-run cap intact.
  const scenarioIds = [...new Set(pending.flatMap((p) => p.scenarioIds))];
  const configIds = pending.map((p) => p.configId);
  await assertRunConfigsResolve(deps.registry, scenarioIds, configIds);
  const runId = newRunId();
  await createRun(deps.db, {
    id: runId,
    name: `${parent.name ?? parent.id} rerun`,
    scenarioIds,
    configIds,
    attemptsPerCell: RERUN_ATTEMPTS,
    concurrency: parent.concurrency,
    judgeModel: parent.judgeModel ?? undefined,
    efforts: parent.efforts ?? {},
    maxMeteredUsd: RERUN_MAX_METERED_USD,
    rerunOf: parent.id,
  });
  try {
    await ensureRunConfigPins(deps.db, runId, deps.registry, scenarioIds, configIds);
    deps.startRun(runId);
  } catch (err) {
    // Never leave a pending run behind: it would read as a rerun still to come.
    await setRunStatus(deps.db, runId, "failed");
    throw err;
  }
  return runId;
}

async function post(deps: RunCompletionDeps, parent: EvalRunRow, text: string): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  if (!deps.postSlack) {
    // Not claimed: the run stays "unposted" so the scheduled-run workflow can post it.
    log(`[${parent.id}] EVALS_SLACK_WEBHOOK_URL is unset; summary not posted:\n${text}`);
    return;
  }
  // Claim first: two hooks racing (a resume, a slow rerun) must not double-post.
  if (!(await markSummaryPosted(deps.db, parent.id))) return;
  try {
    await deps.postSlack(text);
    log(`[${parent.id}] posted the Slack summary`);
  } catch (err) {
    // Roll the claim back so a later completion (or the workflow's fallback) can post it.
    await deps.db.execute({
      sql: "UPDATE eval_runs SET summary_posted_at = NULL WHERE id = ?",
      args: [parent.id],
    });
    throw err;
  }
}

export async function onRunFinished(deps: RunCompletionDeps, runId: string): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const run = await getRun(deps.db, runId);
  if (!run) return;
  const parent = run.rerunOf ? await getRun(deps.db, run.rerunOf) : run;
  if (!parent || !isScheduledPreset(parent.preset) || parent.summaryPostedAt) return;
  if (!TERMINAL.has(parent.status)) return;

  if (parent.status !== "done") {
    const { text } = await buildRunSummaryText(deps, parent);
    await post(deps, parent, text);
    return;
  }

  const { report, rerunRuns, settled } = await buildRunRegression(deps, parent);
  const meta = summaryRun(parent, deps.publicUrl);
  if (!settled && report.pendingReruns.length > 0) {
    if (rerunRuns.length > 0) return; // a rerun is still executing; its completion comes back here
    try {
      const rerunId = await startReruns(deps, parent, report.pendingReruns);
      log(
        `[${parent.id}] ${report.pendingReruns.length} config(s) flagged; rerun ${rerunId} started, summary waits for it`,
      );
      return;
    } catch (err) {
      log(
        `[${parent.id}] could not start the rerun (${err instanceof Error ? err.message : String(err)}); posting the flags unconfirmed`,
      );
    }
    const unconfirmed = await buildRunRegression(deps, parent, { forceSettled: true });
    await post(deps, parent, formatRunSummary(meta, unconfirmed.report, summaryScenarioOrder()));
    return;
  }
  await post(deps, parent, formatRunSummary(meta, report, summaryScenarioOrder()));
}
