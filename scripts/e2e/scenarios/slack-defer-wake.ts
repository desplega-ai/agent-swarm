import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  announceLiveView,
  ask,
  createChildTask,
  enableSlackRenderV2Only,
  findSlackTask,
  finish,
  registerLead,
  registerWorker,
  slackPace,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

/**
 * `/api/poll` hands out one task per call, in the pool's own order. After a
 * worker finishes, the lead has both the wake-up and the worker-completion
 * follow-up pending, so poll until the one we want is ours.
 */
async function claimTask(ctx: ScenarioContext, agentId: string, taskId: string): Promise<void> {
  let last: Record<string, unknown> = {};
  const claimed = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/tasks/${taskId}`);
    expectStatus(response, [200], `read task ${taskId} while claiming it`);
    last = asRecord(response.json);
    if (last.status === "in_progress") return true;
    expectStatus(
      await ctx.api("GET", "/api/poll", { agentId }),
      [200],
      `agent ${agentId} polls for ${taskId}`,
    );
    return false;
  }, 15_000);
  expect(
    claimed,
    `Task ${taskId} did not reach in_progress for ${agentId} within 15 seconds ` +
      `(status ${String(last.status)}, agentId ${String(last.agentId)})`,
  );
}

async function findTask(
  ctx: ScenarioContext,
  agentId: string,
  match: (row: Record<string, unknown>) => boolean,
  what: string,
): Promise<Record<string, unknown>> {
  let task: Record<string, unknown> | undefined;
  const found = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/tasks?agentId=${agentId}&fields=full&limit=50`);
    expectStatus(response, [200], `list tasks for ${agentId} while finding ${what}`);
    const tasks = asRecord(response.json).tasks;
    expect(Array.isArray(tasks), `Task list for ${agentId} has no tasks array`);
    task = tasks.map(asRecord).find(match);
    return task !== undefined;
  }, 15_000);
  expect(found && task, `No ${what} within 15 seconds`);
  return task;
}

function threadMessagesOf(ctx: ScenarioContext, threadTs: string) {
  return ctx.slack.messages("general").filter((entry) => entry.thread_ts === threadTs);
}

/** The thread-tree status message: the bot message whose text opens with 🧵. */
async function waitForTreeHeader(
  ctx: ScenarioContext,
  threadTs: string,
  header: string,
): Promise<string> {
  let text = "";
  const found = await pollUntil(() => {
    const tree = threadMessagesOf(ctx, threadTs).find((entry) =>
      String(entry.text ?? "").startsWith("🧵"),
    );
    text = String(tree?.text ?? "");
    return text.startsWith(header);
  }, 15_000);
  expect(found, `Thread tree never read "${header}" within 15 seconds; last: ${text}`);
  return text;
}

function reactionNames(ctx: ScenarioContext, ts: string): string[] {
  const message = ctx.slack.messages("general").find((entry) => entry.ts === ts);
  return (message?.reactions ?? []).map((reaction) => reaction.name);
}

/**
 * The event-based half of the deferral card lifecycle, end to end on v2:
 * a lead defers on a delegated child (`wakeOn`), the card reads "Waiting on
 * <agent> — or <when> at the latest", the child settles, the wake-up task
 * answers, and the ⏳ card is rewritten IN PLACE (same ts) by
 * `refreshResolvedDeferralCards()` with the answer. The wake-up posts no card
 * of its own, so the answer lands in the thread exactly once.
 *
 * While parked, the ask keeps 👀 rather than ✅; once resolved it reads done.
 */
async function deferOnChildAndWake(ctx: ScenarioContext): Promise<void> {
  await registerLead(ctx, "e2e-lead-defer-wake");
  const workerName = "Researcher";
  const workerId = await registerWorker(ctx, workerName);

  await announceLiveView(ctx, "/c/general");
  const message = await ask(ctx, "ship the release notes once the staging deploy is verified");
  ctx.markThread("defer-wake-v2", "C0GENERAL0", message.ts);
  await announceLiveView(ctx, `/c/C0GENERAL0/t/${message.ts}`);
  await waitForEyes(ctx, message.ts);
  const task = await findSlackTask(ctx, message.ts);
  const taskId = String(task.id);
  const leadId = String(task.agentId);
  await claimTask(ctx, leadId, taskId);
  await slackPace("eyes");

  const childId = await createChildTask(
    ctx,
    taskId,
    workerId,
    "Verify the staging deploy is healthy",
  );
  await claimTask(ctx, workerId, childId);

  const pendingWork = `Publish the release notes ${ctx.nonce}`;
  const mcp = await ctx.connectMcp(leadId);
  try {
    const result = await mcp.callTool("defer-task", {
      taskId,
      delayMs: 86_400_000,
      wakeOn: { event: "settled", taskId: childId },
      summary: "Asked Researcher to verify staging before publishing.",
      note: `Pending: ${pendingWork}`,
    });
    expect(!result.isError, `defer-task failed: ${JSON.stringify(result)}`);
  } finally {
    await mcp.close();
  }

  const waitingOn = `Waiting on ${workerName} — or `;
  const card = await waitForOutcome(ctx, message.ts, waitingOn);
  expect(card.bot_id === ctx.slack.bot.botId, "Deferral card must come from the bot");
  const stopped = await ctx.slack.waitForApiCall("chat.stopStream", {
    timeoutMs: 30_000,
    where: (call) => call.args.ts === card.ts && call.args.channel === "C0GENERAL0",
  });
  expect(stopped.ok === true, "Deferral card did not finish streaming");
  expect(JSON.stringify(card).includes("⏳"), "Event-based deferral card must read as waiting");
  expect(!JSON.stringify(card).includes("✅"), "Event-based deferral card must not read as done");
  // Parked is not answered: no ✅ on the ask. (The tree reads "🔄 working"
  // here, since Researcher is still running; slack-defer-eta-v2 covers the
  // "⏳ waiting" header of a thread with nothing else running.)
  const parkedReactions = reactionNames(ctx, message.ts);
  expect(
    parkedReactions.includes("eyes") && !parkedReactions.includes("white_check_mark"),
    `A parked ask must keep 👀 and not read ✅; reactions: ${parkedReactions.join(", ")}`,
  );
  await slackPace("waiting-on");
  await slackPace();

  // The child settles: the wait fires and books the wake-up for the lead.
  await finish(ctx, workerId, childId, {
    status: "completed",
    output: "Staging is healthy: 0 errors in the last 15 minutes.",
  });
  const wake = await findTask(
    ctx,
    leadId,
    (row) => row.parentTaskId === taskId && row.taskType === "deferred",
    `wake-up task for ${taskId}`,
  );
  const wakeId = String(wake.id);
  // A worker finishing also books a review follow-up for the lead, and the
  // lead holds one task at a time. Clear the review first so the wake-up
  // can be claimed, whichever of the two the pool hands out first.
  const followUp = await findTask(
    ctx,
    leadId,
    (row) => row.parentTaskId === childId && row.taskType === "follow-up",
    `worker follow-up for ${childId}`,
  );
  const followUpId = String(followUp.id);
  await claimTask(ctx, leadId, followUpId).catch(async () => {
    // The pool handed out the wake-up first: answer the review after it.
    await claimTask(ctx, leadId, wakeId);
  });
  const current = asRecord((await ctx.api("GET", `/api/tasks/${followUpId}`)).json);
  if (current.status === "in_progress") {
    await finish(ctx, leadId, followUpId, { status: "completed", output: "Reviewed." });
    await claimTask(ctx, leadId, wakeId);
  }
  await slackPace("wake-running");

  const answer = `Release notes published after staging checked out ${ctx.nonce}`;
  await finish(ctx, leadId, wakeId, { status: "completed", output: answer });
  await waitForOutcome(ctx, message.ts, answer);
  if (asRecord((await ctx.api("GET", `/api/tasks/${followUpId}`)).json).status === "pending") {
    await claimTask(ctx, leadId, followUpId);
    await finish(ctx, leadId, followUpId, { status: "completed", output: "Reviewed." });
  }

  // Same ts, new body: the ⏳ card is closed where it stands.
  const rewritten = await ctx.slack.waitForApiCall("chat.update", {
    timeoutMs: 30_000,
    where: (call) =>
      call.args.ts === card.ts &&
      call.args.channel === "C0GENERAL0" &&
      String(call.args.text ?? "").startsWith("✅"),
  });
  expect(rewritten.ok === true, "chat.update rewriting the deferral card failed");
  const cardNow = ctx.slack
    .messages("general")
    .find((entry) => entry.ts === card.ts && entry.thread_ts === message.ts);
  expect(cardNow !== undefined, "The rewritten deferral card is no longer in the thread");
  const cardText = JSON.stringify(cardNow);
  expect(!cardText.includes("⏳"), `Resolved deferral card still reads as waiting: ${cardText}`);
  expect(cardText.includes("✅"), `Resolved deferral card does not read as done: ${cardText}`);

  const threadMessages = () => threadMessagesOf(ctx, message.ts);
  const answerCardsNow = () =>
    threadMessages().filter((entry) => JSON.stringify(entry).includes(answer));
  // The rewrite IS the answer; the wake-up must not post it a second time in
  // a card of its own. Give such a card the window a render tick needs.
  await pollUntil(() => answerCardsNow().length > 1, 10_000);
  const answerCards = answerCardsNow();
  expect(
    answerCards.length === 1 && answerCards[0]!.ts === card.ts,
    `The wake-up answer landed ${answerCards.length} times in the thread (ts ${answerCards
      .map((entry) => entry.ts)
      .join(", ")}); it belongs once, in the rewritten deferral card ${card.ts}`,
  );
  // Resolved: the ask is answered, so it and the tree now read done.
  await waitForReaction(ctx, message.ts, "white_check_mark");
  const tree = await waitForTreeHeader(ctx, message.ts, "🧵 ✅ done");
  expect(!tree.includes("⏳"), `Resolved thread tree still shows a waiting line: ${tree}`);
  const thread = JSON.stringify(threadMessages());
  expect(!thread.includes(pendingWork), "v2 Slack thread leaked the agent's internal handoff note");
  expect(!thread.includes("/schedules/"), "v2 Slack thread leaked the defer schedule link");
  await slackPace("resolved");
}

// After slack-defer-eta-v2 (135): v2 on, delegation still off, which is prod.
export const slackDeferWakeV2: Scenario = {
  name: "slack-defer-wake-v2",
  order: 137,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await deferOnChildAndWake(ctx);
  },
};
