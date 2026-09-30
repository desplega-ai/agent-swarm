import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import { workerTasks } from "./orchestration-utils.ts";

/**
 * capability-routing (swarm-evals plan v2, Phase 8; lead + 3 workers)
 * ------------------------------------------------------------------
 * Three workers with neutral names (Ana, Bo, Cy) declare different profiles
 * (role, description, capabilities), written by the runner before any task
 * exists, so the lead sees them in get-swarm. Each holds, on its own sandbox,
 * the one input its job needs (seeded through `seed.workerExec`):
 *   - Ana (worker 0, ops):          /workspace/ops/rota.csv, the on-call rota
 *   - Bo  (worker 1, data):         /workspace/data/orders.csv, the orders dataset
 *   - Cy  (worker 2, localization): /workspace/i18n/glossary-es.tsv, the Spanish glossary
 * The lead gets three jobs, listed in an order that matches no worker order.
 * A job sent to the wrong worker cannot be done there, so a declared capability
 * is load-bearing, not a label.
 *
 * Graded deterministically:
 *   - gate: the lead's answers file exists.
 *   - `routing` (5): per job, the lead's FIRST task for it went to the right
 *     worker (1), or right but the job was also sent elsewhere or again (0.5),
 *     or wrong / never delegated (0). Jobs are told apart by the words in the
 *     lead's task text. Mean over the three jobs.
 *   - `correctness` (3): the answer key over the answers file (6 facts).
 *   - `efficiency` (1): against budgetUsd / budgetMs.
 * No solo baseline: routing across teammates has no single-agent analogue.
 *
 * Anti-gaming: answers live only in the seeded files; the glossary uses
 * non-default translations ("encargo", not "tarea"), so a model that
 * translates without the glossary misses those facts.
 */

const LEAD_INDEX = 3;
const ANSWERS_FILE = "/workspace/routing/answers.md";

type JobId = "orders" | "translation" | "on-call";

interface Job {
  id: JobId;
  /** Worker index holding this job's input. */
  worker: number;
  /** How a lead task text is recognized as carrying this job. */
  match: RegExp;
}

const JOBS: Job[] = [
  { id: "orders", worker: 1, match: /refund/i },
  { id: "translation", worker: 2, match: /spanish|translat|glossary/i },
  { id: "on-call", worker: 0, match: /on[- ]?call|\brota\b/i },
];

// ---- seeded inputs ----

/** [id, status, amountCents]. */
const ORDERS: [string, string, number][] = [
  ["O-1001", "paid", 4200],
  ["O-1002", "refunded", 1850],
  ["O-1003", "paid", 990],
  ["O-1004", "shipped", 12500],
  ["O-1005", "refunded", 3300],
  ["O-1006", "paid", 780],
  ["O-1007", "cancelled", 2150],
  ["O-1008", "refunded", 640],
  ["O-1009", "shipped", 5600],
  ["O-1010", "paid", 3125],
  ["O-1011", "refunded", 7415],
  ["O-1012", "shipped", 910],
  ["O-1013", "paid", 2600],
  ["O-1014", "cancelled", 430],
];
const REFUNDED = ORDERS.filter((o) => o[1] === "refunded");
const REFUND_COUNT = REFUNDED.length;
const REFUND_TOTAL = REFUNDED.reduce((sum, o) => sum + o[2], 0);

const GLOSSARY: [string, string][] = [
  ["task", "encargo"],
  ["retry", "reintentar"],
  ["swarm", "enjambre"],
  ["workspace", "espacio común"],
  ["agent", "agente"],
];
const RELEASE_LINES = ["Tasks now retry automatically.", "The swarm shares one workspace."];

const ROTA: [string, string, string][] = [
  ["billing", "2026-10-01", "Tomás Ortega"],
  ["billing", "2026-10-02", "Priya Raman"],
  ["billing", "2026-10-03", "Lena Fischer"],
  ["search", "2026-10-02", "Omar Haddad"],
  ["payments", "2026-10-02", "Jonas Berg"],
];
const ON_CALL_SERVICE = "billing";
const ON_CALL_DATE = "2026-10-02";
const ON_CALL = ROTA.find((r) => r[0] === ON_CALL_SERVICE && r[1] === ON_CALL_DATE)?.[2] ?? "";

function writeFile(path: string, content: string): string {
  const b64 = Buffer.from(content).toString("base64");
  return `mkdir -p "$(dirname ${path})" && echo '${b64}' | base64 -d > ${path} && chmod -R a+rwX "$(dirname ${path})"`;
}

const ROTA_CSV = `${["service,date,engineer", ...ROTA.map((r) => r.join(","))].join("\n")}\n`;
const ORDERS_CSV = `${["id,status,amount_cents", ...ORDERS.map((o) => o.join(","))].join("\n")}\n`;
const GLOSSARY_TSV = `${["term\tspanish", ...GLOSSARY.map(([en, es]) => `${en}\t${es}`)].join("\n")}\n`;

// ---- answer key ----

interface Fact {
  label: string;
  pattern: RegExp;
}

function num(n: number): string {
  const s = String(n);
  return s.length > 3 ? `${s.slice(0, -3)}[,.]?${s.slice(-3)}` : s;
}

const FACTS: Fact[] = [
  {
    label: `refund-count=${REFUND_COUNT}`,
    pattern: new RegExp(`refund[^\\n]{0,40}\\b${REFUND_COUNT}\\b`, "i"),
  },
  {
    label: `refund-total=${REFUND_TOTAL}`,
    pattern: new RegExp(`refund[^\\n]{0,80}\\b${num(REFUND_TOTAL)}\\b`, "i"),
  },
  { label: "glossary:encargo", pattern: /\bencargos?\b/i },
  { label: "glossary:enjambre", pattern: /\benjambre\b/i },
  { label: "glossary:espacio común", pattern: /espacio com[uú]n/i },
  { label: `on-call=${ON_CALL}`, pattern: new RegExp(ON_CALL.replace(" ", "\\s+"), "i") },
];

// ---- checks ----

async function readAnswers(ctx: JudgeContext): Promise<string | null> {
  return ctx.workers[LEAD_INDEX]?.readFile(ANSWERS_FILE) ?? null;
}

const answersExist: DeterministicCheck = {
  name: `answers-exist[w${LEAD_INDEX}]:${ANSWERS_FILE}`,
  fn: async (ctx): Promise<CheckResult> => {
    const content = await readAnswers(ctx);
    if (content === null) return { pass: false, detail: `${ANSWERS_FILE} not found` };
    if (!/\S/.test(content)) return { pass: false, detail: `${ANSWERS_FILE} is empty` };
    return { pass: true, detail: `${ANSWERS_FILE} (${content.length} bytes)` };
  },
};

const answerKey: DeterministicCheck = {
  name: "routing-answer-key",
  fn: async (ctx): Promise<CheckResult> => {
    const content = await readAnswers(ctx);
    if (content === null) return { pass: false, score: 0, detail: `${ANSWERS_FILE} not found` };
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

function createdAtMs(t: SwarmTask): number {
  const ms = typeof t.createdAt === "string" ? Date.parse(t.createdAt) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

const routingCheck: DeterministicCheck = {
  name: "routing-first-time",
  fn: async (ctx): Promise<CheckResult> => {
    const lead = ctx.workers.find((w) => w.isLead);
    const children = workerTasks(ctx, lead?.agentId).sort(
      (a, b) => createdAtMs(a) - createdAtMs(b),
    );
    const workerIndex = new Map(ctx.workers.map((w) => [w.agentId, w.index]));
    const parts: string[] = [];
    let total = 0;
    for (const job of JOBS) {
      const sent = children.filter((t) => job.match.test(`${t.title}\n${t.description}`));
      const first = sent[0];
      let score = 0;
      let note: string;
      if (!first) {
        note = "never delegated";
      } else if (workerIndex.get(first.agentId as string) !== job.worker) {
        note = `first sent to w${workerIndex.get(first.agentId as string)}, needed w${job.worker}`;
      } else if (sent.length === 1) {
        score = 1;
        note = "right first time";
      } else {
        score = 0.5;
        note = `right first, but sent ${sent.length}×`;
      }
      total += score;
      parts.push(`${job.id}=${score} (${note})`);
    }
    const score = total / JOBS.length;
    return { pass: score >= 1, score, detail: `routing ${score.toFixed(2)} — ${parts.join(", ")}` };
  },
};

// ---- prompt ----

const LEAD_BRIEF = [
  "You are the LEAD of a three-person team. Get these three jobs done by your teammates and",
  `write the answers to \`${ANSWERS_FILE}\` on your own sandbox (markdown; create the directory).`,
  "",
  `1. Translation: translate these two release-note lines into Spanish, using the terms of the`,
  `   product glossary: "${RELEASE_LINES[0]}" and "${RELEASE_LINES[1]}"`,
  `2. On-call: who is on call for the ${ON_CALL_SERVICE} service on ${ON_CALL_DATE}?`,
  "3. Orders: how many orders in the orders dataset have status `refunded`, and what is their",
  "   total amount in cents?",
  "",
  "Each job needs data that only one teammate has, on their own sandbox; you have none of it.",
  "Read each teammate's declared role, description and capabilities (get-swarm) and send each job",
  "to the one teammate who can do it, once. Do not send a job to several teammates, and do not",
  "try to do the jobs yourself.",
  "",
  "The answers file MUST contain exactly these lines:",
  "  Spanish: <line 1> / <line 2>",
  `  On-call ${ON_CALL_SERVICE} ${ON_CALL_DATE}: <engineer>`,
  "  Refunded orders: <count>, total <amount in cents>",
].join("\n");

export const capabilityRouting: Scenario = {
  id: "capability-routing",
  version: 1,
  name: "Capability routing",
  description: [
    "A lead gets three jobs (a Spanish translation with the product glossary, an on-call lookup,",
    "a refunds count) and three teammates whose declared roles and capabilities say who holds",
    "which input. Each input exists only on its owner's sandbox. Graded from the task tree: each",
    "job's first task went to the right teammate, once (routing, 5); the answer key over the",
    "lead's answers file (correctness, 3); cost and time against budget (efficiency, 1).",
  ].join(" "),
  workers: [
    {
      name: "Ana",
      profile: {
        role: "ops-engineer",
        description: "Operations engineer. Keeps the on-call rota for every service.",
        capabilities: ["on-call-rota", "incident-response"],
      },
    },
    {
      name: "Bo",
      profile: {
        role: "data-analyst",
        description: "Data analyst with read access to the orders dataset.",
        capabilities: ["orders-data", "sql", "csv-analysis"],
      },
    },
    {
      name: "Cy",
      profile: {
        role: "localization",
        description: "Localization specialist. Owns the Spanish product glossary.",
        capabilities: ["translation", "spanish", "product-glossary"],
      },
    },
  ],
  lead: { name: "Lead", template: "lead" },
  seed: {
    workerExec: [
      { worker: 0, commands: [writeFile("/workspace/ops/rota.csv", ROTA_CSV)] },
      { worker: 1, commands: [writeFile("/workspace/data/orders.csv", ORDERS_CSV)] },
      { worker: 2, commands: [writeFile("/workspace/i18n/glossary-es.tsv", GLOSSARY_TSV)] },
    ],
  },
  tasks: [
    {
      title: "Three jobs for the right teammates (lead)",
      worker: "lead",
      description: LEAD_BRIEF,
    },
  ],
  outcome: {
    gates: [answersExist],
    dimensions: [
      { name: "routing", weight: 5, checks: [routingCheck] },
      { name: "correctness", weight: 3, checks: [answerKey] },
      { name: "efficiency", weight: 1 },
    ],
  },
  awaitSpawnedTasks: true,
  timeoutMs: 12 * 60_000,
  budgetUsd: 0.5,
  budgetMs: 6 * 60_000,
};

// Exported for the rubric unit tests and grader fixtures.
export const __test__ = {
  JOBS,
  ORDERS,
  REFUND_COUNT,
  REFUND_TOTAL,
  GLOSSARY,
  RELEASE_LINES,
  ON_CALL,
  ON_CALL_SERVICE,
  ON_CALL_DATE,
  FACTS,
  LEAD_INDEX,
  ANSWERS_FILE,
  routingCheck,
  answerKey,
};
