import { drainTasks } from "../gap-helpers";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { ask, claim, findSlackTask, finish, registerLead, waitForEyes } from "./slack-helpers";

// #2490: the socket dies between the envelope and the ack. The event must be processed
// exactly once, also when the API restarts before Slack redelivers it.
// Needs the local slack-mock patch `dropSocketBeforeAck` (slack-mock >= 0.5.0 + patch).
type DropMock = { dropSocketBeforeAck: (o: { times?: number; name?: string }) => void };

async function ackNotReady(ctx: ScenarioContext): Promise<number> {
  const r = await ctx.api("GET", "/api/slack/inbound/diagnostics");
  expectStatus(r, [200], "slack inbound diagnostics");
  const j = asRecord(r.json);
  return Number(asRecord(asRecord(j.outcomes).socket).ackNotReady ?? Number.NaN);
}

async function slackTasksFor(ctx: ScenarioContext, ts: string): Promise<number> {
  const r = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100");
  expectStatus(r, [200], "list slack tasks");
  const tasks = asRecord(r.json).tasks as unknown[];
  return tasks.map(asRecord).filter((t) => t.slackTriggerMessageTs === ts).length;
}

export const gapSlackAckDrop: Scenario = {
  name: "gap-slack-ack-drop",
  order: 1140,
  async run(ctx) {
    try {
      await gapRun(ctx);
    } finally {
      await drainTasks(ctx);
    }
  },
};

async function gapRun(ctx: ScenarioContext): Promise<void> {
  const mock = ctx.slack as unknown as DropMock;
  expect(
    typeof mock.dropSocketBeforeAck === "function",
    "slack-mock lacks dropSocketBeforeAck (patch not linked)",
  );
  let leadId = await registerLead(ctx, "e2e-lead-gap-ackdrop");

  // Control: no drop -> counter stays flat, one task.
  const baseline = await ackNotReady(ctx);
  expect(Number.isFinite(baseline), "ackNotReady counter missing from /api/slack/inbound");
  const control = await ask(ctx, "control, socket stays up");
  await waitForEyes(ctx, control.ts);
  const cTask = await findSlackTask(ctx, control.ts);
  leadId = String(cTask.agentId);
  await claim(ctx, leadId, String(cTask.id));
  await finish(ctx, leadId, String(cTask.id), { status: "completed", output: "control done" });
  expect((await ackNotReady(ctx)) === baseline, "control: ackNotReady moved without a socket drop");
  expect((await slackTasksFor(ctx, control.ts)) === 1, "control: not exactly one task");

  // Drop before the ack of the next `message` envelope.
  mock.dropSocketBeforeAck({ times: 1, name: "message" });
  const dropped = await ask(ctx, "socket dies before ack");
  const counted = await pollUntil(async () => (await ackNotReady(ctx)) > baseline, 20_000);
  expect(counted, `ackNotReady never rose above ${baseline}`);
  await waitForEyes(ctx, dropped.ts);
  const dTask = await findSlackTask(ctx, dropped.ts);
  // The stored receipt runs the event right away, not on Slack's redelivery (mock ack timeout 3s).
  const firstSend = ctx.slack.hub.history.find((d) => d.name === "message" && d.attempts > 1);
  expect(firstSend, "premise: no redelivered message envelope");
  const latencyMs = Date.parse(String(dTask.createdAt)) - Date.parse(firstSend.sentAt);
  ctx.log(`dropped-ack task created ${latencyMs}ms after the envelope was first sent`);
  expect(
    latencyMs < 2500,
    `task created ${latencyMs}ms after the envelope, i.e. only on the redelivery`,
  );
  // Let Slack's redelivery (retry_attempt >= 1) land and be dropped.
  const redelivered = ctx.slack.hub.history.filter((d) => d.name === "message" && d.attempts > 1);
  await pollUntil(
    () => ctx.slack.hub.history.some((d) => d.name === "message" && d.attempts > 1 && d.acked),
    25_000,
  );
  await Bun.sleep(3000);
  const attempts = ctx.slack.hub.history.filter((d) => d.name === "message" && d.attempts > 1);
  ctx.log(`redelivered message envelopes: ${attempts.length} (before wait: ${redelivered.length})`);
  expect(attempts.length >= 1, "premise: the mock never redelivered the unacked envelope");
  expect(
    (await slackTasksFor(ctx, dropped.ts)) === 1,
    `dropped-ack event produced ${await slackTasksFor(ctx, dropped.ts)} tasks, expected exactly 1`,
  );
  const eyes = ctx.slack
    .apiCalls("reactions.add")
    .filter((c) => c.args.name === "eyes" && c.args.timestamp === dropped.ts);
  expect(eyes.length === 1, `eyes reaction added ${eyes.length} times`);
  await claim(ctx, leadId, String(dTask.id));
  await finish(ctx, leadId, String(dTask.id), { status: "completed", output: "drop done" });

  // Drop, then restart the API before the redelivery arrives: still exactly one task.
  mock.dropSocketBeforeAck({ times: 1, name: "message" });
  const before = await ackNotReady(ctx);
  const restartMsg = await ask(ctx, "socket dies, then the API restarts");
  const stored = await pollUntil(async () => (await ackNotReady(ctx)) > before, 20_000);
  expect(stored, "restart phase: ackNotReady did not rise");
  await findSlackTask(ctx, restartMsg.ts);
  await ctx.restartSut();
  await pollUntil(
    () =>
      ctx.slack.hub.history.some(
        (d) =>
          d.envelope_id &&
          d.name === "message" &&
          d.attempts > 1 &&
          d.acked &&
          d.sentAt > restartMsg.ts,
      ),
    25_000,
  );
  await Bun.sleep(4000);
  expect(
    (await slackTasksFor(ctx, restartMsg.ts)) === 1,
    `after restart: ${await slackTasksFor(ctx, restartMsg.ts)} tasks for the event, expected 1`,
  );
}
