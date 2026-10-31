import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cancelQuietly,
  claimTask,
  createAssignedTask,
  createUser,
  expectToolError,
  expectToolOk,
  readTask,
  registerLead,
  registerWorker,
  retireAgent,
  UUID,
  withMcp,
} from "./core-helpers";

const GHOST = "00000000-0000-4000-8000-00000000dead";

type SteerRow = {
  status: string;
  delivered_mode: string | null;
  handled_note: string | null;
  promoted_task_id: string | null;
  created_by_kind: string;
  created_by_user_id: string | null;
  source: string;
  mode: string;
};

function steerRow(ctx: ScenarioContext, id: string): SteerRow {
  const row = ctx.db.get<SteerRow>(
    `SELECT status, delivered_mode, handled_note, promoted_task_id, created_by_kind,
            created_by_user_id, source, mode
     FROM task_steering_messages WHERE id = ?`,
    [id],
  );
  expect(row !== null, `No task_steering_messages row for ${id}`);
  return row;
}

async function steer(
  ctx: ScenarioContext,
  taskId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", `/api/tasks/${taskId}/steer`, { body });
  expectStatus(response, [200], `steer ${taskId}`);
  return asRecord(response.json);
}

/** Start a task on `agentId` and return its id. */
async function runningTask(ctx: ScenarioContext, agentId: string, text: string): Promise<string> {
  const taskId = await createAssignedTask(ctx, agentId, text);
  await claimTask(ctx, agentId, taskId);
  return taskId;
}

/** The three outcomes of POST /api/tasks/{id}/steer, decided by the worker's harness. */
async function outcomes(ctx: ScenarioContext) {
  const codex = await registerWorker(ctx, "steer-codex", {
    harness_provider: "codex",
    maxTasks: 3,
  });
  const claude = await registerWorker(ctx, "steer-claude", { harness_provider: "claude" });
  const acp = await registerWorker(ctx, "steer-acp", { harness_provider: "acp" });
  const user = await createUser(ctx, "steerer");

  // codex honours steer: the message reaches the live session.
  const codexTask = await runningTask(ctx, codex, `steer codex ${ctx.nonce}`);
  expect(
    JSON.stringify(asRecord(await readTask(ctx, codexTask)).supportedSteerModes) ===
      JSON.stringify(["steer", "queue"]),
    "A codex task does not advertise both steer modes",
  );
  let result = await steer(ctx, codexTask, {
    message: `codex steer ${ctx.nonce}`,
    mode: "steer",
    source: "ui",
    requestedByUserId: user,
  });
  expect(
    result.outcome === "steered" && result.effectiveMode === "steer" && !("degradedFrom" in result),
    `codex steer outcome ${JSON.stringify(result)}`,
  );
  let row = steerRow(ctx, String(result.steeringMessageId));
  expect(
    row.status === "pending" &&
      row.mode === "steer" &&
      row.source === "ui" &&
      row.created_by_kind === "user" &&
      row.created_by_user_id === user,
    `Steering row lost the sender: ${JSON.stringify(row)}`,
  );
  // A task that has not started yet degrades "steer" to "queue" on any harness.
  const codexPending = await createAssignedTask(ctx, codex, `steer codex pending ${ctx.nonce}`);
  result = await steer(ctx, codexPending, { message: `pre-start ${ctx.nonce}`, mode: "steer" });
  expect(
    result.outcome === "queued" &&
      result.effectiveMode === "queue" &&
      result.degradedFrom === "steer",
    `Pre-start steer did not degrade: ${JSON.stringify(result)}`,
  );
  await cancelQuietly(ctx, codexPending);

  // claude supports queue only.
  const claudeTask = await runningTask(ctx, claude, `steer claude ${ctx.nonce}`);
  result = await steer(ctx, claudeTask, { message: `claude steer ${ctx.nonce}`, mode: "steer" });
  expect(
    result.outcome === "queued" &&
      result.effectiveMode === "queue" &&
      result.degradedFrom === "steer",
    `claude steer outcome ${JSON.stringify(result)}`,
  );
  result = await steer(ctx, claudeTask, { message: `claude queue ${ctx.nonce}` });
  expect(
    result.outcome === "queued" && result.effectiveMode === "queue" && !("degradedFrom" in result),
    `claude default-mode outcome ${JSON.stringify(result)}`,
  );
  expect(
    steerRow(ctx, String(result.steeringMessageId)).mode === "queue",
    "Default mode is not queue",
  );
  let refused = await ctx.api("POST", `/api/tasks/${claudeTask}/steer`, {
    body: { message: `strict ${ctx.nonce}`, mode: "steer", onUnsupported: "fail" },
  });
  expectStatus(refused, [422], "steer with onUnsupported=fail");
  expect(
    String(asRecord(refused.json).error).includes("does not support steering mode 'steer'"),
    "422 lacks the unsupported-mode reason",
  );

  // A harness with no steering primitive promotes the message to a follow-up task.
  const acpTask = await runningTask(ctx, acp, `steer acp ${ctx.nonce}`);
  result = await steer(ctx, acpTask, { message: `acp promote ${ctx.nonce}` });
  expect(
    result.outcome === "promoted" && UUID.test(String(result.promotedTaskId)),
    `acp steer should promote: ${JSON.stringify(result)}`,
  );
  const promoted = await readTask(ctx, String(result.promotedTaskId));
  expect(
    promoted.parentTaskId === acpTask &&
      promoted.taskType === "follow-up" &&
      promoted.task === `acp promote ${ctx.nonce}` &&
      promoted.agentId === acp,
    `Promoted follow-up is wrong: ${JSON.stringify(promoted)}`,
  );
  row = steerRow(ctx, String(result.steeringMessageId));
  expect(
    row.status === "promoted" && row.promoted_task_id === result.promotedTaskId,
    "Promoted steering row does not point at the follow-up",
  );
  await cancelQuietly(ctx, String(result.promotedTaskId));
  await cancelQuietly(ctx, acpTask);

  // Validation.
  refused = await ctx.api("POST", `/api/tasks/${claudeTask}/steer`, { body: { message: "  " } });
  expectStatus(refused, [400], "blank steering message");
  expectStatus(
    await ctx.api("POST", `/api/tasks/${claudeTask}/steer`, {
      body: { message: "x", mode: "interrupt" },
    }),
    [400],
    "unknown mode",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${GHOST}/steer`, { body: { message: "x" } }),
    [404],
    "steer an unknown task",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${claudeTask}/steer`, {
      apiKey: null,
      body: { message: "x" },
    }),
    [401],
    "steer without credentials",
  );

  // GET /api/tasks/{id}/steering-messages keeps the history, oldest first.
  const history = await ctx.api("GET", `/api/tasks/${claudeTask}/steering-messages`);
  expectStatus(history, [200], "steering history");
  const messages = asRecords(history.json, "messages");
  expect(
    messages.length === 2 && messages[0]?.body === `claude steer ${ctx.nonce}`,
    `Unexpected steering history ${JSON.stringify(messages.map((m) => m.body))}`,
  );
  expectStatus(
    await ctx.api("GET", `/api/tasks/${GHOST}/steering-messages`),
    [404],
    "history of an unknown task",
  );
  for (const id of [codexTask, claudeTask]) await cancelQuietly(ctx, id);
}

/** The callbacks a worker makes while it drains its steering messages. */
async function workerCallbacks(ctx: ScenarioContext) {
  const agentId = await registerWorker(ctx, "steer-drain");
  const otherId = await registerWorker(ctx, "steer-drain-other");
  const taskId = await runningTask(ctx, agentId, `drain task ${ctx.nonce}`);
  const first = String(
    (await steer(ctx, taskId, { message: `first ${ctx.nonce}` })).steeringMessageId,
  );
  const second = String(
    (await steer(ctx, taskId, { message: `second ${ctx.nonce}` })).steeringMessageId,
  );
  const third = String(
    (await steer(ctx, taskId, { message: `third ${ctx.nonce}` })).steeringMessageId,
  );

  // GET /api/steering-messages: the worker's pending queue.
  let response = await ctx.api("GET", "/api/steering-messages", { agentId });
  expectStatus(response, [200], "pending steering");
  let pending = asRecords(response.json, "messages").map((m) => m.id);
  expect(
    [first, second, third].every((id) => pending.includes(id)),
    "The worker's pending list omits queued messages",
  );
  response = await ctx.api("GET", `/api/steering-messages?taskId=${taskId}`, { agentId });
  expect(asRecords(response.json, "messages").length === 3, "taskId filter dropped messages");
  response = await ctx.api("GET", `/api/steering-messages?taskId=${taskId}`, { agentId: otherId });
  expect(
    asRecords(response.json, "messages").length === 0,
    "Another worker reads this task's queue",
  );
  expectStatus(await ctx.api("GET", "/api/steering-messages"), [400], "pending without X-Agent-ID");
  expectStatus(
    await ctx.api("GET", "/api/steering-messages", { agentId: GHOST }),
    [404],
    "pending for an unknown agent",
  );

  // delivered
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${first}/delivered`, { body: { mode: "queue" } }),
    [400],
    "delivered without X-Agent-ID",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${first}/delivered`, {
      agentId: otherId,
      body: { mode: "queue" },
    }),
    [403],
    "delivered by another agent",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${GHOST}/delivered`, {
      agentId,
      body: { mode: "queue" },
    }),
    [404],
    "delivered for an unknown message",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${first}/delivered`, {
      agentId,
      body: { mode: "queue", taskId: GHOST },
    }),
    [409],
    "delivered naming another task",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${first}/delivered`, {
      agentId,
      body: { mode: "interrupt" },
    }),
    [400],
    "delivered with an unknown mode",
  );
  response = await ctx.api("POST", `/api/steering-messages/${first}/delivered`, {
    agentId,
    body: { mode: "queue", taskId },
  });
  expectStatus(response, [200], "mark delivered");
  let message = asRecord(asRecord(response.json).message);
  expect(
    message.status === "delivered" && message.deliveredMode === "queue",
    `delivered message: ${JSON.stringify(message)}`,
  );
  expect(steerRow(ctx, first).status === "delivered", "delivered not persisted");
  response = await ctx.api("POST", `/api/steering-messages/${first}/delivered`, {
    agentId,
    body: { mode: "steer" },
  });
  expect(
    asRecord(asRecord(response.json).message).deliveredMode === "queue",
    "A second delivered call rewrote the delivered mode",
  );

  // handled: only a delivered message advances, with an optional note.
  response = await ctx.api("POST", `/api/steering-messages/${second}/handled`, { agentId });
  expectStatus(response, [200], "handled on a pending message");
  expect(
    asRecord(asRecord(response.json).message).status === "pending",
    "pending jumped to handled",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${first}/handled`, { agentId: otherId }),
    [403],
    "handled by another agent",
  );
  expectStatus(await ctx.api("POST", `/api/steering-messages/${first}/handled`), [400], "no agent");
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${GHOST}/handled`, { agentId }),
    [404],
    "handled for an unknown message",
  );
  response = await ctx.api("POST", `/api/steering-messages/${first}/handled`, {
    agentId,
    body: { note: `folded in ${ctx.nonce}` },
  });
  expectStatus(response, [200], "mark handled with a note");
  message = asRecord(asRecord(response.json).message);
  expect(
    message.status === "handled" && message.handledNote === `folded in ${ctx.nonce}`,
    `handled message: ${JSON.stringify(message)}`,
  );
  expect(steerRow(ctx, first).handled_note === `folded in ${ctx.nonce}`, "Note not persisted");

  // undeliverable: the worker cannot apply the message, so it becomes a follow-up task.
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${second}/undeliverable`, {
      agentId,
      body: { reason: "" },
    }),
    [400],
    "undeliverable without a reason",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${second}/undeliverable`, {
      agentId: otherId,
      body: { reason: "x" },
    }),
    [403],
    "undeliverable by another agent",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${second}/undeliverable`, {
      agentId,
      body: { reason: "x", taskId: GHOST },
    }),
    [409],
    "undeliverable naming another task",
  );
  response = await ctx.api("POST", `/api/steering-messages/${second}/undeliverable`, {
    agentId,
    body: { reason: `session ended ${ctx.nonce}`, taskId },
  });
  expectStatus(response, [200], "mark undeliverable");
  message = asRecord(asRecord(response.json).message);
  const promotedId = String(asRecord(response.json).promotedTaskId);
  expect(
    message.status === "promoted" && message.promotedTaskId === promotedId && UUID.test(promotedId),
    `undeliverable did not promote: ${response.text}`,
  );
  expect(
    (await readTask(ctx, promotedId)).parentTaskId === taskId,
    "Promoted task lost its parent",
  );
  response = await ctx.api("POST", `/api/steering-messages/${second}/undeliverable`, {
    agentId,
    body: { reason: "again" },
  });
  expect(
    asRecord(response.json).promotedTaskId === promotedId,
    "A repeated undeliverable created a second follow-up",
  );
  expectStatus(
    await ctx.api("POST", `/api/steering-messages/${GHOST}/undeliverable`, {
      agentId,
      body: { reason: "x" },
    }),
    [404],
    "undeliverable for an unknown message",
  );

  // The queue now holds only the third message.
  response = await ctx.api("GET", "/api/steering-messages", { agentId });
  pending = asRecords(response.json, "messages").map((m) => m.id);
  expect(pending.length === 1 && pending[0] === third, `Pending after drain: ${pending.join(",")}`);

  // Pause, then steer: a steer on a paused task resumes it.
  expectStatus(await ctx.api("POST", `/api/tasks/${taskId}/pause`, { agentId }), [200], "pause");
  await steer(ctx, taskId, { message: `wake up ${ctx.nonce}` });
  expect(
    (await readTask(ctx, taskId)).status === "in_progress",
    "Steering did not resume the task",
  );

  await cancelQuietly(ctx, promotedId);
  await cancelQuietly(ctx, taskId);
}

/** steer-task and accept-steer between a task creator, its worker and a lead. */
async function mcpSteering(ctx: ScenarioContext) {
  const creatorId = await registerWorker(ctx, "steer-creator");
  const workerId = await registerWorker(ctx, "steer-worker");
  const leadId = await registerLead(ctx, "steer");
  try {
    await withMcp(ctx, creatorId, async (creator) => {
      await withMcp(ctx, workerId, async (worker) => {
        await withMcp(ctx, leadId, async (lead) => {
          const sent = await expectToolOk(creator, "send-task", {
            agentId: workerId,
            routingReason: "skill",
            routingNote: "this worker owns the described area",
            task: `Rebuild the search index for shard ${ctx.nonce}`,
          });
          const taskId = String(asRecord(sent.data.task).id);
          await claimTask(ctx, workerId, taskId);

          const queued = await expectToolOk(creator, "steer-task", {
            taskId,
            message: `Use the new schema ${ctx.nonce}`,
          });
          expect(
            queued.data.outcome === "queued" &&
              queued.data.effectiveMode === "queue" &&
              queued.message === "Queued for delivery.",
            `steer-task result ${JSON.stringify(queued.data)}`,
          );
          const messageId = String(queued.data.steeringMessageId);
          const row = steerRow(ctx, messageId);
          expect(
            row.source === "mcp" && row.created_by_kind === "agent",
            `MCP steering row: ${JSON.stringify(row)}`,
          );

          const degraded = await expectToolOk(creator, "steer-task", {
            taskId,
            message: `Interrupt please ${ctx.nonce}`,
            mode: "steer",
          });
          expect(
            degraded.data.degradedFrom === "steer" &&
              degraded.message.includes("claude supports queue only"),
            `steer-task degrade: ${degraded.message}`,
          );
          await expectToolError(
            creator,
            "steer-task",
            { taskId, message: "strict", mode: "steer", onUnsupported: "fail" },
            "does not support steering mode",
          );
          await expectToolError(
            worker,
            "steer-task",
            { taskId, message: "I steer myself" },
            "Only the lead or task creator",
          );
          await expectToolError(
            creator,
            "steer-task",
            { taskId: GHOST, message: "x" },
            "not found",
          );
          const byLead = await expectToolOk(lead, "steer-task", {
            taskId,
            message: `Lead says hurry ${ctx.nonce}`,
          });
          expect(byLead.data.outcome === "queued", "The lead could not steer another's task");

          // accept-steer only works once the message was delivered.
          await expectToolError(
            worker,
            "accept-steer",
            { steeringMessageId: messageId },
            'cannot be acknowledged from status "pending"',
          );
          expectStatus(
            await ctx.api("POST", `/api/steering-messages/${messageId}/delivered`, {
              agentId: workerId,
              body: { mode: "queue" },
            }),
            [200],
            "deliver the message",
          );
          const accepted = await expectToolOk(worker, "accept-steer", {
            steeringMessageId: messageId,
            note: `schema applied ${ctx.nonce}`,
          });
          expect(
            asRecord(accepted.data.steeringMessage).status === "handled" &&
              accepted.message.includes(ctx.nonce),
            `accept-steer result ${JSON.stringify(accepted.data)}`,
          );
          expect(
            steerRow(ctx, messageId).handled_note === `schema applied ${ctx.nonce}`,
            "accept-steer note not persisted",
          );
          const again = await expectToolOk(worker, "accept-steer", {
            steeringMessageId: messageId,
          });
          expect(again.message.includes("already acknowledged"), `Second accept: ${again.message}`);
          await expectToolError(
            creator,
            "accept-steer",
            { steeringMessageId: messageId },
            "assigned to another agent",
          );
          await expectToolError(worker, "accept-steer", { steeringMessageId: GHOST }, "not found");
        });
      });
    });
    const finished = await ctx.api("GET", `/api/tasks?agentId=${workerId}&status=in_progress`);
    for (const task of asRecords(finished.json, "tasks")) await cancelQuietly(ctx, String(task.id));
    // Pending steering messages of a cancelled task are promoted; clean those up too.
    const leftovers = await ctx.api("GET", `/api/tasks?agentId=${workerId}`);
    for (const task of asRecords(leftovers.json, "tasks"))
      await cancelQuietly(ctx, String(task.id));
  } finally {
    await retireAgent(ctx, leadId);
  }
}

/** A worker that finishes first turns its undelivered steering into a follow-up it then runs. */
async function finishPromotes(ctx: ScenarioContext) {
  const agentId = await registerWorker(ctx, "steer-flow", { maxTasks: 2 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taskId = await createAssignedTask(ctx, agentId, `long running job ${ctx.nonce}`);
  const sim = await ctx.startAgent({
    agentId,
    async onTask(trigger) {
      if (trigger.taskId === taskId) await gate;
      return { status: "completed", output: `finished ${trigger.taskId}` };
    },
  });
  try {
    const running = await pollUntil(
      async () => (await readTask(ctx, taskId)).status === "in_progress",
      15_000,
      100,
    );
    expect(running, "The simulated worker never started the job");
    const result = await steer(ctx, taskId, { message: `also update the docs ${ctx.nonce}` });
    expect(result.outcome === "queued", `Expected a queued steer, got ${JSON.stringify(result)}`);
    const messageId = String(result.steeringMessageId);

    release();
    await sim.waitForTask(taskId);
    const promoted = await pollUntil(
      () => steerRow(ctx, messageId).status === "promoted",
      15_000,
      100,
    );
    expect(promoted, "Undelivered steering was not promoted when the task finished");
    const followUpId = String(steerRow(ctx, messageId).promoted_task_id);
    const followUp = await readTask(ctx, followUpId);
    expect(
      followUp.parentTaskId === taskId &&
        followUp.agentId === agentId &&
        followUp.task === `also update the docs ${ctx.nonce}`,
      `Follow-up is wrong: ${JSON.stringify(followUp)}`,
    );
    const outcome = await sim.waitForTask(followUpId);
    expect(outcome.status === "completed", "The worker did not run the promoted follow-up");
    expect((await readTask(ctx, followUpId)).status === "completed", "Follow-up did not complete");
  } finally {
    release();
    await sim.stop();
  }
}

export const coreSteering: Scenario = {
  name: "core-steering",
  order: 230,
  async run(ctx) {
    await outcomes(ctx);
    await workerCallbacks(ctx);
    await mcpSteering(ctx);
    await finishPromotes(ctx);
  },
};
