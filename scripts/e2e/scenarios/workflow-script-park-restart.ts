import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { startScriptRunner } from "../script-runner";
import { getLead, startStub, upsertScript } from "./script-helpers";
import { createWorkflow, getRunDetail, setGlobalConfig, triggerWorkflow } from "./workflow-helpers";

export const workflowScriptParkRestart: Scenario = {
  name: "workflow-script-park-restart",
  order: 507,
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
    const env = { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" };
    await ctx.restartSut({ env });
    const counts = new Map<string, number>();
    let released = false;
    const gate = startStub((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/start") {
        const id = url.searchParams.get("id")!;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return Response.json({ released });
    });
    const name = `park-restart-${ctx.nonce}`;
    const counterNamespace = `workflow-proof:${ctx.nonce}`;
    const lead = await getLead(ctx);
    await upsertScript(ctx, lead, {
      name,
      scope: "global",
      source: `export default async (args: any,ctx: any) => {
      const count=await ctx.swarm.kv_incr({key:args.id,namespace:args.counterNamespace});
      if(!count.success) throw new Error("authorized counter update failed");
      await fetch(args.gate+"/start?id="+args.id);
      while(!((await (await fetch(args.gate)).json()) as any).released) await new Promise(r=>setTimeout(r,50));
      const read=await ctx.swarm.config_get({key:"WORKFLOW_MAX_ITERATIONS"});
      if(!read.success) throw new Error("authorized config read failed");
      return {id:args.id,status:read.status};
    }`,
    });
    const minted = await ctx.api("POST", "/api/script-runners/credentials", { body: { name } });
    expectStatus(minted, [201], "mint restart runner");
    const token = asString(asRecord(minted.json).token, "runner token");
    const credentialId = asString(
      asRecord(asRecord(minted.json).credential).id,
      "runner credential ID",
    );
    const runners = [startScriptRunner(ctx.baseUrl, token, 1)];
    const jobs = (runId: string) =>
      ctx.db.query<{ id: string; status: string; owner_id: string | null; error: string | null }>(
        sql`SELECT id,status,owner_id,error FROM workflow_step_jobs WHERE run_id=${runId}`,
      );
    const make = async (ids: string[]) =>
      createWorkflow(ctx, `park-restart-${ids.join("-")}`, {
        nodes: [
          {
            id: "fan",
            type: "foreach",
            config: {
              over: ids.map((id) => ({ id })),
              itemKey: "id",
              body: {
                type: "swarm-script",
                config: {
                  scriptName: name,
                  scope: "global",
                  args: { id: "{{item.id}}", gate: gate.origin, counterNamespace },
                  timeoutMs: 300000,
                },
              },
            },
          },
        ],
      });
    try {
      expect(
        await pollUntil(
          async () =>
            asRecords(asRecord((await ctx.api("GET", "/api/script-runners")).json), "sessions")
              .length === 1,
          20000,
        ),
        "runner connects",
      );
      const workflow = await make(["running", "queued"]);
      const { runId } = await triggerWorkflow(ctx, workflow);
      expect(
        await pollUntil(
          async () =>
            jobs(runId).some((j) => j.status === "running") &&
            jobs(runId).some((j) => j.status === "queued") &&
            counts.has("running"),
          20000,
        ),
        "one running and one queued before restart",
      );
      const restarting = ctx.restartSut({ env });
      await Bun.sleep(500);
      released = true;
      await restarting;
      expect(
        await pollUntil(
          async () => (await getRunDetail(ctx, runId)).run.status === "completed",
          60000,
        ),
        "running and queued jobs survive API restart",
      );
      expect(
        counts.get("running") === 1 && counts.get("queued") === 1,
        "API restart repeats neither script",
      );
      const effects = ctx.db.query<{ value: string }>(
        sql`SELECT value FROM kv_entries WHERE namespace=${counterNamespace} AND key IN ('running','queued')`,
      );
      expect(
        effects.length === 2 && effects.every((row) => String(row.value) === "1"),
        "KV effects occur once across API restart",
      );
      expect(
        jobs(runId).length === 2 && jobs(runId).every((j) => j.status === "completed"),
        "both jobs settled after restart",
      );
      released = false;
      const cancelWorkflow = await make(["cancel"]);
      const cancelled = await triggerWorkflow(ctx, cancelWorkflow);
      expect(await pollUntil(async () => counts.has("cancel"), 20000), "cancel fixture starts");
      const cancel = await ctx.api("POST", `/api/workflow-runs/${cancelled.runId}/cancel`);
      expectStatus(cancel, [200], "cancel parked workflow");
      expect(
        jobs(cancelled.runId).length === 1 &&
          jobs(cancelled.runId).every((j) => j.status === "cancelled"),
        "cancelled job persists",
      );
      const liveTokens = ctx.db.query<{ id: string }>(
        sql`SELECT id FROM session_tokens WHERE "sourceStepId" IN (SELECT step_id FROM workflow_step_jobs WHERE run_id=${cancelled.runId}) AND "revokedAt" IS NULL`,
      );
      expect(liveTokens.length === 0, "cancellation revokes per-step credentials");
      released = true;

      released = false;
      const replayWorkflow = await make(["replay"]);
      const replay = await triggerWorkflow(ctx, replayWorkflow);
      const replayStarted = await pollUntil(async () => counts.has("replay"), 20000);
      if (!replayStarted)
        console.log(
          JSON.stringify({
            fixture: "cancel-to-replay-diagnostic",
            jobs: jobs(replay.runId),
            cancelledJobs: jobs(cancelled.runId),
            runnerLogs: runners[0]!.logs(),
          }),
        );
      expect(replayStarted, "replay fixture starts");
      const firstOwner = jobs(replay.runId)[0]?.owner_id;
      await runners[0]!.stop("SIGKILL");
      runners.push(startScriptRunner(ctx.baseUrl, token, 1));
      released = true;
      expect(
        await pollUntil(
          async () => (await getRunDetail(ctx, replay.runId)).run.status === "completed",
          90000,
        ),
        "expired lease replays on replacement runner",
      );
      expect(counts.get("replay") === 2, "real runner death repeats exactly the in-flight script");
      expect(jobs(replay.runId)[0]?.owner_id !== firstOwner, "replacement runner owns settlement");

      released = false;
      const stoppedWorkflow = await make(["stopped"]);
      const stoppedRun = await triggerWorkflow(ctx, stoppedWorkflow);
      expect(await pollUntil(async () => counts.has("stopped"), 20000), "SIGSTOP fixture starts");
      const stoppedOwner = jobs(stoppedRun.runId)[0]?.owner_id;
      runners[1]!.signal("SIGSTOP");
      runners.push(startScriptRunner(ctx.baseUrl, token, 1));
      released = true;
      expect(
        await pollUntil(
          async () => (await getRunDetail(ctx, stoppedRun.runId)).run.status === "completed",
          90000,
        ),
        "expired stopped runner lease replays",
      );
      expect(counts.get("stopped") === 2, "stopped runner repeats exactly its in-flight script");
      expect(
        jobs(stoppedRun.runId)[0]?.owner_id !== stoppedOwner,
        "stopped runner loses its claim",
      );
      runners[1]!.signal("SIGCONT");
      await runners[1]!.stop("SIGKILL");

      const secretKey = `E2E_PARK_SECRET_${ctx.nonce.toUpperCase()}`;
      const secretValue = `synthetic-secret-${crypto.randomUUID()}`;
      const removeSecret = await setGlobalConfig(ctx, secretKey, secretValue, true);
      const failing = `park-fail-${ctx.nonce}`;
      await upsertScript(ctx, lead, {
        name: failing,
        scope: "global",
        source:
          "export default (args: any,ctx: any) => { throw new Error(ctx.stdlib.Redacted.value(ctx.swarm.config.get(args.key))); }",
      });
      for (const retry of [false, true]) {
        const id = await createWorkflow(ctx, `failure-${retry}`, {
          nodes: [
            {
              id: "fail",
              type: "swarm-script",
              config: { scriptName: failing, scope: "global", args: { key: secretKey } },
              ...(retry
                ? { retry: { maxRetries: 1, strategy: "static", baseDelayMs: 10, maxDelayMs: 10 } }
                : {}),
            },
          ],
        });
        const run = await triggerWorkflow(ctx, id);
        expect(
          await pollUntil(
            async () => (await getRunDetail(ctx, run.runId)).run.status === "failed",
            30000,
          ),
          "failed job fails the workflow",
        );
        expect(jobs(run.runId).length === (retry ? 2 : 1), "retry creates one job per attempt");
        expect(
          jobs(run.runId).every((job) => job.error?.includes("[REDACTED:config:")),
          "failure keeps the scrubbed config error",
        );
        expect(
          !JSON.stringify(
            ctx.db.query<Record<string, unknown>>(
              sql`SELECT * FROM workflow_step_jobs WHERE run_id=${run.runId}`,
            ),
          ).includes(secretValue),
          "job rows contain no config secret",
        );
      }
      await removeSecret();
      console.log(
        JSON.stringify({
          fixture: "workflow-script-park-restart",
          executions: Object.fromEntries(counts),
          cancelledJobs: jobs(cancelled.runId).length,
          liveCancelledCredentials: liveTokens.length,
          replayOwnerChanged: jobs(replay.runId)[0]?.owner_id !== firstOwner,
          stoppedOwnerChanged: jobs(stoppedRun.runId)[0]?.owner_id !== stoppedOwner,
        }),
      );
    } finally {
      released = true;
      await Promise.all(runners.map((r) => r.stop("SIGKILL")));
      await gate.stop();
      await ctx.api("DELETE", `/api/script-runners/credentials/${credentialId}`);
      await ctx.restartSut();
    }
  },
};
