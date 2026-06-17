/**
 * Fixture generator for the `sql-audit` scenario (v8.0 round-11).
 *
 * Emits `sql-audit-history.sql`: an INSERT-only seed of terminal `agent_tasks`
 * rows — the reference audit history, and nothing else. NO schema, NO
 * `_migrations`: the schema is built PRE-BOOT from the REAL migrations in the API
 * image (see bootStack in src/swarm/sandbox.ts), so this fixture is just the
 * answer-key rows. The worker under test audits that history through the swarm
 * API and answers three graded questions whose answer key lives ONLY in the
 * seeded rows (never in the task prompt):
 *
 *   Q1 (count):     how many tasks are `completed` (red-herring rows in other
 *                   statuses make a naive "count everything" wrong).
 *   Q2 (which):     the title (first line of `task`) of the single highest-
 *                   `priority` `completed` task.
 *   Q3 (anomaly):   the one task whose `output` asserts success while its
 *                   `status` is `failed` — discoverable only by cross-referencing
 *                   status against output, never from any single field.
 *
 * Deterministic: no randomness, so the committed fixture is reproducible. Re-run
 * with `bun scenarios/fixtures/generate-sql-audit-history.ts` after any change to
 * the dataset, then update the answer-key constants in `scenarios/sql-audit.ts`
 * to match the values printed at the end of this run.
 *
 * IMPORTANT (fixture rules, see fixtures/README.md): reference data only — these
 * rows are all TERMINAL (`completed`/`failed`/`cancelled`), never `pending`/
 * `running`, so the booting worker never claims a seeded row. No `agents`/
 * sessions/locks rows are added.
 */

import { validateSqlDumpText } from "../../src/runner/index.ts";

const OUT = new URL("./sql-audit-history.sql", import.meta.url);

/** One seeded audit task. `output` is intentionally separate from `status` so Q3 can encode a contradiction. */
interface AuditTask {
  id: string;
  /** Multi-line task text: line 1 is the title the audit questions reference. */
  task: string;
  status: "completed" | "failed" | "cancelled";
  priority: number;
  output: string | null;
  createdAt: string;
  finishedAt: string;
}

/** Deterministic UUID-ish id from an ordinal (stable across regen). */
function id(n: number): string {
  const h = n.toString(16).padStart(12, "0");
  return `aud17a48-c000-4000-a000-${h}`;
}

function ts(dayOffset: number, hour: number): string {
  const d = new Date(Date.UTC(2026, 4, 1 + dayOffset, hour, 0, 0)); // May 2026
  return d.toISOString();
}

/**
 * The audit dataset. Hand-authored (not random) so the answer key is fixed and
 * reviewable. Mix of categories + statuses + red herrings; the three answers are
 * NOT stated anywhere in the prompt and require querying + cross-referencing.
 */
const TASKS: AuditTask[] = [
  // ---- completed tasks (the Q1 count target) ----
  {
    id: id(1),
    task: "Provision staging Postgres replica\n\nStand up a read replica for the staging analytics workload.",
    status: "completed",
    priority: 40,
    output: "Replica provisioned in us-east-1; lag under 200ms.",
    createdAt: ts(0, 9),
    finishedAt: ts(0, 11),
  },
  {
    id: id(2),
    task: "Rotate the payments service API keys\n\nRotate and redeploy the payments gateway credentials.",
    status: "completed",
    // Highest-priority COMPLETED task → the Q2 answer.
    priority: 95,
    output: "All four payment keys rotated and redeployed; zero downtime.",
    createdAt: ts(1, 8),
    finishedAt: ts(1, 10),
  },
  {
    id: id(3),
    task: "Backfill user_events partition for April\n\nReprocess the April event stream into the partitioned table.",
    status: "completed",
    priority: 55,
    output: "Backfill complete: 41.2M rows reprocessed, checksum verified.",
    createdAt: ts(2, 7),
    finishedAt: ts(2, 13),
  },
  {
    id: id(4),
    task: "Tune the search relevance ranker\n\nApply the new BM25 weights and re-evaluate offline.",
    status: "completed",
    priority: 60,
    output: "Ranker updated; offline nDCG@10 improved from 0.71 to 0.78.",
    createdAt: ts(3, 9),
    finishedAt: ts(3, 12),
  },
  {
    id: id(5),
    task: "Migrate billing webhooks to the v3 endpoint\n\nCut over webhook subscribers from v2 to v3.",
    status: "completed",
    priority: 70,
    output: "Cutover done; all 18 subscribers acknowledged on v3.",
    createdAt: ts(4, 8),
    finishedAt: ts(4, 11),
  },
  {
    id: id(6),
    task: "Archive cold S3 buckets to Glacier\n\nMove buckets untouched for 180+ days to cold storage.",
    status: "completed",
    priority: 30,
    output: "Archived 12 buckets (3.4 TB) to Glacier Deep Archive.",
    createdAt: ts(5, 10),
    finishedAt: ts(5, 14),
  },
  {
    id: id(7),
    task: "Patch the CVE-2026-1188 in the image base\n\nRebuild and republish the base container image.",
    status: "completed",
    priority: 90,
    output: "Base image rebuilt and republished; vuln scan clean.",
    createdAt: ts(6, 6),
    finishedAt: ts(6, 8),
  },
  {
    id: id(8),
    task: "Generate the Q1 reliability report\n\nCompile the SLO attainment numbers for Q1.",
    status: "completed",
    priority: 45,
    output: "Report generated; 99.94% availability across tracked services.",
    createdAt: ts(7, 9),
    finishedAt: ts(7, 10),
  },
  {
    id: id(9),
    task: "Enable mTLS on the internal mesh\n\nRoll out mutual TLS across the service mesh.",
    status: "completed",
    priority: 80,
    output: "mTLS enforced mesh-wide; no plaintext connections remain.",
    createdAt: ts(8, 7),
    finishedAt: ts(8, 12),
  },
  {
    id: id(10),
    task: "Reindex the product catalog\n\nFull reindex of the catalog into the new ES cluster.",
    status: "completed",
    priority: 50,
    output: "Reindex complete: 2.1M documents, 0 rejected.",
    createdAt: ts(9, 8),
    finishedAt: ts(9, 11),
  },
  {
    id: id(11),
    task: "Decommission the legacy cron host\n\nRetire the old cron box after migrating its jobs.",
    status: "completed",
    priority: 35,
    output: "Host decommissioned; 23 jobs migrated to the scheduler.",
    createdAt: ts(10, 9),
    finishedAt: ts(10, 10),
  },
  {
    id: id(12),
    task: "Add idempotency keys to the order API\n\nGuard the order-create endpoint against double submits.",
    status: "completed",
    priority: 65,
    output: "Idempotency keys live; duplicate-order rate dropped to 0.",
    createdAt: ts(11, 8),
    finishedAt: ts(11, 13),
  },
  {
    id: id(13),
    task: "Compress historical metrics in TSDB\n\nApply downsampling to metrics older than 90 days.",
    status: "completed",
    priority: 25,
    output: "Downsampling applied; TSDB footprint cut by 38%.",
    createdAt: ts(12, 10),
    finishedAt: ts(12, 12),
  },
  {
    id: id(14),
    task: "Wire up the on-call escalation policy\n\nConfigure the new PagerDuty escalation chains.",
    status: "completed",
    priority: 75,
    output: "Escalation policy active; tested with a synthetic page.",
    createdAt: ts(13, 7),
    finishedAt: ts(13, 9),
  },

  // ---- the Q3 ANOMALY: status `failed` but `output` claims success ----
  {
    id: id(15),
    task: "Deploy the checkout redesign to production\n\nShip the new checkout flow behind the rollout flag.",
    // Anomaly: marked failed, yet output asserts a clean success. Only a
    // cross-reference of status vs output exposes the contradiction. NOT the
    // highest-priority row and NOT completed, so it cannot be confused with Q2.
    status: "failed",
    priority: 85,
    output:
      "Deploy succeeded: checkout redesign live for 100% of traffic, all health checks green.",
    createdAt: ts(14, 8),
    finishedAt: ts(14, 9),
  },

  // ---- genuine failures (failed AND output reflects failure — NOT the anomaly) ----
  {
    id: id(16),
    task: "Upgrade Kafka to 3.7\n\nRolling upgrade of the Kafka brokers.",
    status: "failed",
    priority: 60,
    output: "Aborted: broker 3 failed to rejoin the ISR; rolled back to 3.6.",
    createdAt: ts(15, 8),
    finishedAt: ts(15, 11),
  },
  {
    id: id(17),
    task: "Run the GDPR data-deletion sweep\n\nProcess the pending erasure requests.",
    status: "failed",
    priority: 88,
    output: "Failed: deletion job hit a foreign-key violation on audit_log; no records removed.",
    createdAt: ts(16, 7),
    finishedAt: ts(16, 8),
  },
  {
    id: id(18),
    task: "Migrate sessions to the new Redis cluster\n\nMove session storage to the clustered Redis.",
    status: "failed",
    priority: 72,
    output: null,
    createdAt: ts(17, 9),
    finishedAt: ts(17, 10),
  },
  {
    id: id(19),
    task: "Enable autoscaling on the ingest tier\n\nConfigure HPA for the ingest deployment.",
    status: "failed",
    priority: 50,
    output: "Failed: metrics-server unavailable, HPA could not read CPU targets.",
    createdAt: ts(18, 8),
    finishedAt: ts(18, 9),
  },

  // ---- cancelled tasks (red herrings for the count; never `completed`) ----
  {
    id: id(20),
    task: "Trial the experimental WASM filter\n\nProof-of-concept of the WASM request filter.",
    status: "cancelled",
    priority: 20,
    output: "Cancelled before start; deprioritized for the quarter.",
    createdAt: ts(19, 9),
    finishedAt: ts(19, 9),
  },
  {
    id: id(21),
    task: "Evaluate the third-party fraud vendor\n\nSpike on the candidate fraud-scoring API.",
    status: "cancelled",
    priority: 40,
    output: "Cancelled; legal review pending.",
    createdAt: ts(20, 10),
    finishedAt: ts(20, 10),
  },
  {
    id: id(22),
    task: "Prototype the GraphQL gateway\n\nStand up a throwaway GraphQL facade.",
    status: "cancelled",
    priority: 30,
    output: "Cancelled in favor of the existing REST aggregation layer.",
    createdAt: ts(21, 8),
    finishedAt: ts(21, 8),
  },
  {
    id: id(23),
    task: "Pilot blue-green for the API tier\n\nTrial a blue-green rollout strategy.",
    status: "cancelled",
    priority: 55,
    output: "Cancelled; rolling deploys deemed sufficient.",
    createdAt: ts(22, 9),
    finishedAt: ts(22, 9),
  },

  // ---- more completed tasks (so the count is non-trivial and spread out) ----
  {
    id: id(24),
    task: "Harden the SSH bastion configuration\n\nApply the CIS hardening baseline to the bastion.",
    status: "completed",
    priority: 78,
    output: "Bastion hardened; CIS Level 1 fully compliant.",
    createdAt: ts(23, 7),
    finishedAt: ts(23, 9),
  },
  {
    id: id(25),
    task: "Add p99 latency alerts for checkout\n\nWire alerting on the checkout latency SLO.",
    status: "completed",
    priority: 58,
    output: "Alerts deployed; firing threshold set at 800ms p99.",
    createdAt: ts(24, 8),
    finishedAt: ts(24, 9),
  },
  {
    id: id(26),
    task: "Consolidate the duplicate feature flags\n\nMerge the redundant flag definitions.",
    status: "completed",
    priority: 33,
    output: "Consolidated 14 flags down to 6; removed dead branches.",
    createdAt: ts(25, 9),
    finishedAt: ts(25, 11),
  },
  {
    id: id(27),
    task: "Document the incident runbook for region failover\n\nWrite the regional failover runbook.",
    status: "completed",
    priority: 48,
    output: "Runbook published; reviewed by two on-call leads.",
    createdAt: ts(26, 8),
    finishedAt: ts(26, 10),
  },

  // ---- a couple of close-but-not-equal priority completed rows, to make Q2
  //      require actually comparing priorities (95 still wins; 92 is a decoy).
  {
    id: id(28),
    task: "Failover the primary database to the standby\n\nExecute a planned primary→standby failover.",
    status: "completed",
    priority: 92,
    output: "Failover executed; new primary healthy, replication re-established.",
    createdAt: ts(27, 6),
    finishedAt: ts(27, 7),
  },
  {
    id: id(29),
    task: "Renew the wildcard TLS certificate\n\nReissue and deploy the *.example.com cert.",
    status: "completed",
    priority: 82,
    output: "Certificate renewed and deployed to all edge nodes.",
    createdAt: ts(28, 9),
    finishedAt: ts(28, 10),
  },
  {
    id: id(30),
    task: "Throttle the abusive scraper IPs\n\nApply rate limits to the flagged scraper ranges.",
    status: "completed",
    priority: 44,
    output: "Rate limits applied; scraper traffic down 96%.",
    createdAt: ts(29, 8),
    finishedAt: ts(29, 9),
  },
];

/** SQL string literal (single-quote escaped). */
function lit(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Explicit-column INSERT — only the columns the audit needs; SQLite fills the
 * rest from the table defaults/NULL. `source='api'` mirrors the flux row so the
 * rows look like ordinary historical API-created tasks. `\n` is written as a SQL
 * char so the multi-line title survives (the task text uses real newlines).
 */
function insert(t: AuditTask): string {
  const cols = "id, task, status, source, priority, createdAt, lastUpdatedAt, finishedAt, output";
  const vals = [
    lit(t.id),
    lit(t.task),
    lit(t.status),
    lit("api"),
    String(t.priority),
    lit(t.createdAt),
    lit(t.finishedAt),
    lit(t.finishedAt),
    lit(t.output),
  ].join(", ");
  return `INSERT INTO agent_tasks (${cols}) VALUES (${vals});`;
}

// ---- compose the fixture (INSERT-only) ----
// No base dump, no schema, no `_migrations` — just the audit rows. The schema is
// built pre-boot from the real migrations; these rows are the ONLY agent_tasks
// history, so the Q1 count reflects exactly the seeded audit rows.
const out = [
  "-- ==== sql-audit seed (v8.0 round-11) — generated by generate-sql-audit-history.ts ====",
  "-- INSERT-only reference history; every row is terminal (completed/failed/cancelled).",
  "-- DO NOT hand-edit: re-run `bun scenarios/fixtures/generate-sql-audit-history.ts`.",
  ...TASKS.map(insert),
  "-- ==== end sql-audit seed ====",
  "",
].join("\n");

const invalid = validateSqlDumpText(out);
if (invalid) throw new Error(`generated fixture is invalid: ${invalid}`);

await Bun.write(OUT, out);

// ---- print the answer key (used to set the check patterns in sql-audit.ts) ----
const completed = TASKS.filter((t) => t.status === "completed");
const q1Count = completed.length;
const q2 = completed.reduce((a, b) => (b.priority > a.priority ? b : a));
const q2Title = q2.task.split("\n")[0];
const anomalies = TASKS.filter(
  (t) =>
    t.status === "failed" && t.output !== null && /succeed|success|live for 100%/i.test(t.output),
);

console.log(`wrote ${Bun.fileURLToPath(OUT)} (${TASKS.length} audit tasks)`);
console.log("---- ANSWER KEY (mirror into scenarios/sql-audit.ts) ----");
console.log(`Q1 completed count: ${q1Count}`);
console.log(`Q2 highest-priority completed title: "${q2Title}" (priority ${q2.priority})`);
console.log(
  `Q3 anomaly (failed-but-output-claims-success): ${anomalies.length} row(s):`,
  anomalies.map((a) => a.task.split("\n")[0]),
);
