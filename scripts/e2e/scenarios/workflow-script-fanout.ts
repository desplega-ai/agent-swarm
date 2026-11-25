import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { startScriptRunner } from "../script-runner";
import { getLead, upsertScript } from "./script-helpers";
import { createWorkflow, getRunDetail, outputOf, triggerWorkflow } from "./workflow-helpers";

export const workflowScriptFanout: Scenario = {
  name: "workflow-script-fanout",
  order: 502,
  async run(ctx) {
    if (ctx.db.engine !== "postgres") {
      expectStatus(
        await ctx.api("POST", "/api/script-runners/credentials", {
          body: { name: "workflow-fixture" },
        }),
        [409],
        "SQLite refuses script runner credentials",
      );
      return;
    }
    await ctx.restartSut({ env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" } });
    const lead = await getLead(ctx);
    const name = `fanout-${ctx.nonce}`;
    await upsertScript(ctx, lead, {
      name,
      scope: "global",
      source: `export default async (args: any) => {
      const start=Date.now(); await new Promise(r=>setTimeout(r,args.delay)); return {id:args.id,start,end:Date.now()};
    }`,
    });
    const minted = await ctx.api("POST", "/api/script-runners/credentials", { body: { name } });
    expectStatus(minted, [201], "mint workflow runner");
    const token = asString(asRecord(minted.json).token, "runner token");
    const credentialId = asString(
      asRecord(asRecord(minted.json).credential).id,
      "runner credential ID",
    );
    const runners = [
      startScriptRunner(ctx.baseUrl, token, 2),
      startScriptRunner(ctx.baseUrl, token, 2),
    ];
    try {
      expect(
        await pollUntil(
          async () =>
            asRecords(asRecord((await ctx.api("GET", "/api/script-runners")).json), "sessions")
              .length === 2,
          20000,
        ),
        "runners connected",
      );
      const workflow = await createWorkflow(ctx, "fanout", {
        nodes: [
          {
            id: "fan",
            type: "foreach",
            config: {
              over: Array.from({ length: 8 }, (_, i) => ({ id: String(i) })),
              itemKey: "id",
              body: {
                type: "swarm-script",
                config: {
                  scriptName: name,
                  scope: "global",
                  args: { id: "{{item.id}}", delay: 1000 },
                },
              },
            },
          },
        ],
      });
      const start = Date.now();
      const { runId } = await triggerWorkflow(ctx, workflow);
      const parked = await getRunDetail(ctx, runId);
      expect(
        parked.steps.some((step) => step.status === "waiting"),
        "trigger returns with parked script items",
      );
      expect(
        await pollUntil(
          async () => (await getRunDetail(ctx, runId)).run.status === "completed",
          30000,
        ),
        "fanout completes",
      );
      const duration = Date.now() - start;
      expect(duration < 5000, `eight bodies finish in two waves: ${duration}ms`);
      const detail = await getRunDetail(ctx, runId);
      const results = asRecords(outputOf(detail, "fan"), "results");
      expect(results.length === 8, "eight results");
      expect(
        results.every((row, i) => row.itemKey === String(i)),
        "item order",
      );
      const spans = results.map((row) => asRecord(asRecord(row.output).result));
      const peak = Math.max(
        ...spans.map(
          (span) =>
            spans.filter(
              (other) =>
                Number(other.start) <= Number(span.start) && Number(other.end) > Number(span.start),
            ).length,
        ),
      );
      expect(peak <= 4 && peak >= 2, "slot bound and actual overlap");
      console.log(
        JSON.stringify({
          fixture: "workflow-script-fanout",
          durationMs: duration,
          peak,
          results: results.length,
        }),
      );
      const jobs = await ctx.db.query<Record<string, unknown>>(
        sql`SELECT * FROM workflow_step_jobs WHERE run_id = ${runId}`,
      );
      expect(
        jobs.length === 8 && jobs.every((job) => job.status === "completed"),
        "all reference jobs settled",
      );
      expect(
        jobs.every((job) => !("result" in job) && !("payload" in job)),
        "job rows omit payload and result",
      );
      await Promise.all(runners.map((r) => r.stop("SIGKILL")));
      const single = startScriptRunner(ctx.baseUrl, token, 1);
      try {
        expect(
          await pollUntil(
            async () =>
              asRecords(asRecord((await ctx.api("GET", "/api/script-runners")).json), "sessions")
                .length === 1,
            20000,
          ),
          "single runner connected",
        );
        const forty = await createWorkflow(ctx, "forty", {
          nodes: [
            {
              id: "fan",
              type: "foreach",
              config: {
                over: Array.from({ length: 40 }, (_, i) => ({ id: String(i) })),
                itemKey: "id",
                body: {
                  type: "swarm-script",
                  config: {
                    scriptName: name,
                    scope: "global",
                    args: { id: "{{item.id}}", delay: 20 },
                  },
                },
              },
            },
          ],
        });
        const queued = await triggerWorkflow(ctx, forty);
        expect(
          await pollUntil(
            async () => (await getRunDetail(ctx, queued.runId)).run.status === "completed",
            60000,
          ),
          "forty queued bodies complete on one slot",
        );
        const rows = ctx.db.query<{ status: string; error: string | null }>(
          sql`SELECT status,error FROM workflow_step_jobs WHERE run_id=${queued.runId}`,
        );
        expect(
          rows.length === 40 &&
            rows.every((row) => row.status === "completed" && row.error === null),
          "no queue capacity failure",
        );
      } finally {
        await single.stop("SIGKILL");
      }
    } finally {
      await Promise.all(runners.map((runner) => runner.stop("SIGKILL")));
      await ctx.api("DELETE", `/api/script-runners/credentials/${credentialId}`);
      await ctx.restartSut();
    }
  },
};
