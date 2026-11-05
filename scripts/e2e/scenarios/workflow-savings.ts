// Automation savings for one workflow: a run is priced, its daily series sums to
// the same saving, an idle workflow is not valid (never $0), and bad input is rejected.
import { asRecord, asRecords, expect, expectStatus } from "../http";
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

      let response = await ctx.api("GET", `/api/savings/jobs?workflowId=${ran}&days=7&tier=smart`);
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

      // The daily series sums to the same p50 saving.
      response = await ctx.api("GET", `/api/savings/daily?workflowId=${ran}&days=7&tier=smart`);
      expectStatus(response, [200], "daily savings for a workflow with a run");
      const daily = asRecord(response.json);
      const points = asRecords(daily, "points");
      expect(daily.valid === true && points.length === 8, `8 daily points ${response.text}`);
      const pointCents = Math.round(points.reduce((s, p) => s + Number(p.savingUsd), 0) * 100);
      expect(
        pointCents === Math.round(Number(band.p50) * 100),
        `daily points sum to the p50 saving ${pointCents} vs ${band.p50}`,
      );

      response = await ctx.api("GET", `/api/savings/daily?workflowId=${idle}`);
      expectStatus(response, [200], "daily savings for an idle workflow");
      json = asRecord(response.json);
      expect(
        json.valid === false && json.reason === "no-runs" && asRecords(json, "points").length === 0,
        `idle workflow has no daily points ${response.text}`,
      );
      response = await ctx.api("GET", `/api/savings/daily?workflowId=missing-${ctx.nonce}`);
      expectStatus(response, [404], "daily: unknown workflow");

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
      expectStatus(response, [400], "missing workflowId");
    } finally {
      await deleteWorkflowQuietly(ctx, ran);
      await deleteWorkflowQuietly(ctx, idle);
    }
  },
};
