import { fileContainsOnWorker } from "../src/judge/deterministic.ts";
import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

/**
 * distributed-audit (v8.0 round-11, Data + Multi-worker, lead + 2 workers)
 * -----------------------------------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.6-sol vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.25 → 0.75.
 *
 * The same audit history as `sql-audit` (the `sql-audit-history.sql` dump: 30
 * terminal `agent_tasks` rows across completed/failed/cancelled with red herrings
 * and one status/output-contradiction anomaly) is seeded into the API DB, but the
 * investigation is SHARDED across two workers and MERGED by a lead into one
 * report — a distributed-audit pattern rather than a single-worker audit:
 *   - Worker 0 (shard A) audits ONLY the `completed` tasks: counts them and finds
 *     the highest-`priority` completed task. Publishes its shard findings into
 *     swarm memory under a channel tag.
 *   - Worker 1 (shard B) audits ONLY the non-`completed` tasks (failed +
 *     cancelled): counts each status and finds the one ANOMALY — a `failed` task
 *     whose `output` claims success. Publishes its shard findings into memory.
 *   - The LEAD (member index 2, dependsOn both shards) retrieves BOTH shard
 *     findings from memory and MERGES them into one audit report on its own
 *     sandbox, stating every shard's numbers + the merged grand total + the
 *     anomaly, justified from the shard data.
 *
 * Reuses the `seed.sqlDump` + `apiGet`/`fileContains` machinery from the old
 * `sql-seeded-history` scenario (now embodied by `sql-audit`'s shared fixture +
 * the generate-sql-audit-history.ts generator), and the lead + WorkerSpec[] +
 * multi-task-chain machinery from the old `roster-demo` scenario (lead boot/
 * routing, `worker: "lead"` agentId-less task creation), generalized to a sharded
 * investigation with a lead merge. The two workers + the lead never share a disk;
 * the shard handoff is through swarm memory only.
 *
 * Requires an embedding key in evals/.env (EMBEDDING_API_KEY or OPENAI_API_KEY)
 * for the swarm memory store/search the shard→lead handoff relies on.
 *
 * Grading:
 *   - `completeness` (weight 2): a graded SHARD-COVERAGE check — the merged report
 *       must cover BOTH shards (the completed-tasks section AND the failures/
 *       cancellations section), proving the lead actually merged both
 *       investigations rather than dropping a shard. Partial credit (fraction of
 *       shards covered) so a report that surfaced only one shard ranks below a
 *       fully-merged one.
 *   - `correctness` (weight 3): the merged ANSWER KEY graded over the lead's report
 *       — the completed count (21), the failed count (5), the cancelled count (4),
 *       the highest-priority completed task ("Rotate the payments service API
 *       keys"), and the anomaly ("Deploy the checkout redesign to production").
 *       Each fact is checked independently against the lead's merged report
 *       (partial credit), and NONE of the answer-key values appear in any prompt.
 *   - `communication` (weight 1): an agentic judge grades the merged report's
 *       clarity and whether it ATTRIBUTES each number to a shard and justifies it
 *       from the shard data — not on whether the numbers are correct (a separate
 *       check grades that). The judge reads the lead's report on worker 2 (v8.0 §4
 *       full-roster tools) and uses the head+tail transcript so the final merged
 *       report text reaches it (v8.0 §4 — `distributed-audit` is a named dependency
 *       of that transcript fix).
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - Each shard's answer is NOT in any prompt: the prompts state WHICH slice of
 *     the history to audit (its statuses) but never the counts, the top-priority
 *     title, or the anomaly. The answer key lives ONLY in the seeded DB rows; the
 *     worker must query the API to obtain it. Echoing the prompt or guessing scores
 *     0 on the per-fact correctness checks.
 *   - The anomaly is NOT derivable from any single field or from the prompt — only
 *     a cross-reference of `status` (`failed`) against `output` (claims success)
 *     surfaces it; it is shard B's responsibility, so a worker that only counts
 *     statuses misses it.
 *   - Red-herring rows (genuine failures whose output reflects failure, near-miss
 *     priorities 92/88/85) make both the counts and the "which"/"anomaly" answers
 *     non-trivial — a naive "count everything" or "pick the named deploy" scores 0.
 *   - Each per-fact count is PROXIMITY-ANCHORED to its status word (the digit must
 *     sit within a short window of "completed"/"failed"/"cancelled" on the same
 *     line), so a report that merely contains a stray lone 5 or 4 in unrelated
 *     prose does NOT score the count for free — only a count stated against its
 *     status matches.
 *   - The completeness shard-coverage check requires BOTH shard sections in the
 *     merged report, so a lead can't "win" by parroting one worker's findings; it
 *     must merge both. The merged report is graded against a HIDDEN key.
 *   - The grading rubric / per-fact patterns / shard-coverage criteria are NOT
 *     shown to any worker or the lead.
 *
 * Answer key (mirror of `generate-sql-audit-history.ts` output — regenerate the
 * shared fixture and update sql-audit.ts AND this file if the dataset changes):
 *   completed count                     = 21
 *   failed count                        = 5
 *   cancelled count                     = 4
 *   highest-priority completed title    = "Rotate the payments service API keys"
 *   anomaly title                       = "Deploy the checkout redesign to production"
 */

// The lead is member index 2 (appended after the two workers, v7 §12.4) and
// writes the single merged report onto its OWN sandbox.
const LEAD_WORKER = 2;
const REPORT_FILE = "/workspace/audit/merged-report.md";

// Distinctive shared memory channel tags so the lead can find each worker's shard
// findings. The tags are part of the protocol the prompts describe; the SECRET is
// the audit answer key (in the seeded DB), never any tag.
const SHARD_A_TAG = "dist-audit-shard-completed-q3z";
const SHARD_B_TAG = "dist-audit-shard-failures-q3z";

/**
 * One merged answer-key fact graded against the lead's merged report. Each is a
 * distinctive regex over the report text; partial credit comes from the fraction
 * of facts present. The values come from the seeded DB only — none appears in any
 * prompt (anti-gaming).
 */
interface MergedFact {
  label: string;
  pattern: RegExp;
}

// The five merged answer-key facts. Each numeric count is PROXIMITY-ANCHORED to
// its status word on the same line (within a 40-char window either side) so a bare
// stray digit in unrelated prose can't satisfy it — mirroring the title/anomaly
// facts below, which anchor their value near a keyword. `\b…\b` additionally keeps
// a nearby wrong count ("221"/"210") from matching. The titles match the
// distinctive words of each task, tolerant of casing/punctuation.
const MERGED_FACTS: MergedFact[] = [
  {
    label: "completed-count=21",
    pattern: /completed[^\n]{0,40}\b21\b|\b21\b[^\n]{0,40}completed/i,
  },
  { label: "failed-count=5", pattern: /failed[^\n]{0,40}\b5\b|\b5\b[^\n]{0,40}failed/i },
  { label: "cancelled-count=4", pattern: /cancell?ed[^\n]{0,40}\b4\b|\b4\b[^\n]{0,40}cancell?ed/i },
  {
    label: "top-priority-completed=payments-key-rotation",
    pattern: /payments?[\s\S]{0,40}?(rotat|key)|(rotat|key)[\s\S]{0,40}?payments?/i,
  },
  {
    label: "anomaly=checkout-redesign-deploy",
    pattern: /checkout[\s\S]{0,40}?(redesign|deploy)|(redesign|deploy)[\s\S]{0,40}?checkout/i,
  },
];

// ---- correctness: the merged answer key graded over the LEAD's merged report
// (member index 2). Reads the report from the lead's sandbox and scores the
// fraction of the five facts present. A missing report scores 0. Anchored to the
// lead because IT owns the merge — a worker's own shard findings cover only part
// of the key, so only a real merge scores high. ----
const mergedCorrectness: DeterministicCheck = {
  name: "merged-answer-key",
  fn: async (ctx): Promise<CheckResult> => {
    const lead = ctx.workers[LEAD_WORKER];
    if (!lead) return { pass: false, score: 0, detail: `lead worker ${LEAD_WORKER} not booted` };
    const content = await lead.readFile(REPORT_FILE);
    if (content === null) return { pass: false, score: 0, detail: `${REPORT_FILE} not found` };
    const total = MERGED_FACTS.length;
    const missing = MERGED_FACTS.filter((f) => !f.pattern.test(content)).map((f) => f.label);
    const matched = total - missing.length;
    const score = matched / total;
    return {
      pass: matched === total,
      score,
      detail:
        matched === total
          ? `${matched}/${total} merged answer-key facts present`
          : `${matched}/${total} merged facts present (missing: ${missing.join(", ")})`,
    };
  },
};

// ---- completeness: the merged report must COVER both shards (shard A = the
// completed-tasks investigation; shard B = the failed/cancelled investigation).
// Graded fraction of shards covered so a report that surfaced only one shard ranks
// below a fully-merged one — proving the lead merged BOTH worker findings rather
// than dropping a shard. A section "counts" when the report names that shard's
// status terms. ----
const SHARD_SECTIONS: { label: string; pattern: RegExp }[] = [
  // Shard A: the completed-tasks investigation — names "completed" and a count.
  {
    label: "shard-A:completed",
    pattern: /completed[\s\S]{0,80}?\b\d+\b|\b\d+\b[\s\S]{0,80}?completed/i,
  },
  // Shard B: the failures/cancellations investigation — names BOTH non-completed
  // statuses, so a report that only mentions "completed" does not cover shard B.
  { label: "shard-B:failed", pattern: /failed/i },
  { label: "shard-B:cancelled", pattern: /cancell?ed/i },
];

const shardCoverage: DeterministicCheck = {
  name: "shard-coverage",
  fn: async (ctx): Promise<CheckResult> => {
    const lead = ctx.workers[LEAD_WORKER];
    if (!lead) return { pass: false, score: 0, detail: `lead worker ${LEAD_WORKER} not booted` };
    const content = await lead.readFile(REPORT_FILE);
    if (content === null) return { pass: false, score: 0, detail: `${REPORT_FILE} not found` };
    const total = SHARD_SECTIONS.length;
    const missing = SHARD_SECTIONS.filter((s) => !s.pattern.test(content)).map((s) => s.label);
    const covered = total - missing.length;
    const score = covered / total;
    return {
      pass: missing.length === 0,
      score,
      detail:
        missing.length === 0
          ? `merged report covers all ${total} shard sections`
          : `${covered}/${total} shard sections covered (missing: ${missing.join(", ")})`,
    };
  },
};

export const distributedAudit: Scenario = {
  id: "distributed-audit",
  name: "Distributed audit",
  description: [
    "The same seeded task history as sql-audit (30 terminal tasks across",
    "completed/failed/cancelled with red herrings and one status/output anomaly) is audited in a",
    "DISTRIBUTED fashion: worker 0 audits only the completed tasks (count + highest priority),",
    "worker 1 audits only the failed/cancelled tasks (per-status counts + the one failed-but-claims-",
    "success anomaly), each publishing its shard findings into swarm memory; a lead then merges both",
    "shards into one report on its own sandbox. Graded on shard coverage (completeness, 2×), the merged",
    "answer key (correctness, 3×), and the merged report's communication quality (judge, 1×).",
  ].join(" "),
  // Two workers (under the 3-worker cap) + a lead (outside the cap). The workers
  // shard the investigation; the lead merges. The lead orchestrates and owns the
  // single merged report.
  workers: [
    { name: "auditor-a", template: "researcher" },
    { name: "auditor-b", template: "researcher" },
  ],
  lead: { name: "Lead", template: "lead" },
  seed: { sqlDump: "sql-audit-history.sql" },
  tasks: [
    {
      title: "Audit the completed tasks (shard A)",
      worker: 0,
      description: [
        "You own SHARD A of a distributed audit. The swarm API at",
        "`$MCP_BASE_URL/api/tasks?fields=full` (your `API_KEY` env var is the bearer token) returns a",
        "history of past tasks. Each record has a `task` text (its first line is the title), a `status`,",
        "a `priority`, and an `output`.",
        "",
        "Audit ONLY the tasks whose `status` is `completed` (ignore every other status — that is another",
        "auditor's shard). Determine:",
        "  1. How many tasks have status `completed`.",
        "  2. Among those `completed` tasks, the one with the highest `priority` — record its exact title",
        "     (the first line of its task text).",
        "",
        "PUBLISH your shard findings so the lead can merge them: index a swarm memory whose content",
        `states the completed count and the highest-priority completed task's title AND the exact channel`,
        `tag \`${SHARD_A_TAG}\` (the lead searches that tag), and include the same findings in your`,
        "completion report. Do not invent numbers — every figure must come from the API data. Report",
        "completion via store-progress.",
      ].join("\n"),
    },
    {
      title: "Audit the failed and cancelled tasks (shard B)",
      worker: 1,
      description: [
        "You own SHARD B of a distributed audit. The swarm API at",
        "`$MCP_BASE_URL/api/tasks?fields=full` (your `API_KEY` env var is the bearer token) returns a",
        "history of past tasks. Each record has a `task` text (its first line is the title), a `status`,",
        "a `priority`, and an `output`.",
        "",
        "Audit ONLY the tasks that did NOT complete — those whose `status` is `failed` or `cancelled`",
        "(ignore the `completed` tasks — that is another auditor's shard). Determine:",
        "  1. How many tasks have status `failed`, and how many have status `cancelled` (two separate",
        "     counts).",
        "  2. The one ANOMALY among them: exactly one task's `output` claims the work succeeded even",
        "     though its `status` is not `completed`. Record that task's exact title. (This requires",
        "     cross-referencing each task's status against its output — it is not visible from status",
        "     alone.)",
        "",
        "PUBLISH your shard findings so the lead can merge them: index a swarm memory whose content",
        `states the failed count, the cancelled count, and the anomaly's title AND the exact channel tag`,
        `\`${SHARD_B_TAG}\` (the lead searches that tag), and include the same findings in your completion`,
        "report. Do not invent numbers — every figure must come from the API data. Report completion via",
        "store-progress.",
      ].join("\n"),
    },
    {
      title: "Merge the shard findings into one report (lead)",
      worker: "lead",
      dependsOn: [0, 1],
      description: [
        "You are the LEAD. Two auditors each investigated a SHARD of the seeded task history and",
        "published their findings into swarm memory:",
        `  - Shard A (completed tasks) under the channel tag \`${SHARD_A_TAG}\`: the completed count and`,
        "    the highest-priority completed task's title.",
        `  - Shard B (failed + cancelled tasks) under the channel tag \`${SHARD_B_TAG}\`: the failed`,
        "    count, the cancelled count, and the one status/output-contradiction anomaly.",
        "",
        "Search your memory for BOTH channel tags and retrieve each shard's findings (do not re-run the",
        "audit yourself and do not invent numbers — use exactly what the auditors published).",
        "",
        `MERGE them into a single audit report and write it to \`${REPORT_FILE}\` (markdown; create the`,
        "directory). The merged report MUST:",
        "  - State shard A's findings: the `completed` count and the highest-priority completed task.",
        "  - State shard B's findings: the `failed` count, the `cancelled` count, and the anomaly task.",
        "  - State the merged GRAND TOTAL of all audited tasks (completed + failed + cancelled).",
        "  - Briefly justify each figure by attributing it to the shard it came from.",
        "",
        "Then report completion via store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gates (binary must-pass): the merged report must EXIST on the lead's sandbox
    // (the required output surface — the lead actually produced a merge). The
    // synthetic tasks-completed gate is prepended by the runner. Coverage,
    // correctness, and communication are GRADED (not gated) so they discriminate.
    gates: [fileContainsOnWorker(LEAD_WORKER, REPORT_FILE, /\S/)],
    dimensions: [
      {
        name: "completeness",
        weight: 2,
        // Shard-coverage: the merged report must cover BOTH shards (graded
        // fraction). A lead that dropped a shard ranks below a full merge.
        checks: [shardCoverage],
      },
      {
        name: "correctness",
        weight: 3,
        // The merged answer key graded over the lead's report (partial credit
        // over the five facts). The answer-key values live only in the seeded DB.
        checks: [mergedCorrectness],
      },
      {
        name: "communication",
        weight: 1,
        judge: {
          rubric: [
            `Grade ONLY the merged audit report at ${REPORT_FILE} (read it via read_file on worker 2 —`,
            "the lead). Score 0-1 on whether the report communicates the MERGED audit clearly and",
            "ATTRIBUTES each figure to the shard it came from — not on whether the numbers are correct (a",
            "separate deterministic check grades correctness). A strong report: states shard A's findings",
            "(the completed count and the highest-priority completed task) AND shard B's findings (the",
            "failed count, the cancelled count, and the anomaly); gives the merged grand total; and",
            "explains which auditor/shard each figure came from. A weak report: covers only one shard,",
            "omits the attribution, is vague, or just dumps raw findings. Do not reward length. If the",
            "report file is missing or empty, score 0.",
          ].join(" "),
          agentic: true,
          maxSteps: 10,
        },
      },
    ],
  },
  // A deep distributed scenario: two API audits sharded across isolated sandboxes,
  // a swarm-memory handoff at each worker→lead hop, and a lead merge that must
  // reconcile both shards. Weaker configs burn turns getting the memory publish/
  // search right and mis-sharding the history. Raised to 18 minutes.
  timeoutMs: 18 * 60_000,
};
