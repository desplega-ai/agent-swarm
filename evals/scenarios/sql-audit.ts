import { fileContains } from "../src/judge/deterministic.ts";
import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

/**
 * sql-audit (v8.0 round-11, Data, 1 worker)
 * ------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.5 vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.4 → 0.9.
 *
 * The API DB is pre-seeded from `sql-audit-history.sql` — a full dev-DB dump
 * carrying 30 historical `agent_tasks` rows across `completed`/`failed`/
 * `cancelled` statuses with red herrings. The worker AUDITS that history through
 * the swarm API and answers three graded questions, writing each answer to its
 * own file. Grading:
 *   - `correctness` (weight 3): three answer-key `fileContains` checks —
 *       Q1 count of completed tasks, Q2 the highest-priority completed task's
 *       title, Q3 the one status/output-contradiction anomaly.
 *   - `communication` (weight 1): a judge grades the written audit report's
 *       clarity and whether it justifies each answer from the data.
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - Red-herring rows (failed/cancelled, plus near-miss priorities 92/88/85)
 *     make the count and the "which" non-trivial — naive "count all" or
 *     "pick the one named deploy" both score 0.
 *   - The anomaly (a `failed` task whose `output` claims success) is NOT
 *     derivable from any single field or from the prompt — only a cross-
 *     reference of status against output surfaces it.
 *   - The answer-key VALUES (21, "Rotate the payments service API keys", the
 *     checkout-redesign anomaly) appear NOWHERE in the task text, so echoing
 *     the prompt or guessing scores 0 on the per-question checks.
 *   - The grading rubric / check patterns are NOT shown to the worker.
 *
 * Answer key (mirror of `generate-sql-audit-history.ts` output — regenerate the
 * fixture and update both if the dataset changes):
 *   Q1 completed count                  = 21
 *   Q2 highest-priority completed title = "Rotate the payments service API keys"
 *   Q3 anomaly title                    = "Deploy the checkout redesign to production"
 */

const ANSWER_FILE_COUNT = "/workspace/audit/completed-count.txt";
const ANSWER_FILE_TOP = "/workspace/audit/top-priority-completed.txt";
const ANSWER_FILE_ANOMALY = "/workspace/audit/anomaly.txt";
const REPORT_FILE = "/workspace/audit/report.md";

// ---- Q1: count of completed tasks. The file must state exactly 21 (and not a
// nearby wrong count). `\b21\b` anchored so "121"/"210" don't satisfy it; a
// negative guard rejects the naive "count everything" answer of 30. ----
const countCorrect: DeterministicCheck = {
  name: "audit:completed-count",
  fn: async (ctx): Promise<CheckResult> => {
    const content = await ctx.readFile(ANSWER_FILE_COUNT);
    if (content === null)
      return { pass: false, score: 0, detail: `${ANSWER_FILE_COUNT} not found` };
    const ok = /\b21\b/.test(content);
    return ok
      ? { pass: true, score: 1, detail: "completed count = 21" }
      : {
          pass: false,
          score: 0,
          detail: `expected 21 in ${ANSWER_FILE_COUNT}, got ${content.trim().slice(0, 60)}`,
        };
  },
};

// ---- Q2: the highest-priority COMPLETED task's title. Must name the payments
// key-rotation task (priority 95), NOT the priority-92 failover decoy nor the
// priority-85 failed deploy. ----
const topPriorityCorrect: DeterministicCheck = {
  name: "audit:top-priority-completed",
  fn: async (ctx): Promise<CheckResult> => {
    const content = await ctx.readFile(ANSWER_FILE_TOP);
    if (content === null) return { pass: false, score: 0, detail: `${ANSWER_FILE_TOP} not found` };
    // Match the distinctive words of the title, tolerant of casing/punctuation.
    const ok = /payments?/i.test(content) && /(rotate|rotation|key)/i.test(content);
    return ok
      ? { pass: true, score: 1, detail: "top-priority completed = payments key rotation" }
      : {
          pass: false,
          score: 0,
          detail: `expected the payments key-rotation task in ${ANSWER_FILE_TOP}, got ${content.trim().slice(0, 80)}`,
        };
  },
};

// ---- Q3: the anomaly — a `failed` task whose `output` asserts success. Must
// name the checkout-redesign deploy. ----
const anomalyCorrect: DeterministicCheck = {
  name: "audit:anomaly",
  fn: async (ctx): Promise<CheckResult> => {
    const content = await ctx.readFile(ANSWER_FILE_ANOMALY);
    if (content === null)
      return { pass: false, score: 0, detail: `${ANSWER_FILE_ANOMALY} not found` };
    const ok = /checkout/i.test(content) && /(redesign|deploy)/i.test(content);
    return ok
      ? { pass: true, score: 1, detail: "anomaly = checkout-redesign deploy" }
      : {
          pass: false,
          score: 0,
          detail: `expected the checkout-redesign deploy anomaly in ${ANSWER_FILE_ANOMALY}, got ${content.trim().slice(0, 80)}`,
        };
  },
};

export const sqlAudit: Scenario = {
  id: "sql-audit",
  name: "SQL audit",
  description: [
    "The API DB is pre-seeded from a full dump carrying 30 historical tasks across",
    "completed/failed/cancelled statuses with red herrings. A single worker audits that",
    "history through the swarm API and answers three questions — how many tasks completed,",
    "which completed task had the highest priority, and which task's output contradicts its",
    "status — writing each answer to a file plus a short report. Graded on answer-key",
    "correctness (3×) and the report's communication quality (judge, 1×).",
  ].join(" "),
  seed: { sqlDump: "sql-audit-history.sql" },
  tasks: [
    {
      title: "Audit the seeded task history",
      description: [
        "The swarm API at `$MCP_BASE_URL/api/tasks?fields=full` (your `API_KEY` env var is the",
        "bearer token) returns a history of past tasks. Each task record has a `task` text (its",
        "first line is the title), a `status`, a `priority`, and an `output`. Audit this history",
        "and answer three questions. Create the `/workspace/audit/` directory, then:",
        "",
        "1. Count how many tasks have status `completed`. Write JUST that number to",
        `   \`${ANSWER_FILE_COUNT}\`.`,
        "2. Among the `completed` tasks, find the one with the highest `priority`. Write its",
        `   exact title (the first line of its task text) to \`${ANSWER_FILE_TOP}\`.`,
        "3. Exactly one task is anomalous: its `output` claims the work succeeded even though its",
        `   \`status\` is not \`completed\`. Write that task's exact title to \`${ANSWER_FILE_ANOMALY}\`.`,
        "",
        `Finally, write a short audit report to \`${REPORT_FILE}\` (markdown) that states each of`,
        "the three answers and briefly justifies it from the data (e.g. the counts you saw, the",
        "priority you compared, the status/output mismatch you found). Then report completion via",
        "store-progress. Do not invent numbers — every answer must come from the API data.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gates (binary must-pass): the audit directory + report must exist, proving
    // the worker actually produced the required output surface. Per-question
    // CORRECTNESS is graded (not gated) so partial credit discriminates.
    gates: [fileContains(REPORT_FILE)],
    dimensions: [
      {
        name: "correctness",
        weight: 3,
        checks: [countCorrect, topPriorityCorrect, anomalyCorrect],
      },
      {
        name: "communication",
        weight: 1,
        judge: {
          rubric: [
            "Grade ONLY the written audit report at /workspace/audit/report.md (read it via",
            "read_file). Score 0-1 on whether the report communicates the audit clearly and",
            "justifies its conclusions FROM THE DATA — not on whether the numbers are correct",
            "(a separate deterministic check grades correctness). A strong report: states all",
            "three answers explicitly; explains HOW each was derived (the completed-count, the",
            "priority comparison among completed tasks, the status-vs-output contradiction it",
            "found); is concise and unambiguous. A weak report: omits answers, gives no",
            "reasoning, is vague, or just dumps raw API output. Do not reward length. If the",
            "report file is missing or empty, score 0.",
          ].join(" "),
          agentic: true,
          maxSteps: 8,
        },
      },
    ],
  },
  // Single deep data-audit task: querying + cross-referencing 30 rows takes more
  // than the default budget for weaker configs. Raised to 12 minutes.
  timeoutMs: 12 * 60_000,
};
