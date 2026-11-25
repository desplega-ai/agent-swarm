import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { getLead, registerAgent, upsertScript } from "./script-helpers";
import { createWorkflow, triggerWorkflow, waitForRun } from "./workflow-helpers";

const NOOP = "export default async function () { return 1; }";

/** Invite a user as `requester` and exchange the invite for a real `aswt_` token. */
async function inviteRequester(ctx: ScenarioContext): Promise<{ token: string; userId: string }> {
  const invite = await ctx.api("POST", "/api/invites", {
    body: { email: `obs-int-${ctx.nonce}@example.com`, role: "requester" },
  });
  expectStatus(invite, [201], "invite a requester");
  const code = new URL(String(asRecord(invite.json).inviteUrl)).pathname.split("/")[2];
  const exchange = await ctx.api("POST", "/api/invites/exchange", {
    apiKey: null,
    body: { code },
  });
  expectStatus(exchange, [200], "exchange the requester invite");
  return {
    token: asString(asRecord(exchange.json).token, "user token"),
    userId: asString(asRecord(exchange.json).userId, "user id"),
  };
}

/**
 * Flow `rbac-integration-role`: a scoped user token (primary `requester`) is refused on the
 * workflow trigger, workflow event and durable script-run routes, and admitted once the extra
 * `obs-lite-integration` role is attached. A named global script launched by the user runs as
 * the script's owning agent; its idempotency keys do not collide with an agent's; it cancels only
 * its own runs. The operator key and agents keep the routes as before.
 */
export const rbacIntegrationRole: Scenario = {
  name: "rbac-integration-role",
  order: 449,
  async run(ctx) {
    const leadId = await getLead(ctx);
    const launcherId = await registerAgent(ctx, "obs-int-launcher");
    const scriptName = `e2e-obs-int-${ctx.nonce}`;
    await upsertScript(ctx, leadId, { name: scriptName, source: NOOP, scope: "global" });
    const eventName = `e2e.obs.int.${ctx.nonce}`;
    const workflowId = await createWorkflow(ctx, "obs-int", {
      nodes: [
        {
          id: "start",
          type: "notify",
          config: { channel: "swarm", template: "start" },
          next: "wait",
        },
        {
          id: "wait",
          type: "wait",
          config: { mode: "event", eventName, scope: "run" },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "done" } },
      ],
    });

    // Operator key and agents: unchanged.
    const operatorRun = await triggerWorkflow(ctx, workflowId);
    const agentRun = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: { source: NOOP, idempotencyKey: `obs-int-key-${ctx.nonce}` },
    });
    expectStatus(agentRun, [201], "an agent launches an inline durable run");
    const agentRunId = asString(asRecord(agentRun.json).id, "agent run id");
    const namedByAgent = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: { name: scriptName },
    });
    expectStatus(namedByAgent, [201], "an agent launches a named global script");
    expectStatus(
      await ctx.api("POST", "/api/script-runs", {
        agentId: launcherId,
        body: { name: scriptName, source: NOOP },
      }),
      [400],
      "name and source together",
    );
    expectStatus(
      await ctx.api("POST", "/api/workflow-events", {
        body: { name: `${eventName}.global`, payload: {} },
      }),
      [200],
      "the operator key sends a global workflow event",
    );

    // Requester only: every route is refused at admission with the missing verb named.
    const user = await inviteRequester(ctx);
    const asUser = { apiKey: user.token };
    const refusals: [string, string, unknown, string][] = [
      ["POST", `/api/workflows/${workflowId}/trigger`, {}, "workflow.trigger"],
      [
        "POST",
        `/api/workflow-runs/${operatorRun.runId}/events`,
        { name: eventName },
        "workflow.run.event",
      ],
      ["POST", "/api/workflow-events", { name: eventName }, "workflow.run.event"],
      ["POST", "/api/script-runs", { name: scriptName }, "script.run.durable"],
      ["DELETE", `/api/script-runs/${agentRunId}`, undefined, "script.run.cancel"],
    ];
    for (const [method, path, body, verb] of refusals) {
      const response = await ctx.api(method, path, { ...asUser, body });
      expectStatus(response, [403], `a requester-only user on ${method} ${path}`);
      expect(response.text.includes(verb), `the 403 names ${verb}: ${response.text}`);
    }

    // Requester + obs-lite-integration.
    expectStatus(
      await ctx.api("PUT", `/api/users/${user.userId}/roles`, {
        body: { roles: ["requester", "obs-lite-integration"] },
      }),
      [200],
      "attach the integration role",
    );
    const triggered = await ctx.api("POST", `/api/workflows/${workflowId}/trigger`, {
      ...asUser,
      body: {},
    });
    expectStatus(triggered, [201], "the integration user triggers the workflow");
    const userRunId = asString(asRecord(triggered.json).runId, "user workflow run id");
    await waitForRun(ctx, userRunId, "waiting");
    expectStatus(
      await ctx.api("POST", `/api/workflow-runs/${userRunId}/events`, {
        ...asUser,
        body: { name: eventName, payload: {} },
      }),
      [200],
      "the integration user sends a run-scoped event",
    );
    await waitForRun(ctx, userRunId, "completed");
    expectStatus(
      await ctx.api("POST", "/api/workflow-events", {
        ...asUser,
        body: { name: `${eventName}.global`, payload: {} },
      }),
      [200],
      "the integration user sends a global event",
    );

    // Durable script runs: a global script by name, run as its owning agent.
    expectStatus(
      await ctx.api("POST", "/api/script-runs", { ...asUser, body: { source: NOOP } }),
      [400],
      "a user token cannot launch inline source",
    );
    expectStatus(
      await ctx.api("POST", "/api/script-runs", {
        ...asUser,
        body: { name: `${scriptName}-missing` },
      }),
      [404],
      "an unknown global script",
    );
    const sameKey = { name: scriptName, idempotencyKey: `obs-int-key-${ctx.nonce}` };
    const launched = await ctx.api("POST", "/api/script-runs", { ...asUser, body: sameKey });
    expectStatus(launched, [201], "the agent's key does not collide with the user's");
    const userScriptRunId = asString(asRecord(launched.json).id, "user script run id");
    const replay = await ctx.api("POST", "/api/script-runs", { ...asUser, body: sameKey });
    expectStatus(replay, [409], "the user replays its own key");
    expect(asRecord(replay.json).id === userScriptRunId, "the replay returns the user's run");
    let run: Record<string, unknown> = {};
    const finished = await pollUntil(async () => {
      const response = await ctx.api("GET", `/api/script-runs/${userScriptRunId}`);
      expectStatus(response, [200], "poll the user's script run");
      run = asRecord(asRecord(response.json).run);
      return ["completed", "failed", "cancelled"].includes(String(run.status));
    }, 60_000);
    expect(
      finished && run.status === "completed",
      `user script run: ${JSON.stringify(run).slice(0, 400)}`,
    );
    expect(run.agentId === leadId, `the run executes as the owning agent: ${String(run.agentId)}`);
    expect(run.requestedByUserId === user.userId, "the run is attributed to the user");
    expect(run.scriptName === scriptName, "the run records the script name");

    // An agent reusing the agent key still gets its own run, not the user's.
    const agentReplay = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: { source: NOOP, idempotencyKey: `obs-int-key-${ctx.nonce}` },
    });
    expectStatus(agentReplay, [409], "the agent replays its own key");
    expect(asRecord(agentReplay.json).id === agentRunId, "the agent's replay returns its run");
    const outsiderId = await registerAgent(ctx, "obs-int-outsider");
    const outsider = await ctx.api("POST", "/api/script-runs", {
      agentId: outsiderId,
      body: { source: NOOP, idempotencyKey: `obs-int-key-${ctx.nonce}` },
    });
    expectStatus(outsider, [409], "another agent's key");
    expect(
      asRecord(outsider.json).id === undefined,
      `a foreign key does not leak the run: ${outsider.text}`,
    );

    // Cancel: own runs only.
    expectStatus(
      await ctx.api("DELETE", `/api/script-runs/${agentRunId}`, asUser),
      [403],
      "a scoped user cannot cancel an agent's run",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/script-runs/${userScriptRunId}`, asUser),
      [204],
      "a scoped user cancels its own run",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/script-runs/${agentRunId}`),
      [204],
      "the operator key cancels any run",
    );
    expectStatus(
      await ctx.api("POST", `/api/workflow-runs/${operatorRun.runId}/events`, {
        body: { name: eventName, payload: {} },
      }),
      [200],
      "the operator key sends a run-scoped event",
    );
    await waitForRun(ctx, operatorRun.runId, "completed");
  },
};
