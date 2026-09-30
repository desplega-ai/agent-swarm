import type { ToolUse } from "../src/judge/session-log-parse.ts";
import { toolUseMatches } from "../src/judge/session-log-parse.ts";
import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  OutcomeSpec,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import { safeStringify, soloVariant, taskToolUses, workerTasks } from "./orchestration-utils.ts";

/**
 * fanout-research (swarm-evals plan v2, Phase 7; lead + 3 workers, parallel)
 * -------------------------------------------------------------------------
 * The swarm API is seeded with 45 incident postmortems across three region
 * shards (fixtures/fanout-research-history.sql). The LEAD must fan the research
 * out, one region per researcher, all at once, then merge the three shard
 * reports into one incident review on its own sandbox. `fanout-research-solo`
 * hands the same brief to a single worker (plan Q6 baseline).
 *
 * Graded deterministically from the task tree and artifacts:
 *   - `delegation` (5, swarm only): one composite check. Hard zero when the lead
 *     queried the incident records itself. Otherwise: F1 the three shards went
 *     to three distinct workers; F2 every shard was done exactly once (each
 *     region's downtime total appears in exactly one worker's output, so a
 *     missing shard and a duplicated shard both cost); F3 the shard tasks were
 *     all created before the first one finished (a real fan-out, not a relay);
 *     F4 the report's shard facts trace back to worker output. A worker that
 *     re-delegated costs a penalty.
 *   - `correctness` (3): the merged answer key over the review (10 facts).
 *   - `communication` (1): judge, report quality only.
 *   - `efficiency` (1): deterministic, against budgetUsd / budgetMs.
 * The solo variant keeps correctness, communication and efficiency, with the
 * same weights and budgets (enforced by validateBaselinePairs).
 *
 * Anti-gaming:
 *   - The answer key lives only in the seeded rows; the prompts name the three
 *     regions and the report format, never a count, total, cause or title.
 *   - The overall most common root cause (dependency-failure, 13) is no region's
 *     top cause, so merging per-region "top causes" gives the wrong answer; the
 *     lead must ask for and sum per-cause counts.
 *   - Each report number is anchored to its label or region on the same line.
 *   - F2 identifies which shard a worker did from its OUTPUT (the region's
 *     distinctive downtime total), not from the task description the lead wrote,
 *     so a vague description cannot claim a shard and a worker that pulled all 45
 *     rows shows up as doing every shard.
 *
 * Answer key (mirror of generate-fanout-research-history.ts output):
 *   emea: 17 incidents, 682 downtime minutes
 *   amer: 15 incidents, 641 downtime minutes
 *   apac: 13 incidents, 709 downtime minutes
 *   total: 45 incidents, 2032 downtime minutes
 *   most common root cause overall: dependency-failure (13)
 *   longest incident: "INC-3301: tokyo-edge-cache capacity exhaustion" (184 min)
 */

const WORKER_COUNT = 3;
/** Lead is appended after the three workers. */
const LEAD_INDEX = WORKER_COUNT;
const SOLO_INDEX = 0;
const REPORT_FILE = "/workspace/research/incident-review.md";

interface Shard {
  region: "emea" | "amer" | "apac";
  incidents: number;
  downtime: number;
}

const SHARDS: Shard[] = [
  { region: "emea", incidents: 17, downtime: 682 },
  { region: "amer", incidents: 15, downtime: 641 },
  { region: "apac", incidents: 13, downtime: 709 },
];

/** A shard's fingerprint in free-form worker output: its distinctive downtime total. */
function shardSignature(shard: Shard): RegExp {
  return new RegExp(`\\b${shard.downtime}\\b`);
}

interface Fact {
  label: string;
  pattern: RegExp;
}

/** The report format is prescribed, so every fact is anchored to its region or label on one line. */
const MERGED_FACTS: Fact[] = [
  ...SHARDS.map((s) => ({
    label: `${s.region}-incidents=${s.incidents}`,
    pattern: new RegExp(`\\b${s.region}\\b[^\\n]{0,60}\\b${s.incidents}\\b`, "i"),
  })),
  ...SHARDS.map((s) => ({
    label: `${s.region}-downtime=${s.downtime}`,
    pattern: new RegExp(`\\b${s.region}\\b[^\\n]{0,80}\\b${s.downtime}\\b`, "i"),
  })),
  { label: "total-incidents=45", pattern: /total incidents[^\n]{0,20}\b45\b/i },
  { label: "total-downtime=2032", pattern: /total downtime[^\n]{0,30}\b2,?032\b/i },
  {
    label: "top-cause=dependency-failure",
    pattern: /most common root cause[^\n]{0,40}dependency[- _]failure/i,
  },
  {
    label: "longest=INC-3301",
    pattern: /longest incident[^\n]{0,40}(INC-3301|tokyo[- ]edge[- ]cache)/i,
  },
];

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

function mergedCorrectness(reporter: number): DeterministicCheck {
  return {
    name: "merged-answer-key",
    fn: async (ctx): Promise<CheckResult> => {
      const content = await readReport(ctx, reporter);
      if (content === null) return { pass: false, score: 0, detail: `${REPORT_FILE} not found` };
      const missing = MERGED_FACTS.filter((f) => !f.pattern.test(content)).map((f) => f.label);
      const matched = MERGED_FACTS.length - missing.length;
      return {
        pass: missing.length === 0,
        score: matched / MERGED_FACTS.length,
        detail:
          missing.length === 0
            ? `${matched}/${MERGED_FACTS.length} answer-key facts present`
            : `${matched}/${MERGED_FACTS.length} facts present (missing: ${missing.join(", ")})`,
      };
    },
  };
}

// ---- delegation (swarm only) ----

/** Words only a query for the incident DATA carries (a lead checking on its children does not). */
const DATASET_QUERY_RE = /region|INC-\d|downtime|root_cause/i;

function limitAtLeast(input: string, min: number): boolean {
  const m = /"limit"\s*:\s*(\d+)/.exec(input);
  return m !== null && Number(m[1]) >= min;
}

/**
 * Did the lead pull the incident records itself? Every route, per Rule 5:
 * `db-query`; a get-tasks/list-tasks call filtered on the dataset (search/tags
 * naming a region or incident field) or paging 30+ rows; a Bash/fetch against
 * the `/api/tasks?` list endpoint with the same shape. Reading its own child
 * tasks is mandatory and never flagged: get-task-details, get-tasks without a
 * dataset filter (full text included, to read worker output), `/api/tasks/<id>`.
 */
function leadPulledDataset(tools: ToolUse[]): ToolUse | undefined {
  return tools.find((u) => {
    if (toolUseMatches(u.toolName, ["db-query", "db_query"])) return true;
    const input = safeStringify(u.input);
    if (toolUseMatches(u.toolName, ["get-tasks", "list-tasks", "get_tasks", "list_tasks"])) {
      return DATASET_QUERY_RE.test(input) || limitAtLeast(input, 30);
    }
    if (toolUseMatches(u.toolName, [/^bash$/i, "command_execution"])) {
      return (
        /\/api\/tasks\?/i.test(input) &&
        (DATASET_QUERY_RE.test(input) || /limit=(?:[3-9]\d|\d{3,})/i.test(input))
      );
    }
    return false;
  });
}

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

const PENALTY_LOOP = 0.5;
const W_F1 = 3;
const W_F2 = 3;
const W_F3 = 1;
const W_F4 = 4;

const fanoutDelegation: DeterministicCheck = {
  name: "fanout-paper-trail",
  fn: async (ctx): Promise<CheckResult> => {
    const lead = ctx.workers.find((w) => w.isLead);
    if (!lead) return { pass: false, score: 0, detail: "no lead agent in roster" };
    const leadTasks = ctx.tasks.filter((t) => t.agentId === lead.agentId);
    const leadTools: ToolUse[] = [];
    for (const t of leadTasks) leadTools.push(...(await taskToolUses(ctx, t)));

    // Hard zero: the lead researched the incident records itself.
    const solo = leadPulledDataset(leadTools);
    if (solo) {
      return {
        pass: false,
        score: 0,
        detail: `lead queried the incident records itself (${solo.toolName}) — delegation zeroed`,
      };
    }

    const children = workerTasks(ctx, lead.agentId);
    const done = children.filter(isCompletedWithOutput);

    // F1: the shards went to three distinct workers.
    const distinctWorkers = new Set(children.map((t) => t.agentId)).size;
    const f1 = Math.min(distinctWorkers, WORKER_COUNT) / WORKER_COUNT;

    // F2: every shard done exactly once, identified from worker OUTPUT.
    const perShard = SHARDS.map((s) => ({
      shard: s,
      doneBy: done.filter((t) => shardSignature(s).test(t.result ?? "")),
    }));
    const f2 = perShard.filter((p) => p.doneBy.length === 1).length / SHARDS.length;

    // F3: fan-out — every shard task created before the first one finished.
    const shardTasks = perShard.flatMap((p) => (p.doneBy[0] ? [p.doneBy[0]] : []));
    const created = shardTasks.map((t) => timeOf(t.createdAt));
    const finished = shardTasks.map((t) => timeOf(t.finishedAt));
    let f3: number | null = null;
    if (shardTasks.length < 2) f3 = 0;
    else if (created.every((c) => c !== null) && finished.every((f) => f !== null)) {
      const lastCreated = Math.max(...(created as number[]));
      const firstFinished = Math.min(...(finished as number[]));
      f3 = lastCreated <= firstFinished ? 1 : 0;
    }

    // F4: of the shard facts in the report, the fraction also in worker output.
    let f4 = 0;
    const report = await readReport(ctx, LEAD_INDEX);
    if (report) {
      const inReport = SHARDS.filter((s) => shardSignature(s).test(report));
      if (inReport.length > 0) {
        const traced = inReport.filter((s) =>
          done.some((t) => shardSignature(s).test(t.result ?? "")),
        );
        f4 = traced.length / inReport.length;
      }
    }

    const parts: [number, number | null][] = [
      [W_F1, f1],
      [W_F2, f2],
      [W_F3, f3],
      [W_F4, f4],
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
      `F1=${f1.toFixed(2)}(${distinctWorkers} workers, ${children.length} children)`,
      `F2=${f2.toFixed(2)}(${perShard.map((p) => `${p.shard.region}×${p.doneBy.length}`).join(" ")})`,
      `F3=${f3 === null ? "n/a(no timestamps)" : f3.toFixed(2)}`,
      `F4=${f4.toFixed(2)}(facts→workers)`,
    ];
    if (loops.length > 0) flags.push(`loop penalty (${loops.length} worker-created tasks)`);
    return {
      pass: score >= 1,
      score,
      detail: `delegation ${score.toFixed(2)} — ${flags.join(", ")}`,
    };
  },
};

// ---- rubric ----

function communicationRubric(reporter: number): string {
  return [
    `Grade ONLY the incident review at ${REPORT_FILE} (read it via read_file on worker ${reporter}).`,
    "Score 0-1 on report quality, not on whether the numbers are right (deterministic checks grade",
    "that): does it give one clear line per region, a per-root-cause breakdown for each region, and",
    "the labelled summary block (total incidents, total downtime minutes, most common root cause",
    "overall, longest incident)? Is it concise and easy to scan? Do not reward length. If the file",
    "is missing or empty, score 0.",
  ].join(" ");
}

/** Outcome dimensions both variants share, read from `reporter`'s sandbox. */
function sharedDimensions(reporter: number): NonNullable<OutcomeSpec["dimensions"]> {
  return [
    { name: "correctness", weight: 3, checks: [mergedCorrectness(reporter)] },
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
  "The swarm API holds a history of past incident postmortems, stored as completed tasks. Each",
  "record's task text is a small structured record: the first line is the incident title",
  "(`INC-<n>: ...`), followed by `region:`, `service:`, `root_cause:` and `downtime_minutes:` lines.",
  "There are three regions: `emea`, `amer` and `apac`. Query the records with the `get-tasks` tool",
  "(filter with `search`, e.g. `region: emea`, or `tags`, e.g. `region:emea`; pass `includeFull: true`",
  "to get the full record; at most 100 rows per call) or with",
  "`GET $MCP_BASE_URL/api/tasks?fields=full&search=...` using your `API_KEY` env var as the bearer.",
  "",
  `Produce an incident review and write it to \`${REPORT_FILE}\` (markdown; create the directory).`,
  "It MUST contain:",
  "  - One line per region, exactly in the form `<region>: <incidents> incidents, <minutes> downtime",
  "    minutes`, followed by that region's incident count per root cause.",
  "  - A summary block with exactly these labelled lines:",
  "      Total incidents: <n>",
  "      Total downtime minutes: <n>",
  "      Most common root cause overall: <root_cause>",
  "      Longest incident: <title of the single incident with the most downtime_minutes>",
  "",
  "Every number must come from the incident records; do not estimate. Then report completion via",
  "store-progress.",
].join("\n");

const LEAD_PREAMBLE = [
  "You are the LEAD of a three-researcher swarm (researcher-1, researcher-2, researcher-3). This is",
  "a fan-out exercise:",
  "  - Split the research into the three region shards and delegate ONE region to EACH researcher,",
  "    all three at once so they work in parallel. Each researcher reports, for its region only:",
  "    the incident count, the total downtime minutes, the incident count per root cause, and its",
  "    longest incident (title and downtime minutes).",
  "  - Do NOT query the incident records yourself, and do not have any region done twice. Your job",
  "    is to orchestrate the researchers and MERGE their findings, using exactly the numbers they",
  "    report.",
  "",
  "The task:",
  "",
  "",
].join("\n");

const SOLO_PREAMBLE = "You are working alone: do all of the research yourself.\n\nThe task:\n\n";

export const fanoutResearch: Scenario = {
  id: "fanout-research",
  version: 1,
  name: "Fan-out research",
  description: [
    "A lead fans an incident-history analysis out to three researchers, one region each, in",
    "parallel, then merges the shard reports. The API is seeded with 45 incident postmortems",
    "(emea 17, amer 15, apac 13). Graded from the task tree and artifacts: one shard per worker,",
    "no shard done twice, shard tasks created before the first finished, report facts traceable",
    "to worker output (delegation, 5); the merged answer key (correctness, 3); report quality",
    "(judge, 1); cost and time against budget (efficiency, 1). A lead that queries the records",
    "itself scores zero on delegation.",
  ].join(" "),
  workers: [{ name: "researcher-1" }, { name: "researcher-2" }, { name: "researcher-3" }],
  lead: { name: "Lead", template: "lead" },
  seed: { sqlDump: "fanout-research-history.sql" },
  tasks: [
    {
      title: "Incident review by fanning out to three researchers (lead)",
      worker: "lead",
      description: LEAD_PREAMBLE + BRIEF,
    },
  ],
  outcome: {
    gates: [reportExistsGate(LEAD_INDEX)],
    dimensions: [
      { name: "delegation", weight: 5, checks: [fanoutDelegation] },
      ...sharedDimensions(LEAD_INDEX),
    ],
  },
  // The lead may defer while its researchers run; keep waiting for the children.
  awaitSpawnedTasks: true,
  timeoutMs: 15 * 60_000,
  budgetUsd: 0.75,
  budgetMs: 10 * 60_000,
};

export const fanoutResearchSolo: Scenario = soloVariant(fanoutResearch, {
  worker: { name: "researcher-1" },
  task: {
    title: "Incident review (single agent)",
    description: SOLO_PREAMBLE + BRIEF,
  },
  outcome: {
    gates: [reportExistsGate(SOLO_INDEX)],
    dimensions: sharedDimensions(SOLO_INDEX),
  },
});

// Exported for the rubric unit tests.
export const __test__ = {
  fanoutDelegation,
  leadPulledDataset,
  mergedCorrectness,
  MERGED_FACTS,
  SHARDS,
  LEAD_INDEX,
  REPORT_FILE,
  PENALTY_LOOP,
};
