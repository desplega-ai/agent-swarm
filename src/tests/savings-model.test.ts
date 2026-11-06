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
  splitByDay,
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
    // The $1 LLM estimate is not measured spend.
    expect(priced.measuredUsd).toBeCloseTo(10, 9);
    expect(priced.estimatedLlmUsd).toBeCloseTo(1, 9);
    expect(priced.agentOnlyUsd.p50 - 10).toBeCloseTo(4 * priced.agentOnlyUsdPerRun, 9);
    expect(priced.actualHours).toBeCloseTo(3, 9);
  });

  test("measured spend is reported unscaled; the scaled estimate keeps the saving", () => {
    // One $100 manual run and 999 skipped runs on one day.
    const window = facts({ runs: 1000, countedRuns: 1, opsSum: 10, agentTasks: 1, agentUsd: 100 });
    const priced = priceWorkflow(window, { tier: "smart", days: 30, band: "job" });
    expect(priced.substitutedRuns).toBe(1);
    expect(priced.measuredUsd).toBe(100);
    // The estimator's actual side is the scaled estimate, not the $100 measured.
    expect(priced.actualUsd).toBeCloseTo(0.1, 9);
    // Kept agent spend cancels: the saving is one substituted run at the unit cost.
    expect(priced.savingUsd.p50).toBeCloseTo(priced.agentOnlyUsdPerRun, 9);
    const [point] = splitByDay(window, [{ day: "2026-10-01", ...window }], {
      tier: "smart",
      days: 30,
    });
    expect(point?.measuredUsd).toBe(100);
    expect(point?.actualUsd).toBeCloseTo(0.1, 9);
    expect(point?.savingUsd).toBeCloseTo(priced.savingUsd.p50, 9);
  });

  test("estimated LLM spend is reported apart from measured spend", () => {
    // No recorded LLM cost: $5 is estimated from tokens and output size.
    const window = facts({ runs: 1, countedRuns: 1, opsSum: 10, estimatedLlmUsd: 5 });
    const priced = priceWorkflow(window, { tier: "smart", days: 30, band: "job" });
    expect(priced.measuredUsd).toBe(0);
    expect(priced.estimatedLlmUsd).toBe(5);
    // The saving still subtracts the estimate.
    expect(priced.actualUsd).toBe(5);
    expect(priced.savingUsd.p50).toBeCloseTo(priced.agentOnlyUsdPerRun - 5, 9);
    const [point] = splitByDay(window, [{ day: "2026-10-01", ...window }], {
      tier: "smart",
      days: 30,
    });
    expect(point?.measuredUsd).toBe(0);
    expect(point?.estimatedLlmUsd).toBe(5);
    expect(point?.actualUsd).toBe(5);
    expect(point?.savingUsd).toBeCloseTo(priced.savingUsd.p50, 9);
  });

  test("recorded LLM cost replaces the token estimate", () => {
    const priced = priceWorkflow(facts({ recordedLlmUsd: 2, estimatedLlmUsd: 5 }), {
      tier: "smart",
      days: 30,
      band: "job",
    });
    expect(priced.actualUsd).toBe(2);
    expect(priced.measuredUsd).toBe(2);
    expect(priced.estimatedLlmUsd).toBe(0);
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

  test("daily split sums to the window, and capped schedule runs spread pro rata", () => {
    // 2 days of polling every 5 minutes (288 a day) against a 1-day cap of 24,
    // plus one manual run with an agent task and a recorded LLM cost.
    const day1 = facts({
      runs: 288,
      countedRuns: 288,
      schedRuns: 288,
      schedEffectRuns: 3,
      opsSum: 288 * 5,
      recordedLlmUsd: 0.4,
    });
    const day2 = facts({
      runs: 145,
      countedRuns: 145,
      schedRuns: 144,
      schedEffectRuns: 0,
      opsSum: 145 * 5,
      agentTasks: 1,
      agentUsd: 2,
      followupUsd: 0.1,
      recordedLlmUsd: 0.2,
    });
    const window = facts({});
    for (const k of Object.keys(window) as (keyof WorkflowFacts)[]) window[k] = day1[k] + day2[k];
    const priced = priceWorkflow(window, { tier: "smart", days: 1, band: "job" });
    expect(priced.capApplied).toBe(true);
    const points = splitByDay(
      window,
      [
        { day: "2026-10-01", ...day1 },
        { day: "2026-10-02", ...day2 },
      ],
      { tier: "smart", days: 1 },
    );
    const sum = (key: "savingUsd" | "actualUsd" | "measuredUsd" | "estimatedLlmUsd") =>
      points.reduce((s, p) => s + p[key], 0);
    expect(sum("savingUsd")).toBeCloseTo(priced.savingUsd.p50, 9);
    expect(sum("actualUsd")).toBeCloseTo(priced.actualUsd, 9);
    expect(sum("measuredUsd")).toBeCloseTo(priced.measuredUsd, 9);
    expect(sum("estimatedLlmUsd")).toBeCloseTo(priced.estimatedLlmUsd, 9);
    // The 24 counted schedule runs split 288:144; the manual run stays on day 2.
    const unit = priced.agentOnlyUsdPerRun;
    const share = priced.substitutedRuns / window.runs;
    expect(points[0]?.savingUsd).toBeCloseTo(16 * unit - 0.4 * share, 9);
    expect(points[1]?.savingUsd).toBeCloseTo((8 + 1) * unit - 0.2 * share, 9);
  });
});
