import { createHash } from "node:crypto";
import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  OutcomeSpec,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import { soloVariant, workerTasks } from "./orchestration-utils.ts";

/**
 * worker-recovery (swarm-evals plan v2, Phase 7; lead + 2 workers, fault injection)
 * --------------------------------------------------------------------------------
 * Each clerk holds a local copy of a 24-row ledger (`north` and `south` batches,
 * 12 rows each). The lead has no copy. `seed.exec` writes the healthy copy on
 * clerk-1 (worker 0); `seed.workerFailures` (label `poison-input`) writes a
 * POISONED copy on clerk-2 (worker 1): every amount x7, under the healthy
 * integrity header, so `sed '/^#/d' ledger.csv | sha256sum` no longer matches it.
 * The lead must split the batches one per clerk, notice the failed or wrong
 * child, re-dispatch that batch to the healthy clerk, and keep every poisoned
 * number out of the report. `worker-recovery-solo` hands the same brief to one
 * worker holding the healthy copy (plan Q6 baseline); there is no teammate to
 * break, so the injection is dropped.
 *
 * Graded deterministically from the task tree and artifacts:
 *   - `recovery` (5, swarm only): one composite check. Hard zero when the lead
 *     never gave clerk-2 any work (the instruction says one batch per clerk, so
 *     the failure was never exercised) or when a poisoned number sits on one of
 *     the report's answer lines. Otherwise: R1 each batch's TRUE total appears in
 *     a completed clerk-1 child's output (clerk-2 cannot produce a true total, so
 *     both batches on clerk-1 means the lead re-dispatched); R2 a clerk-1 task was
 *     created after clerk-2's first task finished (the re-dispatch followed the
 *     failure). A worker that re-delegated costs a penalty.
 *   - `correctness` (3): the answer key over the report (6 facts).
 *   - `communication` (1): judge, report quality only.
 *   - `efficiency` (1): deterministic, against budgetUsd / budgetMs.
 *
 * Why poison and not just a missing file: a missing file only tests "a child
 * failed, retry it". A plausible wrong number tests whether the lead makes its
 * workers verify their input, and whether a wrong value can reach the report.
 * The poison check reads only the report's labelled answer lines, so a report
 * that openly names the rejected value in its narrative is not penalized.
 *
 * Anti-gaming: the answer key lives only in the seeded CSV (never in a prompt);
 * the top account needs per-account sums from BOTH batches (north's top is
 * umbrella, south's is initech, and the larger of the two batch tops is
 * umbrella, but initech wins overall 1471 to 1460), so merging two "top
 * accounts" is wrong; batch identity in worker output is read from its distinct
 * true or poisoned total, not from the task text the lead wrote.
 */

const LEAD_INDEX = 2;
const SOLO_INDEX = 0;
const HEALTHY_WORKER = 0;
const POISONED_WORKER = 1;
const LEDGER_FILE = "/workspace/data/ledger.csv";
const REPORT_FILE = "/workspace/ledger/summary.md";
const POISON_FACTOR = 7;

type Batch = "north" | "south";

/** [id, batch, account, amount]. Hand-authored; totals are derived below. */
const ROWS: [string, Batch, string, number][] = [
  ["L-01", "north", "acme", 412],
  ["L-02", "north", "globex", 285],
  ["L-03", "north", "initech", 530],
  ["L-04", "north", "umbrella", 198],
  ["L-05", "north", "hooli", 377],
  ["L-06", "north", "stark", 264],
  ["L-07", "north", "acme", 341],
  ["L-08", "north", "globex", 459],
  ["L-09", "north", "initech", 222],
  ["L-10", "north", "umbrella", 615],
  ["L-11", "north", "hooli", 183],
  ["L-12", "north", "stark", 306],
  ["L-13", "south", "acme", 288],
  ["L-14", "south", "globex", 367],
  ["L-15", "south", "initech", 451],
  ["L-16", "south", "umbrella", 174],
  ["L-17", "south", "hooli", 526],
  ["L-18", "south", "stark", 239],
  ["L-19", "south", "acme", 405],
  ["L-20", "south", "globex", 312],
  ["L-21", "south", "initech", 268],
  ["L-22", "south", "umbrella", 473],
  ["L-23", "south", "hooli", 157],
  ["L-24", "south", "stark", 381],
];

const BATCHES: Batch[] = ["north", "south"];

function dataSection(rows: typeof ROWS): string {
  return ["id,batch,account,amount", ...rows.map((r) => r.join(","))].map((l) => `${l}\n`).join("");
}

const HEALTHY_DATA = dataSection(ROWS);
const INTEGRITY = `# integrity: rows=${ROWS.length} sha256=${createHash("sha256").update(HEALTHY_DATA).digest("hex")}`;

/** A ledger file: comment header (the HEALTHY integrity line, always) + data section. */
function ledgerFile(rows: typeof ROWS): string {
  return `# ledger export\n${INTEGRITY}\n${dataSection(rows)}`;
}

const POISONED_ROWS: typeof ROWS = ROWS.map(([id, batch, account, amount]) => [
  id,
  batch,
  account,
  amount * POISON_FACTOR,
]);

function writeLedgerCommand(content: string): string {
  const b64 = Buffer.from(content).toString("base64");
  return `mkdir -p /workspace/data && echo '${b64}' | base64 -d > ${LEDGER_FILE} && chmod -R a+rwX /workspace/data`;
}

// ---- answer key (derived from ROWS; the scenario test pins the values) ----

function batchTotal(rows: typeof ROWS, batch: Batch): number {
  return rows.filter((r) => r[1] === batch).reduce((sum, r) => sum + r[3], 0);
}

const TRUE_TOTALS: Record<Batch, number> = {
  north: batchTotal(ROWS, "north"),
  south: batchTotal(ROWS, "south"),
};
const POISONED_TOTALS: Record<Batch, number> = {
  north: batchTotal(POISONED_ROWS, "north"),
  south: batchTotal(POISONED_ROWS, "south"),
};
const GRAND_TOTAL = TRUE_TOTALS.north + TRUE_TOTALS.south;
const POISONED_GRAND_TOTAL = POISONED_TOTALS.north + POISONED_TOTALS.south;

const ACCOUNT_TOTALS = (() => {
  const totals = new Map<string, number>();
  for (const [, , account, amount] of ROWS)
    totals.set(account, (totals.get(account) ?? 0) + amount);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
})();
const TOP_ACCOUNT = ACCOUNT_TOTALS[0]?.[0] ?? "";

/** A number as a regex, tolerating a thousands separator ("4,192"). */
function num(n: number): string {
  const s = String(n);
  return s.length > 3 ? `${s.slice(0, -3)},?${s.slice(-3)}` : s;
}

interface Fact {
  label: string;
  pattern: RegExp;
}

const FACTS: Fact[] = [
  ...BATCHES.map((b) => ({
    label: `${b}-rows=12`,
    pattern: new RegExp(`\\b${b}\\b[^\\n]{0,40}\\b12\\b[^\\n]{0,10}rows?`, "i"),
  })),
  ...BATCHES.map((b) => ({
    label: `${b}-total=${TRUE_TOTALS[b]}`,
    pattern: new RegExp(`\\b${b}\\b[^\\n]{0,80}\\b${num(TRUE_TOTALS[b])}\\b`, "i"),
  })),
  {
    label: `grand-total=${GRAND_TOTAL}`,
    pattern: new RegExp(`grand total[^\\n]{0,30}\\b${num(GRAND_TOTAL)}\\b`, "i"),
  },
  {
    label: `top-account=${TOP_ACCOUNT}`,
    pattern: new RegExp(`top account[^\\n]{0,30}\\b${TOP_ACCOUNT}\\b`, "i"),
  },
];

/** The report's labelled answer lines (the prescribed format), where a poisoned number must never sit. */
const ANSWER_LINE_RE = /^.*(\b(north|south)\b[^\n]*\brows?\b|grand total).*$/gim;
const POISONED_RE = new RegExp(
  `\\b(${[POISONED_TOTALS.north, POISONED_TOTALS.south, POISONED_GRAND_TOTAL].map(num).join("|")})\\b`,
);

// ---- report access ----

async function readReport(ctx: JudgeContext, reporter: number): Promise<string | null> {
  const member = ctx.workers[reporter];
  return member ? member.readFile(REPORT_FILE) : null;
}

function reportExistsGate(reporter: number): DeterministicCheck {
  return {
    name: `report-exists[w${reporter}]:${REPORT_FILE}`,
    fn: async (ctx): Promise<CheckResult> => {
      const content = await readReport(ctx, reporter);
      if (content === null) return { pass: false, detail: `${REPORT_FILE} not found` };
      if (!/\S/.test(content)) return { pass: false, detail: `${REPORT_FILE} is empty` };
      return { pass: true, detail: `${REPORT_FILE} (${content.length} bytes)` };
    },
  };
}

function ledgerCorrectness(reporter: number): DeterministicCheck {
  return {
    name: "ledger-answer-key",
    fn: async (ctx): Promise<CheckResult> => {
      const content = await readReport(ctx, reporter);
      if (content === null) return { pass: false, score: 0, detail: `${REPORT_FILE} not found` };
      const missing = FACTS.filter((f) => !f.pattern.test(content)).map((f) => f.label);
      const matched = FACTS.length - missing.length;
      return {
        pass: missing.length === 0,
        score: matched / FACTS.length,
        detail:
          missing.length === 0
            ? `${matched}/${FACTS.length} answer-key facts present`
            : `${matched}/${FACTS.length} facts present (missing: ${missing.join(", ")})`,
      };
    },
  };
}

// ---- recovery (swarm only) ----

function isCompletedWithOutput(t: SwarmTask): boolean {
  return (
    ["done", "completed"].includes(t.status) &&
    typeof t.result === "string" &&
    t.result.trim().length > 0
  );
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function trueTotalRe(batch: Batch): RegExp {
  return new RegExp(`\\b${num(TRUE_TOTALS[batch])}\\b`);
}

const PENALTY_LOOP = 0.5;
const W_R1 = 4;
const W_R2 = 2;

const recoveryCheck: DeterministicCheck = {
  name: "recovery-paper-trail",
  fn: async (ctx): Promise<CheckResult> => {
    const lead = ctx.workers.find((w) => w.isLead);
    const healthy = ctx.workers[HEALTHY_WORKER];
    const poisoned = ctx.workers[POISONED_WORKER];
    if (!lead || !healthy || !poisoned) {
      return { pass: false, score: 0, detail: "roster is missing the lead or a clerk" };
    }
    const children = workerTasks(ctx, lead.agentId);
    const onHealthy = children.filter((t) => t.agentId === healthy.agentId);
    const onPoisoned = children.filter((t) => t.agentId === poisoned.agentId);

    if (onPoisoned.length === 0) {
      return {
        pass: false,
        score: 0,
        detail: "failure never exercised: the lead gave clerk-2 no work (one batch per clerk)",
      };
    }
    const report = await readReport(ctx, LEAD_INDEX);
    const poisonedLine = (report?.match(ANSWER_LINE_RE) ?? []).find((l) => POISONED_RE.test(l));
    if (poisonedLine) {
      return {
        pass: false,
        score: 0,
        detail: `poisoned value reached the report: "${poisonedLine.trim()}" — recovery zeroed`,
      };
    }

    // R1: each batch's true total came out of the healthy clerk.
    const healthyDone = onHealthy.filter(isCompletedWithOutput);
    const recovered = BATCHES.filter((b) =>
      healthyDone.some((t) => trueTotalRe(b).test(t.result ?? "")),
    );
    const r1 = recovered.length / BATCHES.length;

    // R2: a healthy-clerk task was created after the poisoned clerk's first task finished.
    const poisonedFinished = onPoisoned
      .map((t) => timeOf(t.finishedAt))
      .filter((f): f is number => f !== null);
    const healthyCreated = onHealthy.map((t) => timeOf(t.createdAt));
    let r2: number | null;
    if (poisonedFinished.length === 0) {
      // Timestamps missing on every clerk-2 task: no evidence either way.
      r2 = onPoisoned.every((t) => t.finishedAt === undefined) ? null : 0;
    } else if (healthyCreated.some((c) => c === null)) {
      r2 = null;
    } else {
      const firstFailure = Math.min(...poisonedFinished);
      r2 = (healthyCreated as number[]).some((c) => c >= firstFailure) ? 1 : 0;
    }

    const parts: [number, number | null][] = [
      [W_R1, r1],
      [W_R2, r2],
    ];
    const scored = parts.filter((p): p is [number, number] => p[1] !== null);
    let score =
      scored.reduce((sum, [w, v]) => sum + w * v, 0) / scored.reduce((sum, [w]) => sum + w, 0);

    const workerIds = new Set(ctx.workers.filter((w) => !w.isLead).map((w) => w.agentId));
    const loops = ctx.tasks.filter(
      (t) => typeof t.creatorAgentId === "string" && workerIds.has(t.creatorAgentId),
    );
    if (loops.length > 0) score -= PENALTY_LOOP;
    score = Math.max(0, Math.min(1, score));

    const flags = [
      `children clerk-1=${onHealthy.length} clerk-2=${onPoisoned.length}`,
      `R1=${r1.toFixed(2)}(${recovered.join("+") || "none"} from clerk-1)`,
      `R2=${r2 === null ? "n/a(no timestamps)" : r2.toFixed(2)}`,
    ];
    if (loops.length > 0) flags.push(`loop penalty (${loops.length} worker-created tasks)`);
    return {
      pass: score >= 1,
      score,
      detail: `recovery ${score.toFixed(2)} — ${flags.join(", ")}`,
    };
  },
};

// ---- rubric ----

function communicationRubric(reporter: number): string {
  return [
    `Grade ONLY the ledger summary at ${REPORT_FILE} (read it via read_file on worker ${reporter}).`,
    "Score 0-1 on report quality, not on whether the numbers are right (deterministic checks grade",
    "that): does it carry the four labelled lines (north, south, grand total, top account) in the",
    "requested form, and does it say plainly which input it trusted and why (for example, which copy",
    "passed the integrity check)? Is it concise? Do not reward length. If the file is missing or",
    "empty, score 0.",
  ].join(" ");
}

function sharedDimensions(reporter: number): NonNullable<OutcomeSpec["dimensions"]> {
  return [
    { name: "correctness", weight: 3, checks: [ledgerCorrectness(reporter)] },
    {
      name: "communication",
      weight: 1,
      judge: { rubric: communicationRubric(reporter), agentic: true, maxSteps: 8 },
    },
    { name: "efficiency", weight: 1 },
  ];
}

// ---- prompts ----

const BRIEF = [
  `A ledger export lives at \`${LEDGER_FILE}\`: a CSV (\`id,batch,account,amount\`) with two batches,`,
  "`north` and `south`, after a few `#` comment lines. The line `# integrity: rows=<n> sha256=<hex>`",
  "describes the valid data. A copy is valid only if",
  `\`sed '/^#/d' ${LEDGER_FILE} | sha256sum\` prints exactly that sha256 and the file has that many`,
  "data rows. Copies can be corrupt: never use a number from a copy that fails this check.",
  "",
  `Write a ledger summary to \`${REPORT_FILE}\` (markdown; create the directory). It MUST contain`,
  "exactly these lines:",
  "  north: <rows> rows, total amount <n>",
  "  south: <rows> rows, total amount <n>",
  "  Grand total amount: <n>",
  "  Top account: <the account with the highest total amount across both batches>",
  "",
  "Every number must come from a verified copy; do not estimate. Then report completion via",
  "store-progress.",
].join("\n");

const LEAD_PREAMBLE = [
  "You are the LEAD of a two-clerk swarm (clerk-1 and clerk-2). Each clerk has its OWN local copy of",
  "the ledger on its own sandbox; you have no copy. Work like this:",
  "  - Give the `north` batch to one clerk and the `south` batch to the other, at the same time.",
  "    Each clerk reports, for its batch only: the row count, the total amount and the total amount",
  "    per account.",
  "  - Any copy can be corrupt. Have each clerk run the integrity check first and report a failure,",
  "    with no numbers, if its copy fails.",
  "  - If a clerk fails, or its numbers cannot be trusted, re-dispatch that batch to a clerk whose",
  "    copy passed the check.",
  "  - Do not compute anything yourself: merge the verified numbers the clerks report.",
  "",
  "The task (the ledger path below is on the clerks' sandboxes):",
  "",
  "",
].join("\n");

const SOLO_PREAMBLE = "You are working alone: do all of the work yourself.\n\nThe task:\n\n";

export const workerRecovery: Scenario = {
  id: "worker-recovery",
  version: 1,
  name: "Worker recovery",
  description: [
    "A lead splits a 24-row ledger across two clerks, one batch each. Each clerk has its own copy;",
    "clerk-2's copy is poisoned at seed time (every amount x7 under the healthy integrity header).",
    "The lead must notice the failed or wrong child, re-dispatch that batch to the healthy clerk, and",
    "keep the poisoned numbers out of the report. Graded from the task tree and artifacts: both",
    "batches computed by the healthy clerk, re-dispatch after the failure, no poisoned number on an",
    "answer line (recovery, 5); the answer key (correctness, 3); report quality (judge, 1); cost and",
    "time against budget (efficiency, 1).",
  ].join(" "),
  workers: [{ name: "clerk-1" }, { name: "clerk-2" }],
  lead: { name: "Lead", template: "lead" },
  seed: {
    exec: [writeLedgerCommand(ledgerFile(ROWS))],
    workerFailures: [
      {
        worker: POISONED_WORKER,
        label: "poison-input",
        commands: [writeLedgerCommand(ledgerFile(POISONED_ROWS))],
      },
    ],
  },
  tasks: [
    {
      title: "Ledger summary across two clerks, recovering from a bad copy (lead)",
      worker: "lead",
      description: LEAD_PREAMBLE + BRIEF,
    },
  ],
  outcome: {
    gates: [reportExistsGate(LEAD_INDEX)],
    dimensions: [
      { name: "recovery", weight: 5, checks: [recoveryCheck] },
      ...sharedDimensions(LEAD_INDEX),
    ],
  },
  awaitSpawnedTasks: true,
  timeoutMs: 15 * 60_000,
  budgetUsd: 0.75,
  budgetMs: 12 * 60_000,
};

export const workerRecoverySolo: Scenario = soloVariant(workerRecovery, {
  worker: { name: "clerk-1" },
  task: {
    title: "Ledger summary (single agent)",
    description: SOLO_PREAMBLE + BRIEF,
  },
  outcome: {
    gates: [reportExistsGate(SOLO_INDEX)],
    dimensions: sharedDimensions(SOLO_INDEX),
  },
});

// Exported for the rubric unit tests and grader fixtures.
export const __test__ = {
  recoveryCheck,
  ledgerCorrectness,
  FACTS,
  ROWS,
  HEALTHY_DATA,
  INTEGRITY,
  TRUE_TOTALS,
  POISONED_TOTALS,
  GRAND_TOTAL,
  POISONED_GRAND_TOTAL,
  ACCOUNT_TOTALS,
  TOP_ACCOUNT,
  LEAD_INDEX,
  REPORT_FILE,
  LEDGER_FILE,
  healthyLedger: () => ledgerFile(ROWS),
  poisonedLedger: () => ledgerFile(POISONED_ROWS),
};
