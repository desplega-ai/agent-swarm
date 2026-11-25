import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { getLead, registerAgent, startStub, upsertScript } from "./script-helpers";
import {
  createWorkflow,
  getRunDetail,
  outputOf,
  setGlobalConfig,
  triggerWorkflow,
} from "./workflow-helpers";

export const workflowScriptSyncBaseline: Scenario = {
  name: "workflow-script-sync-baseline",
  order: 349,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "workflow-baseline");
    const fixtureOwner = await getLead(ctx);
    const key = `E2E_WORKFLOW_BASELINE_${ctx.nonce.toUpperCase()}`;
    const dropConfig = await setGlobalConfig(ctx, key, crypto.randomUUID(), true);
    let released = false;
    const scripts: string[] = [];
    const workflows: string[] = [];
    let durableId: string | undefined;
    const durableSource = `export default async function(args: any, ctx: any) {
        const deadline = Date.now() + 30000;
        while (!(await (await fetch(args.gate)).json()).released) {
          if (Date.now() > deadline) throw new Error("inline run never released the durable step");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return await ctx.step.swarmScript("after-inline", {
          source: "export default async function() { return { startedAt: Date.now(), value: 42 }; }"
        });
      }`;
    const gate = startStub(async (request) => {
      if (request.method === "GET") return Response.json({ released });
      if (request.method !== "POST" || new URL(request.url).pathname !== "/launch") {
        return new Response(null, { status: 404 });
      }
      const launched = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: { source: durableSource, args: { gate: gate.origin }, background: true },
      });
      expectStatus(launched, [201], "launch fixture durable run");
      durableId = asString(asRecord(launched.json).id, "durable id");
      return Response.json({ id: durableId }, { status: 201 });
    });
    try {
      const name = `sync-baseline-${ctx.nonce}`;
      await upsertScript(ctx, fixtureOwner, {
        name,
        scope: "global",
        source: `export default async function(args: any, ctx: any) {
          const read = await ctx.swarm.config_get({ key: args.key, includeSecrets: true });
          const response = await fetch(args.launchUrl, { method: "POST" });
          const launched: any = await response.json();
          if (response.status !== 201) throw new Error(JSON.stringify(launched));
          return { durableId: launched.id, agentId: ctx.stdlib.Redacted.value(ctx.swarm.config.agentId),
            status: read.status, count: read.data.configs.length,
            secretVisible: read.data.configs[0]?.value !== "********" };
        }`,
      });
      scripts.push(name);
      const workflow = await createWorkflow(ctx, "sync-baseline", {
        nodes: [
          {
            id: "run",
            type: "swarm-script",
            config: {
              scriptName: name,
              scope: "global",
              args: {
                key,
                launchUrl: `${gate.origin}/launch`,
              },
            },
          },
        ],
      });
      workflows.push(workflow);
      const definition = await ctx.api("GET", `/api/workflows/${workflow}`);
      expect(!asRecord(definition.json).createdByAgentId, "workflow must have no creator");
      const triggered = await triggerWorkflow(ctx, workflow);
      const returnedAt = Date.now();
      const detail = await getRunDetail(ctx, triggered.runId);
      expect(detail.run.status === "completed", "trigger must return after inline completion");
      const result = asRecord(outputOf(detail, "run").result);
      expect(result.agentId === "workflow", "creator-less script identity changed");
      expect(
        result.status === 200 && result.count === 1 && result.secretVisible === true,
        "creator-less script must retain operator access to the synthetic secret",
      );
      durableId = asString(result.durableId, "nested durable id");
      const pending = asRecord((await ctx.api("GET", `/api/script-runs/${durableId}`)).json);
      expect(
        asRecords(pending, "journal").length === 0,
        "durable step must wait until inline completion",
      );
      released = true;
      let finished: Record<string, unknown> = {};
      expect(
        await pollUntil(async () => {
          const response = await ctx.api("GET", `/api/script-runs/${durableId}`);
          expectStatus(response, [200], "poll nested durable run");
          finished = asRecord(response.json);
          return ["completed", "failed", "cancelled"].includes(
            String(asRecord(finished.run).status),
          );
        }, 30000),
        "nested durable run never finished",
      );
      const run = asRecord(finished.run);
      expect(run.status === "completed", `nested durable run failed: ${JSON.stringify(run)}`);
      const output = asRecord(asRecord(run.output).result);
      expect(
        output.value === 42 && Number(output.startedAt) >= returnedAt,
        "durable step must execute after inline completion",
      );
      expect(
        asRecords(finished, "journal").some(
          (row) => row.stepKey === "after-inline" && row.status === "completed",
        ),
        "durable step must be journaled",
      );

      const bodyName = `foreach-baseline-${ctx.nonce}`;
      await upsertScript(ctx, fixtureOwner, {
        name: bodyName,
        scope: "global",
        source: `export default async function(args: any) {
          const start = Date.now();
          await new Promise(resolve => setTimeout(resolve, 50));
          return { item: args.item, start, end: Date.now() };
        }`,
      });
      scripts.push(bodyName);
      const foreach = await createWorkflow(ctx, "foreach-baseline", {
        nodes: [
          {
            id: "each",
            type: "foreach",
            config: {
              over: [{ id: "0" }, { id: "1" }, { id: "2" }, { id: "3" }],
              itemKey: "id",
              body: {
                type: "swarm-script",
                config: {
                  scriptName: bodyName,
                  scope: "global",
                  args: { item: "{{item.id}}" },
                },
              },
            },
          },
        ],
      });
      workflows.push(foreach);
      const fanout = await triggerWorkflow(ctx, foreach);
      const fanoutDetail = await getRunDetail(ctx, fanout.runId);
      expect(
        fanoutDetail.run.status === "completed",
        `foreach must complete before trigger returns: ${JSON.stringify(fanoutDetail)}`,
      );
      const aggregate = outputOf(fanoutDetail, "each");
      expect(
        aggregate.okCount === 4 && aggregate.failedCount === 0,
        "all four bodies must succeed",
      );
      const results = asRecords(aggregate, "results").map((row) =>
        asRecord(asRecord(row.output).result),
      );
      expect(
        results.length === 4 && results.every((row, index) => Number(row.item) === index),
        "foreach must preserve item order",
      );
      for (let index = 0; index < results.length; index++) {
        expect(
          Number(results[index]!.end) > Number(results[index]!.start),
          "body must record its interval",
        );
        if (index)
          expect(
            Number(results[index]!.start) >= Number(results[index - 1]!.end),
            "script bodies must not overlap",
          );
      }
    } finally {
      released = true;
      if (durableId) await ctx.api("DELETE", `/api/script-runs/${durableId}`);
      gate.stop();
      for (const id of workflows) await ctx.api("DELETE", `/api/workflows/${id}`);
      for (const id of scripts)
        await ctx.api("DELETE", `/api/scripts/${id}?scope=global`, { agentId: fixtureOwner });
      await dropConfig();
    }
  },
};
