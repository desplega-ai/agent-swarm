/**
 * Starts a scheduled eval run on the deployed evals service and waits for it (Phase 9).
 * The `evals-nightly` workflow runs this; run it by hand the same way:
 *
 *   EVALS_API_KEY=... bun apps/evals/scripts/run-scheduled.ts --tier canary
 *
 * The service does the work: it runs the preset, the regression check and the reruns,
 * and posts the one Slack summary. This script only starts the run, polls
 * `GET /api/runs/:id/regression` until the report is final, and reports back:
 *
 *   - exit 0 when the run finished `done` (a page is Slack's job, not a red workflow);
 *   - exit 1 when the run could not start, ended failed/cancelled, or timed out;
 *   - if the service has no Slack webhook (or never posted), it posts the summary itself
 *     with EVALS_SLACK_WEBHOOK_URL, so the message goes out exactly once either way;
 *   - when the run never started or timed out, the service has nothing to say, so it posts
 *     a short failure notice with the same webhook.
 *
 * Env: EVALS_API_KEY (required), EVALS_API_URL (default https://evals.agent-swarm.dev),
 * EVALS_SLACK_WEBHOOK_URL (optional), GITHUB_STEP_SUMMARY (set by Actions).
 */

import { appendFileSync } from "node:fs";

export type Tier = "canary" | "weekly";

interface TierPlan {
  preset: string;
  label: string;
  concurrency: number;
  /** Longest wait for the run and its reruns. */
  maxWaitMs: number;
}

export const TIERS: Record<Tier, TierPlan> = {
  // ~1 h of agent time at concurrency 3, plus reruns.
  canary: {
    preset: "nightly-canary",
    label: "Nightly canary",
    concurrency: 3,
    maxWaitMs: 3 * 3_600_000,
  },
  // ~3 h at concurrency 6; the job limit is 6 h.
  weekly: {
    preset: "weekly-matrix",
    label: "Weekly matrix",
    concurrency: 6,
    maxWaitMs: 5.5 * 3_600_000,
  },
};

export const DEFAULT_API_URL = "https://evals.agent-swarm.dev";
const POLL_MS = 60_000;
/** After the report is final, how long the service gets to post before this script does. */
const POST_GRACE_MS = 5 * 60_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

interface RegressionResponse {
  runId: string;
  status: string;
  final: boolean;
  summaryPostedAt: string | null;
  text: string | null;
}

export interface ScheduledRunDeps {
  tier: Tier;
  env: Record<string, string | undefined>;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Appends markdown to the Actions job summary. */
  appendSummary?: (markdown: string) => void;
  pollMs?: number;
  postGraceMs?: number;
}

export type Outcome = "done" | "run-not-done" | "start-failed" | "timed-out" | "lost-contact";

export interface ScheduledRunResult {
  exitCode: 0 | 1;
  runId: string | null;
  outcome: Outcome;
  /** Who posted the Slack message, if anyone did. */
  slack: "service" | "workflow" | "failure-notice" | null;
}

export async function runScheduled(deps: ScheduledRunDeps): Promise<ScheduledRunResult> {
  const plan = TIERS[deps.tier];
  const env = deps.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const pollMs = deps.pollMs ?? POLL_MS;
  const graceMs = deps.postGraceMs ?? POST_GRACE_MS;
  const apiKey = env.EVALS_API_KEY;
  if (!apiKey) throw new Error("EVALS_API_KEY is not set");
  const baseUrl = (env.EVALS_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const webhook = env.EVALS_SLACK_WEBHOOK_URL || null;
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  const postSlack = async (text: string): Promise<boolean> => {
    if (!webhook) return false;
    try {
      const res = await fetchImpl(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Slack webhook answered ${res.status}`);
      return true;
    } catch (err) {
      log(`could not post to Slack: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  const fail = async (
    outcome: Outcome,
    runId: string | null,
    reason: string,
  ): Promise<ScheduledRunResult> => {
    log(reason);
    deps.appendSummary?.(`### ${plan.label}: ${reason}\n`);
    const posted = await postSlack(
      `:x: *${plan.label}: ${reason}*${runId ? ` (${baseUrl}/#/runs/${runId})` : ""}`,
    );
    return { exitCode: 1, runId, outcome, slack: posted ? "failure-notice" : null };
  };

  // 1. Start the run.
  const startedAt = now();
  const name = `${plan.label} ${new Date(startedAt).toISOString().slice(0, 10)}`;
  let runId: string | null = null;
  let startError = "no attempt made";
  for (let attempt = 1; attempt <= 3 && runId === null; attempt++) {
    try {
      const res = await fetchImpl(`${baseUrl}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          preset: plan.preset,
          name,
          concurrency: deps.concurrency ?? plan.concurrency,
        }),
      });
      if (res.status === 201) {
        runId = ((await res.json()) as { runId: string }).runId;
        break;
      }
      startError = `POST /api/runs answered ${res.status}: ${(await res.text()).slice(0, 300)}`;
      if (res.status < 500) break; // 4xx (429: a run is already active) will not change on retry
    } catch (err) {
      startError = `POST /api/runs failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (attempt < 3) await sleep(10_000);
  }
  if (runId === null) return fail("start-failed", null, `could not start the run (${startError})`);
  log(`started ${plan.preset} as ${runId}: ${baseUrl}/#/runs/${runId}`);

  // 2. Wait for the run, its reruns and the summary.
  let finalAt: number | null = null;
  let pollErrors = 0;
  while (now() - startedAt < plan.maxWaitMs) {
    await sleep(pollMs);
    let report: RegressionResponse;
    try {
      const res = await fetchImpl(`${baseUrl}/api/runs/${runId}/regression`, { headers });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      report = (await res.json()) as RegressionResponse;
      pollErrors = 0;
    } catch (err) {
      pollErrors++;
      log(
        `poll failed (${pollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        return fail(
          "lost-contact",
          runId,
          `lost contact with the evals service while run ${runId} was in flight`,
        );
      }
      continue;
    }
    if (!report.final) {
      finalAt = null;
      continue;
    }
    finalAt ??= now();
    const done = report.status === "done";
    let slack: ScheduledRunResult["slack"] = null;
    if (report.summaryPostedAt) {
      slack = "service";
    } else if (now() - finalAt >= graceMs) {
      // The service had its chance: it has no webhook, or its post failed.
      if (report.text && (await postSlack(report.text))) slack = "workflow";
      else
        log("no Slack summary went out: the service did not post and no webhook is available here");
    } else {
      continue; // give the service its grace period
    }
    if (report.text) deps.appendSummary?.(`${report.text}\n`);
    log(
      `run ${runId} ${report.status}; Slack summary ${slack ? `posted by the ${slack}` : "not posted"}`,
    );
    return { exitCode: done ? 0 : 1, runId, outcome: done ? "done" : "run-not-done", slack };
  }
  return fail(
    "timed-out",
    runId,
    `run ${runId} was not final after ${Math.round(plan.maxWaitMs / 3_600_000)} h`,
  );
}

function parseTier(value: string | undefined): Tier {
  if (value === "canary" || value === "weekly") return value;
  throw new Error(`--tier must be "canary" or "weekly", got "${value ?? ""}"`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  const concurrency = flag("concurrency");
  if (
    concurrency !== undefined &&
    !(Number.isInteger(Number(concurrency)) && Number(concurrency) >= 1)
  ) {
    throw new Error(`--concurrency must be a positive integer, got "${concurrency}"`);
  }
  const result = await runScheduled({
    tier: parseTier(flag("tier")),
    env: process.env,
    concurrency: concurrency ? Number(concurrency) : undefined,
    appendSummary: summaryFile ? (md) => appendFileSync(summaryFile, md) : undefined,
  });
  process.exit(result.exitCode);
}
