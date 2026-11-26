import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cancelTask, createPinnedTask } from "./knowledge-helpers";
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
 * `obs-lite-integration` role is attached. The same holds for binding a new task to a Slack thread
 * (`task.slack.thread.bind`), by the two thread fields or by a slack contextKey; only one of the two
 * thread fields is a 400. A user may launch only the global scripts listed in
 * `SCRIPT_RUN_USER_ALLOWLIST`, and each runs as the script's owning agent; its idempotency keys do not collide with an agent's; it cancels only
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
    // A lead-owned global script the operator did not list for user tokens.
    const unlistedName = `${scriptName}-unlisted`;
    await upsertScript(ctx, leadId, { name: unlistedName, source: NOOP, scope: "global" });
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
    // POST /api/tasks itself is open to a requester; binding a Slack thread is not.
    const slackThread = { slackChannelId: `C0E2E${ctx.nonce}`, slackThreadTs: "1700000000.000100" };
    const threadRefused = await ctx.api("POST", "/api/tasks", {
      ...asUser,
      body: { task: `obs-int-thread ${ctx.nonce}`, ...slackThread },
    });
    expectStatus(threadRefused, [403], "a requester-only user binding a Slack thread");
    expect(
      threadRefused.text.includes("task.slack.thread.bind"),
      `the 403 names task.slack.thread.bind: ${threadRefused.text}`,
    );
    // A slack-family contextKey binds the thread too: task creation backfills the Slack
    // fields from it.
    const slackContextKey = `task:slack:C0E2EKEY${ctx.nonce}:1700000000.000200`;
    const keyRefused = await ctx.api("POST", "/api/tasks", {
      ...asUser,
      body: { task: `obs-int-key ${ctx.nonce}`, contextKey: slackContextKey },
    });
    expectStatus(keyRefused, [403], "a requester-only user naming a Slack contextKey");
    expect(
      keyRefused.text.includes("task.slack.thread.bind"),
      `the contextKey 403 names task.slack.thread.bind: ${keyRefused.text}`,
    );
    // A child may reuse its parent's own thread, and only that thread: the user owns a
    // parent the operator bound to channel:thread, and neither half may differ.
    const parentChannel = `C0E2EPAR${ctx.nonce}`;
    const parentTs = "1700000000.000300";
    const parent = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `obs-int-parent ${ctx.nonce}`,
        slackChannelId: parentChannel,
        slackThreadTs: parentTs,
        requestedByUserId: user.userId,
      },
    });
    expectStatus(parent, [201], "the operator binds a user-owned parent to a Slack thread");
    const parentTaskId = asString(asRecord(parent.json).id, "parent task id");
    const childOf = (channel: string, ts: string) =>
      ctx.api("POST", "/api/tasks", {
        ...asUser,
        body: {
          task: `obs-int-child ${ctx.nonce}`,
          parentTaskId,
          contextKey: `task:slack:${channel}:${ts}`,
        },
      });
    const sameThread = await childOf(parentChannel, parentTs);
    expectStatus(sameThread, [201], "a child in its parent's own Slack thread");
    await cancelTask(ctx, asString(asRecord(sameThread.json).id, "same-thread child id"));
    for (const [channel, ts, label] of [
      [parentChannel, "1700000000.000400", "another thread in the parent's channel"],
      [`C0E2EPAR2${ctx.nonce}`, parentTs, "the parent's thread ts in another channel"],
    ]) {
      const refused = await childOf(channel, ts);
      expectStatus(refused, [403], `a child naming ${label}`);
      expect(
        refused.text.includes("task.slack.thread.bind"),
        `the 403 for ${label} names task.slack.thread.bind: ${refused.text}`,
      );
    }
    await cancelTask(ctx, parentTaskId);

    // Requester + obs-lite-integration.
    expectStatus(
      await ctx.api("PUT", `/api/users/${user.userId}/roles`, {
        body: { roles: ["requester", "obs-lite-integration"] },
      }),
      [200],
      "attach the integration role",
    );
    expectStatus(
      await ctx.api("POST", "/api/tasks", {
        ...asUser,
        body: { task: `obs-int-half ${ctx.nonce}`, slackChannelId: slackThread.slackChannelId },
      }),
      [400],
      "a Slack channel without a thread ts",
    );
    const bound = await ctx.api("POST", "/api/tasks", {
      ...asUser,
      body: { task: `obs-int-thread ${ctx.nonce}`, ...slackThread },
    });
    expectStatus(bound, [201], "the integration user binds a task to a Slack thread");
    const boundTask = asRecord(bound.json);
    expect(
      boundTask.slackChannelId === slackThread.slackChannelId &&
        boundTask.slackThreadTs === slackThread.slackThreadTs,
      `the task stores the thread: ${bound.text.slice(0, 400)}`,
    );
    await cancelTask(ctx, asString(boundTask.id, "bound task id"));
    const keyBound = await ctx.api("POST", "/api/tasks", {
      ...asUser,
      body: { task: `obs-int-key ${ctx.nonce}`, contextKey: slackContextKey },
    });
    expectStatus(keyBound, [201], "the integration user binds a thread through a contextKey");
    const keyBoundTask = asRecord(keyBound.json);
    expect(
      keyBoundTask.slackChannelId === `C0E2EKEY${ctx.nonce}` &&
        keyBoundTask.slackThreadTs === "1700000000.000200",
      `the contextKey task stores its thread: ${keyBound.text.slice(0, 400)}`,
    );
    await cancelTask(ctx, asString(keyBoundTask.id, "contextKey task id"));
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

    // Durable script runs: only a global script in SCRIPT_RUN_USER_ALLOWLIST, run as its owning agent.
    expectStatus(
      await ctx.api("POST", "/api/script-runs", { ...asUser, body: { source: NOOP } }),
      [400],
      "a user token cannot launch inline source",
    );
    const unlistedBeforeConfig = await ctx.api("POST", "/api/script-runs", {
      ...asUser,
      body: { name: scriptName },
    });
    expectStatus(unlistedBeforeConfig, [403], "an empty allowlist admits no user script run");
    expect(
      unlistedBeforeConfig.text.includes("SCRIPT_RUN_USER_ALLOWLIST"),
      `the 403 names the allowlist: ${unlistedBeforeConfig.text}`,
    );
    expectStatus(
      await ctx.api("PUT", "/api/config", {
        body: {
          scope: "global",
          scopeId: null,
          key: "SCRIPT_RUN_USER_ALLOWLIST",
          value: `${scriptName}, ${scriptName}-missing`,
          isSecret: false,
        },
      }),
      [200],
      "the operator lists the integration script",
    );
    const unlisted = await ctx.api("POST", "/api/script-runs", {
      ...asUser,
      body: { name: unlistedName },
    });
    expectStatus(unlisted, [403], "another lead-owned global script stays refused");
    expect(asRecord(unlisted.json).id === undefined, `no run is created: ${unlisted.text}`);
    expectStatus(
      await ctx.api("POST", "/api/script-runs", {
        ...asUser,
        body: { name: `${scriptName}-nonexistent` },
      }),
      [403],
      "an unlisted unknown name answers like an unlisted script",
    );
    expectStatus(
      await ctx.api("POST", "/api/script-runs", {
        ...asUser,
        body: { name: `${scriptName}-missing` },
      }),
      [404],
      "a listed but unknown global script",
    );
    const sameKey = { name: scriptName, idempotencyKey: `obs-int-key-${ctx.nonce}` };
    const launched = await ctx.api("POST", "/api/script-runs", { ...asUser, body: sameKey });
    expectStatus(launched, [201], "the agent's key does not collide with the user's");
    const userScriptRunId = asString(asRecord(launched.json).id, "user script run id");
    const replay = await ctx.api("POST", "/api/script-runs", { ...asUser, body: sameKey });
    expectStatus(replay, [409], "the user replays its own key");
    expect(asRecord(replay.json).id === userScriptRunId, "the replay returns the user's run");
    // A user token has no calling run, and the run executes as the script's owner: a
    // body-named parent is ignored, never checked against (or grafted onto) the owner's runs.
    expectStatus(
      await ctx.api("POST", "/api/script-runs", {
        ...asUser,
        body: { name: scriptName, parentScriptRunId: `no-such-run-${ctx.nonce}` },
      }),
      [201],
      "a user token's parentScriptRunId is ignored",
    );
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

    // The `user:` key prefix is reserved: no agent can plant a key in a user's namespace,
    // neither to block the user's launch nor, as a lead naming the user, to hand it a run.
    const plants: [string, Record<string, unknown>, string][] = [
      [launcherId, {}, `plant-a-${ctx.nonce}`],
      [leadId, { requestedByUserId: user.userId }, `plant-b-${ctx.nonce}`],
    ];
    for (const [plantAgentId, extra, key] of plants) {
      expectStatus(
        await ctx.api("POST", "/api/script-runs", {
          agentId: plantAgentId,
          body: { source: NOOP, idempotencyKey: `user:${user.userId}:${key}`, ...extra },
        }),
        [400],
        `an agent cannot plant a user-namespace key (${key})`,
      );
      expectStatus(
        await ctx.api("POST", "/api/script-runs", {
          ...asUser,
          body: { name: scriptName, idempotencyKey: key },
        }),
        [201],
        `the user's launch with ${key} is a fresh run`,
      );
    }

    // A user token cannot route its run into an agent task's thread via X-Source-Task-Id.
    const leadTaskId = await createPinnedTask(ctx, leadId, "obs-int-source");
    const sourceHeader = { headers: { "X-Source-Task-Id": leadTaskId } };
    const readSourceTask = async (response: { json: unknown }) => {
      const id = asString(asRecord(response.json).id, "source-task run id");
      const read = await ctx.api("GET", `/api/script-runs/${id}`);
      expectStatus(read, [200], "read the source-task run");
      return asRecord(asRecord(read.json).run).sourceTaskId;
    };
    const leadLaunch = await ctx.api("POST", "/api/script-runs", {
      agentId: leadId,
      ...sourceHeader,
      body: { name: scriptName },
    });
    expectStatus(leadLaunch, [201], "the lead launches with its own task as source");
    expect(
      (await readSourceTask(leadLaunch)) === leadTaskId,
      "control: an agent's own task is recorded as the run's source task",
    );
    const userLaunch = await ctx.api("POST", "/api/script-runs", {
      ...asUser,
      ...sourceHeader,
      body: { name: scriptName },
    });
    expectStatus(userLaunch, [201], "the user launches with an owner-agent task header");
    const userSourceTask = await readSourceTask(userLaunch);
    expect(!userSourceTask, `a user run records no source task: ${String(userSourceTask)}`);
    await cancelTask(ctx, leadTaskId);

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
