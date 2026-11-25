import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { getLead, registerAgent, startStub, upsertScript } from "./script-helpers";
import {
  createWorkflow,
  expectRunStatus,
  outputOf,
  setGlobalConfig,
  triggerWorkflow,
} from "./workflow-helpers";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (asRecord(error).code === "ESRCH") return false;
    throw error;
  }
}

export const scriptRunnerApiRestart: Scenario = {
  name: "script-runner-api-restart",
  order: 509,
  async run(ctx) {
    const minted = await ctx.api("POST", "/api/script-runners/credentials", {
      body: { name: `restart-${ctx.nonce}` },
    });
    if (ctx.db.engine === "sqlite") {
      expectStatus(minted, [409], "SQLite refuses the execution tier");
      expect(minted.text.includes("script_runners_need_postgres"), "SQLite refusal code");
      return;
    }
    expectStatus(minted, [201], "mint restart runner credential");
    const credential = asString(asRecord(asRecord(minted.json).credential).id, "credential ID");
    const token = asString(asRecord(minted.json).token, "runner token");
    const sessions = async () =>
      asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions");
    const agentId = await registerAgent(ctx, "combined-restart");
    const lead = await getLead(ctx);
    const scriptName = `combined-restart-${ctx.nonce}`;
    const configKey = `E2E_COMBINED_RESTART_${ctx.nonce.toUpperCase()}`;
    let dropConfig: (() => Promise<void>) | undefined;
    let scriptSaved = false;
    let workflowId: string | undefined;
    let workflowRunId: string | undefined;
    let durableId: string | undefined;
    let runner: ReturnType<typeof ctx.startScriptRunner> | undefined;
    let sync: Promise<Awaited<ReturnType<typeof ctx.api>> | Error> | undefined;
    let syncPid = 0;
    let stepPid = 0;
    let stepStarts = 0;
    let durableStarts = 0;
    let effectCalls = 0;
    let refusedCalls = 0;
    let releaseStep = false;
    let releaseDurable = false;
    const gate = startStub((request, body) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        if (path === "/sync") syncPid = Number(body);
        if (path === "/step") {
          stepPid = Number(body);
          stepStarts++;
        }
        if (path === "/durable") durableStarts++;
        if (path === "/effect") effectCalls++;
        if (path === "/refused") refusedCalls++;
      }
      return Response.json({ released: path === "/step-gate" ? releaseStep : releaseDurable });
    });
    try {
      dropConfig = await setGlobalConfig(ctx, configKey, "survived");
      await ctx.restartSut({ env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" } });
      runner = ctx.startScriptRunner(token, 6);
      expect(
        await pollUntil(async () => (await sessions()).length === 1, 20000, 50),
        "runner connects",
      );
      const instanceId = asString((await sessions())[0]!.instanceId, "runner instance ID");

      // The guest reports a real refused SDK request before the API can start again.
      await upsertScript(ctx, lead, {
        name: scriptName,
        scope: "global",
        executor: "native",
        source: `export default async function(args: any, ctx: any) {
          const original = globalThis.fetch.bind(globalThis);
          await original(args.gate + "/step", { method: "POST", body: String((globalThis as any).process.pid) });
          while (!(await (await original(args.gate + "/step-gate")).json() as any).released)
            await new Promise(resolve => setTimeout(resolve, 25));
          (globalThis as any).fetch = async (input: any, init: any) => {
            try { return await original(input, init); }
            catch (error) {
              if ((error as any)?.code === "ECONNREFUSED")
                await original(args.gate + "/refused", { method: "POST" });
              throw error;
            }
          };
          const read = await ctx.swarm.config_get({ key: args.key });
          return { status: read.status, value: read.data.configs[0]?.value, pid: (globalThis as any).process.pid };
        }`,
      });
      scriptSaved = true;
      workflowId = await createWorkflow(ctx, "combined-restart", {
        nodes: [
          {
            id: "remote",
            type: "swarm-script",
            config: {
              scriptName,
              scope: "global",
              timeoutMs: 120000,
              args: { gate: gate.origin, key: configKey },
            },
          },
        ],
      });
      workflowRunId = (await triggerWorkflow(ctx, workflowId)).runId;
      expect(await pollUntil(() => stepStarts === 1, 20000, 50), "parked step starts once");
      const parked = ctx.db.get<{ status: string; owner_id: string; attempt: number }>(
        sql`SELECT status, owner_id, attempt FROM workflow_step_jobs WHERE run_id = ${workflowRunId}`,
      );
      expect(
        parked?.status === "running" && parked.owner_id === instanceId,
        "remote runner owns the parked step",
      );

      const launched = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: {
          source: `export default async function(args: any, ctx: any) {
          await fetch(args.gate + "/durable", { method: "POST" });
          const first = await ctx.step.swarmScript("before-restart", {
            source: "export default async function(args: any) { await fetch(args.gate + '/effect', { method: 'POST' }); return 41; }",
            args: { gate: args.gate },
          });
          while (!(await (await fetch(args.gate + "/durable-gate")).json()).released)
            await new Promise(resolve => setTimeout(resolve, 25));
          const second = await ctx.step.swarmScript("after-restart", { source: "export default () => 1" });
          return [first.result, second.result];
        }`,
          args: { gate: gate.origin },
        },
      });
      expectStatus(launched, [201], "launch remote durable run");
      durableId = asString(asRecord(launched.json).id, "durable run ID");
      const durablePath = `/api/script-runs/${durableId}`;
      expect(
        await pollUntil(
          async () => {
            const detail = await ctx.api("GET", durablePath);
            return asRecords(detail.json, "journal").some(
              (entry) => entry.stepKey === "before-restart" && entry.status === "completed",
            );
          },
          20000,
          50,
        ),
        "first durable step commits before restart",
      );
      expect(effectCalls === 1, "journaled effect occurs once before restart");
      const owned = ctx.db.get<{ ownerId: string; pid: number | null }>(
        sql`SELECT "ownerId", pid FROM script_runs WHERE id = ${durableId}`,
      );
      expect(owned?.ownerId === instanceId && owned.pid === null, "durable run executes remotely");

      sync = ctx
        .api("POST", "/api/scripts/run", {
          agentId,
          body: {
            executor: "native",
            source: `export default async () => {
          await fetch(${JSON.stringify(`${gate.origin}/sync`)}, { method: "POST", body: String(process.pid) });
          await new Promise(resolve => setTimeout(resolve, 60000)); return 42;
        }`,
          },
        })
        .catch((error) => (error instanceof Error ? error : new Error(String(error))));
      expect(await pollUntil(() => syncPid > 0, 10000, 50), "sync native child starts");
      expect(
        Number((await sessions())[0]!.jobsInFlight) >= 3,
        "all three remote jobs remain in flight",
      );

      let reconnectMs = 0;
      await ctx.restartSut({
        env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" },
        afterStop: async () => {
          releaseStep = true;
          expect(
            await pollUntil(() => refusedCalls > 0, 5000, 25),
            "SDK call receives ECONNREFUSED during API downtime",
          );
        },
        onHealthy: async () => {
          const healthyAt = performance.now();
          expect(
            await pollUntil(
              async () => (await sessions()).some((row) => row.instanceId === instanceId),
              3000,
              25,
            ),
            "first hello arrives within three seconds of health",
          );
          reconnectMs = performance.now() - healthyAt;
          expect(reconnectMs < 3000, "reconnect stays within three seconds");
        },
      });
      const syncResult = await sync;
      expect(
        syncResult instanceof Error
          ? syncResult.name !== "TimeoutError"
          : asRecord(syncResult.json).error === "executor_error",
        "API restart fails the sync caller",
      );
      expect(
        await pollUntil(() => !processExists(syncPid), 5000, 50),
        "API restart kills the inline native child",
      );
      expect(
        await pollUntil(() => durableStarts >= 2, 20000, 50),
        "durable guest replays after API restart",
      );
      releaseDurable = true;
      let finished: Record<string, unknown> = {};
      expect(
        await pollUntil(
          async () => {
            finished = asRecord((await ctx.api("GET", durablePath)).json);
            return ["completed", "failed", "cancelled"].includes(
              String(asRecord(finished.run).status),
            );
          },
          30000,
          100,
        ),
        "durable run reaches a terminal state",
      );
      expect(
        asRecord(finished.run).status === "completed",
        `durable replay completes: ${JSON.stringify(finished)}`,
      );
      const journal = asRecords(finished, "journal");
      expect(
        journal.length === 2 &&
          journal.every((entry) => entry.status === "completed") &&
          new Set(journal.map((entry) => entry.stepKey)).size === 2,
        "durable journal stores each completed step once",
      );
      expect(
        JSON.stringify(asRecord(finished.run).output) === "[41,1]",
        "durable replay preserves both step results",
      );
      expect(
        effectCalls === 1 && durableStarts === 2,
        "durable replay repeats no journaled effect",
      );

      const workflow = await expectRunStatus(ctx, workflowRunId, "completed", 30000);
      const output = asRecord(outputOf(workflow, "remote").result);
      expect(
        output.status === 200 && output.value === "survived",
        "parked script retries its SDK call and completes",
      );
      expect(
        output.pid === stepPid && stepStarts === 1 && workflow.steps.length === 1,
        "parked script retains its child and completes once",
      );
      const jobs = ctx.db.query<{ status: string; attempt: number }>(
        sql`SELECT status, attempt FROM workflow_step_jobs WHERE run_id = ${workflowRunId}`,
      );
      expect(
        jobs.length === 1 && jobs[0]!.status === "completed" && jobs[0]!.attempt === parked.attempt,
        "parked job completes without another attempt",
      );
      ctx.log(
        `Combined restart: hello within ${Math.round(reconnectMs)}ms of health, ${refusedCalls} refused SDK requests, one workflow execution, two durable executions, one journaled effect`,
      );
    } catch (error) {
      ctx.log(
        `Restart markers: stepStarts=${stepStarts} durableStarts=${durableStarts} effectCalls=${effectCalls} refusedCalls=${refusedCalls}`,
      );
      if (runner) ctx.log(runner.logs());
      throw error;
    } finally {
      releaseStep = true;
      releaseDurable = true;
      try {
        await runner?.stop("SIGKILL");
        // Restore the API even when the downtime assertion failed before the next boot.
        await ctx.restartSut();
        await sync;
        if (durableId) await ctx.api("DELETE", `/api/script-runs/${durableId}`);
        if (workflowRunId)
          await ctx.api("POST", `/api/workflow-runs/${workflowRunId}/cancel`, { body: {} });
        if (workflowId) await ctx.api("DELETE", `/api/workflows/${workflowId}`);
        if (scriptSaved)
          await ctx.api("DELETE", `/api/scripts/${scriptName}?scope=global`, { agentId: lead });
        await dropConfig?.();
        await ctx.api("DELETE", `/api/script-runners/credentials/${credential}`);
      } finally {
        gate.stop();
      }
    }
  },
};
