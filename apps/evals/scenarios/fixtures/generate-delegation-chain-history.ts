/**
 * Fixture generator for the `delegation-chain` scenario.
 *
 * Emits `delegation-chain-history.sql`: an INSERT-only seed of 18 terminal
 * `agent_tasks` rows. It is delegation-chain's OWN dataset (it used to reuse
 * sql-audit's), so the two scenarios no longer share an answer key and a
 * contaminated sql-audit answer cannot score here. Same three questions, split
 * across the three chained hops:
 *
 *   phase-one:   how many tasks are `completed`.
 *   phase-two:   the title of the highest-`priority` `completed` task.
 *   phase-three: the one task whose `output` claims success while its `status`
 *                is `failed`.
 *
 * Size: 18 rows, so the seed plus the lead's task and its three children fits
 * one default 25-row `/api/tasks` page. Enforced by scenarios.test.ts.
 *
 * Deterministic. Re-run with
 * `bun scenarios/fixtures/generate-delegation-chain-history.ts`, then mirror the
 * printed answer key into `scenarios/delegation-chain.ts`.
 *
 * Fixture rules (fixtures/README.md): terminal rows only, no agents/sessions/locks.
 */

import { validateSqlDumpText } from "../../src/runner/index.ts";

const OUT = new URL("./delegation-chain-history.sql", import.meta.url);

interface ChainTask {
  task: string;
  status: "completed" | "failed" | "cancelled";
  priority: number;
  output: string | null;
}

/** Deterministic id from an ordinal (distinct prefix from the sql-audit seed). */
function id(n: number): string {
  return `dc4a1a00-c000-4000-a000-${n.toString(16).padStart(12, "0")}`;
}

function ts(dayOffset: number, hour: number): string {
  return new Date(Date.UTC(2026, 5, 1 + dayOffset, hour, 0, 0)).toISOString(); // June 2026
}

const TASKS: ChainTask[] = [
  // ---- completed (phase-one count target) ----
  {
    task: "Cut over the ledger service to the new region\n\nMove ledger writes to eu-west-2.",
    status: "completed",
    // Highest-priority COMPLETED task → phase-two answer.
    priority: 97,
    output: "Ledger cutover done; write latency p99 at 41ms in the new region.",
  },
  {
    task: "Expire stale OAuth refresh tokens\n\nRevoke refresh tokens idle for 90+ days.",
    status: "completed",
    // Decoy: close to 97 but lower.
    priority: 94,
    output: "Revoked 18,204 idle refresh tokens.",
  },
  {
    task: "Compact the audit-log table\n\nVacuum and reindex the audit log.",
    status: "completed",
    priority: 35,
    output: "Compaction complete; table size down 52%.",
  },
  {
    task: "Upgrade the CI runners to Ubuntu 26.04\n\nRebuild the runner images.",
    status: "completed",
    priority: 62,
    output: "All 40 runners rebuilt on 26.04; pipelines green.",
  },
  {
    task: "Add retries to the invoice mailer\n\nWrap SMTP sends in bounded retries.",
    status: "completed",
    priority: 48,
    output: "Retries live; bounce rate unchanged, transient failures recovered.",
  },
  {
    task: "Shard the notifications queue\n\nSplit the queue into eight partitions.",
    status: "completed",
    priority: 71,
    output: "Queue sharded 8 ways; consumer lag cleared.",
  },
  {
    task: "Publish the Q2 cost report\n\nSummarize cloud spend by team.",
    status: "completed",
    priority: 30,
    output: "Report published; spend down 7% quarter over quarter.",
  },
  {
    task: "Enforce MFA for admin console logins\n\nRequire WebAuthn for all admins.",
    status: "completed",
    priority: 89,
    output: "MFA enforced for 64 admin accounts.",
  },
  {
    task: "Migrate image thumbnails to AVIF\n\nRe-encode the thumbnail cache.",
    status: "completed",
    priority: 42,
    output: "Thumbnails re-encoded; bandwidth down 28%.",
  },
  {
    task: "Set up synthetic checks for signup\n\nProbe the signup flow every minute.",
    status: "completed",
    priority: 57,
    output: "Synthetic checks running from three regions.",
  },

  // ---- the phase-three ANOMALY: failed, but output claims success ----
  {
    task: "Roll out the new pricing engine to EU customers\n\nEnable the pricing engine for the EU cohort.",
    status: "failed",
    priority: 91,
    output: "Rollout succeeded: pricing engine serving 100% of EU traffic, error rate flat.",
  },

  // ---- genuine failures ----
  {
    task: "Rebalance the Cassandra ring\n\nMove tokens off the hot nodes.",
    status: "failed",
    priority: 66,
    output: "Aborted: streaming timed out on node 7; ring left unchanged.",
  },
  {
    task: "Rotate the SFTP host keys\n\nReissue host keys for the partner SFTP.",
    status: "failed",
    priority: 93,
    output: "Failed: two partners pinned the old fingerprint; rolled back.",
  },
  {
    task: "Turn on query caching for reports\n\nEnable the result cache on the reports API.",
    status: "failed",
    priority: 38,
    output: null,
  },

  // ---- cancelled ----
  {
    task: "Evaluate a second CDN vendor\n\nBenchmark the alternative CDN.",
    status: "cancelled",
    priority: 45,
    output: "Cancelled; contract renewed with the current vendor.",
  },
  {
    task: "Prototype voice search\n\nSpike on speech-to-text search input.",
    status: "cancelled",
    priority: 20,
    output: "Cancelled before start.",
  },
  {
    task: "Trial serverless batch jobs\n\nPort one nightly batch to functions.",
    status: "cancelled",
    priority: 52,
    output: "Cancelled; cold starts too slow for the batch window.",
  },
  {
    task: "Replace the feature-flag vendor\n\nMigrate flags to the in-house service.",
    status: "cancelled",
    priority: 60,
    output: "Cancelled; vendor price cut accepted.",
  },
];

function lit(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

function insert(t: ChainTask, i: number): string {
  const created = ts(i, 8);
  const finished = ts(i, 10);
  const cols = "id, task, status, source, priority, createdAt, lastUpdatedAt, finishedAt, output";
  const vals = [
    lit(id(i + 1)),
    lit(t.task),
    lit(t.status),
    lit("api"),
    String(t.priority),
    lit(created),
    lit(finished),
    lit(finished),
    lit(t.output),
  ].join(", ");
  return `INSERT INTO agent_tasks (${cols}) VALUES (${vals});`;
}

const out = [
  "-- ==== delegation-chain seed — generated by generate-delegation-chain-history.ts ====",
  "-- INSERT-only reference history; every row is terminal (completed/failed/cancelled).",
  "-- DO NOT hand-edit: re-run `bun scenarios/fixtures/generate-delegation-chain-history.ts`.",
  ...TASKS.map(insert),
  "-- ==== end delegation-chain seed ====",
  "",
].join("\n");

const invalid = validateSqlDumpText(out);
if (invalid) throw new Error(`generated fixture is invalid: ${invalid}`);

await Bun.write(OUT, out);

const completed = TASKS.filter((t) => t.status === "completed");
const top = completed.reduce((a, b) => (b.priority > a.priority ? b : a));
const anomalies = TASKS.filter(
  (t) => t.status === "failed" && t.output !== null && /succeed|success/i.test(t.output),
);
console.log(`wrote ${Bun.fileURLToPath(OUT)} (${TASKS.length} tasks)`);
console.log("---- ANSWER KEY (mirror into scenarios/delegation-chain.ts) ----");
console.log(`phase-one completed count: ${completed.length}`);
console.log(`phase-two top completed: "${top.task.split("\n")[0]}" (priority ${top.priority})`);
console.log(`phase-three anomaly: ${anomalies.map((a) => a.task.split("\n")[0]).join(" | ")}`);
