import { drainTasks } from "../gap-helpers";
import { expect, pollUntil } from "../http";
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

// #2585: a human's `!leave` in a thread the swarm is in leaves it in code,
// with an ephemeral confirmation to the sender and no task / model call.
export const gapSlackLeave: Scenario = {
  name: "gap-slack-leave",
  order: 1100,
  async run(ctx) {
    try {
      await gapRun(ctx);
    } finally {
      await drainTasks(ctx);
    }
  },
};

async function gapRun(ctx: ScenarioContext): Promise<void> {
  const botUser = ctx.slack.bot.userId;
  const leftRows = () =>
    ctx.db.query<{ key: string; value: string }>(
      "SELECT key, value FROM kv_entries WHERE namespace = 'slack-left-thread'",
    );
  const slackTaskCount = () =>
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE source = 'slack'")?.n ??
    0;
  const confirmations = () =>
    ctx.slack
      .apiCalls("chat.postEphemeral")
      .filter((c) => String(c.args.text ?? "").includes("Left this thread"));

  let leadId = await registerLead(ctx, "e2e-lead-gap-leave");
  const root = await ask(ctx, "kick off a thread for leave test");
  await waitForEyes(ctx, root.ts);
  const task = await findSlackTask(ctx, root.ts);
  leadId = String(task.agentId);
  await claim(ctx, leadId, String(task.id));
  await finish(ctx, leadId, String(task.id), { status: "completed", output: "Thread started." });
  await waitForOutcome(ctx, root.ts, "Thread started.");

  // Negative 1: "!leave now" (extra text) is an ordinary message.
  await ctx.slack.postMessage({
    channel: "general",
    user: "alice",
    text: "!leave now",
    thread_ts: root.ts,
  });
  await Bun.sleep(3000);
  expect(leftRows().length === 0, `"!leave now" left the thread: ${JSON.stringify(leftRows())}`);
  expect(confirmations().length === 0, `"!leave now" produced a confirmation`);

  // Negative 2: someone else's @mention before !leave is not addressed to the swarm.
  const other = ctx.slack.addUser({ name: "carol" });
  await ctx.slack.postMessage({
    channel: "general",
    user: "alice",
    text: `<@${other.id}> !leave`,
    thread_ts: root.ts,
  });
  await Bun.sleep(3000);
  expect(leftRows().length === 0, `"@carol !leave" left the thread`);

  // Negative 3: !leave in a thread with no swarm activity.
  const strangerRoot = await ctx.slack.postMessage({
    channel: "general",
    user: "alice",
    text: "just humans talking here",
  });
  await ctx.slack.postMessage({
    channel: "general",
    user: "bob",
    text: "a reply",
    thread_ts: strangerRoot.ts,
  });
  await ctx.slack.postMessage({
    channel: "general",
    user: "alice",
    text: "!leave",
    thread_ts: strangerRoot.ts,
  });
  await Bun.sleep(3000);
  expect(leftRows().length === 0, `!leave in a no-activity thread left it`);
  expect(confirmations().length === 0, `!leave in a no-activity thread produced a confirmation`);

  // Negative 4: top-level !leave (no thread).
  await ctx.slack.postMessage({ channel: "general", user: "alice", text: "!leave" });
  await Bun.sleep(2000);
  expect(leftRows().length === 0, `top-level !leave left something`);

  // Positive: !leave in the swarm's thread.
  const tasksBefore = slackTaskCount();
  const leaveMsg = await ctx.slack.postMessage({
    channel: "general",
    user: "alice",
    text: "!leave",
    thread_ts: root.ts,
  });
  const ok = await pollUntil(() => leftRows().length === 1, 15_000);
  expect(ok, "!leave in the swarm's thread did not record a left-thread row");
  const row = leftRows()[0];
  expect(
    row.key === `C0GENERAL0:${root.ts}`,
    `left-thread key ${row.key}, expected C0GENERAL0:${root.ts}`,
  );
  const val = JSON.parse(row.value) as { slackUserId?: string };
  const alice = ctx.slack.user("alice").id;
  expect(val.slackUserId === alice, `left-by ${val.slackUserId}, expected ${alice}`);
  const conf = await pollUntil(() => confirmations().length === 1, 10_000);
  expect(conf, "no ephemeral confirmation");
  const call = confirmations()[0];
  expect(
    call.args.user === alice && call.args.thread_ts === root.ts && call.ok === true,
    `ephemeral went to ${String(call.args.user)} thread ${String(call.args.thread_ts)} ok=${call.ok}`,
  );
  const eph = ctx.slack
    .ephemeralMessages("general")
    .filter((m) => m.text?.includes("Left this thread"));
  expect(eph.length === 1, `mock holds ${eph.length} ephemeral confirmations`);
  expect(
    slackTaskCount() === tasksBefore,
    `!leave created a task (${tasksBefore} -> ${slackTaskCount()})`,
  );
  expect(
    !ctx.slack
      .messages("general")
      .some(
        (m) => m.thread_ts === root.ts && m.ts !== root.ts && m.text?.includes("Left this thread"),
      ),
    "confirmation was visible in-channel",
  );
  ctx.log(`leave msg ts ${leaveMsg.ts}; kv ${row.key}`);

  // Left thread is silent: an unmentioned reply creates no task and gets no eyes.
  const silent = await ctx.slack.postMessage({
    channel: "general",
    user: "bob",
    text: "so what do you think?",
    thread_ts: root.ts,
  });
  await Bun.sleep(4000);
  expect(slackTaskCount() === tasksBefore, `message in left thread created a task`);
  const eyes = ctx.slack.apiCalls("reactions.add").some((c) => c.args.timestamp === silent.ts);
  expect(!eyes, "swarm reacted to a message in a left thread");

  // An @mention brings it back.
  const back = await ask(ctx, "are you back?", root.ts);
  await waitForEyes(ctx, back.ts);
  const resumed = await pollUntil(() => leftRows().length === 0, 10_000);
  expect(resumed, "mention did not clear the left-thread row");
  expect(
    slackTaskCount() === tasksBefore + 1,
    `mention created ${slackTaskCount() - tasksBefore} tasks, expected 1`,
  );
  expect(botUser, "bot user");
}
