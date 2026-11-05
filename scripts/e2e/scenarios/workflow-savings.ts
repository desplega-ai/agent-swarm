// Automation savings, read from the hourly rollup: a run is priced on the
// detail route right away, the daily points add up to it, the list route
// answers, the fleet summary and fleet daily series agree, an idle workflow
// is not valid (never $0), the script routes answer, and bad input is rejected.
import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  createWorkflow,
  deleteWorkflowQuietly,
  expectRunStatus,
  triggerWorkflow,
} from "./workflow-helpers";

const DEFINITION = {
  nodes: [{ id: "hello", type: "script", config: { runtime: "bash", script: "echo savings" } }],
};

export const workflowSavings: Scenario = {
  name: "workflow-savings",
  order: 355,
  async run(ctx) {
    const ran = await createWorkflow(ctx, "savings-ran", DEFINITION);
    const idle = await createWorkflow(ctx, "savings-idle", DEFINITION);
    try {
      const { runId } = await triggerWorkflow(ctx, ran);
      await expectRunStatus(ctx, runId, "completed");

      // The rollup backfills its days on boot; wait for the first tick.
      let response = await ctx.api("GET", `/api/savings/jobs?workflowId=${ran}&days=7&tier=smart`);
      await pollUntil(async () => {
        response = await ctx.api("GET", `/api/savings/jobs?workflowId=${ran}&days=7&tier=smart`);
        return asRecord(response.json).reason !== "not-computed";
      }, 30_000);
      expectStatus(response, [200], "savings for a workflow with a run");
      let json = asRecord(response.json);
      expect(json.valid === true && json.reason === null, `valid savings ${response.text}`);
      expect(json.tier === "smart", "tier echoed");
      expect(asRecord(json.window).days === 7, "window days echoed");
      const [row] = asRecords(json, "rows");
      expect(row?.workflowId === ran && row.runs === 1, `one run counted ${response.text}`);
      expect(row?.substitutedRuns === 1 && row.basis === "modelled", "the run is substituted");
      const band = asRecord(row?.savingUsd);
      expect(
        Number(band.p10) < Number(band.p50) && Number(band.p50) < Number(band.p90),
        `saving band ordered ${JSON.stringify(band)}`,
      );

      // The daily series sums to the same p50 saving, to the cent.
      response = await ctx.api("GET", `/api/savings/daily?workflowId=${ran}&days=7&tier=smart`);
      expectStatus(response, [200], "daily savings for a workflow with a run");
      const daily = asRecord(response.json);
      const points = asRecords(daily, "points");
      expect(daily.valid === true && points.length === 7, `7 daily points ${response.text}`);
      const pointCents = Math.round(points.reduce((s, p) => s + Number(p.savingUsd), 0) * 100);
      expect(
        pointCents === Math.round(Number(band.p50) * 100),
        `daily points sum to the p50 saving ${pointCents} vs ${band.p50}`,
      );

      // The fleet total covers the run, and the fleet daily series sums to it.
      // Script days follow workflow days in the tick, so wait for both.
      await pollUntil(async () => {
        response = await ctx.api("GET", "/api/savings/summary?days=7&tier=smart");
        return asRecord(response.json).reason !== "not-computed";
      }, 30_000);
      expectStatus(response, [200], "fleet savings summary");
      const summary = asRecord(response.json);
      const fleetP50 = Number(asRecord(asRecord(summary.total).savingUsd).p50);
      expect(summary.valid === true && Number.isFinite(fleetP50), `fleet total ${response.text}`);
      expect(
        Array.isArray(summary.assumptions) && typeof summary.fleetLlmUsd === "number",
        `summary carries spend and assumptions ${response.text}`,
      );
      response = await ctx.api("GET", "/api/savings/daily?days=7&tier=smart");
      expectStatus(response, [200], "fleet daily savings");
      const fleetCents = Math.round(
        asRecords(asRecord(response.json), "points").reduce((s, p) => s + Number(p.savingUsd), 0) *
          100,
      );
      expect(
        fleetCents === Math.round(fleetP50 * 100),
        `fleet daily points sum to the fleet p50 ${fleetCents} vs ${fleetP50}`,
      );
      response = await ctx.api("GET", "/api/savings/summary?tier=huge");
      expectStatus(response, [400], "summary: unknown tier");

      // The default 30-day window is valid once the tick reaches its oldest day;
      // workflow and script days share the tick, newest first.
      await pollUntil(async () => {
        response = await ctx.api("GET", `/api/savings/daily?workflowId=${idle}`);
        return asRecord(response.json).reason !== "not-computed";
      }, 30_000);
      expectStatus(response, [200], "daily savings for an idle workflow");
      json = asRecord(response.json);
      expect(
        json.valid === false && json.reason === "no-runs" && asRecords(json, "points").length === 0,
        `idle workflow has no daily points ${response.text}`,
      );
      response = await ctx.api("GET", `/api/savings/daily?workflowId=missing-${ctx.nonce}`);
      expectStatus(response, [404], "daily: unknown workflow");

      response = await ctx.api("GET", "/api/savings/jobs?kind=workflow&days=7");
      expectStatus(response, [200], "savings for every workflow");
      expect(Array.isArray(asRecord(response.json).rows), `list rows ${response.text}`);

      response = await ctx.api("GET", `/api/savings/jobs?workflowId=${idle}`);
      expectStatus(response, [200], "savings for an idle workflow");
      json = asRecord(response.json);
      expect(
        json.valid === false && json.reason === "no-runs" && asRecords(json, "rows").length === 0,
        `idle workflow is not valid ${response.text}`,
      );

      response = await ctx.api("GET", `/api/savings/jobs?workflowId=missing-${ctx.nonce}`);
      expectStatus(response, [404], "unknown workflow");
      response = await ctx.api("GET", `/api/savings/jobs?workflowId=${ran}&tier=huge`);
      expectStatus(response, [400], "unknown tier");
      response = await ctx.api("GET", "/api/savings/jobs");
      expectStatus(response, [400], "neither workflowId nor kind");

      // Scripts read the same rollup, keyed by script name.
      response = await ctx.api("GET", "/api/savings/jobs?kind=script&days=7");
      expectStatus(response, [200], "savings for every script");
      json = asRecord(response.json);
      expect(
        Array.isArray(json.rows) && json.reason !== "not-computed",
        `script list computed ${response.text}`,
      );
      response = await ctx.api("GET", `/api/savings/jobs?scriptName=missing-${ctx.nonce}`);
      expectStatus(response, [404], "unknown script");
      response = await ctx.api("GET", `/api/savings/daily?scriptName=missing-${ctx.nonce}`);
      expectStatus(response, [404], "daily: unknown script");
      response = await ctx.api("GET", `/api/savings/jobs?scriptName=x&workflowId=${ran}`);
      expectStatus(response, [400], "two targets");
    } finally {
      await deleteWorkflowQuietly(ctx, ran);
      await deleteWorkflowQuietly(ctx, idle);
    }
  },
};
