import { parseToolUses, type ToolUse, toolUseMatches } from "../src/judge/session-log-parse.ts";
import type { SessionLogRow } from "../src/swarm/client.ts";
import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  Scenario,
  SwarmTask,
} from "../src/types.ts";

/**
 * delegation-probe (Plan A §Phase 2 — Delegation & lifecycle axis, lead + 2 workers)
 * ---------------------------------------------------------------------------------
 * Scores the LEAD's DELEGATION behavior deterministically (no judge) from the
 * task / session-log paper-trail. A single audit job is handed to the lead with
 * an explicit mandate: DELEGATE the work to its two researcher workers and do
 * NOT query the tasks API itself. A capable lead spawns two child tasks (one per
 * shard), the workers query the seeded history and report back, the lead receives
 * the auto follow-ups, and merges both shards into one report on its own sandbox.
 * A lead that instead audits the history solo (despite the mandate) scores ZERO
 * on the `delegation` dimension even if its merged report is perfectly correct.
 *
 * Why deterministic: the negative finding (`thoughts/.../mechanics-rethink-handoff.md`)
 * is that correctness saturates and the soft judge is too noisy to discriminate
 * model tiers. The delegation paper-trail (child tasks created, worker tasks
 * completed, whether the report's facts trace back to worker output, who ran
 * which tool) is fully observable from the swarm API + session logs, so we grade
 * the BEHAVIOR, not the prose.
 *
 * Two dimensions:
 *   - `delegation` (weight 5): did the lead actually orchestrate?
 *       P1 child-tasks-created    (≥2 children, creator=lead, parent=lead seed task)  w3
 *       P2 worker-tasks-completed (≥2 of those completed with non-empty output)        w2
 *       P4 workers-have-sessions  (each child task has non-empty session_logs)          w1
 *       Q1 task-count-discipline  (exactly 2 children = ideal; 3 = half; else 0)        w1
 *       Q4 facts-flow-through-workers (report facts trace back to worker output)        w4
 *       N1 no-solo-research       (lead session has NO get-tasks-with-status tool_use)  ZEROES the dimension
 *       N2 no-solo-audit          (lead session has no db-query / data-scrape Bash)      penalty
 *       N3 no-delegation-loops    (no task created BY a worker with a parent)           penalty
 *       N4 no-re-doing-work       (lead does data-research AFTER it began delegating)    penalty
 *     The positive checks (P1/P2/P4 existence + Q1/Q4 quality) are a weighted mean
 *     (the positive delegation score); the N2/N3/N4 negatives each subtract a fixed
 *     penalty; N1 is a HARD ZERO (see `delegationDimensionCheck` — the short-circuit
 *     returns score 0 before any positive credit is computed, so a solo lead cannot
 *     dilute it back up).
 *
 *     NOTE (Pilot-3 / 2026-06-17): the former P3 "follow-up-received" check
 *     (≥1 system follow-up whose parent is a child task, w2) was DROPPED. It was a
 *     brittle proxy: a lead that delegates well but sets `followUpConfig.disabled`
 *     on its send-task calls (a legitimate choice — it manages the merge itself) got
 *     NO system follow-up task and so P3=0, dropping the dimension 2/11 even on a
 *     perfect run. Its real intent ("lead acknowledged and used worker output") is
 *     already measured, more robustly, by Q4 (facts-flow-through-workers). Its weight
 *     (2) was folded into Q4 (2→4), keeping positiveTotal=11 unchanged. N4 (which
 *     used to gate on P3) was re-gated on the lead having delegated at all.
 *   - `correctness` (weight 2): the MERGED answer key graded over the lead's
 *       report (per-status counts + the highest-priority completed title). Anchored
 *       to the lead's report because IT owns the merge; the answer-key values live
 *       only in the seeded DB (anti-gaming).
 *
 * Aggregate = (5·delegation + 2·correctness) / 7; default pass threshold 0.75.
 *
 * Answer key (mirror of generate-delegation-probe-history.ts output — regenerate
 * the fixture and update this file if the dataset changes):
 *   completed count                  = 11
 *   failed count                     = 5
 *   cancelled count                  = 4
 *   highest-priority completed title = "Provision the analytics warehouse cluster"
 */

// The lead is member index 2 (appended after the two workers, v7 §12.4) and
// writes the single merged report onto its OWN sandbox.
const LEAD_WORKER = 2;
const REPORT_FILE = "/workspace/audit/merged-report.md";

// ---------------------------------------------------------------------------
// Answer-key facts graded over the lead's merged report (correctness dimension).
// Each numeric count is PROXIMITY-ANCHORED to its status word on the same line
// (within a 40-char window either side) so a bare stray digit in unrelated prose
// can't satisfy it; `\b…\b` keeps a nearby wrong count from matching. The title
// matches the distinctive words of the top task, tolerant of casing/punctuation.
// Values come from the seeded DB only — none appears in any prompt.
// ---------------------------------------------------------------------------
interface MergedFact {
  label: string;
  pattern: RegExp;
}

const MERGED_FACTS: MergedFact[] = [
  {
    label: "completed-count=11",
    pattern: /completed[^\n]{0,40}\b11\b|\b11\b[^\n]{0,40}completed/i,
  },
  { label: "failed-count=5", pattern: /failed[^\n]{0,40}\b5\b|\b5\b[^\n]{0,40}failed/i },
  { label: "cancelled-count=4", pattern: /cancell?ed[^\n]{0,40}\b4\b|\b4\b[^\n]{0,40}cancell?ed/i },
  {
    label: "top-priority-completed=analytics-warehouse",
    pattern: /analytics[\s\S]{0,40}?warehouse|warehouse[\s\S]{0,40}?analytics/i,
  },
];

// ===========================================================================
// Delegation-rubric helpers. All read from ctx.tasks (the runner merges runtime-
// spawned child + follow-up tasks into it — Plan A §Phase 1) and ctx.apiGet (the
// per-task session-logs). Agent ids are resolved from ctx.workers.
// ===========================================================================

/** Lead/worker agent-id resolution from the booted roster (v7 §12 isLead flag). */
function resolveRoster(ctx: JudgeContext): {
  leadAgentId: string | undefined;
  workerAgentIds: Set<string>;
} {
  const leadAgentId = ctx.workers.find((w) => w.isLead)?.agentId;
  const workerAgentIds = new Set(ctx.workers.filter((w) => !w.isLead).map((w) => w.agentId));
  return { leadAgentId, workerAgentIds };
}

/** The lead's upfront SEED task (the scenario's single `worker:"lead"` task). It
 * is the one assigned to the lead that is NOT a system follow-up and has no parent
 * (the children + follow-ups all carry a parentTaskId). */
function findLeadSeedTask(
  ctx: JudgeContext,
  leadAgentId: string | undefined,
): SwarmTask | undefined {
  return ctx.tasks.find(
    (t) =>
      t.agentId === leadAgentId &&
      (t.taskType ?? null) !== "follow-up" &&
      (t.parentTaskId ?? null) == null,
  );
}

/** Child tasks the lead delegated to a worker: created by the lead, assigned to a
 * worker, parented to the lead's seed task. */
function findChildTasks(
  ctx: JudgeContext,
  leadAgentId: string | undefined,
  workerAgentIds: Set<string>,
  leadSeedTaskId: string | undefined,
): SwarmTask[] {
  if (!leadAgentId || !leadSeedTaskId) return [];
  return ctx.tasks.filter(
    (t) =>
      t.creatorAgentId === leadAgentId &&
      typeof t.agentId === "string" &&
      workerAgentIds.has(t.agentId) &&
      t.parentTaskId === leadSeedTaskId,
  );
}

/** Did the lead query the tasks API with a STATUS filter itself? The forbidden
 * solo-research signal: a get-tasks tool_use whose input mentions a status filter
 * (status=, ?status, "status":"completed"…). Echoing the seeded statuses only
 * happens when the lead itself audited the history rather than delegating. */
// Tolerates both query-string (`status=completed`, `?status=completed`) and
// JSON (`"status":"completed"`) shapes — the optional closing key-quote before
// the `[=:]` delimiter is what makes the JSON case match.
const STATUS_FILTER_RE = /status["']?\s*[=:]\s*["']?(completed|failed|cancelled)/i;

function leadQueriedTasksApi(toolUses: ToolUse[]): ToolUse | undefined {
  return toolUses.find((u) => {
    if (!toolUseMatches(u.toolName, ["get-tasks", "list-tasks", "list_tasks", "get_tasks"])) {
      // Also catch a raw GET against /api/tasks?...status=... via Bash/curl/fetch.
      const inputStr = safeStringify(u.input);
      if (!/\/api\/tasks/i.test(inputStr)) return false;
      return STATUS_FILTER_RE.test(inputStr);
    }
    return STATUS_FILTER_RE.test(safeStringify(u.input));
  });
}

/** Did the lead do the RESEARCH/AUDIT itself instead of delegating it? This is
 * the N2 data-scrape signal. It does NOT include Write/Edit — writing the merged
 * report is the mandatory deliverable (the `report-exists` gate) and must never
 * be penalized. We flag only the lead pulling the audit DATA itself:
 *   - the `db-query` MCP tool (a direct read-only SQL query against the swarm DB;
 *     the lead has no legitimate reason to run SQL in a delegation exercise — this
 *     closes the anti-gaming hole where a lead audited the seeded `agent_tasks`
 *     history via `db-query` and escaped every negative check), or
 *   - a Bash/command_execution that scrapes `/api/tasks` or the seeded
 *     `agent_tasks` history (curl/fetch/sqlite).
 * (N1 separately hard-zeroes the get-tasks-with-status-filter MCP path.) */
function leadDidDataResearch(toolUses: ToolUse[]): ToolUse | undefined {
  return toolUses.find((u) => isDataResearchTool(u));
}

/** True when this tool call is the lead doing the audit/research itself (the
 * `db-query` MCP tool, or a Bash data-scrape against /api/tasks / agent_tasks). */
function isDataResearchTool(u: ToolUse): boolean {
  // Direct DB/tasks-API query MCP tool (e.g. mcp__agent-swarm__db-query). Any
  // db-query by the lead in this scenario is the lead auditing the history itself.
  if (toolUseMatches(u.toolName, ["db-query", "db_query"])) return true;
  if (toolUseMatches(u.toolName, [/^Bash$/i, "command_execution"])) {
    const inputStr = safeStringify(u.input);
    // Data-research Bash (the lead pulling the audit data itself) — a curl/fetch
    // at /api/tasks, or a sqlite query against the seeded history.
    return /\/api\/tasks/i.test(inputStr) || /agent_tasks/i.test(inputStr);
  }
  return false;
}

/** Tools the lead uses to DELEGATE (hand a child task to a worker). The first such
 * call marks the start of orchestration — any data-research the lead does AFTER it
 * is the N4 "re-did the work" signal (the lead should merge from worker output, not
 * re-audit the history once it has delegated). */
function leadDelegationToolIndex(toolUses: ToolUse[]): number {
  return toolUses.findIndex((u) =>
    toolUseMatches(u.toolName, ["send-task", "send_task", "create-task", "create_task"]),
  );
}

/** A delegation LOOP: a task created BY a worker that itself has a parent (a
 * worker re-delegating instead of doing the work). */
function findDelegationLoops(ctx: JudgeContext, workerAgentIds: Set<string>): SwarmTask[] {
  return ctx.tasks.filter(
    (t) =>
      typeof t.creatorAgentId === "string" &&
      workerAgentIds.has(t.creatorAgentId) &&
      (t.parentTaskId ?? null) != null,
  );
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "";
  }
}

/** Read a task's session-logs through the API (Plan A §Phase 2 — first check-side
 * apiGet usage). Returns [] on any error / missing-logs shape (never throws). */
async function fetchSessionLogs(
  ctx: JudgeContext,
  taskId: string,
  limit: number,
): Promise<SessionLogRow[]> {
  try {
    const res = (await ctx.apiGet(`/api/tasks/${taskId}/session-logs?limit=${limit}`)) as {
      logs?: SessionLogRow[];
    } | null;
    return res?.logs ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Penalty weights for the negative checks. N2/N3/N4 each subtract a fixed amount
// from the positive delegation score (clamped to [0,1]); N1 is a HARD ZERO that
// bypasses the positive score entirely (see delegationDimensionCheck).
// ---------------------------------------------------------------------------
const N2_PENALTY = 0.25; // lead audited the history itself (db-query / data-scrape)
const N3_PENALTY = 0.5; //  a worker re-delegated (delegation loop)
const N4_PENALTY = 0.25; // lead re-did research after it began delegating

// Positive-check weights (P1/P2/P4), per the plan. (P3 follow-up-received was
// dropped in Pilot-3; its weight was folded into Q4 — see the header NOTE.)
const P1_WEIGHT = 3;
const P2_WEIGHT = 2;
const P4_WEIGHT = 1;

// Quality-graded positive-check weights (Q1, Q4) — folded into the SAME composite
// (PR #775 design proposal §1; only the robust, hard-to-game Q1+Q4 are implemented,
// Q2/Q3 are deliberately skipped as keyword-brittle). Both are GUARDED on P1 so a
// non-delegator earns no phantom quality credit. Q1 grades task-count discipline
// (1 per worker = 2 children is ideal); Q4 grades delegation FIDELITY — whether the
// merged report's answer-key facts trace back to WORKER output rather than the lead
// re-deriving them. Q4 absorbed the dropped P3's weight (2→4) so its real intent
// ("lead used worker output") is now carried by the more robust fidelity check.
// With these, the positive total is
//   P1(3)+P2(2)+P4(1)+Q1(1)+Q4(4) = 11, and a clean delegator (all P pass,
//   Q1=1, Q4=1) scores 11/11 = 1.0 — clearing the 0.75 dimension threshold.
const Q1_WEIGHT = 1;
const Q4_WEIGHT = 4;

/**
 * The `delegation` dimension as a SINGLE composite check. Modeling it as one
 * check (rather than one DeterministicCheck per P/N) is what lets N1 ZERO the
 * dimension deterministically: the runner's weighted mean over a one-check
 * dimension equals that check's returned score (`dimensionScoreFromChecks` in
 * src/scoring.ts — a single {value,weight} pair yields `value`). So when N1
 * fires we `return { score: 0 }` and the dimension sub-score is 0, full stop —
 * the P1–P4 partial credit is never even computed and cannot dilute it back up.
 *
 * Interaction with the runner (src/runner/index.ts scoreDimension → runChecks →
 * dimensionScoreFromChecks): runChecks runs this check, takes `score ?? (pass?1:0)`
 * as its value, and dimensionScoreFromChecks([{value, weight:1}]) returns `value`.
 * No special-casing in the engine is required — the zeroing lives entirely in the
 * check `fn`, keeping the scoring engine untouched (plan §"NOT doing": no engine
 * rewrite).
 */
const delegationDimensionCheck: DeterministicCheck = {
  name: "delegation-paper-trail",
  fn: async (ctx): Promise<CheckResult> => {
    const { leadAgentId, workerAgentIds } = resolveRoster(ctx);
    if (!leadAgentId) {
      return { pass: false, score: 0, detail: "no lead agent in roster" };
    }
    const leadSeedTask = findLeadSeedTask(ctx, leadAgentId);
    const leadSeedTaskId = leadSeedTask?.id;
    const childTasks = findChildTasks(ctx, leadAgentId, workerAgentIds, leadSeedTaskId);
    const childTaskIds = new Set(childTasks.map((t) => t.id));

    // ---- N1 (hard zero): did the lead audit the history itself? Read the lead's
    // own session and look for a tasks-API query carrying a status filter. ----
    const leadLogs = leadSeedTaskId ? await fetchSessionLogs(ctx, leadSeedTaskId, 500) : [];
    const leadTools = parseToolUses(leadLogs);
    const soloQuery = leadQueriedTasksApi(leadTools);
    if (soloQuery) {
      return {
        pass: false,
        score: 0,
        detail: `N1 violated: lead queried the tasks API itself (${soloQuery.toolName}) — delegation dimension zeroed`,
      };
    }

    // ---- P1: child tasks created (≥2, creator=lead, parent=lead seed task) ----
    const p1 = childTasks.length >= 2;

    // ---- P2: ≥2 of those children completed with non-empty output ----
    const completedChildren = childTasks.filter(
      (t) =>
        ["done", "completed"].includes(t.status) &&
        typeof t.result === "string" &&
        t.result.trim().length > 0,
    );
    const p2 = completedChildren.length >= 2;

    // ---- (P3 DROPPED, Pilot-3 / 2026-06-17) The former P3 "follow-up-received"
    // check was removed from scoring: a lead that delegates well but disables
    // follow-ups (managing the merge itself) got no system follow-up and so P3=0
    // even on a perfect run. Its intent is now carried by Q4. We still tally the
    // follow-up count below PURELY as an observability `detail` string — it does
    // NOT affect the score. ----
    const followUpCount = ctx.tasks.filter(
      (t) =>
        t.source === "system" &&
        t.taskType === "follow-up" &&
        typeof t.parentTaskId === "string" &&
        childTaskIds.has(t.parentTaskId),
    ).length;

    // ---- P4: each child task has non-empty session_logs (the worker ran) ----
    let workersWithSessions = 0;
    for (const child of childTasks) {
      const logs = await fetchSessionLogs(ctx, child.id, 1);
      if (logs.length > 0) workersWithSessions++;
    }
    const p4 = childTasks.length > 0 && workersWithSessions === childTasks.length;

    // ---- Q1 (quality, weight 1): task-count discipline. A well-delegating lead
    // creates exactly 2 children (one per worker). 3 is over-delegation (half
    // credit); 1 or 4+ is undisciplined (zero). GUARDED on P1 — no quality credit
    // for a lead that didn't delegate (≥2 children). ----
    const q1 = p1 ? (childTasks.length === 2 ? 1 : childTasks.length === 3 ? 0.5 : 0) : 0;

    // ---- Q4 (quality, weight 2): facts-flow-through-workers — the delegation-
    // FIDELITY check. Of the answer-key facts present in the merged report, what
    // fraction also appears in the WORKERS' completed output? A faithful lead
    // merges worker results (q4≈1); a lead that re-derived the data itself produces
    // a report whose facts don't trace back to any worker (q4 low). Reads the lead's
    // sandbox report (same file as mergedCorrectness) and the completed children's
    // `result` (the worker `output` column, normalized to `result`). GUARDED on P1. ----
    let q4 = 0;
    if (p1) {
      const lead = ctx.workers[LEAD_WORKER];
      const report = lead ? await lead.readFile(REPORT_FILE) : null;
      if (report) {
        const factsInReport = MERGED_FACTS.filter((f) => f.pattern.test(report));
        if (factsInReport.length > 0) {
          const workerResults = completedChildren
            .map((t) => t.result ?? "")
            .filter((r) => r.length > 0);
          const factsAlsoInWorkers = factsInReport.filter((fact) =>
            workerResults.some((wr) => fact.pattern.test(wr)),
          );
          q4 = factsAlsoInWorkers.length / factsInReport.length;
        }
      }
    }

    // Positive weighted mean (P1/P2/P4 existence + Q1/Q4 quality). P3 dropped.
    const positiveWeighted =
      P1_WEIGHT * (p1 ? 1 : 0) +
      P2_WEIGHT * (p2 ? 1 : 0) +
      P4_WEIGHT * (p4 ? 1 : 0) +
      Q1_WEIGHT * q1 +
      Q4_WEIGHT * q4;
    const positiveTotal = P1_WEIGHT + P2_WEIGHT + P4_WEIGHT + Q1_WEIGHT + Q4_WEIGHT;
    let score = positiveWeighted / positiveTotal;

    // ---- N2: the lead audited the history itself (penalty) ----
    // The data-scrape signal ONLY — the lead pulling the audit data via the
    // db-query MCP tool or a /api/tasks / agent_tasks Bash. Writing the merged
    // report (the mandatory deliverable / report-exists gate) is NOT penalized.
    const n2Tool = leadDidDataResearch(leadTools);
    if (n2Tool) score -= N2_PENALTY;

    // ---- N3: a worker re-delegated — delegation loop (penalty) ----
    const loops = findDelegationLoops(ctx, workerAgentIds);
    if (loops.length > 0) score -= N3_PENALTY;

    // ---- N4: after it began delegating, the lead did data research again ----
    // "Re-doing the work": the lead should merge from the worker output, not re-
    // query the history itself. We detect a data-research tool call (the SAME
    // signal N2 uses — db-query / data-scrape Bash, NEVER a Write) that occurs
    // POSITIONALLY AFTER the lead's first delegation in its transcript
    // (parseToolUses preserves transcript order, so array index is a valid
    // ordering). N4 is GATED on the lead having actually delegated — at least one
    // child task exists OR P1 (≥2 children) — so it never fires on a non-delegating
    // run (that path is N1/N2's job) and cannot fire merely because the lead wrote
    // the report. (Pilot-3 / 2026-06-17: this gate was changed from the now-removed
    // P3 "follow-up-received" to "delegated at all", so a lead that disables
    // follow-ups is still penalized for re-researching after it delegated.)
    const delegated = childTasks.length >= 1 || p1;
    const delegateIdx = leadDelegationToolIndex(leadTools);
    const reResearchedAfterDelegating =
      delegateIdx >= 0 && leadTools.slice(delegateIdx + 1).some((u) => isDataResearchTool(u));
    const n4Redo = delegated && reResearchedAfterDelegating;
    if (n4Redo) score -= N4_PENALTY;

    score = Math.max(0, Math.min(1, score));

    const flags: string[] = [];
    flags.push(`P1=${p1 ? "✓" : "✗"}(${childTasks.length} children)`);
    flags.push(`P2=${p2 ? "✓" : "✗"}(${completedChildren.length} done w/ output)`);
    flags.push(`P4=${p4 ? "✓" : "✗"}(${workersWithSessions}/${childTasks.length} w/ sessions)`);
    // Observability only — P3 was dropped; the follow-up count does NOT affect score.
    flags.push(`followups=${followUpCount}`);
    flags.push(`Q1=${q1.toFixed(2)}(${childTasks.length} children)`);
    flags.push(`Q4=${q4.toFixed(2)}(facts→workers)`);
    if (n2Tool) flags.push(`N2 penalty (${n2Tool.toolName})`);
    if (loops.length > 0) flags.push(`N3 penalty (${loops.length} loops)`);
    if (n4Redo) flags.push("N4 penalty (re-research after delegating)");

    return {
      pass: score >= 1,
      score,
      detail: `delegation ${score.toFixed(2)} — ${flags.join(", ")}`,
    };
  },
};

// ---------------------------------------------------------------------------
// correctness: the merged answer key graded over the LEAD's merged report
// (member index 2). Reads the report from the lead's sandbox and scores the
// fraction of the four facts present. A missing report scores 0.
// ---------------------------------------------------------------------------
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

/** Gate: the merged report EXISTS and is non-empty on the lead's sandbox. */
const reportExistsGate: DeterministicCheck = {
  name: `report-exists[w${LEAD_WORKER}]:${REPORT_FILE}`,
  fn: async (ctx): Promise<CheckResult> => {
    const lead = ctx.workers[LEAD_WORKER];
    if (!lead) return { pass: false, detail: `lead worker ${LEAD_WORKER} not booted` };
    const content = await lead.readFile(REPORT_FILE);
    if (content === null) return { pass: false, detail: `${REPORT_FILE} not found` };
    if (!/\S/.test(content)) return { pass: false, detail: `${REPORT_FILE} is empty` };
    return { pass: true, detail: `${REPORT_FILE} (${content.length} bytes)` };
  },
};

export const delegationProbe: Scenario = {
  id: "delegation-probe",
  name: "Delegation probe",
  description: [
    "A single audit job is handed to the LEAD with an explicit mandate to DELEGATE the work to its",
    "two researcher workers and NOT query the tasks API itself. A capable lead spawns one child task",
    "per shard, the workers query the seeded 20-task history (11 completed / 5 failed / 4 cancelled),",
    "report back, and the lead merges both shards into one report on its own sandbox. Graded",
    "deterministically (no judge) on delegation behavior (child tasks created, worker tasks completed,",
    "whether the report's facts trace back to worker output, who ran which tool — weight 5) and the merged answer key (correctness,",
    "weight 2). A lead that audits the history solo scores ZERO on delegation even if its merged",
    "report is correct.",
  ].join(" "),
  // Two researcher workers (under the 3-worker cap) + a lead (outside the cap).
  // The lead orchestrates; the workers do the shard research.
  workers: [{ name: "researcher-alpha" }, { name: "researcher-beta" }],
  lead: { name: "Lead", template: "lead" },
  seed: { sqlDump: "delegation-probe-history.sql" },
  tasks: [
    {
      title: "Audit the seeded task history by DELEGATING to your two researchers (lead)",
      worker: "lead",
      description: [
        "You are the LEAD of a two-researcher swarm. The swarm API has a seeded history of past tasks",
        "(each record has a `task` text whose first line is the title, a `status`, a `priority`, and an",
        "`output`). Your job is to produce ONE merged audit report — but you MUST get there by",
        "DELEGATING the actual research to your two workers. This is a delegation exercise:",
        "",
        "  - DO delegate to your two workers (researcher-alpha and researcher-beta). Create a task for",
        "    each that tells them which slice of the history to audit and what to report back.",
        "  - Do NOT query the tasks API yourself, and do NOT audit the history yourself. Your role is to",
        "    orchestrate the two researchers and MERGE their findings — not to do the research.",
        "",
        "Shard the work however you like across the two researchers (for example: one audits the",
        "`completed` tasks, the other audits the `failed` and `cancelled` tasks). Each researcher should",
        "report, from the API data: how many tasks have each status they own, and — for whoever owns the",
        "`completed` tasks — the exact title (first line of the task text) of the highest-`priority`",
        "completed task.",
        "",
        "When both researchers have reported back, MERGE their findings into a single audit report and",
        `write it to \`${REPORT_FILE}\` (markdown; create the directory). The merged report MUST state`,
        "the count of `completed`, `failed`, and `cancelled` tasks, the merged grand total, and the",
        "highest-priority completed task's title — attributing each figure to the researcher who found",
        "it. Do not invent numbers; use exactly what the researchers reported. Then report completion",
        "via store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gate (binary must-pass): the merged report must EXIST on the lead's sandbox.
    // The synthetic tasks-completed gate is prepended by the runner.
    gates: [reportExistsGate],
    dimensions: [
      {
        // Custom dimension name (allowed via DimensionName = string & {} — the
        // registry validates structure, not the name set). Scored by a SINGLE
        // composite check so N1 can hard-zero it (see delegationDimensionCheck).
        name: "delegation",
        weight: 5,
        checks: [delegationDimensionCheck],
      },
      {
        name: "correctness",
        weight: 2,
        checks: [mergedCorrectness],
      },
    ],
  },
  // A delegation + merge scenario across three isolated sandboxes: the lead must
  // route two child tasks, the workers audit + report, the lead merges. Weaker
  // configs skip delegation and audit solo, or never merge. 15 minutes.
  timeoutMs: 15 * 60_000,
};

// Exported for unit testing the rubric against synthetic JudgeContexts.
export const __test__ = {
  delegationDimensionCheck,
  mergedCorrectness,
  reportExistsGate,
  MERGED_FACTS,
  LEAD_WORKER,
  REPORT_FILE,
  N2_PENALTY,
  N3_PENALTY,
  N4_PENALTY,
  Q1_WEIGHT,
  Q4_WEIGHT,
};
