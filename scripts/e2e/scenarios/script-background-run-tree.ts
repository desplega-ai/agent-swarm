import { sql } from "../db";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { registerAgent, upsertScript } from "./script-helpers";

// Waits for the test to open its kv gate (30 s cap), so the tree stays running on cue.
const GRANDCHILD = `export default async function (args: { gate: string; token: string }, ctx: any) {
  for (let i = 0; i < 120; i++) {
    try {
      const got = await ctx.swarm.kv_get({ key: args.gate });
      if (JSON.stringify(got).includes(args.token)) return "released";
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("gate never opened");
}`;

// The background run: a journaled step, a nested inline run, then a fire-and-forget
// launch it does not wait for. It completes while its grandchild still runs.
const ORCHESTRATOR = `export default async function (args: { gate: string; token: string }, ctx: any) {
  await ctx.step.swarmScript("child", { source: "export default async function () { return 1; }" });
  await ctx.swarm.script_run({ source: "export default async function () { return 2; }" });
  await ctx.swarm.script_launchRun({
    source: ${JSON.stringify(GRANDCHILD)},
    args,
    scriptName: "e2e-bg-grandchild",
  });
  return "orchestrated";
}`;

const REFRESH = `export default async function (args: { gate: string; token: string }, ctx: any) {
  const launched = await ctx.swarm.script_launchRun({
    source: ${JSON.stringify(ORCHESTRATOR)},
    args,
    scriptName: "e2e-bg-orchestrator",
  });
  return { launched: (launched?.data ?? launched)?.id ?? null };
}`;

/**
 * Every run a background-launched run starts joins its tree: the step child, the nested
 * `script_run` and the fire-and-forget `script_launchRun` all name the background run as
 * parent, so `app-action-status` counts them and stays unsettled until the last one ends.
 * Before the fix only the action and the orchestrator were linked, and the tree read
 * settled the moment the orchestrator returned.
 */
export const scriptBackgroundRunTree: Scenario = {
  name: "script-background-run-tree",
  order: 507,
  async run(ctx) {
    const owner = await registerAgent(ctx, "bg-tree-owner");
    const outsider = await registerAgent(ctx, "bg-tree-outsider");
    const created = await ctx.api("POST", "/api/users", {
      body: { name: `bg tree admin ${ctx.nonce}`, status: "active" },
    });
    expectStatus(created, [200], "create the user");
    const userId = asString(asRecord(asRecord(created.json).user).id, "user id");
    expectStatus(
      await ctx.api("PUT", `/api/users/${userId}/roles`, { body: { roles: ["admin"] } }),
      [200],
      "make the user an admin",
    );
    const minted = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, {
      body: { label: "bg-tree" },
    });
    expectStatus(minted, [200], "mint the user token");
    const userToken = asString(asRecord(minted.json).plaintext, "user token");
    const script = await upsertScript(ctx, owner, {
      name: `e2e-bg-tree-refresh-${ctx.nonce}`,
      scope: "agent",
      description: "Background run tree fixture",
      intent: "Launch a background orchestrator",
      source: REFRESH,
    });
    const definition = {
      models: {},
      actions: { refresh: { kind: "script", scriptId: script.id } },
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
      body: { name: `E2E background tree ${ctx.nonce}`, definition },
    });
    expectStatus(response, [201], "create app");
    const appId = asString(asRecord(asRecord(response.json).app).id, "app id");
    try {
      const gate = `e2e-bg-gate-${ctx.nonce}`;
      const token = `open-${ctx.nonce}`;
      response = await ctx.api("POST", `/api/apps/${appId}/actions/refresh`, {
        body: { input: { gate, token } },
      });
      expectStatus(response, [200], "run the refresh action");
      const rootId = asString(asRecord(asRecord(response.json).run).id, "action run id");

      // The orchestrator returns while its launched grandchild waits on the gate.
      let orchestrator: { id: string; status: string } | null = null;
      const done = await pollUntil(() => {
        orchestrator = ctx.db.get<{ id: string; status: string }>(
          sql`SELECT id, status FROM script_runs WHERE "parentScriptRunId" = ${rootId} AND "scriptName" = ${"e2e-bg-orchestrator"}`,
        );
        return orchestrator?.status === "completed";
      }, 30_000);
      expect(done, `the orchestrator completes: ${JSON.stringify(orchestrator)}`);
      const orchestratorId = asString(asRecord(orchestrator).id, "orchestrator id");
      type Child = { id: string; scriptName: string | null; status: string };
      let children: Child[] = [];
      await pollUntil(() => {
        children = ctx.db.query<Child>(
          sql`SELECT id, "scriptName", status FROM script_runs WHERE "parentScriptRunId" = ${orchestratorId}`,
        );
        return children.length >= 3;
      }, 10_000);
      expect(
        children.length === 3 &&
          children.filter((c) => c.scriptName === "(inline source)").length === 2 &&
          children.some((c) => c.scriptName === "e2e-bg-grandchild" && c.status === "running"),
        `the step child, the nested run and the running grandchild name the orchestrator: ${JSON.stringify(children)}`,
      );

      response = await ctx.api("GET", `/api/apps/${appId}/action-runs/${rootId}?waitSeconds=0`);
      expectStatus(response, [200], "read the action run");
      let state = asRecord(response.json);
      let runs = asRecord(state.runs);
      expect(
        state.settled === false &&
          state.state === "running" &&
          runs.total === 5 &&
          runs.running === 1,
        `the tree counts every run and stays unsettled while the grandchild runs: ${JSON.stringify(state)}`,
      );

      // Only a live run of the calling agent takes a body-named child. The grandchild is the
      // owner's and still running, so only the agent check refuses another agent's graft.
      const grandchildId = asString(
        children.find((c) => c.scriptName === "e2e-bg-grandchild")?.id,
        "grandchild id",
      );
      const graft = { source: "export default async function () { return 3; }" };
      response = await ctx.api("POST", "/api/scripts/run", {
        agentId: outsider,
        body: { ...graft, parentScriptRunId: grandchildId },
      });
      expectStatus(response, [404], "another agent cannot name a running run as parent");
      response = await ctx.api("POST", "/api/script-runs", {
        agentId: outsider,
        body: { ...graft, background: true, parentScriptRunId: grandchildId },
      });
      expectStatus(response, [404], "another agent cannot launch a run under a running run");
      // A user token has no calling run: its body-named parent is ignored, not recorded.
      response = await ctx.api("POST", "/api/scripts/run", {
        apiKey: userToken,
        agentId: owner,
        body: { ...graft, parentScriptRunId: grandchildId },
      });
      expectStatus(response, [200], "a user token runs inline source as the owner");
      const grafted = ctx.db.query<{ id: string }>(
        sql`SELECT id FROM script_runs WHERE "parentScriptRunId" = ${grandchildId}`,
      );
      expect(
        grafted.length === 0,
        `the running grandchild took no child: ${JSON.stringify(grafted)}`,
      );
      response = await ctx.api("POST", "/api/scripts/run", {
        agentId: owner,
        body: { ...graft, parentScriptRunId: orchestratorId },
      });
      expectStatus(response, [404], "a finished run takes no new child");

      response = await ctx.api("PUT", `/api/kv/${gate}`, {
        agentId: owner,
        body: { value: { token } },
      });
      expectStatus(response, [200], "open the gate");
      response = await ctx.api("GET", `/api/apps/${appId}/action-runs/${rootId}?waitSeconds=25`);
      expectStatus(response, [200], "wait on the action run");
      state = asRecord(response.json);
      runs = asRecord(state.runs);
      expect(
        state.settled === true &&
          state.state === "succeeded" &&
          runs.total === 5 &&
          runs.completed === 5,
        `the tree settles once the grandchild finishes: ${JSON.stringify(state)}`,
      );
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`);
    }
  },
};
