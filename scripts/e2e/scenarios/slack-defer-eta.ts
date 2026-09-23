import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  announceLiveView,
  ask,
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  registerLead,
  slackPace,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

async function deferAndCheckSlack(ctx: ScenarioContext, renderer: "legacy" | "v2") {
  await registerLead(ctx, `e2e-lead-defer-${renderer}`);
  await announceLiveView(ctx, "/c/general");
  const message = await ask(ctx, "check the staging deployment when it finishes");
  ctx.markThread(`defer-eta-${renderer}`, "C0GENERAL0", message.ts);
  await announceLiveView(ctx, `/c/C0GENERAL0/t/${message.ts}`);
  await waitForEyes(ctx, message.ts);
  await slackPace("eyes");
  const task = await findSlackTask(ctx, message.ts);
  const taskId = String(task.id);
  const leadId = String(task.agentId);
  await claim(ctx, leadId, taskId);

  const pendingWork = `Verify the staging deployment ${renderer} ${ctx.nonce}`;
  const mcp = await ctx.connectMcp(leadId);
  try {
    const result = await mcp.callTool("defer-task", {
      taskId,
      delayMs: 86_400_000,
      summary: "Deployment started; waiting for it to finish.",
      note: `Pending: ${pendingWork}`,
    });
    expect(!result.isError, `defer-task failed: ${JSON.stringify(result)}`);
  } finally {
    await mcp.close();
  }

  // Positive control: exercise a real engine-authored ETA, not a pre-sanitized fixture.
  const response = await ctx.api("GET", `/api/tasks/${taskId}`);
  expectStatus(response, [200], "read deferred task");
  const deferred = asRecord(response.json);
  expect(deferred.status === "completed", "Deferred task did not complete");
  // This defer is time-based (delayMs, no wakeOn), so the card is the
  // "checking back" shape. A wakeOn defer instead reads "Waiting on <agent> —
  // or <when> at the latest"; both are asserted as units in defer-task.test.ts.
  expect(
    typeof deferred.output === "string" && deferred.output.startsWith("Checking back "),
    `Stored output must be the human-facing defer ETA, got: ${JSON.stringify(deferred.output)}`,
  );
  // The schedule UUID link used to ride along in the stored output, where Slack
  // stripped it but the UI task-detail row rendered it raw.
  expect(
    !String(deferred.output).includes("/schedules/"),
    "Stored output must not carry the defer schedule link",
  );
  expect(
    !String(deferred.output).includes(pendingWork),
    "Stored output must not carry the agent's internal handoff note",
  );

  // The ETA is the card: it is what a human needs to decide whether to wait.
  const outcome = await waitForOutcome(ctx, message.ts, "Checking back ");
  expect(outcome.bot_id === ctx.slack.bot.botId, "Deferral outcome must come from the bot");
  if (renderer === "v2") {
    // Require the outcome stream to finish, so a tree update cannot satisfy this assertion.
    const stopped = await ctx.slack.waitForApiCall("chat.stopStream", {
      timeoutMs: 30_000,
      where: (call) => call.args.ts === outcome.ts && call.args.channel === "C0GENERAL0",
    });
    expect(stopped.ok === true, "Deferred outcome card did not finish streaming");
  }
  // Parked is not answered: the ask keeps 👀 and gets no ✅. The reaction is
  // settled in the same pass that posts the card, so a short window suffices.
  await waitForReaction(ctx, message.ts, "eyes");
  const done = await pollUntil(
    () =>
      ctx.slack
        .messages("general")
        .find((entry) => entry.ts === message.ts)
        ?.reactions?.some((reaction) => reaction.name === "white_check_mark") === true,
    3_000,
  );
  expect(!done, `${renderer}: a parked ask must not get a ✅ reaction`);
  if (renderer === "v2") {
    // Nothing else is running, so the tree header is the deferral's state.
    const header = await pollUntil(
      () =>
        ctx.slack
          .messages("general")
          .some(
            (entry) =>
              entry.thread_ts === message.ts &&
              String(entry.text ?? "").startsWith("🧵 ⏳ waiting"),
          ),
      15_000,
    );
    expect(header, "v2 thread tree must read ⏳ waiting while the ask is parked");
  }
  await slackPace("checking-back");

  const thread = JSON.stringify(
    ctx.slack.messages("general").filter((entry) => entry.thread_ts === message.ts),
  );
  // A deferral is stored `completed`, but to the thread the work is still
  // outstanding, so the card must not claim it is done.
  //
  // v2 only: the legacy renderer composes its outcome through
  // `buildCompletedBlocks`, whose ✅ header is fixed, so a legacy deferral
  // still reads as completed. The card body below is fixed in both.
  if (renderer === "v2") {
    expect(thread.includes("⏳"), "v2 Slack thread did not mark the deferral as waiting");
  }
  expect(
    !thread.includes(pendingWork),
    `${renderer} Slack thread leaked the agent's internal handoff note`,
  );
  expect(!thread.includes("Deferred until"), `${renderer} Slack thread used the old defer wording`);
  expect(
    !thread.includes("/schedules/"),
    `${renderer} Slack thread leaked the defer schedule link`,
  );
}

// registry.ts discovers both exports. Legacy must precede the scenarios that enable v2;
// v2 must precede the scenarios that enable delegation globally.
export const slackDeferEtaLegacy: Scenario = {
  name: "slack-defer-eta-legacy",
  order: 125,
  groups: ["visuals-legacy"],
  run: (ctx) => deferAndCheckSlack(ctx, "legacy"),
};

export const slackDeferEtaV2: Scenario = {
  name: "slack-defer-eta-v2",
  order: 135,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await deferAndCheckSlack(ctx, "v2");
  },
};
