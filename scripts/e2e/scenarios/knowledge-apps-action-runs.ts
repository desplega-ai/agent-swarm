import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  registerAgent,
  structured,
  toolText,
  upsertScript,
  withMcp,
} from "./script-helpers";

// The background orchestrator: runs ~3 s across a nested script_run, so the action
// returns long before it settles. `fail` makes it throw at the end.
const ORCHESTRATOR = `export default async function (args: { fail?: boolean }, ctx: any) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  await ctx.swarm.script_run({ source: "export default async function () { return 1; }" });
  await sleep(1500);
  if (args.fail) throw new Error("orchestrator boom");
  return "orchestrated";
}`;

// The `refresh` action script: one inline nested run, then launch the orchestrator and return.
// `holdMs` keeps the action itself running after its nested run, so a probe can read it mid-flight.
// `throwNote` fails the action itself with an error that echoes the caller's `note`.
const REFRESH = `export default async function (args: { fail?: boolean; holdMs?: number; note?: string; throwNote?: boolean }, ctx: any) {
  if (args.throwNote) throw new Error("bad input: " + args.note);
  await ctx.swarm.script_run({ source: "export default async function () { return 0; }" });
  if (args.holdMs) await new Promise((r) => setTimeout(r, args.holdMs));
  const launched = await ctx.swarm.script_launchRun({
    source: ${JSON.stringify(ORCHESTRATOR)},
    args: { fail: args.fail === true },
    scriptName: "e2e-app-orchestrator",
  });
  return { launched: (launched?.data ?? launched)?.id ?? null, note: args.note ?? null };
}`;

function runOf(result: unknown): Record<string, unknown> {
  return asRecord(structured(result).run);
}

/**
 * `app-action-run` returns a run handle and can wait on it; `app-action-status` (and its REST
 * route) waits on a script action's whole run tree, or on a task action's task. The loop an
 * agent needs for a launched background refresh is two calls: run, then one status wait.
 */
export const knowledgeAppsActionRuns: Scenario = {
  name: "knowledge-apps-action-runs",
  order: 558,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-runs-owner");
    const worker = await ctx.startAgent({
      name: `e2e-app-runs-worker-${ctx.nonce}`,
      onTask: () => ({ status: "completed", output: "done" }),
    });
    const created: string[] = [];
    try {
      const script = await upsertScript(ctx, owner, {
        name: `e2e-app-refresh-${ctx.nonce}`,
        scope: "agent",
        description: "App action fixture",
        intent: "Launch a background orchestrator",
        source: REFRESH,
      });
      const definition = {
        models: {},
        actions: {
          refresh: { kind: "script", scriptId: script.id },
          review: { kind: "task", prompt: "Review and report.", agentId: worker.agentId },
        },
        pages: {
          main: {
            title: "Main",
            root: "t",
            elements: { t: { type: "Text", props: { content: "x" } } },
          },
        },
        defaultPage: "main",
      };
      let response = await ctx.api("POST", "/api/apps", {
        body: { name: `E2E action runs ${ctx.nonce}`, definition },
      });
      expectStatus(response, [201], "create app");
      const appId = asString(asRecord(asRecord(response.json).app).id, "app id");
      created.push(appId);
      response = await ctx.api("POST", "/api/apps", {
        body: { name: `E2E action runs other ${ctx.nonce}`, definition },
      });
      expectStatus(response, [201], "create the other app");
      const otherAppId = asString(asRecord(asRecord(response.json).app).id, "other app id");
      created.push(otherAppId);

      await withMcp(ctx, owner, async (mcp) => {
        // ── a launched background tree: running at once, settled after one wait ──
        let calls = 0;
        const t0 = Date.now();
        let result = await callToolOk(mcp, "app-action-run", {
          appId,
          action: "refresh",
          waitSeconds: 0,
        });
        calls++;
        const firstMs = Date.now() - t0;
        let run = runOf(result);
        const runId = asString(run.id, "run id");
        expect(
          run.state === "running" && run.settled === false,
          `run starts running: ${JSON.stringify(run)}`,
        );
        expect(firstMs < 5000, `app-action-run with waitSeconds 0 returns fast (${firstMs} ms)`);
        expect(
          typeof run.next === "string" && run.next.includes("app-action-status"),
          "a running run says how to continue",
        );
        expect(
          toolText(result).includes("still running"),
          "the text channel says the run is running",
        );

        result = await callToolOk(mcp, "app-action-status", { appId, runId, waitSeconds: 25 });
        calls++;
        run = runOf(result);
        const doneMs = Date.now() - t0;
        expect(
          run.settled === true && run.state === "succeeded",
          `the tree settles in one wait: ${JSON.stringify(run)}`,
        );
        const runs = asRecord(run.runs);
        // The action's run, its inline nested run and the orchestrator it launched.
        expect(
          runs.total === 3 && runs.running === 0,
          `run tree has 3 runs: ${JSON.stringify(runs)}`,
        );
        expect(doneMs < 12_000, `the tree settles within 12 s (${doneMs} ms)`);
        ctx.log(`calls_to_done=${calls} ms_to_done=${doneMs}`);
        expect(calls <= 2, `calls_to_done ${calls} <= 2`);

        // REST twin: the same state, settled, no wait.
        response = await ctx.api("GET", `/api/apps/${appId}/action-runs/${runId}?waitSeconds=0`);
        expectStatus(response, [200], "GET action run");
        expect(asRecord(response.json).state === "succeeded", "REST reads the settled tree");
        response = await ctx.api("GET", `/api/apps/${otherAppId}/action-runs/${runId}`);
        expectStatus(response, [404], "a run of another app is not found");
        await callToolErr(mcp, "app-action-status", { appId: otherAppId, runId });
        response = await ctx.api("GET", `/api/apps/${appId}/action-runs/${runId}?waitSeconds=99`);
        expectStatus(response, [400], "waitSeconds above 25 is rejected");

        // ── no other agent can graft a run into this tree and flip its state ──
        const outsider = await registerAgent(ctx, "app-runs-outsider");
        const graftBody = {
          source: 'export default async function () { throw new Error("grafted"); }',
          background: true,
          parentScriptRunId: runId,
        };
        response = await ctx.api("POST", "/api/script-runs", {
          agentId: outsider,
          body: graftBody,
        });
        expectStatus(response, [403, 404], "another agent cannot name this run as parent");
        // The owner cannot either once the run finished: only a running run takes children.
        response = await ctx.api("POST", "/api/script-runs", { agentId: owner, body: graftBody });
        expectStatus(response, [403, 404], "a finished run takes no new children");
        const grafted = ctx.db.get<{ n: number }>(
          sql`SELECT COUNT(*) AS n FROM script_runs WHERE "parentScriptRunId" = ${runId} AND "scriptName" IS NULL AND kind <> 'inline'`,
        );
        expect(Number(grafted?.n) === 0, `no grafted row: ${JSON.stringify(grafted)}`);
        response = await ctx.api("GET", `/api/apps/${appId}/action-runs/${runId}`);
        expect(
          asRecord(response.json).state === "succeeded" &&
            asRecord(asRecord(response.json).runs).total === 3,
          `the tree is unchanged: ${JSON.stringify(response.json)}`,
        );

        // ── the action's own row is running while its script runs ──
        // Every run that exists now; the in-flight action's nested run names a parent outside it.
        const knownRoots = new Set(
          ctx.db
            .query<{ id: string }>(sql`SELECT id FROM script_runs WHERE "agentId" = ${owner}`)
            .map((r) => r.id),
        );
        const note = `caller-private-${ctx.nonce}`;
        const inFlight = ctx.api("POST", `/api/apps/${appId}/actions/refresh`, {
          body: { input: { holdMs: 2500, note } },
        });
        let liveRoot: string | undefined;
        for (const deadline = Date.now() + 10_000; !liveRoot && Date.now() < deadline; ) {
          liveRoot = ctx.db
            .query<{ parent: string }>(
              sql`SELECT "parentScriptRunId" AS parent FROM script_runs WHERE "agentId" = ${owner} AND "parentScriptRunId" IS NOT NULL`,
            )
            .find((r) => !knownRoots.has(r.parent))?.parent;
          if (!liveRoot) await Bun.sleep(50);
        }
        expect(liveRoot !== undefined, "the in-flight action's nested run names a parent");
        const liveRow = ctx.db.get<{ status: string }>(
          sql`SELECT status FROM script_runs WHERE id = ${liveRoot}`,
        );
        expect(
          liveRow?.status === "running",
          `the parent row exists, running: ${JSON.stringify(liveRow)}`,
        );
        response = await ctx.api("GET", `/api/apps/${appId}/action-runs/${liveRoot}`);
        expectStatus(response, [200], "the in-flight action run reads");
        expect(
          asRecord(response.json).state === "running",
          `it reads running: ${JSON.stringify(response.json)}`,
        );
        response = await inFlight;
        expectStatus(response, [200], "the held action finishes");
        expect(
          asRecord(asRecord(response.json).run).id === liveRoot,
          "the response names the same run",
        );
        expect(
          asRecord(asRecord(response.json).result).note === note,
          "the caller gets its result back",
        );
        // script_runs reads are open to every authenticated principal: the action's row
        // must not carry the caller's input, identity or result.
        response = await ctx.api("GET", `/api/script-runs/${liveRoot}`, { agentId: outsider });
        expectStatus(response, [200], "another agent reads the action's script run");
        const exposed = asRecord(asRecord(response.json).run);
        expect(
          !JSON.stringify(exposed).includes(note) &&
            asRecord(exposed.args).caller === undefined &&
            exposed.output == null,
          `the row holds no caller payload: ${JSON.stringify({ args: exposed.args, output: exposed.output })}`,
        );
        response = await ctx.api("GET", `/api/script-runs?agentId=${owner}`, { agentId: outsider });
        expect(
          !JSON.stringify(response.json).includes(note),
          "the run list holds no caller payload",
        );
        result = await callToolOk(mcp, "app-action-status", {
          appId,
          runId: liveRoot,
          waitSeconds: 25,
        });
        run = runOf(result);
        expect(
          run.settled === true && run.state === "succeeded" && asRecord(run.runs).total === 3,
          `the held action's tree settles: ${JSON.stringify(run)}`,
        );

        // ── a failing action: the caller gets the error, the run row does not keep it ──
        const failNote = `caller-error-${ctx.nonce}`;
        response = await ctx.api("POST", `/api/apps/${appId}/actions/refresh`, {
          body: { input: { throwNote: true, note: failNote } },
        });
        expectStatus(response, [200], "the failing action answers");
        const failed = asRecord(response.json);
        expect(
          failed.ok === false && String(failed.error).includes(failNote),
          `the caller gets the detailed error: ${JSON.stringify(failed)}`,
        );
        const failedRoot = asString(asRecord(failed.run).id, "failed run id");
        response = await ctx.api("GET", `/api/script-runs/${failedRoot}`, { agentId: outsider });
        expectStatus(response, [200], "another agent reads the failed action's script run");
        const failedRow = asRecord(asRecord(response.json).run);
        expect(
          failedRow.status === "failed" && !JSON.stringify(failedRow).includes(failNote),
          `the failed row holds no caller error text: ${JSON.stringify(failedRow)}`,
        );
        response = await ctx.api("GET", `/api/script-runs?agentId=${owner}`, { agentId: outsider });
        expect(
          !JSON.stringify(response.json).includes(failNote),
          "the run list holds no caller error text",
        );

        // ── a failing launched run fails the tree and names the failure ──
        result = await callToolOk(mcp, "app-action-run", {
          appId,
          action: "refresh",
          input: { fail: true },
          waitSeconds: 25,
        });
        run = runOf(result);
        expect(
          run.settled === true && run.state === "failed",
          `a failing launched run fails the tree: ${JSON.stringify(run)}`,
        );
        const failures = Array.isArray(run.failures) ? run.failures.map(asRecord) : [];
        expect(
          failures.some((f) => String(f.error).includes("orchestrator boom")),
          `failures name the launched run's error: ${JSON.stringify(failures)}`,
        );

        // ── a task action: run.id is the task, settled when the task completes ──
        result = await callToolOk(mcp, "app-action-run", { appId, action: "review" });
        const data = structured(result);
        const taskId = asString(data.taskId, "task id");
        run = runOf(result);
        expect(
          run.id === taskId && run.taskId === taskId,
          `task run handle: ${JSON.stringify(run)}`,
        );
        result = await callToolOk(mcp, "app-action-status", {
          appId,
          runId: taskId,
          waitSeconds: 25,
        });
        run = runOf(result);
        expect(
          run.settled === true && run.state === "succeeded" && run.status === "completed",
          `the task run settles with its task: ${JSON.stringify(run)}`,
        );
        response = await ctx.api("GET", `/api/apps/${otherAppId}/action-runs/${taskId}`);
        expectStatus(response, [404], "a task run of another app is not found");

        await callToolErr(mcp, "app-action-status", { appId, runId: crypto.randomUUID() });
      });
    } finally {
      for (const id of created) await ctx.api("DELETE", `/api/apps/${id}`);
    }
  },
};
