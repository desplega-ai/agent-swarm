import { randomBytes } from "node:crypto";
import { sql } from "../db";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { deleteConfig, putConfig, reloadConfig } from "./platform-helpers";
import {
  ask,
  claim,
  createChildTask,
  enableSlackRenderV2Only,
  findSlackTask,
  finish,
  registerLead,
  registerWorker,
  slackAbsenceWindowMs,
  waitForEyes,
  waitForOutcome,
  waitForReaction,
} from "./slack-helpers";

const CHANNEL = "C0GENERAL0";
const ALICE = "U0ALICE000";
const BOB = "U0BOB00000";

/** Slack's `agent_session_stopped`, as Slack sends it when `user` clicks Stop in the thread. */
async function clickStop(ctx: ScenarioContext, threadTs: string, user: string): Promise<void> {
  const now = Date.now() / 1000;
  const ack = await ctx.slack.delivery.send("events_api", {
    token: "mock-verification-token",
    team_id: ctx.slack.team.id,
    api_app_id: ctx.slack.store.app.id,
    type: "event_callback",
    event_id: `Ev${randomBytes(5).toString("hex").toUpperCase()}`,
    event_time: Math.floor(now),
    authorizations: [{ team_id: ctx.slack.team.id, user_id: ctx.slack.bot.userId, is_bot: true }],
    event: {
      type: "agent_session_stopped",
      user,
      channel: CHANNEL,
      thread_ts: threadTs,
      streaming_message_ts: [],
      event_ts: now.toFixed(6),
    },
  });
  expect(ack.attempts >= 1, `agent_session_stopped for ${threadTs} was never acked`);
}

function sessionStatus(ctx: ScenarioContext, threadTs: string): string | undefined {
  return ctx.slack.assistantThread(CHANNEL, threadTs).sessionStatus;
}

async function waitForSessionStatus(
  ctx: ScenarioContext,
  threadTs: string,
  status: string,
): Promise<void> {
  const reached = await pollUntil(() => sessionStatus(ctx, threadTs) === status, 30_000);
  expect(
    reached,
    `Thread ${threadTs} session status is ${sessionStatus(ctx, threadTs)}, never ${status}`,
  );
}

async function taskStatus(ctx: ScenarioContext, taskId: string): Promise<string> {
  const response = await ctx.api("GET", `/api/tasks/${taskId}`);
  expectStatus(response, [200], `read task ${taskId}`);
  return String(asRecord(response.json).status);
}

/** A running ask: the lead's task claimed, in its own thread. */
async function runningAsk(ctx: ScenarioContext, leadId: string, text: string) {
  const message = await ask(ctx, `swarm#${leadId} ${text} ${ctx.nonce}`);
  await waitForEyes(ctx, message.ts);
  const taskId = String((await findSlackTask(ctx, message.ts)).id);
  await claim(ctx, leadId, taskId);
  await waitForSessionStatus(ctx, message.ts, "processing");
  return { threadTs: message.ts, taskId };
}

/** A Stop click nobody may act on: the work keeps running and the thread stays `processing`. */
async function expectStopIgnored(ctx: ScenarioContext, threadTs: string, taskIds: string[]) {
  const ended = await pollUntil(async () => {
    for (const id of taskIds) if ((await taskStatus(ctx, id)) === "cancelled") return true;
    return false;
  }, slackAbsenceWindowMs(ctx));
  expect(!ended, `An ignored Stop cancelled work in thread ${threadTs}`);
  expect(
    sessionStatus(ctx, threadTs) === "processing",
    `An ignored Stop moved thread ${threadTs} to ${sessionStatus(ctx, threadTs)}`,
  );
}

/**
 * Slack's native Stop button for a running ask, behind SLACK_STOP_BUTTON_ENABLED. An explicit
 * `false` wins over the on default: the event is ignored. Unset (the default, on): a person
 * outside the sender allowlist is ignored, and an allowed person cancels the thread's open tasks
 * and their delegated work, then the session leaves `processing`. The mock cannot draw Slack's
 * own Working… line, so the frames show the thread before and after the click.
 */
export const slackStopButton: Scenario = {
  name: "slack-stop-button",
  order: 136.7,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    const leadId = await registerLead(ctx, `e2e-lead-stop-${ctx.nonce}`);
    const presence = await ctx.api(
      "GET",
      "/api/config/env-presence?keys=SLACK_STOP_BUTTON_ENABLED",
    );
    expectStatus(presence, [200], "check the Stop button setting is unset");
    expect(
      asRecord(asRecord(presence.json).presence).SLACK_STOP_BUTTON_ENABLED === false,
      "SLACK_STOP_BUTTON_ENABLED is already set; the on phase checks the default",
    );

    const rows: string[] = [];
    try {
      // ── Explicit false: the click does nothing ─────────────────────────────────
      const offRow = String(
        (await putConfig(ctx, { key: "SLACK_STOP_BUTTON_ENABLED", value: "false" })).id,
      );
      rows.push(offRow);
      await reloadConfig(ctx);
      await ctx.slack.waitForConnection(30_000);
      const off = await runningAsk(ctx, leadId, "summarize the open incidents");
      ctx.markThread("stop-button-off", CHANNEL, off.threadTs);
      await clickStop(ctx, off.threadTs, ALICE);
      await expectStopIgnored(ctx, off.threadTs, [off.taskId]);
      // Logged once per process, so an earlier ignored click in this process may have logged it.
      expect(
        (await ctx.sutLog()).includes("SLACK_STOP_BUTTON_ENABLED is off"),
        "The SUT did not log why it ignored the Stop click",
      );
      await finish(ctx, leadId, off.taskId, { status: "completed", output: "No open incidents." });
      await waitForReaction(ctx, off.threadTs, "white_check_mark");
      await deleteConfig(ctx, offRow);
      rows.splice(rows.indexOf(offRow), 1);

      // ── Unset: on by default ───────────────────────────────────────────────────
      rows.push(String((await putConfig(ctx, { key: "SLACK_ALLOWED_USER_IDS", value: ALICE })).id));
      await reloadConfig(ctx);
      await ctx.slack.waitForConnection(30_000);

      const on = await runningAsk(ctx, leadId, "draft the weekly report");
      ctx.markThread("stop-button-on", CHANNEL, on.threadTs);
      const workerId = await registerWorker(ctx, `e2e-worker-stop-${ctx.nonce}`);
      const childId = await createChildTask(ctx, on.taskId, workerId, "collect the weekly numbers");

      // Someone the message handler would not accept.
      await clickStop(ctx, on.threadTs, BOB);
      await expectStopIgnored(ctx, on.threadTs, [on.taskId, childId]);

      await clickStop(ctx, on.threadTs, ALICE);
      for (const id of [on.taskId, childId]) {
        const cancelled = await pollUntil(
          async () => (await taskStatus(ctx, id)) === "cancelled",
          15_000,
        );
        expect(cancelled, `Stop did not cancel task ${id}`);
        const row = ctx.db.get<{ failureReason: string | null; statusKind: string | null }>(
          sql`SELECT "failureReason", "statusKind" FROM agent_tasks WHERE id = ${id}`,
        );
        expect(
          row?.failureReason === `Stopped from Slack by <@${ALICE}>` && row.statusKind === "user",
          `Task ${id} was cancelled with ${JSON.stringify(row)}`,
        );
      }
      await waitForSessionStatus(ctx, on.threadTs, "active");
      await waitForOutcome(ctx, on.threadTs, "Stopped from Slack");
    } finally {
      for (const id of rows) await deleteConfig(ctx, id);
      await reloadConfig(ctx);
      await ctx.slack.waitForConnection(30_000);
    }
  },
};
