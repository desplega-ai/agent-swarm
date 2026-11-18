#!/usr/bin/env bun
/**
 * CI baseline for one workflow, from the GitHub API: compute cost, feedback time, runner
 * queueing and merge-queue flakes. Run it before and after a CI change and compare.
 *
 *   bun scripts/ci-baseline.ts                                # Merge Gate, last 7 days
 *   bun scripts/ci-baseline.ts --since 2026-11-10T00:00:00Z --until 2026-11-17T00:00:00Z
 *   bun scripts/ci-baseline.ts --workflow docker-and-deploy.yml --gate-job ""
 *   bun scripts/ci-baseline.ts --json baseline.json           # also write the numbers
 *
 * Read-only. Needs GITHUB_TOKEN, or a logged-in `gh`. One request per run for its jobs, so
 * a busy week of Merge Gate costs about 800 requests of the 5,000 per hour.
 *
 * Definitions:
 *   runner-min   sum of (completed - started) over the jobs that ran, latest attempt only
 *   verdict      run created -> the gate job completed, first attempts whose gate is green
 *   last job     the job that finished last before the gate job started
 *   queue wait   job created -> job started (runner allocation)
 *   flake        a failed merge-queue entry whose pull request later merged with no new push
 */

type Job = {
  name: string;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};
type Run = {
  id: number;
  event: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  head_branch: string | null;
  jobs: Job[];
};

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i] ?? "", Bun.argv[i + 1] ?? "");
const repo = args.get("--repo") ?? "desplega-ai/agent-swarm";
const workflow = args.get("--workflow") ?? "merge-gate.yml";
const gateJob = args.get("--gate-job") ?? "Merge Gate";
const until = new Date(args.get("--until") ?? Date.now());
const since = new Date(args.get("--since") ?? until.getTime() - 7 * 86_400_000);

const token = process.env.GITHUB_TOKEN ?? (await Bun.$`gh auth token`.quiet().text()).trim();
async function api<T>(path: string): Promise<T> {
  // GitHub answers an occasional 502 on the jobs endpoint; three tries ride it out.
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status < 500 || attempt === 3) throw new Error(`GET ${path}: ${response.status}`);
    await Bun.sleep(1000 * attempt);
  }
}

/** Runs created in [from, to). The API returns 1,000 results at most, so a full window splits. */
async function listRuns(from: Date, to: Date): Promise<Omit<Run, "jobs">[]> {
  const range = `${from.toISOString()}..${new Date(to.getTime() - 1000).toISOString()}`;
  const query = `actions/workflows/${workflow}/runs?per_page=100&created=${range}`;
  const first = await api<{ total_count: number; workflow_runs: Run[] }>(query);
  if (first.total_count > 1000) {
    const mid = new Date((from.getTime() + to.getTime()) / 2);
    return [...(await listRuns(from, mid)), ...(await listRuns(mid, to))];
  }
  const runs = [...first.workflow_runs];
  for (let page = 2; runs.length < first.total_count; page++) {
    const next = await api<{ workflow_runs: Run[] }>(`${query}&page=${page}`);
    if (next.workflow_runs.length === 0) break;
    runs.push(...next.workflow_runs);
  }
  return runs;
}

async function withJobs(runs: Omit<Run, "jobs">[]): Promise<Run[]> {
  const out: Run[] = [];
  let next = 0;
  const worker = async () => {
    while (next < runs.length) {
      const run = runs[next++];
      if (!run) break;
      const { jobs } = await api<{ jobs: Job[] }>(`actions/runs/${run.id}/jobs?per_page=100`);
      out.push({ ...run, jobs });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

const seconds = (from: string | null, to: string | null) =>
  from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : 0;
const ran = (job: Job) => job.conclusion !== "skipped" && job.started_at !== null;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function quantile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}
const minutes = (value: number) => (Number.isNaN(value) ? "-" : (value / 60).toFixed(1));
/** "Run Tests (3/8)" and "E2E Contract (shard 2/4)" count as one job each. */
const jobKey = (name: string) =>
  name
    .replace(/\((\d+)\/(\d+)\)/, "(N/$2)")
    .replace(/shard \d+\//, "shard N/")
    .replace(/Playwright \(\d+\)/, "Playwright (N)")
    .slice(0, 60);

const runs = (await withJobs(await listRuns(since, until))).filter((run) => run.conclusion);
const events = [...new Set(runs.map((run) => run.event))].sort();
const report: Record<string, unknown> = {
  repo,
  workflow,
  since: since.toISOString(),
  until: until.toISOString(),
  runs: runs.length,
};
console.log(`${workflow} in ${repo}, ${since.toISOString()} to ${until.toISOString()}\n`);

console.log("event | runs | green | red | cancelled | runner-min/run | jobs/run");
for (const event of events) {
  const of = runs.filter((run) => run.event === event);
  const count = (conclusion: string) => of.filter((run) => run.conclusion === conclusion).length;
  const runnerSeconds = sum(
    of.flatMap((run) =>
      run.jobs.filter(ran).map((job) => seconds(job.started_at, job.completed_at)),
    ),
  );
  const row = {
    runs: of.length,
    green: count("success"),
    red: count("failure"),
    cancelled: count("cancelled"),
    runnerMinPerRun: Number((runnerSeconds / 60 / of.length).toFixed(1)),
    jobsPerRun: Number((sum(of.map((run) => run.jobs.filter(ran).length)) / of.length).toFixed(1)),
  };
  report[event] = row;
  console.log(`${event} | ${Object.values(row).join(" | ")}`);
}

for (const event of events) {
  const of = runs.filter((run) => run.event === event);
  const byJob = new Map<string, number>();
  for (const job of of.flatMap((run) => run.jobs.filter(ran))) {
    byJob.set(
      jobKey(job.name),
      (byJob.get(jobKey(job.name)) ?? 0) + seconds(job.started_at, job.completed_at),
    );
  }
  const total = sum([...byJob.values()]);
  console.log(`\nRunner time by job, ${event} (runner-min per run, share):`);
  for (const [name, value] of [...byJob].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(
      `  ${(value / 60 / of.length).toFixed(1)}  ${((value / total) * 100).toFixed(1)}%  ${name}`,
    );
  }
}

if (gateJob) {
  console.log(`\nVerdict: run created to "${gateJob}" done (first attempts, green gate)`);
  for (const event of events) {
    const verdicts: number[] = [];
    const last = new Map<string, number>();
    for (const run of runs.filter((r) => r.event === event && r.run_attempt === 1)) {
      const gate = run.jobs.find((job) => job.name === gateJob);
      if (gate?.conclusion !== "success" || !gate.started_at) continue;
      verdicts.push(seconds(run.created_at, gate.completed_at));
      const before = run.jobs
        .filter(
          (job) =>
            job !== gate &&
            ran(job) &&
            job.completed_at &&
            job.completed_at <= (gate.started_at ?? ""),
        )
        .sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));
      const name = jobKey(before.at(-1)?.name ?? "none");
      last.set(name, (last.get(name) ?? 0) + 1);
    }
    const lastJobs = [...last]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, n]) => `${name} ${Math.round((n / verdicts.length) * 100)}%`);
    report[`${event}Verdict`] = {
      n: verdicts.length,
      p50Min: Number(minutes(quantile(verdicts, 0.5))),
      p90Min: Number(minutes(quantile(verdicts, 0.9))),
    };
    console.log(
      `  ${event}: p50 ${minutes(quantile(verdicts, 0.5))} min, p90 ${minutes(quantile(verdicts, 0.9))} min (n=${verdicts.length}); last job: ${lastJobs.join(", ")}`,
    );
  }
}

const waits = runs.flatMap((run) =>
  run.jobs.filter(ran).map((job) => seconds(job.created_at, job.started_at)),
);
const edges = runs
  .flatMap((run) => run.jobs.filter((job) => ran(job) && job.completed_at))
  .flatMap((job) => [
    [Date.parse(job.started_at ?? ""), 1] as const,
    [Date.parse(job.completed_at ?? ""), -1] as const,
  ])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let running = 0;
let peak = 0;
for (const [, delta] of edges) {
  running += delta;
  peak = Math.max(peak, running);
}
report.queue = {
  p50s: quantile(waits, 0.5),
  p90s: quantile(waits, 0.9),
  p99s: quantile(waits, 0.99),
  peakJobs: peak,
};
console.log(
  `\nJob queue wait: p50 ${quantile(waits, 0.5)} s, p90 ${quantile(waits, 0.9)} s, p99 ${quantile(waits, 0.99)} s; peak concurrent jobs of this workflow: ${peak}`,
);

// Merge-queue flakes. A queue ref is gh-readonly-queue/<base>/pr-<number>-<sha>.
const queueRuns = runs.filter((run) => run.event === "merge_group");
const prOf = (run: Run) => Number(/pr-(\d+)-/.exec(run.head_branch ?? "")?.[1] ?? 0);
const failedEntries = queueRuns.filter((run) => run.conclusion === "failure" && prOf(run) > 0);
let flakes = 0;
const delays: number[] = [];
const flakyJobs = new Map<string, number>();
for (const failed of failedEntries) {
  const green = queueRuns
    .filter(
      (run) =>
        prOf(run) === prOf(failed) &&
        run.conclusion === "success" &&
        run.created_at > failed.created_at,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (!green) continue;
  const { head } = await api<{ head: { ref: string } }>(`pulls/${prOf(failed)}`);
  const pushed = runs.some(
    (run) =>
      run.event === "pull_request" &&
      run.head_branch === head.ref &&
      run.created_at > failed.created_at &&
      run.created_at < green.created_at,
  );
  if (pushed) continue;
  flakes++;
  delays.push(seconds(failed.created_at, green.updated_at));
  for (const job of failed.jobs.filter((j) => j.conclusion === "failure" && j.name !== gateJob)) {
    flakyJobs.set(jobKey(job.name), (flakyJobs.get(jobKey(job.name)) ?? 0) + 1);
  }
}
if (queueRuns.length > 0) {
  report.mergeQueue = {
    entries: queueRuns.length,
    failed: failedEntries.length,
    flakes,
    medianDelayMin: Number(minutes(quantile(delays, 0.5))),
  };
  console.log(
    `\nMerge queue: ${queueRuns.length} entries, ${failedEntries.length} failed, ${flakes} of them went green with no new push (flakes); median ${minutes(quantile(delays, 0.5))} min from the failed entry to the green one`,
  );
  if (flakyJobs.size > 0) {
    console.log(
      `  failed jobs in those entries: ${[...flakyJobs]
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name} ${n}`)
        .join(", ")}`,
    );
  }
}

const jsonPath = args.get("--json");
if (jsonPath) await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
