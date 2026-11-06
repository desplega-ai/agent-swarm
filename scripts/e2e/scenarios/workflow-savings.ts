// Automation savings, read from the hourly rollup: a run is priced on the
// detail route right away, the daily points add up to it, the list route
// answers, an idle workflow is not valid (never $0), and bad input is rejected.
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
      // Seven rolling days touch every UTC day from the window start to its end
      // (eight, unless the window starts on the minute of midnight).
      const dailyWindow = asRecord(daily.window);
      const firstDay = String(dailyWindow.start).slice(0, 10);
      const lastDay = String(dailyWindow.end).slice(0, 10);
      const windowDays = (Date.parse(lastDay) - Date.parse(firstDay)) / 86_400_000 + 1;
      expect(
        daily.valid === true &&
          points.length === windowDays &&
          points[0]?.day === firstDay &&
          points.at(-1)?.day === lastDay,
        `${windowDays} daily points from ${firstDay} to ${lastDay} ${response.text}`,
      );
      const pointCents = Math.round(points.reduce((s, p) => s + Number(p.savingUsd), 0) * 100);
      expect(
        pointCents === Math.round(Number(band.p50) * 100),
        `daily points sum to the p50 saving ${pointCents} vs ${band.p50}`,
      );

      // The default 30-day window can still be backfilling after the 7-day one is done.
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
    } finally {
      await deleteWorkflowQuietly(ctx, ran);
      await deleteWorkflowQuietly(ctx, idle);
    }
  },
};
