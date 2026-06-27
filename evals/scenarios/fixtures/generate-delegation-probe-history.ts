/**
 * Fixture generator for the `delegation-probe` scenario (Plan A §Phase 2).
 *
 * Emits `delegation-probe-history.sql`: an INSERT-only seed of 20 terminal
 * `agent_tasks` rows — the reference audit history, and nothing else. NO schema,
 * NO `_migrations`: the schema is built PRE-BOOT from the REAL migrations in the
 * API image (see bootStack in src/swarm/sandbox.ts), so this fixture is just the
 * answer-key rows. The LEAD under test must DELEGATE the audit to two researcher
 * workers (it is forbidden from querying the tasks API itself), and the workers
 * query this seeded history through the swarm API. The merged answer key lives
 * ONLY in these rows (never in any prompt):
 *
 *   completed count                  = 11
 *   failed count                     = 5
 *   cancelled count                  = 4
 *   highest-priority completed title = "Provision the analytics warehouse cluster"
 *
 * Distinct from `sql-audit-history.sql` on purpose: different titles, counts,
 * and top-priority row, so a config can't smuggle the sql-audit answer key in.
 * There is intentionally NO failed-but-claims-success anomaly here — the
 * delegation rubric grades whether the lead delegated + merged, not anomaly
 * hunting; the four merged facts above are enough to grade a real merge.
 *
 * Deterministic: no randomness, so the committed fixture is reproducible. Re-run
 * with `bun scenarios/fixtures/generate-delegation-probe-history.ts` after any
 * change to the dataset, then update the answer-key constants in
 * `scenarios/delegation-probe.ts` to match the values printed at the end.
 *
 * IMPORTANT (fixture rules, see fixtures/README.md): reference data only — every
 * row is TERMINAL (`completed`/`failed`/`cancelled`), never `pending`/`running`,
 * so the booting worker never claims a seeded row. No `agents`/sessions/locks
 * rows are added (workers self-register at boot).
 */

import { validateSqlDumpText } from "../../src/runner/index.ts";

const OUT = new URL("./delegation-probe-history.sql", import.meta.url);

/** One seeded audit task. `output` carries an HONEST result (no status/output contradiction here). */
interface AuditTask {
  id: string;
  /** Multi-line task text: line 1 is the title the merged answer key references. */
  task: string;
  status: "completed" | "failed" | "cancelled";
  priority: number;
  output: string | null;
  createdAt: string;
  finishedAt: string;
}

/** Deterministic UUID-ish id from an ordinal (stable across regen; distinct prefix from sql-audit). */
function id(n: number): string {
  const h = n.toString(16).padStart(12, "0");
  return `de1e9a7e-d000-4000-b000-${h}`;
}

function ts(dayOffset: number, hour: number): string {
  const d = new Date(Date.UTC(2026, 3, 1 + dayOffset, hour, 0, 0)); // April 2026
  return d.toISOString();
}

/**
 * The audit dataset. Hand-authored (not random) so the answer key is fixed and
 * reviewable. 20 terminal rows: 11 completed, 5 failed, 4 cancelled. The four
 * merged answers (per-status counts + the highest-priority completed title) are
 * NOT stated anywhere in any prompt — they require querying the seeded rows.
 */
const TASKS: AuditTask[] = [
  // ---- completed tasks (11) ----
  {
    id: id(1),
    task: "Provision the analytics warehouse cluster\n\nStand up the new Snowflake-equivalent warehouse for analytics.",
    status: "completed",
    // Highest-priority COMPLETED row → the top-priority-completed answer.
    priority: 94,
    output: "Warehouse cluster provisioned across 3 AZs; first queries returning under 2s.",
    createdAt: ts(0, 9),
    finishedAt: ts(0, 12),
  },
  {
    id: id(2),
    task: "Roll the JWT signing keys\n\nRotate the auth service signing keys and redeploy.",
    status: "completed",
    priority: 81,
    output: "Signing keys rotated; old keys retired after the grace window.",
    createdAt: ts(1, 8),
    finishedAt: ts(1, 10),
  },
  {
    id: id(3),
    task: "Backfill the orders fact table for March\n\nReprocess March orders into the warehouse fact table.",
    status: "completed",
    priority: 52,
    output: "Backfill complete: 28.7M rows loaded, row counts reconciled.",
    createdAt: ts(2, 7),
    finishedAt: ts(2, 14),
  },
  {
    id: id(4),
    task: "Retune the recommendation embeddings\n\nRetrain and ship the new item-embedding model.",
    status: "completed",
    priority: 66,
    output: "Embeddings retrained; offline recall@20 up from 0.62 to 0.69.",
    createdAt: ts(3, 9),
    finishedAt: ts(3, 13),
  },
  {
    id: id(5),
    task: "Migrate notifications to the v4 push gateway\n\nCut over the push pipeline from v3 to v4.",
    status: "completed",
    priority: 73,
    output: "Cutover done; all 22 push subscribers acknowledged on v4.",
    createdAt: ts(4, 8),
    finishedAt: ts(4, 11),
  },
  {
    id: id(6),
    task: "Tier cold object storage to archive\n\nMove objects untouched for 200+ days to the archive tier.",
    status: "completed",
    priority: 28,
    output: "Tiered 18 buckets (5.1 TB) to the archive class.",
    createdAt: ts(5, 10),
    finishedAt: ts(5, 15),
  },
  {
    id: id(7),
    task: "Patch CVE-2026-2310 in the runtime base\n\nRebuild and republish the runtime base image.",
    status: "completed",
    priority: 88,
    output: "Runtime base rebuilt and republished; vulnerability scan clean.",
    createdAt: ts(6, 6),
    finishedAt: ts(6, 8),
  },
  {
    id: id(8),
    task: "Enforce mTLS across the data mesh\n\nRoll out mutual TLS for the internal data services.",
    status: "completed",
    priority: 79,
    output: "mTLS enforced across the data mesh; no plaintext links remain.",
    createdAt: ts(7, 7),
    finishedAt: ts(7, 12),
  },
  {
    id: id(9),
    task: "Reindex the merchant directory\n\nFull reindex of the merchant directory into the new cluster.",
    status: "completed",
    priority: 49,
    output: "Reindex complete: 1.4M documents, 0 rejected.",
    createdAt: ts(8, 8),
    finishedAt: ts(8, 11),
  },
  {
    id: id(10),
    task: "Add idempotency to the refunds API\n\nGuard the refund-create endpoint against double submits.",
    status: "completed",
    // Second-highest completed priority (89) — a decoy so the top answer (94)
    // requires actually comparing priorities, not picking the first high number.
    priority: 89,
    output: "Idempotency keys live; duplicate-refund rate dropped to 0.",
    createdAt: ts(9, 8),
    finishedAt: ts(9, 13),
  },
  {
    id: id(11),
    task: "Document the multi-region failover runbook\n\nWrite the cross-region failover runbook.",
    status: "completed",
    priority: 41,
    output: "Runbook published; reviewed by two on-call leads.",
    createdAt: ts(10, 8),
    finishedAt: ts(10, 10),
  },

  // ---- failed tasks (5) — every output HONESTLY reflects the failure ----
  {
    id: id(12),
    task: "Upgrade the message broker to 4.1\n\nRolling upgrade of the broker fleet.",
    status: "failed",
    priority: 63,
    output: "Aborted: node 2 failed to rejoin the quorum; rolled back to 4.0.",
    createdAt: ts(11, 8),
    finishedAt: ts(11, 11),
  },
  {
    id: id(13),
    task: "Run the data-retention purge\n\nProcess the pending record-retention deletions.",
    status: "failed",
    priority: 84,
    output: "Failed: purge job hit a foreign-key violation on audit_log; no records removed.",
    createdAt: ts(12, 7),
    finishedAt: ts(12, 8),
  },
  {
    id: id(14),
    task: "Move sessions to the clustered cache\n\nRelocate session storage to the clustered cache.",
    status: "failed",
    priority: 71,
    output: null,
    createdAt: ts(13, 9),
    finishedAt: ts(13, 10),
  },
  {
    id: id(15),
    task: "Enable autoscaling on the ingest tier\n\nConfigure horizontal autoscaling for the ingest service.",
    status: "failed",
    priority: 47,
    output: "Failed: the metrics source was unavailable; autoscaler could not read targets.",
    createdAt: ts(14, 8),
    finishedAt: ts(14, 9),
  },
  {
    id: id(16),
    task: "Cut over DNS to the new edge provider\n\nRepoint apex records at the new edge network.",
    status: "failed",
    priority: 58,
    output: "Failed: propagation stalled on two resolvers; cutover reverted.",
    createdAt: ts(15, 8),
    finishedAt: ts(15, 10),
  },

  // ---- cancelled tasks (4) — red herrings for the count; never `completed` ----
  {
    id: id(17),
    task: "Trial the experimental edge filter\n\nProof-of-concept of the new edge request filter.",
    status: "cancelled",
    priority: 22,
    output: "Cancelled before start; deprioritized for the quarter.",
    createdAt: ts(16, 9),
    finishedAt: ts(16, 9),
  },
  {
    id: id(18),
    task: "Evaluate the third-party risk vendor\n\nSpike on the candidate risk-scoring API.",
    status: "cancelled",
    priority: 38,
    output: "Cancelled; procurement review pending.",
    createdAt: ts(17, 10),
    finishedAt: ts(17, 10),
  },
  {
    id: id(19),
    task: "Prototype the unified query gateway\n\nStand up a throwaway unified query facade.",
    status: "cancelled",
    priority: 31,
    output: "Cancelled in favor of the existing aggregation layer.",
    createdAt: ts(18, 8),
    finishedAt: ts(18, 8),
  },
  {
    id: id(20),
    task: "Pilot canary deploys for the web tier\n\nTrial a canary rollout strategy for the web frontend.",
    status: "cancelled",
    priority: 54,
    output: "Cancelled; staged rolling deploys deemed sufficient.",
    createdAt: ts(19, 9),
    finishedAt: ts(19, 9),
  },
];

/** SQL string literal (single-quote escaped). */
function lit(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Explicit-column INSERT — only the columns the audit needs; SQLite fills the
 * rest from the table defaults/NULL. `source='api'` makes the rows look like
 * ordinary historical API-created tasks. Real newlines in the task text survive
 * inside the single-quoted literal so the multi-line title is preserved.
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
// history, so the per-status counts reflect exactly the seeded delegation-probe
// rows.
const out = [
  "-- ==== delegation-probe seed (Plan A §Phase 2) — generated by generate-delegation-probe-history.ts ====",
  "-- INSERT-only reference history; every row is terminal (completed/failed/cancelled).",
  "-- DO NOT hand-edit: re-run `bun scenarios/fixtures/generate-delegation-probe-history.ts`.",
  ...TASKS.map(insert),
  "-- ==== end delegation-probe seed ====",
  "",
].join("\n");

const invalid = validateSqlDumpText(out);
if (invalid) throw new Error(`generated fixture is invalid: ${invalid}`);

await Bun.write(OUT, out);

// ---- print the answer key (used to set the check patterns in delegation-probe.ts) ----
const completed = TASKS.filter((t) => t.status === "completed");
const failed = TASKS.filter((t) => t.status === "failed");
const cancelled = TASKS.filter((t) => t.status === "cancelled");
const top = completed.reduce((a, b) => (b.priority > a.priority ? b : a));
const topTitle = top.task.split("\n")[0];

console.log(`wrote ${Bun.fileURLToPath(OUT)} (${TASKS.length} audit tasks)`);
console.log("---- ANSWER KEY (mirror into scenarios/delegation-probe.ts) ----");
console.log(`completed count: ${completed.length}`);
console.log(`failed count: ${failed.length}`);
console.log(`cancelled count: ${cancelled.length}`);
console.log(`highest-priority completed title: "${topTitle}" (priority ${top.priority})`);
