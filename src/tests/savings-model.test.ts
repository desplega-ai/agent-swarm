import { describe, expect, test } from "bun:test";
import {
  CURVE,
  curve,
  DEFAULT_OPS,
  F_FOLLOWUP,
  jobKey,
  nodeOpsOf,
  priceWorkflow,
  SAVINGS_TIERS,
  type WorkflowFacts,
} from "../be/savings/model";

const facts = (over: Partial<WorkflowFacts> = {}): WorkflowFacts => ({
  runs: 1,
  countedRuns: 1,
  schedRuns: 0,
  schedEffectRuns: 0,
  opsSum: 0,
  agentTasks: 0,
  agentUsd: 0,
  agentMs: 0,
  followupUsd: 0,
  recordedLlmUsd: 0,
  estimatedLlmUsd: 0,
  computeSecs: 0,
  ...over,
});

const perRun = (ops: number) =>
  SAVINGS_TIERS.map(
    (tier) =>
      priceWorkflow(facts({ opsSum: ops }), { tier, days: 30, band: "job" }).agentOnlyUsdPerRun,
  );

// The report rounds its cells by hand (ultra pr-fix-loop: 3.03 vs 3.044), so allow 1.5 cents.
function expectReportRow(ops: number, row: number[]) {
  perRun(ops).forEach((value, i) => {
    expect(Math.abs(value - (row[i] as number))).toBeLessThan(0.015);
  });
}

describe("savings model", () => {
  test("agent-only cost of one run matches the cost report table", () => {
    // Report table "Agent-only cost of one run", smol/regular/smart/ultra.
    expectReportRow(11, [0.12, 0.26, 0.41, 0.82]); // claude-code-changelog-watch
    expectReportRow(100, [0.15, 0.78, 1.46, 3.03]); // pr-fix-loop
  });

  test("every tier curve has one point per turn up to TAU_MAX", () => {
    for (const tier of SAVINGS_TIERS) {
      expect(CURVE[tier].usd).toHaveLength(61);
      expect(CURVE[tier].hrs).toHaveLength(61);
    }
    // Interpolates and clamps.
    expect(curve(1.5, "smart", "usd")).toBeCloseTo((0.1746 + 0.2138) / 2, 6);
    expect(curve(0, "smart", "usd")).toBe(0.1746);
    expect(curve(500, "smart", "usd")).toBe(2.8086);
  });

  test("schedule runs are capped at 24 a day, but effect runs always count", () => {
    const priced = priceWorkflow(
      facts({ runs: 1100, countedRuns: 1050, schedRuns: 1000, schedEffectRuns: 800, opsSum: 0 }),
      { tier: "smart", days: 30, band: "job" },
    );
    // max(min(1000, 720), 800) + (1050 - 1000) non-schedule runs
    expect(priced.substitutedRuns).toBe(850);
    expect(priced.effectRuns).toBe(80);
    expect(priced.enabledOnlyRuns).toBe(250);
    expect(priced.capApplied).toBe(true);

    const under = priceWorkflow(facts({ runs: 10, countedRuns: 10, schedRuns: 10 }), {
      tier: "smart",
      days: 30,
      band: "job",
    });
    expect(under.substitutedRuns).toBe(10);
    expect(under.capApplied).toBe(false);
  });

  test("the band is wider for one job than for a fleet sum, and p50 is the point", () => {
    const f = facts({ runs: 100, countedRuns: 100, opsSum: 100 * 40 });
    const job = priceWorkflow(f, { tier: "smart", days: 30, band: "job" });
    const fleet = priceWorkflow(f, { tier: "smart", days: 30, band: "fleet" });
    expect(job.savingUsd.p50).toBeCloseTo(fleet.savingUsd.p50, 9);
    expect(job.savingUsd.p50).toBeCloseTo(100 * job.agentOnlyUsdPerRun, 9);
    expect(job.savingUsd.p10).toBeLessThan(fleet.savingUsd.p10);
    expect(job.savingUsd.p90).toBeGreaterThan(fleet.savingUsd.p90);
    expect(job.hoursSaved.p10).toBeLessThan(job.hoursSaved.p50);
  });

  test("kept agent spend appears on both sides; actual spend is per substituted run", () => {
    const priced = priceWorkflow(
      facts({
        runs: 4,
        countedRuns: 4,
        opsSum: 40,
        agentTasks: 2,
        agentUsd: 8,
        followupUsd: 2,
        estimatedLlmUsd: 1,
        agentMs: 7_200_000,
        computeSecs: 3600,
      }),
      { tier: "smart", days: 30, band: "job" },
    );
    expect(priced.actualUsd).toBeCloseTo(11, 9);
    expect(priced.agentOnlyUsd.p50 - 10).toBeCloseTo(4 * priced.agentOnlyUsdPerRun, 9);
    expect(priced.actualHours).toBeCloseTo(3, 9);
  });

  test("recorded LLM cost replaces the token estimate", () => {
    const priced = priceWorkflow(facts({ recordedLlmUsd: 2, estimatedLlmUsd: 5 }), {
      tier: "smart",
      days: 30,
      band: "job",
    });
    expect(priced.actualUsd).toBe(2);
  });

  test("a pure agent dispatcher substitutes nothing and pays no review", () => {
    const priced = priceWorkflow(facts({ runs: 2, countedRuns: 2, agentTasks: 2, agentUsd: 4 }), {
      tier: "smart",
      days: 30,
      band: "job",
    });
    expect(priced.agentOnlyUsdPerRun).toBe(0);
    expect(priced.savingUsd.p50).toBe(0);
  });

  test("node ops and job keys", () => {
    const ops = nodeOpsOf(
      {
        nodes: [
          { id: "s", type: "script", config: { script: "await a(); await b()" } },
          { id: "bare", type: "script", config: { script: "echo hi" } },
          { id: "known", type: "swarm-script", config: { scriptName: "known" } },
          { id: "unknown", type: "swarm-script", config: { scriptName: "nope" } },
          { id: "n", type: "notify" },
          { id: "a", type: "agent-task" },
        ],
      },
      new Map([["known", 42]]),
    );
    expect(Object.fromEntries(ops)).toEqual({
      s: 2,
      bare: 1,
      known: 42,
      unknown: DEFAULT_OPS,
      n: 1,
      a: 0,
    });
    expect(jobKey("pr-fix-loop-retired-2026-10-28")).toBe("pr-fix-loop");
    expect(jobKey("pr-fix-loop")).toBe("pr-fix-loop");
    expect(F_FOLLOWUP).toBe(0.107);
  });
});
