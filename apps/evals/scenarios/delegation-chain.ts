import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import {
  fetchSessionLogs,
  hasTool,
  scoreResult,
  taskToolUses,
  workerTasks,
} from "./orchestration-utils.ts";

const LEAD_WORKER = 3;
const REPORT_FILE = "/workspace/delegation-chain/final-report.md";

const FACTS = [
  {
    label: "phase-1-completed-count",
    pattern: /completed[^\n]{0,40}\b21\b|\b21\b[^\n]{0,40}completed/i,
  },
  {
    label: "phase-2-top-task",
    pattern: /rotate[\s\S]{0,60}payments[\s\S]{0,60}api[\s\S]{0,60}keys/i,
  },
  {
    label: "phase-3-anomaly",
    pattern: /checkout[\s\S]{0,80}production|production[\s\S]{0,80}checkout/i,
  },
];

function leadAgent(ctx: JudgeContext): string | undefined {
  return ctx.workers.find((w) => w.isLead)?.agentId;
}

function dependsOnChild(child: SwarmTask, children: SwarmTask[]): boolean {
  const deps = Array.isArray(child.dependsOn) ? (child.dependsOn as string[]) : [];
  return deps.some((dep) => children.some((candidate) => candidate.id === dep));
}

function childOrder(children: SwarmTask[]): SwarmTask[] {
  const byId = new Map(children.map((c) => [c.id, c]));
  return [...children].sort((a, b) => {
    const aDeps = Array.isArray(a.dependsOn) ? (a.dependsOn as string[]) : [];
    const bDeps = Array.isArray(b.dependsOn) ? (b.dependsOn as string[]) : [];
    if (aDeps.some((id) => id === b.id || byId.has(id))) return 1;
    if (bDeps.some((id) => id === a.id || byId.has(id))) return -1;
    return a.id.localeCompare(b.id);
  });
}

const chainStructureCheck: DeterministicCheck = {
  name: "delegation-chain-paper-trail",
  fn: async (ctx): Promise<CheckResult> => {
    const leadId = leadAgent(ctx);
    const leadTask = ctx.tasks.find(
      (t) => t.agentId === leadId && (t.parentTaskId ?? null) == null,
    );
    const leadTools = await taskToolUses(ctx, leadTask);
    if (hasTool(leadTools, ["get-tasks", "list-tasks", "db-query", "db_query"])) {
      return {
        pass: false,
        score: 0,
        detail: "lead queried task history directly — chain dimension zeroed",
      };
    }

    const children = workerTasks(ctx, leadId);
    const chained = children.filter((c) => dependsOnChild(c, children));
    const completed = children.filter(
      (c) => c.status === "completed" && typeof c.result === "string" && c.result.trim(),
    );
    let sessions = 0;
    for (const child of children)
      if ((await fetchSessionLogs(ctx, child.id, 1)).length > 0) sessions++;

    const ordered = childOrder(children);
    const flowFacts = ordered
      .map((child, index) => {
        const text = `${child.description}\n${child.result ?? ""}`;
        if (index === 0) return /completed/i.test(text);
        if (index === 1) return /completed|top|priority/i.test(text);
        return /anomal|checkout|production/i.test(text);
      })
      .filter(Boolean).length;

    const score =
      ((children.length >= 3 ? 2 : children.length >= 2 ? 1 : 0) +
        (chained.length >= 2 ? 3 : chained.length === 1 ? 1.5 : 0) +
        (children.length > 0 ? completed.length / children.length : 0) * 2 +
        (children.length > 0 ? sessions / children.length : 0) +
        Math.min(1, flowFacts / 3) * 2) /
      10;
    return scoreResult("delegation chain", score, [
      `children=${children.length}`,
      `dependsOn-links=${chained.length}`,
      `completed=${completed.length}`,
      `sessions=${sessions}`,
      `flow=${flowFacts}/3`,
    ]);
  },
};

// ---------------------------------------------------------------------------
// dispatch-structure: a per-hop STRUCTURAL axis, additive to chainStructureCheck
// above. The existing check grades the outcome paper-trail (child count,
// dependsOn links, completed status, flow-fact keywords diluted across a 10-point
// scale) — a lead that creates 3 children with a valid dependsOn shape but routes
// the WRONG content to the wrong worker, or has one worker silently do all three
// phases' thinking while the other two just echo pasted text, can still score
// well there. This check verifies the DISPATCH itself was correct:
//   shape     — the three children form a single strict linear dependsOn chain
//               (no branching/fan-in), not just "≥2 links exist somewhere".
//   identity  — hop i actually landed on the worker the scenario names for
//               phase i ("phase-one"/"phase-two"/"phase-three"), not just ANY
//               of the three workers. Neutral (doesn't move the score) when the
//               roster capture didn't resolve a name, so a name-capture gap
//               degrades to no-signal rather than a false negative.
//   topic     — the task DESCRIPTION handed to hop i (what the lead asked for,
//               not what came back) matches that phase's expected subject.
//   real-work — hop i's own session log shows at least one tool call, i.e. the
//               worker actually did something rather than the lead pre-computing
//               the answer and the child just echoing it back.
// ---------------------------------------------------------------------------
const PHASE_NAMES = ["phase-one", "phase-two", "phase-three"];
const PHASE_TOPICS: RegExp[] = [
  /completed/i,
  /top|priority|highest/i,
  /anomal|checkout|production/i,
];

/** A single strict linear chain: child[0] has no internal dep, child[i] depends
 * on EXACTLY child[i-1] (no fan-in/fan-out) for i > 0. */
function isStrictLinearChain(ordered: SwarmTask[]): boolean {
  if (ordered.length === 0) return false;
  const byId = new Map(ordered.map((c) => [c.id, c]));
  for (let i = 0; i < ordered.length; i++) {
    const deps = Array.isArray(ordered[i]!.dependsOn) ? (ordered[i]!.dependsOn as string[]) : [];
    const internalDeps = deps.filter((d) => byId.has(d));
    if (i === 0) {
      if (internalDeps.length !== 0) return false;
    } else if (internalDeps.length !== 1 || internalDeps[0] !== ordered[i - 1]!.id) {
      return false;
    }
  }
  return true;
}

const dispatchStructureCheck: DeterministicCheck = {
  name: "delegation-chain-dispatch-structure",
  fn: async (ctx): Promise<CheckResult> => {
    const leadId = leadAgent(ctx);
    const children = workerTasks(ctx, leadId);
    const ordered = childOrder(children);
    const shapeOk = children.length === 3 && isStrictLinearChain(ordered);

    const hopCount = Math.min(PHASE_NAMES.length, ordered.length);
    let identityConsidered = 0;
    let identityMatched = 0;
    let topicMatched = 0;
    let realWorkMatched = 0;
    const hopDetails: string[] = [];

    for (let i = 0; i < hopCount; i++) {
      const child = ordered[i]!;
      const expectedAgent = ctx.workers.find((w) => w.name === PHASE_NAMES[i])?.agentId;
      let identityLabel = "worker?";
      if (expectedAgent) {
        identityConsidered++;
        const matched = child.agentId === expectedAgent;
        if (matched) identityMatched++;
        identityLabel = matched ? "right-worker" : "wrong-worker";
      }
      const onTopic = PHASE_TOPICS[i]!.test(child.description ?? "");
      if (onTopic) topicMatched++;
      const tools = await taskToolUses(ctx, child);
      if (tools.length > 0) realWorkMatched++;
      hopDetails.push(
        `hop${i}=${identityLabel}/${onTopic ? "on-topic" : "off-topic"}/${tools.length > 0 ? "worked" : "idle"}`,
      );
    }

    const identityScore = identityConsidered > 0 ? identityMatched / identityConsidered : 1;
    const topicScore = hopCount > 0 ? topicMatched / hopCount : 0;
    const realWorkScore = hopCount > 0 ? realWorkMatched / hopCount : 0;

    const score =
      (3 * (shapeOk ? 1 : 0) + 2 * identityScore + 3 * topicScore + 2 * realWorkScore) / 10;

    return scoreResult("dispatch structure", score, [
      `shape=${shapeOk ? "linear-3" : `broken(${children.length} children)`}`,
      `identity=${identityMatched}/${identityConsidered}`,
      `topic=${topicMatched}/${hopCount}`,
      `real-work=${realWorkMatched}/${hopCount}`,
      ...hopDetails,
    ]);
  },
};

const chainCorrectnessCheck: DeterministicCheck = {
  name: "chain-final-answer-key",
  fn: async (ctx): Promise<CheckResult> => {
    const lead = ctx.workers[LEAD_WORKER];
    const report = lead ? await lead.readFile(REPORT_FILE) : null;
    const text = report ?? ctx.tasks.find((t) => t.agentId === leadAgent(ctx))?.result ?? "";
    const matched = FACTS.filter((f) => f.pattern.test(text)).length;
    return {
      pass: matched === FACTS.length,
      score: matched / FACTS.length,
      detail: `${matched}/${FACTS.length} final facts present`,
    };
  },
};

const finalReportGate: DeterministicCheck = {
  name: `chain-report-exists[w${LEAD_WORKER}]`,
  fn: async (ctx) => {
    const lead = ctx.workers[LEAD_WORKER];
    const report = lead ? await lead.readFile(REPORT_FILE) : null;
    const leadOutput = ctx.tasks.find((t) => t.agentId === leadAgent(ctx))?.result;
    return {
      pass: Boolean(report?.trim() || (typeof leadOutput === "string" && leadOutput.trim())),
      detail: "final report file or lead output present",
    };
  },
};

export const delegationChain: Scenario = {
  id: "delegation-chain",
  name: "Delegation chain",
  description:
    "Lead-driven sequential delegation with dependsOn links, grading the child-task paper trail instead of raw audit ability.",
  workers: [{ name: "phase-one" }, { name: "phase-two" }, { name: "phase-three" }],
  lead: { name: "Lead", template: "lead" },
  seed: { sqlDump: "sql-audit-history.sql" },
  tasks: [
    {
      title: "Run a three-phase chained audit through workers",
      worker: "lead",
      description: [
        "You are the lead. Do not query task history yourself and do not use db-query.",
        "Create a sequential chain of three worker tasks using dependsOn: phase-one counts completed tasks, phase-two depends on phase-one and identifies the highest-priority completed task, phase-three depends on phase-two and checks for the planted anomaly.",
        "Merge the worker outputs into one final report at /workspace/delegation-chain/final-report.md and complete with store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [finalReportGate],
    dimensions: [
      { name: "delegation-chain", weight: 5, checks: [chainStructureCheck] },
      { name: "dispatch-structure", weight: 3, checks: [dispatchStructureCheck] },
      { name: "correctness", weight: 2, checks: [chainCorrectnessCheck] },
    ],
  },
  timeoutMs: 16 * 60_000,
};

export const __test__ = {
  chainStructureCheck,
  dispatchStructureCheck,
  chainCorrectnessCheck,
  finalReportGate,
  isStrictLinearChain,
  PHASE_NAMES,
  PHASE_TOPICS,
  REPORT_FILE,
  LEAD_WORKER,
};
