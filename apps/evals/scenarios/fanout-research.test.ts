import { describe, expect, test } from "bun:test";
import { validateBaselinePairs, validateScenario } from "../src/registry.ts";
import type { JudgeContext, SwarmTask } from "../src/types.ts";
import { __test__, fanoutResearch, fanoutResearchSolo } from "./fanout-research.ts";
import { fixture, __test__ as ref } from "./grader-fixtures/fanout-research.ts";
import { gradeOffline, makeContext, nullTasks, toolCallRows } from "./grader-validation-support.ts";

const { fanoutDelegation, mergedCorrectness, REPORT_FILE, LEAD_INDEX } = __test__;

type Region = keyof typeof ref.SHARD_RESULTS;

/** The reference run, with tasks, lead logs and report swapped per case. */
function ctxWith(opts: {
  children?: SwarmTask[];
  leadLogs?: Record<string, unknown>[];
  report?: string;
}): JudgeContext {
  const [seed] = nullTasks(fanoutResearch);
  return makeContext(fanoutResearch, {
    tasks: [
      { ...(seed as SwarmTask), agentId: ref.LEAD, result: "done" },
      ...(opts.children ?? [ref.child("emea", 0), ref.child("amer", 1), ref.child("apac", 2)]),
    ],
    files: { [`w${LEAD_INDEX}:${REPORT_FILE}`]: opts.report ?? ref.REVIEW },
    logs: { "task-0": opts.leadLogs ?? [] },
  });
}

async function delegation(ctx: JudgeContext) {
  return fanoutDelegation.fn(ctx);
}

describe("fanout-research delegation rubric", () => {
  test("the reference fan-out scores 1.0, and reading child output via get-tasks is not flagged", async () => {
    const res = await delegation(fixture.reference());
    expect(res.score).toBe(1);
    expect(res.detail).toContain("emea×1 amer×1 apac×1");
  });

  test.each([
    [
      "get-tasks search",
      "mcp__agent-swarm__get-tasks",
      { search: "region: emea", includeFull: true },
    ],
    ["get-tasks tag filter", "mcp__agent-swarm__get-tasks", { tags: ["region:apac"] }],
    ["get-tasks paging the history", "mcp__agent-swarm__get-tasks", { limit: 100 }],
    ["db-query", "mcp__agent-swarm__db-query", { sql: "SELECT task FROM agent_tasks" }],
    [
      "curl on the list endpoint",
      "Bash",
      {
        command:
          'curl -s "$MCP_BASE_URL/api/tasks?fields=full&search=region" -H "Authorization: Bearer $API_KEY"',
      },
    ],
  ])("a lead that pulls the incident records itself (%s) is zeroed", async (_label, tool, input) => {
    const res = await delegation(
      ctxWith({ leadLogs: toolCallRows("task-0", tool, input, "[]", "toolu_solo") }),
    );
    expect(res.score).toBe(0);
    expect(res.detail).toContain("queried the incident records itself");
  });

  test("the lead reading one child task over the API is not flagged", async () => {
    const res = await delegation(
      ctxWith({
        leadLogs: toolCallRows(
          "task-0",
          "Bash",
          { command: 'curl -s "$MCP_BASE_URL/api/tasks/child-emea"' },
          "{}",
          "toolu_read_child",
        ),
      }),
    );
    expect(res.score).toBe(1);
  });

  test("a shard done twice and another missed costs F2", async () => {
    const dup = { ...ref.child("emea", 2), id: "child-emea-again" };
    const res = await delegation(
      ctxWith({ children: [ref.child("emea", 0), ref.child("amer", 1), dup] }),
    );
    expect(res.detail).toContain("emea×2 amer×1 apac×0");
    expect(res.score).toBeLessThan(0.8);
  });

  test("one worker that pulled all 45 rows shows up as doing every shard", async () => {
    const all = Object.values(ref.SHARD_RESULTS).join("\n");
    const res = await delegation(
      ctxWith({
        children: [
          { ...ref.child("emea", 0), result: all },
          ref.child("amer", 1),
          ref.child("apac", 2),
        ],
      }),
    );
    expect(res.detail).toContain("emea×1 amer×2 apac×2");
    // F2 = 1/3: (3·1 + 3·⅓ + 1·1 + 4·1) / 11
    expect(res.score).toBeCloseTo(9 / 11, 5);
  });

  test("a relay (each shard sent after the previous finished) fails F3", async () => {
    const relay = (["emea", "amer", "apac"] as Region[]).map((region, i) => ({
      ...ref.child(region, i),
      createdAt: new Date(Date.UTC(2026, 8, 30, 10, i * 10, 0)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 8, 30, 10, i * 10 + 5, 0)).toISOString(),
    }));
    const res = await delegation(ctxWith({ children: relay }));
    expect(res.detail).toContain("F3=0.00");
    expect(res.score).toBeCloseTo(10 / 11, 5);
  });

  test("missing timestamps drop F3 instead of scoring it 0", async () => {
    const bare = (["emea", "amer", "apac"] as Region[]).map((region, i) => {
      const { createdAt: _c, finishedAt: _f, ...rest } = ref.child(region, i);
      return rest;
    });
    const res = await delegation(ctxWith({ children: bare }));
    expect(res.detail).toContain("F3=n/a");
    expect(res.score).toBe(1);
  });

  test("report facts that no worker reported lower F4 (lead re-derived them)", async () => {
    const res = await delegation(
      ctxWith({
        children: [
          ref.child("emea", 0),
          ref.child("amer", 1),
          { ...ref.child("apac", 2), result: "apac done, see my notes" },
        ],
      }),
    );
    expect(res.detail).toMatch(/F4=0\.67/);
  });

  test("a worker that re-delegates costs the loop penalty", async () => {
    const loop: SwarmTask = {
      id: "loop",
      title: "sub",
      description: "",
      status: "completed",
      creatorAgentId: "worker-0",
      agentId: "worker-1",
      result: "",
    };
    const ctx = ctxWith({});
    const res = await delegation({ ...ctx, tasks: [...ctx.tasks, loop] });
    expect(res.score).toBeCloseTo(1 - __test__.PENALTY_LOOP, 5);
  });
});

describe("fanout-research correctness", () => {
  test("the reference review has every fact", async () => {
    const res = await mergedCorrectness(LEAD_INDEX).fn(fixture.reference());
    expect(res.score).toBe(1);
  });

  test("merging per-region top causes instead of summing per-cause counts misses the overall cause", async () => {
    const naive = ref.REVIEW.replace(
      "Most common root cause overall: dependency-failure",
      "Most common root cause overall: cert-expiry",
    );
    const res = await mergedCorrectness(LEAD_INDEX).fn(ctxWith({ report: naive }));
    expect(res.detail).toContain("missing: top-cause=dependency-failure");
  });

  test("a count reported against the wrong region does not match", async () => {
    const swapped = ref.REVIEW.replace("emea: 17 incidents", "emea: 15 incidents");
    const res = await mergedCorrectness(LEAD_INDEX).fn(ctxWith({ report: swapped }));
    expect(res.detail).toContain("emea-incidents=17");
  });

  test("a correct solo run that also delegated nothing still passes the solo rubric", async () => {
    const grade = await gradeOffline({
      scenario: fanoutResearchSolo,
      ctx: makeContext(fanoutResearchSolo, {
        tasks: nullTasks(fanoutResearchSolo),
        files: { [`w0:${REPORT_FILE}`]: ref.REVIEW },
      }),
      judgeScore: 1,
    });
    expect(grade.passed).toBe(true);
    expect(grade.dimensions.map((d) => d.name)).toEqual([
      "correctness",
      "communication",
      "efficiency",
    ]);
  });

  test("a solo-researching lead with a perfect report does not pass the swarm rubric", async () => {
    const grade = await gradeOffline({
      scenario: fanoutResearch,
      ctx: ctxWith({
        children: [],
        leadLogs: toolCallRows("task-0", "mcp__agent-swarm__get-tasks", { limit: 100 }, "[]", "t"),
      }),
      judgeScore: 1,
    });
    expect(grade.dimensions.find((d) => d.name === "delegation")?.subScore).toBe(0);
    expect(grade.passed).toBe(false);
  });
});

describe("fanout-research prompts and variants", () => {
  test("no prompt leaks an answer-key fact", () => {
    for (const s of [fanoutResearch, fanoutResearchSolo]) {
      const prompt = s.tasks.map((t) => t.description).join("\n");
      for (const leak of [/\b682\b/, /\b641\b/, /\b709\b/, /\b2,?032\b/, /\b45\b/, /\b1[357]\b/]) {
        expect(prompt).not.toMatch(leak);
      }
      expect(prompt).not.toMatch(/dependency-failure|INC-3301|tokyo/i);
    }
  });

  test("the solo variant is one worker, same brief, same budget", () => {
    expect(fanoutResearchSolo.id).toBe("fanout-research-solo");
    expect(fanoutResearchSolo.baselineOf).toBe("fanout-research");
    expect(fanoutResearchSolo.lead).toBeUndefined();
    expect(fanoutResearchSolo.workers).toHaveLength(1);
    expect(fanoutResearchSolo.seed).toEqual(fanoutResearch.seed);
    const brief = (s: typeof fanoutResearch) =>
      s.tasks[0]?.description.split("The task:\n\n")[1] ?? "";
    expect(brief(fanoutResearchSolo)).toBe(brief(fanoutResearch));
    expect(brief(fanoutResearch).length).toBeGreaterThan(200);
    for (const key of ["timeoutMs", "budgetUsd", "budgetMs", "version"] as const) {
      expect(fanoutResearchSolo[key]).toBe(fanoutResearch[key]);
    }
  });

  test("both variants validate and pair cleanly", () => {
    expect(validateScenario(fanoutResearch)).toEqual([]);
    expect(validateScenario(fanoutResearchSolo)).toEqual([]);
    expect(validateBaselinePairs([fanoutResearch, fanoutResearchSolo])).toEqual([]);
  });
});
