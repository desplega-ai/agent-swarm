import { describe, expect, it } from "bun:test";
import {
  aggregateScore,
  DEFAULT_PASS_THRESHOLD,
  dimensionScoreFromChecks,
  finalizeScore,
} from "../src/scoring.ts";
import type { JudgeContext, JudgeWorkerContext, SwarmTask } from "../src/types.ts";
import { __test__, delegationProbe } from "./delegation-probe.ts";

/**
 * Rubric unit test for the `delegation-probe` deterministic scoring (Plan A
 * §Phase 2). We construct a SYNTHETIC JudgeContext — a stubbed task list + a
 * stubbed `apiGet` that returns per-task session-logs (the first check-side
 * apiGet usage in the codebase) + a lead `readFile` that returns the merged
 * report — and run the rubric checks directly, asserting both the per-dimension
 * sub-scores AND the aggregate `passed` for three cases:
 *
 *   (a) clean delegation        → high `delegation`, high `correctness`, passes
 *   (b) solo-but-correct lead   → `delegation` === 0 (N1 fires) though
 *                                 `correctness` is high; FAILS the threshold
 *   (c) delegation loop (N3)    → `delegation` penalized below clean
 *
 * Regression coverage for the 0.50-plateau bug (research
 * `2026-06-16-delegation-probe-050-rootcause.md`): a clean delegator that ALSO
 * writes the mandatory merged report must NOT be penalized for the Write (the old
 * N2/N4 flagged it and pinned the dimension at 0.50). And a lead that audits the
 * seeded history itself via the `db-query` MCP tool MUST trip N2 (closing the
 * anti-gaming hole where N2 only watched Bash).
 */

const { delegationDimensionCheck, mergedCorrectness, reportExistsGate, REPORT_FILE } = __test__;

const LEAD_AGENT = "agent-lead";
const WORKER_A = "agent-alpha";
const WORKER_B = "agent-beta";
const LEAD_TASK_ID = "task-lead-seed";

// The four merged answer-key facts, stated correctly + attributed (correctness=1).
const CORRECT_REPORT = [
  "# Merged Audit Report",
  "",
  "## researcher-alpha (completed shard)",
  "- completed tasks: 11",
  '- highest-priority completed task: "Provision the analytics warehouse cluster"',
  "",
  "## researcher-beta (failures shard)",
  "- failed tasks: 5",
  "- cancelled tasks: 4",
  "",
  "## Merged grand total",
  "- 20 audited tasks across all statuses.",
].join("\n");

/** One Claude-style assistant session-log row carrying a tool_use block. */
function toolUseRow(
  taskId: string,
  toolName: string,
  input: unknown,
): { content: string } & Record<string, unknown> {
  return {
    id: `${taskId}-${toolName}`,
    taskId,
    sessionId: "s",
    iteration: 0,
    cli: "claude",
    lineNumber: 0,
    createdAt: "2026-06-16T00:00:00.000Z",
    content: JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: `toolu_${toolName}`, name: toolName, input }],
      },
    }),
  };
}

/**
 * Build a JudgeContext. `leadTools` are tool_use rows attributed to the lead's
 * session; `sessionLogsByTask` maps a taskId → its session-log rows (any non-
 * empty array means "the worker ran"). `report` is what the lead's readFile
 * returns for REPORT_FILE (null = no report).
 */
function makeCtx(opts: {
  tasks: SwarmTask[];
  leadTools?: { content: string }[];
  sessionLogsByTask?: Record<string, { content: string }[]>;
  report?: string | null;
}): JudgeContext {
  const sessionLogsByTask = opts.sessionLogsByTask ?? {};
  // The lead's seed-task session-logs are the lead's tool stream (N1/N2/N4 read it).
  sessionLogsByTask[LEAD_TASK_ID] = opts.leadTools ?? [];

  const apiGet = async (path: string): Promise<unknown> => {
    const m = path.match(/^\/api\/tasks\/([^/]+)\/session-logs/);
    if (m) {
      const taskId = m[1] as string;
      return { logs: sessionLogsByTask[taskId] ?? [] };
    }
    return {};
  };

  const mkWorker = (index: number, agentId: string, isLead: boolean): JudgeWorkerContext => ({
    index,
    agentId,
    isLead,
    role: isLead ? "lead" : "worker",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readFile: async (path: string) =>
      isLead && path === REPORT_FILE ? (opts.report ?? null) : null,
  });

  // Worker indices: 0 = alpha, 1 = beta, 2 = lead (member index 2, v7 §12.4).
  const workers: JudgeWorkerContext[] = [
    mkWorker(0, WORKER_A, false),
    mkWorker(1, WORKER_B, false),
    mkWorker(2, LEAD_AGENT, true),
  ];

  return {
    tasks: opts.tasks,
    transcript: "",
    exec: workers[0]!.exec,
    readFile: workers[0]!.readFile,
    apiGet,
    workers,
  };
}

/** The lead's upfront seed task (assigned to the lead, no parent, not a follow-up). */
function leadSeedTask(): SwarmTask {
  return {
    id: LEAD_TASK_ID,
    title: "Audit by delegating",
    description: "Delegate to your two researchers and merge.",
    status: "completed",
    agentId: LEAD_AGENT,
  };
}

/** A child task delegated by the lead to a worker. */
function childTask(id: string, workerAgentId: string, output: string | null): SwarmTask {
  return {
    id,
    title: `Shard for ${workerAgentId}`,
    description: "Audit your shard and report.",
    status: "completed",
    agentId: workerAgentId,
    creatorAgentId: LEAD_AGENT,
    parentTaskId: LEAD_TASK_ID,
    result: output,
  };
}

/** A system follow-up parented to a child task, assigned back to the lead. */
function followUpTask(id: string, parentChildId: string): SwarmTask {
  return {
    id,
    title: "Follow-up",
    description: "Worker completed — review.",
    status: "completed",
    agentId: LEAD_AGENT,
    source: "system",
    taskType: "follow-up",
    parentTaskId: parentChildId,
  };
}

/** Run delegation + correctness as the runner would and return the aggregate. */
async function scoreScenario(ctx: JudgeContext): Promise<{
  delegation: number;
  correctness: number;
  gatePass: boolean;
  aggregate: number;
  passed: boolean;
}> {
  const delegationRes = await delegationDimensionCheck.fn(ctx);
  const delegation = dimensionScoreFromChecks([
    { value: delegationRes.score ?? (delegationRes.pass ? 1 : 0), weight: 1 },
  ]);
  const correctnessRes = await mergedCorrectness.fn(ctx);
  const correctness = dimensionScoreFromChecks([
    { value: correctnessRes.score ?? (correctnessRes.pass ? 1 : 0), weight: 1 },
  ]);
  const gateRes = await reportExistsGate.fn(ctx);
  const dimensions = [
    { weight: 5, subScore: delegation },
    { weight: 2, subScore: correctness },
  ];
  // The pure Σwᵢ·dimᵢ/Σwᵢ aggregate (exercises aggregateScore directly)…
  const aggregate = aggregateScore(dimensions) ?? 0;
  // …and the full verdict (gate-aware passed + threshold-gated score).
  const { score, passed } = finalizeScore({
    allGatesPass: gateRes.pass,
    dimensions,
    passThreshold: DEFAULT_PASS_THRESHOLD,
  });
  // finalizeScore's score equals the aggregate when all gates pass; assert that
  // invariant so both helpers stay in agreement.
  if (gateRes.pass) expect(score).toBeCloseTo(aggregate, 10);
  return { delegation, correctness, gatePass: gateRes.pass, aggregate, passed };
}

describe("delegation-probe scenario shape", () => {
  it("registers a delegation (w5) + correctness (w2) dimension set, one lead task, the fixture", () => {
    expect(delegationProbe.id).toBe("delegation-probe");
    expect(delegationProbe.seed?.sqlDump).toBe("delegation-probe-history.sql");
    expect(delegationProbe.tasks).toHaveLength(1);
    expect(delegationProbe.tasks[0]?.worker).toBe("lead");
    const dims = delegationProbe.outcome.dimensions ?? [];
    const delegation = dims.find((d) => d.name === "delegation");
    const correctness = dims.find((d) => d.name === "correctness");
    expect(delegation?.weight).toBe(5);
    expect(correctness?.weight).toBe(2);
    // checks-XOR-judge: both dimensions are check-fed, no judge.
    expect(delegation?.checks?.length).toBeGreaterThan(0);
    expect(delegation?.judge).toBeUndefined();
    expect(correctness?.checks?.length).toBeGreaterThan(0);
    expect(correctness?.judge).toBeUndefined();
  });

  it("the lead task prompt does NOT leak the answer-key facts", () => {
    const prompt = delegationProbe.tasks[0]?.description ?? "";
    expect(prompt).not.toMatch(/\b11\b/); // completed count
    expect(prompt).not.toMatch(/analytics warehouse/i); // top-priority title
    // (5 and 4 appear only as status counts in the SEEDED DB, never in the prompt.)
    expect(prompt).not.toMatch(/\bcompleted tasks?:?\s*11\b/i);
  });
});

describe("delegation-probe rubric — three cases", () => {
  it("(a) clean delegation → high delegation + correctness, passes", async () => {
    const childA = childTask(
      "task-child-a",
      WORKER_A,
      "completed=11; top='Provision the analytics warehouse cluster'",
    );
    const childB = childTask("task-child-b", WORKER_B, "failed=5; cancelled=4");
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        childA,
        childB,
        followUpTask("task-fu-a", "task-child-a"),
        followUpTask("task-fu-b", "task-child-b"),
      ],
      // The lead delegated (send-task ×2) and then Wrote the MANDATORY merged
      // report. The Write is the `report-exists` gate's deliverable — it must NOT
      // be penalized. (This is the regression that catches the old 0.50-plateau
      // bug: the previous N2/N4 flagged any Write/Edit and double-penalized it,
      // pinning a perfect delegator at exactly 0.50.)
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", { task: "audit completed" }),
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", { task: "audit failures" }),
        toolUseRow(LEAD_TASK_ID, "Write", { file_path: REPORT_FILE, content: "# merged" }),
      ],
      // Both children have non-empty sessions (the workers ran).
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "get-tasks", { status: "completed" })],
        "task-child-b": [toolUseRow("task-child-b", "get-tasks", { status: "failed" })],
      },
      report: CORRECT_REPORT,
    });

    const r = await scoreScenario(ctx);
    expect(r.gatePass).toBe(true);
    // P1+P2+P4 all pass; the Write is NOT a penalty; Q1=1 (exactly 2 children)
    // and Q4=1 (every report fact also appears in a worker's output — worker A
    // carries completed=11 + the analytics-warehouse title, worker B carries
    // failed=5/cancelled=4) → (3+2+1+1+4)/11 = 11/11 = delegation 1.0. (Follow-up
    // tasks are present in the fixture but no longer scored — P3 was dropped.)
    expect(r.delegation).toBeCloseTo(1, 10);
    // The key regression assertion: a clean delegator scores HIGH, not 0.50.
    expect(r.delegation).toBeGreaterThan(0.75);
    expect(r.correctness).toBeCloseTo(1, 10);
    expect(r.aggregate).toBeCloseTo(1, 10);
    expect(r.passed).toBe(true);
  });

  it("(a2) writing the report is NOT penalized: a delegator that Wrote/Edited but never audited solo scores 1.0", async () => {
    // Same clean delegation tree, but the lead also ran Edit/MultiEdit in addition
    // to Write — none of which is a data-research signal. N2/N4 must stay silent.
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        // Worker outputs carry ALL the answer-key facts the merged report states
        // (completed=11 + analytics-warehouse on A; failed=5/cancelled=4 on B) so
        // Q4 (facts-flow-through-workers) = 1.0 and this test isolates the N2/N4
        // "Write/Edit is not a penalty" regression, not Q4.
        childTask(
          "task-child-a",
          WORKER_A,
          "completed=11; top='Provision the analytics warehouse cluster'",
        ),
        childTask("task-child-b", WORKER_B, "failed=5; cancelled=4"),
        followUpTask("task-fu-a", "task-child-a"),
        followUpTask("task-fu-b", "task-child-b"),
      ],
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        // After the follow-ups landed, the lead merged by Writing + Editing the
        // report file. These are deliverable edits, NOT history audits.
        toolUseRow(LEAD_TASK_ID, "Write", { file_path: REPORT_FILE }),
        toolUseRow(LEAD_TASK_ID, "Edit", { file_path: REPORT_FILE }),
        toolUseRow(LEAD_TASK_ID, "MultiEdit", { file_path: REPORT_FILE }),
      ],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    // No N2 (no db-query / data-scrape Bash) and no N4 (no data-research after
    // delegating) → the Writes/Edits cost nothing. delegation stays 1.0.
    expect(r.delegation).toBeCloseTo(1, 10);
  });

  it("(a3) anti-gaming: a lead that audits the seeded history via the db-query MCP tool trips N2", async () => {
    // The lead delegated AND wrote the report (so it'd look clean) but ALSO ran the
    // db-query MCP tool to audit `agent_tasks` itself — the anti-gaming hole the old
    // N2 (Bash-only) missed. db-query after delegating also trips N4 (re-research).
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        // Faithful worker outputs (all answer-key facts present) → Q4 = 1.0, so the
        // base positive score is 1.0 and this test isolates the N2+N4 db-query
        // penalty, not Q4.
        childTask(
          "task-child-a",
          WORKER_A,
          "completed=11; top='Provision the analytics warehouse cluster'",
        ),
        childTask("task-child-b", WORKER_B, "failed=5; cancelled=4"),
        followUpTask("task-fu-a", "task-child-a"),
        followUpTask("task-fu-b", "task-child-b"),
      ],
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        // The lead audits the history ITSELF via the db-query MCP tool.
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__db-query", {
          sql: "SELECT status, COUNT(*) FROM agent_tasks GROUP BY status",
        }),
        toolUseRow(LEAD_TASK_ID, "Write", { file_path: REPORT_FILE }),
      ],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    // P1–P4 all pass (1.0) then N2 (−0.25) for the solo db-query AND N4 (−0.25)
    // because the db-query came AFTER the lead began delegating.
    expect(r.delegation).toBeCloseTo(1 - __test__.N2_PENALTY - __test__.N4_PENALTY, 10);
    // Clearly LOWER than the clean delegator (1.0) — the hole is closed.
    expect(r.delegation).toBeLessThan(0.75);
  });

  it("(a4) N4 only: data-research AFTER delegating is penalized — WITHOUT relying on a follow-up existing", async () => {
    // A lead that delegated (NO follow-up tasks in the fixture — it disabled them /
    // manages the merge itself), then re-scraped the history via a Bash /api/tasks
    // call AFTER delegating. N2 fires (solo audit) and N4 fires (re-research after
    // delegating). N4 is now GATED on "delegated at all" (≥1 child), not on a
    // follow-up existing (Pilot-3: P3 dropped), so it still fires here. N4 is based
    // on the data-research signal, never a Write, and is ordered after the first
    // delegation.
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        // Faithful worker outputs (all answer-key facts present) → Q4 = 1.0, so the
        // base positive score is 1.0 and this test isolates the N2+N4 penalty.
        childTask(
          "task-child-a",
          WORKER_A,
          "completed=11; top='Provision the analytics warehouse cluster'",
        ),
        childTask("task-child-b", WORKER_B, "failed=5; cancelled=4"),
        // NB: NO followUpTask(...) here — proving N4 no longer depends on P3.
      ],
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        // Re-research AFTER delegating: a Bash curl against /api/tasks.
        toolUseRow(LEAD_TASK_ID, "Bash", {
          command: "curl -s http://localhost:3013/api/tasks",
        }),
        toolUseRow(LEAD_TASK_ID, "Write", { file_path: REPORT_FILE }),
      ],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    expect(r.delegation).toBeCloseTo(1 - __test__.N2_PENALTY - __test__.N4_PENALTY, 10);
  });

  it("(b) solo-but-correct lead (N1 fires) → delegation 0 though correctness high; fails", async () => {
    // The lead queried the tasks API itself WITH a status filter — the forbidden
    // solo-research signal. It still wrote a perfect merged report. N1 must ZERO
    // the delegation dimension so a solo lead cannot pass on correctness alone.
    const ctx = makeCtx({
      // No child tasks delegated — the lead did it all itself.
      tasks: [leadSeedTask()],
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "get-tasks", { status: "completed" }),
        toolUseRow(LEAD_TASK_ID, "get-tasks", { status: "failed" }),
      ],
      report: CORRECT_REPORT,
    });

    const r = await scoreScenario(ctx);
    expect(r.gatePass).toBe(true); // the report exists…
    expect(r.delegation).toBe(0); // …but N1 zeroed delegation
    expect(r.correctness).toBeCloseTo(1, 10);
    // aggregate = (5·0 + 2·1)/7 ≈ 0.286 < 0.75 → fails.
    expect(r.aggregate).toBeCloseTo(2 / 7, 5);
    expect(r.passed).toBe(false);
  });

  it("(b') N1 dominates: a solo lead that ALSO delegated still scores delegation 0", async () => {
    // Even with two real child tasks + follow-ups (P1–P4 would be 1.0), a single
    // N1 violation short-circuits the whole dimension to 0 — proving the zeroing
    // can't be diluted by partial positive credit.
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        childTask("task-child-a", WORKER_A, "completed=11"),
        childTask("task-child-b", WORKER_B, "failed=5; cancelled=4"),
        followUpTask("task-fu-a", "task-child-a"),
      ],
      leadTools: [toolUseRow(LEAD_TASK_ID, "get-tasks", { status: "completed" })],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    expect(r.delegation).toBe(0);
  });

  it("(c) delegation loop (N3) → delegation penalized below the clean score", async () => {
    // Clean baseline minus an N3 penalty: a worker re-delegated (created a task
    // with a parent). P1–P4 still pass, so the score is 1.0 − N3_PENALTY.
    const loopTask: SwarmTask = {
      id: "task-loop",
      title: "Re-delegated by a worker",
      description: "worker pushed work onward",
      status: "completed",
      agentId: WORKER_B,
      creatorAgentId: WORKER_A, // a WORKER created it…
      parentTaskId: "task-child-a", // …and it has a parent → a loop
    };
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        // Faithful worker outputs (all answer-key facts present) → Q4 = 1.0, so the
        // base positive score is 1.0 and this test isolates the N3 loop penalty.
        childTask(
          "task-child-a",
          WORKER_A,
          "completed=11; top='Provision the analytics warehouse cluster'",
        ),
        childTask("task-child-b", WORKER_B, "failed=5; cancelled=4"),
        followUpTask("task-fu-a", "task-child-a"),
        followUpTask("task-fu-b", "task-child-b"),
        loopTask,
      ],
      leadTools: [toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {})],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });

    const r = await scoreScenario(ctx);
    expect(r.delegation).toBeCloseTo(1 - __test__.N3_PENALTY, 10);
    // Strictly below the clean delegation score (1.0).
    expect(r.delegation).toBeLessThan(1);
    expect(r.delegation).toBeGreaterThan(0); // a penalty, not a zero (only N1 zeroes)
  });

  // -------------------------------------------------------------------------
  // Quality checks Q1 (task-count discipline) + Q4 (facts-flow-through-workers).
  // Q4 is the key fidelity check: of the answer-key facts in the merged report,
  // what fraction also trace back to a WORKER's output. A faithful merge scores
  // ~1.0; a lead that re-derived the facts solo (report correct, but the facts
  // are NOT in any worker output) scores Q4≈0 and the dimension drops noticeably.
  // -------------------------------------------------------------------------
  it("(q4-faithful) clean delegation with a faithful merge → delegation 1.0 (Q1=1, Q4=1)", async () => {
    // Each worker's output carries exactly the facts the merged report attributes
    // to it (A: completed=11 + analytics-warehouse title; B: failed=5/cancelled=4).
    // Every report fact traces back to a worker → Q4 = 1.0. Exactly 2 children → Q1=1.
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        childTask(
          "task-child-a",
          WORKER_A,
          "Audited completed shard: 11 completed tasks. Top: Provision the analytics warehouse cluster.",
        ),
        childTask(
          "task-child-b",
          WORKER_B,
          "Audited failures: 5 failed tasks and 4 cancelled tasks.",
        ),
        followUpTask("task-fu-a", "task-child-a"),
        followUpTask("task-fu-b", "task-child-b"),
      ],
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "Write", { file_path: REPORT_FILE }),
      ],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    // All P pass + Q1=1 + Q4=1 → 11/11 = 1.0.
    expect(r.delegation).toBeCloseTo(1, 10);
    expect(r.delegation).toBeGreaterThan(0.75);
  });

  it("(no-followup) lead delegated faithfully but NO follow-up task exists (disabled follow-ups) → delegation 1.0", async () => {
    // The exact Pilot-3 #3 scenario that motivated dropping P3: a lead that
    // delegates faithfully but sets followUpConfig.disabled on its send-task calls
    // (a legitimate choice — it manages the merge itself), so the swarm creates NO
    // system follow-up task. Under the old rubric P3 (follow-up-received) = 0 and the
    // dimension dropped 2/11 → 9/11 ≈ 0.818 even on a perfect run. With P3 dropped and
    // its weight folded into Q4, this clean delegator now scores the full 1.0 WITHOUT
    // any follow-up task in the fixture. This is the regression proving P3 is gone.
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        // Faithful worker outputs — every answer-key fact traces back to a worker.
        childTask(
          "task-child-a",
          WORKER_A,
          "Audited completed shard: 11 completed tasks. Top: Provision the analytics warehouse cluster.",
        ),
        childTask(
          "task-child-b",
          WORKER_B,
          "Audited failures: 5 failed tasks and 4 cancelled tasks.",
        ),
        // NB: NO followUpTask(...) — the lead disabled follow-ups and merges itself.
      ],
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "Write", { file_path: REPORT_FILE }),
      ],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    // P1·3 + P2·2 + P4·1 + Q1·1 + Q4·4 = 11/11 = 1.0 — no follow-up needed.
    expect(r.delegation).toBeCloseTo(1, 10);
    expect(r.delegation).toBeGreaterThan(0.75);
    expect(r.passed).toBe(true);
  });

  it("(q4-infidelity) delegated + report correct but facts NOT in worker output → Q4≈0, delegation drops below faithful", async () => {
    // Same shape (P1/P2/P4 all pass, exactly 2 children → Q1=1) and a CORRECT merged
    // report, but the workers returned only vague acknowledgements — none of the
    // answer-key facts appears in any worker output. The lead must have re-derived
    // the data solo. Q4 = 0 (0 of the 4 report facts trace to a worker), pulling the
    // dimension down to (P1·3 + P2·2 + P4·1 + Q1·1 + Q4·0)/11 = (6+1)/11 = 7/11 ≈ 0.636.
    // (Q4 now weighs 4 — it absorbed the dropped P3's weight — so infidelity costs
    // MORE than before: a correct report whose facts don't trace to workers loses
    // 4/11 of the dimension, not 2/11.)
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        childTask("task-child-a", WORKER_A, "Done — I finished auditing my shard."),
        childTask("task-child-b", WORKER_B, "Audit complete, no issues to report."),
        followUpTask("task-fu-a", "task-child-a"),
        followUpTask("task-fu-b", "task-child-b"),
      ],
      leadTools: [
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {}),
        toolUseRow(LEAD_TASK_ID, "Write", { file_path: REPORT_FILE }),
      ],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    // Q4 = 0 → (P-block 6 [P1·3+P2·2+P4·1] + Q1·1)/11 = 7/11 ≈ 0.636.
    expect(r.delegation).toBeCloseTo((6 + __test__.Q1_WEIGHT) / 11, 10);
    // Meaningfully below the faithful case (1.0) — this is Q4 catching infidelity.
    const FAITHFUL = 1;
    expect(r.delegation).toBeLessThan(FAITHFUL - 0.15);
  });

  it("(q1q4-guarded) only 1 child (P1 fails) → Q1=Q4=0, dimension stays low", async () => {
    // A single child means P1 (≥2 children) fails, so both quality checks are
    // guarded to 0 — no phantom quality credit for a non-delegator. P2 (≥2 completed)
    // also fails; only P4 (child ran) can contribute (P3 was dropped).
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        // A perfectly faithful single worker — but one child is not delegation.
        childTask(
          "task-child-a",
          WORKER_A,
          "completed=11; failed=5; cancelled=4; top='Provision the analytics warehouse cluster'",
        ),
        followUpTask("task-fu-a", "task-child-a"),
      ],
      leadTools: [toolUseRow(LEAD_TASK_ID, "mcp__agent-swarm__send-task", {})],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
      },
      report: CORRECT_REPORT,
    });
    const r = await scoreScenario(ctx);
    // P1=0, P2=0, P4 passes (weight 1), Q1=0, Q4=0 (both guarded on P1) →
    // 1/11 ≈ 0.09. (P3 was dropped — it used to add weight 2 here.)
    expect(r.delegation).toBeCloseTo(1 / 11, 10);
    // Far below a faithful delegator (1.0), and below the 0.75 dimension threshold.
    expect(r.delegation).toBeLessThan(0.5);
  });

  it("missing report → gate fails (correctness 0, cannot pass)", async () => {
    const ctx = makeCtx({
      tasks: [
        leadSeedTask(),
        childTask("task-child-a", WORKER_A, "x"),
        childTask("task-child-b", WORKER_B, "x"),
      ],
      leadTools: [toolUseRow(LEAD_TASK_ID, "send-task", {})],
      sessionLogsByTask: {
        "task-child-a": [toolUseRow("task-child-a", "x", {})],
        "task-child-b": [toolUseRow("task-child-b", "x", {})],
      },
      report: null, // no merged report written
    });
    const r = await scoreScenario(ctx);
    expect(r.gatePass).toBe(false);
    expect(r.correctness).toBe(0);
    expect(r.passed).toBe(false);
  });
});
