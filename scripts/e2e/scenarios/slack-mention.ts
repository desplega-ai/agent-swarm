import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";

// The mock's timeout errors do not say which channel or thread was watched.
async function waitNamed<T>(what: string, wait: Promise<T>): Promise<T> {
  try {
    return await wait;
  } catch (error) {
    throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const slackMention: Scenario = {
  name: "slack-mention",
  async run(ctx) {
    expect(ctx.slack.apiCalls("auth.test").length > 0, "Bolt never called auth.test on the mock");
    expect(
      ctx.slack.apiCalls("apps.connections.open").length > 0,
      "Bolt never called apps.connections.open on the mock",
    );
    expect(
      ctx.slack.hub.connectionCount === 1,
      `Expected one socket mode connection, found ${ctx.slack.hub.connectionCount}`,
    );

    const leadResponse = await ctx.api("POST", "/api/agents", {
      body: { name: `e2e-lead-${ctx.nonce}`, isLead: true },
    });
    expectStatus(leadResponse, [201], "register lead");
    const leadId = asRecord(leadResponse.json).id;
    expect(typeof leadId === "string", "Registered lead has no id");

    const ask = await ctx.slack.postMessage({
      channel: "general",
      user: "alice",
      text: `<@${ctx.slack.bot.userId}> say hello from e2e ${ctx.nonce}`,
    });

    const reaction = await waitNamed(
      `eyes reaction on general ts ${ask.ts}`,
      ctx.slack.waitForApiCall("reactions.add", {
        timeoutMs: 30_000,
        where: (call) => call.args.name === "eyes" && call.args.timestamp === ask.ts,
      }),
    );
    expect(
      reaction.ok === true,
      `reactions.add on ts ${ask.ts} failed: ${reaction.error ?? "no error reported"}`,
    );

    const reply = await waitNamed(
      `bot reply in the general thread ${ask.ts}`,
      ctx.slack.waitForMessage(
        { channel: "general", thread_ts: ask.ts, from: "bot" },
        { timeoutMs: 30_000 },
      ),
    );
    expect(
      reply.thread_ts === ask.ts,
      `Bot replied on thread ${String(reply.thread_ts)}, expected ${ask.ts}`,
    );

    let task: Record<string, unknown> | undefined;
    const listed = await pollUntil(async () => {
      const response = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=50");
      expectStatus(response, [200], "list slack tasks");
      const tasks = asRecord(response.json).tasks;
      expect(Array.isArray(tasks), "Task list has no tasks array");
      task = tasks
        .map(asRecord)
        .find((row) => row.slackThreadTs === ask.ts || row.slackTriggerMessageTs === ask.ts);
      return task !== undefined;
    }, 30_000);
    expect(listed && task, `No slack task for thread ${ask.ts} within 30 seconds`);
    const taskId = String(task.id);
    expect(
      task.status === "pending",
      `Slack task ${taskId} is ${String(task.status)}, not pending`,
    );

    const row = ctx.db.get<{ source: string }>("SELECT source FROM agent_tasks WHERE id = ?", [
      taskId,
    ]);
    expect(
      row?.source === "slack",
      `agent_tasks row for ${taskId} has source ${row?.source ?? "<missing row>"}`,
    );

    // Exactly one poll: polling again while the task runs looks like a crash.
    expectStatus(
      await ctx.api("GET", "/api/poll", { agentId: leadId }),
      [200],
      "lead claims the slack task",
    );
    const claimed = await pollUntil(async () => {
      const response = await ctx.api("GET", `/api/tasks/${taskId}`);
      expectStatus(response, [200], "read the claimed slack task");
      return asRecord(response.json).status === "in_progress";
    }, 15_000);
    expect(claimed, `Slack task ${taskId} did not reach in_progress within 15 seconds`);

    const output = `hello from the e2e worker ${ctx.nonce}`;
    expectStatus(
      await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
        agentId: leadId,
        body: { status: "completed", output },
      }),
      [200],
      "finish the slack task",
    );

    const outcome = await waitNamed(
      `task outcome in C0GENERAL0 thread ${ask.ts}`,
      ctx.slack.waitForMessage(
        (message) =>
          message.channel === "C0GENERAL0" &&
          message.thread_ts === ask.ts &&
          JSON.stringify(message).includes(output),
        { timeoutMs: 30_000 },
      ),
    );
    expect(
      outcome.bot_id === ctx.slack.bot.botId,
      `Outcome message came from ${String(outcome.bot_id)}, expected the bot`,
    );

    // The Slack watcher ticks every three seconds before it flips the reaction.
    const acknowledged = await pollUntil(
      () =>
        ctx.slack
          .messages("general")
          .find((message) => message.ts === ask.ts)
          ?.reactions?.some((entry) => entry.name === "white_check_mark") === true,
      30_000,
    );
    expect(
      acknowledged,
      `Message ${ask.ts} in general never got a white_check_mark within 30 seconds`,
    );
  },
};
