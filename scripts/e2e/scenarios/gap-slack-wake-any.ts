import { drainTasks } from "../gap-helpers";
import { expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForEyes,
  waitForOutcome,
} from "./slack-helpers";

// #2567: SLACK_THREAD_WAKE_ON_ANY_MESSAGE. A thread reply that @mentions
// another person wakes the swarm only when the flag is on.
async function setFlag(ctx: ScenarioContext, key: string, value: string): Promise<void> {
  expectStatus(
    await ctx.api("PUT", "/api/config", {
      body: { scope: "global", scopeId: null, key, value, isSecret: false },
    }),
    [200],
    `set ${key}=${value}`,
  );
  await Bun.sleep(1500); // config auto-reload is debounced ~250ms
}

export const gapSlackWakeAny: Scenario = {
  name: "gap-slack-wake-any",
  order: 1110,
  async run(ctx) {
    try {
      await gapRun(ctx);
    } finally {
      await drainTasks(ctx);
    }
  },
};

async function gapRun(ctx: ScenarioContext): Promise<void> {
  let leadId = await registerLead(ctx, "e2e-lead-gap-wake");
  const carol = ctx.slack.addUser({ name: "carol" });
  const slackTasks = () =>
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE source = 'slack'")?.n ??
    0;

  const root = await ask(ctx, "start a thread for wake test");
  await waitForEyes(ctx, root.ts);
  const rootTask = await findSlackTask(ctx, root.ts);
  leadId = String(rootTask.agentId);
  await claim(ctx, leadId, String(rootTask.id));
  await finish(ctx, leadId, String(rootTask.id), {
    status: "completed",
    output: "Wake thread ready.",
  });
  await waitForOutcome(ctx, root.ts, "Wake thread ready.");

  // Posts a thread reply, reports whether it created a task, and settles that task.
  async function probe(user: string, text: string, threadTs: string): Promise<boolean> {
    const before = slackTasks();
    const msg = await ctx.slack.postMessage({
      channel: "general",
      user,
      text,
      thread_ts: threadTs,
    });
    const created = await pollUntil(() => slackTasks() > before, 7_000, 300);
    if (created) {
      const t = await findSlackTask(ctx, msg.ts);
      await claim(ctx, leadId, String(t.id));
      await finish(ctx, leadId, String(t.id), { status: "completed", output: `ok ${msg.ts}` });
      await waitForOutcome(ctx, threadTs, `ok ${msg.ts}`);
    }
    return created;
  }
  const other = `<@${carol.id}> wdyt about this?`;

  // Flag OFF (default).
  expect(
    (await probe("alice", "plain follow-up, nobody mentioned", root.ts)) === true,
    "control: plain reply did not wake the swarm",
  );
  expect(
    (await probe("alice", other, root.ts)) === false,
    "flag off: reply addressed to another user woke the swarm",
  );

  // Flag ON.
  await setFlag(ctx, "SLACK_THREAD_WAKE_ON_ANY_MESSAGE", "true");
  expect(
    (await probe("alice", other, root.ts)) === true,
    "flag on: reply addressed to another user did not wake the swarm",
  );
  // Does not wake a thread with no swarm activity.
  const strangerRoot = await ctx.slack.postMessage({
    channel: "general",
    user: "alice",
    text: "humans only thread",
  });
  expect(
    (await probe("alice", other, strangerRoot.ts)) === false,
    "flag on: woke a thread with no swarm activity",
  );

  // REQUIRE_MENTION still wins.
  await setFlag(ctx, "SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION", "true");
  expect(
    (await probe("alice", other, root.ts)) === false,
    "flag on + REQUIRE_MENTION: unmentioned reply woke the swarm",
  );
  expect(
    (await probe("alice", `<@${ctx.slack.bot.userId}> explicit mention`, root.ts)) === true,
    "REQUIRE_MENTION: bot mention did not wake the swarm",
  );
  await setFlag(ctx, "SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION", "false");

  // Flag back OFF.
  await setFlag(ctx, "SLACK_THREAD_WAKE_ON_ANY_MESSAGE", "false");
  expect(
    (await probe("alice", other, root.ts)) === false,
    "flag back off: addressed reply woke the swarm",
  );
}
