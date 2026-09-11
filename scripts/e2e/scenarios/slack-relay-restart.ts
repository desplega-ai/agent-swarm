import { expect, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForBotReply,
  waitForEyes,
  waitForOutcome,
} from "./slack-helpers";

type RelayRow = { delivered_at: string | null };
type FinishedSlackTask = { taskId: string; messageTs: string; threadTs: string };

function relayRow(ctx: ScenarioContext, taskId: string): RelayRow | null {
  return ctx.db.get<RelayRow>(
    "SELECT delivered_at FROM slack_relay_obligations WHERE task_id = ?",
    [taskId],
  );
}

function acceptedTerminalUpdates(ctx: ScenarioContext, messageTs: string, output: string): number {
  return ctx.slack
    .apiCalls("chat.update")
    .filter(
      (call) => call.ok && call.args.ts === messageTs && JSON.stringify(call.args).includes(output),
    ).length;
}

async function finishSlackTask(
  ctx: ScenarioContext,
  leadId: string,
  prompt: string,
  output: string,
  beforeFinish?: (task: FinishedSlackTask) => Promise<void> | void,
): Promise<FinishedSlackTask> {
  const message = await ask(ctx, prompt);
  await waitForEyes(ctx, message.ts);
  const reply = await waitForBotReply(ctx, message.ts);
  const task = await findSlackTask(ctx, message.ts);
  const taskId = String(task.id);
  const assignedLeadId = typeof task.agentId === "string" ? task.agentId : leadId;
  await claim(ctx, assignedLeadId, taskId);
  const result = { taskId, messageTs: reply.ts, threadTs: message.ts };
  await beforeFinish?.(result);
  await finish(ctx, assignedLeadId, taskId, { status: "completed", output });
  return result;
}

export const slackRelayRestart: Scenario = {
  name: "slack-relay-restart",
  order: 120,
  async run(ctx) {
    const leadId = await registerLead(ctx, "e2e-lead-relay-restart");
    const output = `durable relay ${ctx.nonce}`;
    let restartPromise: Promise<void> | undefined;

    // Reject the first terminal tree update. Waiting for that recorded rejection
    // gives the harness a state-controlled crash boundary. The mock's change
    // callback runs synchronously, so it verifies the pending row and sends
    // SIGTERM before the old watcher's next pass can accept a retry.
    let target: FinishedSlackTask | undefined;
    const stopListening = ctx.slack.onChange((change) => {
      if (
        change.kind !== "api.call" ||
        change.call.ok ||
        change.call.method !== "chat.update" ||
        !JSON.stringify(change.call.args).includes(output)
      ) {
        return;
      }
      if (!target) return;
      const taskId = target.taskId;
      expect(
        relayRow(ctx, taskId)?.delivered_at === null,
        `Relay ${taskId} was not pending before the crash`,
      );
      expect(
        acceptedTerminalUpdates(ctx, target.messageTs, output) === 0,
        `Slack accepted the outcome for ${taskId} before the crash`,
      );
      restartPromise ??= ctx.restartSut();
    });
    try {
      target = await finishSlackTask(
        ctx,
        leadId,
        "verify a relay survives an API restart",
        output,
        async (pendingTarget) => {
          target = pendingTarget;
          await ctx.slack.waitForApiCall("chat.update", {
            timeoutMs: 30_000,
            where: (call) => call.ok && call.args.ts === pendingTarget.messageTs,
          });
          ctx.slack.injectFault({ method: "chat.update", error: "internal_error" });
        },
      );
      ctx.markThread("relay-restart", "C0GENERAL0", target.threadTs);
      const restartStarted = await pollUntil(() => restartPromise !== undefined, 30_000);
      expect(restartStarted && restartPromise, "Rejected terminal relay did not trigger restart");
      await restartPromise;
    } finally {
      stopListening();
    }

    const completedTarget = target;
    expect(completedTarget, "Target Slack task was not created");
    await waitForOutcome(ctx, completedTarget.threadTs, output);
    const delivered = await pollUntil(
      () => relayRow(ctx, completedTarget.taskId)?.delivered_at !== null,
      30_000,
    );
    expect(delivered, `Relay ${completedTarget.taskId} was not acknowledged after the restart`);
    expect(
      acceptedTerminalUpdates(ctx, completedTarget.messageTs, output) === 1,
      `Expected exactly one accepted outcome for ${completedTarget.taskId} after restart`,
    );

    // A second terminal relay is a state marker for a later watcher pass. Once
    // it is delivered, recount the first task to prove that pass did not replay it.
    const markerOutput = `later watcher pass ${ctx.nonce}`;
    const marker = await finishSlackTask(
      ctx,
      leadId,
      "run another relay watcher pass",
      markerOutput,
    );
    await waitForOutcome(ctx, marker.threadTs, markerOutput);
    const markerDelivered = await pollUntil(
      () => relayRow(ctx, marker.taskId)?.delivered_at !== null,
      30_000,
    );
    expect(markerDelivered, `Later watcher pass did not deliver marker relay ${marker.taskId}`);
    expect(
      acceptedTerminalUpdates(ctx, completedTarget.messageTs, output) === 1,
      `A later watcher pass re-delivered outcome for ${completedTarget.taskId}`,
    );
  },
};
