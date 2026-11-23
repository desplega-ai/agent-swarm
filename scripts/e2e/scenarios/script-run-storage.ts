import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  callToolOk,
  expectRunOk,
  registerAgent,
  runScript,
  structured,
  withMcp,
} from "./script-helpers";

type StoredRun = { id: string; source: string; sourceHash: string; scriptName: string };

/** Repeated inline, saved, nested and restarted durable runs share exact source bodies. */
export const scriptRunStorage: Scenario = {
  name: "script-run-storage",
  order: 445,
  async run(ctx) {
    expect(ctx.db.reclaimsFreeSpace(), "a fresh database must enable incremental auto vacuum");
    const agentId = await registerAgent(ctx, "storage");
    const source = `// storage ${ctx.nonce}: café 雪\nexport default async function (args: { value: number }) {\n  return { value: args.value };\n}\n`;
    let scratchName = "";
    for (let value = 0; value < 3; value += 1) {
      const run = await runScript(ctx, agentId, {
        source,
        args: { value },
        intent: `e2e storage ${ctx.nonce}`,
      });
      expectRunOk(run, "repeated inline source");
      expect(asRecord(run.result).value === value, "inline source returned the wrong value");
      const slug = asString(asRecord(run.autoSaved).slug, "scratch script name");
      if (scratchName) expect(slug === scratchName, "same source created another scratch script");
      scratchName = slug;
    }
    const named = await runScript(ctx, agentId, { name: scratchName, args: { value: 3 } });
    expectRunOk(named, "saved scratch source");
    expect(asRecord(named.result).value === 3, "saved scratch source did not execute");

    const parentSource = `export default async function (args: any, ctx: any) {
  const results = [];
  for (let value = 4; value < 6; value += 1) {
    results.push(await ctx.swarm.script_run({ source: args.source, args: { value } }));
  }
  return results;
}`;
    const parent = await runScript(ctx, agentId, { source: parentSource, args: { source } });
    expectRunOk(parent, "parent with repeated nested runs");
    expect(
      Array.isArray(parent.result) && parent.result.length === 2,
      "parent lost nested results",
    );
    for (const [index, result] of (parent.result as unknown[]).entries()) {
      const envelope = asRecord(result);
      expect(envelope.success === true && envelope.status === 200, "nested SDK call failed");
      const nested = asRecord(envelope.data);
      expectRunOk(nested, `nested run ${index}`);
      expect(asRecord(nested.result).value === index + 4, "nested source did not execute");
    }

    const sharedRuns = ctx.db.query<StoredRun>(
      sql`SELECT id, source, "sourceHash", "scriptName" FROM script_runs WHERE "agentId" = ${agentId} AND "sourceHash" IN (SELECT hash FROM script_run_sources WHERE source = ${source})`,
    );
    expect(sharedRuns.length === 6, `expected six shared runs, got ${sharedRuns.length}`);
    expect(
      sharedRuns.every((run) => run.source === "" && run.sourceHash === sharedRuns[0]?.sourceHash),
      "inline, saved and nested runs must store only a shared source hash",
    );
    expect(
      sharedRuns.some((run) => run.scriptName === scratchName),
      "the named run did not share the inline source",
    );
    expect(
      ctx.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM script_run_sources WHERE source = ${source}`,
      )?.n === 1,
      "six executions must store the exact source once",
    );

    // Trailing whitespace is part of the source, even when execution is identical.
    const distinctSource = `${source} \n`;
    const distinct = await runScript(ctx, agentId, {
      source: distinctSource,
      args: { value: 6 },
    });
    expectRunOk(distinct, "distinct source");
    const distinctRow = ctx.db.get<{ hash: string; source: string }>(
      sql`SELECT hash, source FROM script_run_sources WHERE source = ${distinctSource}`,
    );
    expect(
      distinctRow?.source === distinctSource && distinctRow.hash !== sharedRuns[0]?.sourceHash,
      "sources differing only in whitespace must remain distinct",
    );

    for (const run of sharedRuns) {
      const detail = await ctx.api("GET", `/api/script-runs/${run.id}`);
      expectStatus(detail, [200], "HTTP detail of a shared-source run");
      expect(
        asRecord(asRecord(detail.json).run).source === source,
        "HTTP detail lost exact source",
      );
    }
    await withMcp(ctx, agentId, async (mcp) => {
      const detail = await callToolOk(mcp, "get-script-run", { id: sharedRuns[0]?.id });
      expect(
        asRecord(asRecord(structured(detail).data).run).source === source,
        "MCP detail lost exact source",
      );
    });

    // Leave the step task unclaimed: the boot sweep fails in-progress tasks on restart.
    const workerId = await registerAgent(ctx, "storage-restart-worker");
    const durableSource = `// durable storage ${ctx.nonce}\nexport default async function (args: any, ctx: any) {
  const before = await ctx.step.swarmScript("before", { source: args.source, args: { value: 7 } });
  const done = await ctx.step.agentTask("wait", { task: args.task, agentId: args.workerId });
  return { before: before.result.value, done, marker: args.marker };
}\n`;
    const launched = await ctx.api("POST", "/api/script-runs", {
      agentId,
      body: {
        source: durableSource,
        args: { source, workerId, task: `storage resume ${ctx.nonce}`, marker: ctx.nonce },
        scriptName: `e2e-storage-resume-${ctx.nonce}`,
      },
    });
    expectStatus(launched, [201], "launch durable storage run");
    const runId = asString(asRecord(launched.json).id, "durable run id");
    try {
      let taskId = "";
      const waiting = await pollUntil(() => {
        const task = ctx.db.get<{ id: string; status: string }>(
          sql`SELECT id, status FROM agent_tasks WHERE "contextKey" = ${`script-run:${runId}:wait`} AND "taskType" = 'script-run-step'`,
        );
        if (!task) return false;
        expect(task.status === "pending", `restart step must be unclaimed: ${task.status}`);
        taskId = task.id;
        return true;
      }, 30_000);
      expect(waiting, `durable run never reached its waiting task: ${await ctx.sutLog()}`);
      const beforeRestart = await ctx.api("GET", `/api/script-runs/${runId}`);
      expectStatus(beforeRestart, [200], "read durable run before restart");
      expect(
        asRecord(asRecord(beforeRestart.json).run).status === "running" &&
          asRecords(beforeRestart.json, "journal").some((step) => step.stepKey === "before"),
        "durable run must journal its first step before restart",
      );
      expect(
        ctx.db.get<StoredRun>(sql`SELECT source, "sourceHash" FROM script_runs WHERE id = ${runId}`)
          ?.source === "",
        "durable run must recover without the legacy source column",
      );
      await ctx.restartSut();
      const worker = await ctx.startAgent({
        agentId: workerId,
        onTask: () => ({ status: "completed", output: `resumed-${ctx.nonce}` }),
      });
      await worker.waitForTask(taskId);
      await worker.stop();
      let final: Record<string, unknown> = {};
      const completed = await pollUntil(async () => {
        const detail = await ctx.api("GET", `/api/script-runs/${runId}`);
        expectStatus(detail, [200], "poll restarted durable run");
        final = asRecord(detail.json);
        return ["completed", "failed", "cancelled", "aborted_limit"].includes(
          String(asRecord(final.run).status),
        );
      }, 60_000);
      const run = asRecord(final.run);
      expect(
        completed && run.status === "completed",
        `restart recovery failed: ${JSON.stringify(run)}`,
      );
      const output = asRecord(run.output);
      expect(
        run.source === durableSource &&
          output.before === 7 &&
          output.done === `resumed-${ctx.nonce}` &&
          output.marker === ctx.nonce,
        `restarted run did not execute the exact durable source: ${JSON.stringify(run)}`,
      );
      expect(
        asRecords(final, "journal")
          .map((step) => step.stepKey)
          .join(",") === "before,wait",
        "restarted durable run must retain its journal",
      );
      expect(
        ctx.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM agent_tasks WHERE "contextKey" = ${`script-run:${runId}:wait`} AND "taskType" = 'script-run-step'`,
        )?.n === 1,
        "restart dispatched a duplicate step task",
      );
      expect(
        ctx.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM script_runs WHERE "agentId" = ${agentId} AND "sourceHash" = ${sharedRuns[0]?.sourceHash ?? ""}`,
        )?.n === 7,
        "durable nested step must share the inline source and replay without another execution",
      );
    } finally {
      await ctx.api("DELETE", `/api/script-runs/${runId}`);
    }
  },
};
