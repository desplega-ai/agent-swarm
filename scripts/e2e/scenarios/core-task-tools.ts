import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
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

function sendArgs(
  target: string,
  task: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agentId: target,
    routingReason: "skill",
    routingNote: "this worker fits the described job",
    task,
    ...extra,
  };
}

/** send-task, poll-task, get-task-details, cancel-task between a creator and an assignee. */
async function delegation(
  ctx: ScenarioContext,
  creator: McpConnection,
  creatorId: string,
  assignee: McpConnection,
  assigneeId: string,
  bystander: McpConnection,
  lead: McpConnection,
) {
  // send-task: assign, attributes, persisted row.
  const sent = await expectToolOk(
    creator,
    "send-task",
    sendArgs(assigneeId, `Audit the billing exports for nonce ${ctx.nonce}`, {
      priority: 70,
      tags: ["core-e2e"],
      taskType: "feature",
    }),
  );
  const task = asRecord(sent.data.task);
  const firstId = String(task.id);
  expect(UUID.test(firstId), "send-task returned a task without a UUID");
  expect(
    task.agentId === assigneeId &&
      task.creatorAgentId === creatorId &&
      task.status === "pending" &&
      task.source === "mcp" &&
      task.priority === 70 &&
      task.routingReason === "skill" &&
      task.routingSource === "declared",
    `send-task created an unexpected task: ${JSON.stringify(task)}`,
  );
  expect(sent.message.includes(firstId), "send-task message does not name the task");
  const stored = ctx.db.get<{ creatorAgentId: string; taskType: string; tags: string }>(
    "SELECT creatorAgentId, taskType, tags FROM agent_tasks WHERE id = ?",
    [firstId],
  );
  expect(
    stored?.creatorAgentId === creatorId &&
      stored.taskType === "feature" &&
      stored.tags.includes("core-e2e"),
    `agent_tasks row is wrong: ${JSON.stringify(stored)}`,
  );

  // send-task refusals.
  await expectToolError(
    creator,
    "send-task",
    sendArgs(assigneeId, `Audit the billing exports for nonce ${ctx.nonce}`),
    "Duplicate task detected",
  );
  const forced = await expectToolOk(
    creator,
    "send-task",
    sendArgs(assigneeId, `Audit the billing exports for nonce ${ctx.nonce}`, {
      allowDuplicate: true,
    }),
  );
  const forcedId = String(asRecord(forced.data.task).id);
  expect(forcedId !== firstId, "allowDuplicate returned the original task");
  await expectToolError(
    creator,
    "send-task",
    sendArgs(creatorId, `Rotate the signing keys ${ctx.nonce}`),
    "Cannot send a task to yourself",
  );
  await expectToolError(
    creator,
    "send-task",
    sendArgs("no-such-agent", `Migrate the audit trail ${ctx.nonce}`),
    "not found",
  );
  await expectToolError(
    creator,
    "send-task",
    { agentId: assigneeId, routingReason: "skill", task: `Missing a routing note ${ctx.nonce}` },
    "routingNote",
  );
  await expectToolError(
    creator,
    "send-task",
    sendArgs(assigneeId, `Merge the release branch ${ctx.nonce}`, { leadOnly: true }),
    "Lead-only task requires a Lead",
  );
  await expectToolError(
    creator,
    "send-task",
    sendArgs(assigneeId, `Profile the cold start ${ctx.nonce}`, { model: "zz-not-a-model" }),
    "model catalog",
  );
  await expectToolError(
    creator,
    "send-task",
    sendArgs(assigneeId, `Summarise the incident ${ctx.nonce}`, {
      outputSchema: { type: "object", properties: { answer: null } },
    }),
    "outputSchema",
  );

  // Offer mode, and a child that follows its parent's worker.
  const offered = await expectToolOk(
    creator,
    "send-task",
    sendArgs(assigneeId, `Review the vendor contract ${ctx.nonce}`, { offerMode: true }),
  );
  const offeredTask = asRecord(offered.data.task);
  const offeredId = String(offeredTask.id);
  expect(
    offeredTask.status === "offered" &&
      offeredTask.offeredTo === assigneeId &&
      !offeredTask.agentId,
    `Offered task is wrong: ${JSON.stringify(offeredTask)}`,
  );
  expect(offered.message.includes("offered"), `Offer message: ${offered.message}`);
  const child = await expectToolOk(creator, "send-task", {
    task: `Follow up on the earlier audit with details ${ctx.nonce}`,
    parentTaskId: firstId,
  });
  expect(
    asRecord(child.data.task).agentId === assigneeId &&
      asRecord(child.data.task).routingReason === "continuity" &&
      asRecord(child.data.task).parentTaskId === firstId,
    `A child with a parent must continue on the parent's worker: ${JSON.stringify(child.data.task)}`,
  );
  const childId = String(asRecord(child.data.task).id);

  // poll-task: offers come first and return at once, then pending work starts.
  let poll = await expectToolOk(assignee, "poll-task");
  const offers = asRecords(poll.data, "offeredTasks");
  expect(
    offers.length === 1 && offers[0]?.id === offeredId,
    `poll-task should surface the single offer, got ${JSON.stringify(offers.map((row) => row.id))}`,
  );
  expect(poll.message.includes("offered to you"), `poll-task offer message: ${poll.message}`);
  // The offer stays "offered" until the worker accepts it.
  expect(
    (await readTask(ctx, offeredId)).status === "offered",
    "Polling must not consume an offer",
  );
  await expectToolOk(assignee, "task-action", { action: "accept", taskId: offeredId });
  const accepted = await readTask(ctx, offeredId);
  expect(
    accepted.status === "pending" && accepted.agentId === assigneeId,
    `Accepted offer should be assigned and pending, got ${String(accepted.status)}`,
  );
  poll = await expectToolOk(assignee, "poll-task");
  const started = asRecord(poll.data.task);
  expect(
    started.status === "in_progress" && started.agentId === assigneeId,
    `poll-task did not start pending work: ${JSON.stringify(poll.data)}`,
  );
  expect(typeof poll.data.availableCount === "number", "poll-task lacks availableCount");
  expect(poll.message.includes("assigned and started"), `poll-task message: ${poll.message}`);

  // get-task-details: any agent reads any task, logs included.
  const user = await createUser(ctx, "task-details");
  const requested = await ctx.api("POST", "/api/tasks", {
    body: {
      task: `Draft the quarterly letter ${ctx.nonce}`,
      agentId: assigneeId,
      routingReason: "human_pinned",
      source: "api",
      requestedByUserId: user,
    },
  });
  expectStatus(requested, [201], "create a task for a user");
  const requestedId = String(asRecord(requested.json).id);
  let details = await expectToolOk(bystander, "get-task-details", { taskId: requestedId });
  expect(
    details.message.includes(`(pending) details retrieved`),
    `details message ${details.message}`,
  );
  expect(asRecord(details.data.task).id === requestedId, "get-task-details returned another task");
  expect(
    asRecord(details.data.requestedBy).name === `Core task-details ${ctx.nonce}`,
    "get-task-details lost the requesting user",
  );
  expect(
    asRecords(details.data, "logs").some((log) => log.eventType === "task_created"),
    "get-task-details logs lack task_created",
  );
  details = await expectToolOk(bystander, "get-task-details", { taskId: firstId });
  expect(asRecord(details.data.task).creatorAgentId === creatorId, "details lost the creator");
  await expectToolError(bystander, "get-task-details", { taskId: GHOST }, "not found");
  expect((await callTool(bystander, "get-task-details", { taskId: "nope" })).isError, "bad uuid");

  // cancel-task: the creator or a lead may cancel; nobody cancels a terminal task.
  await expectToolError(
    bystander,
    "cancel-task",
    { taskId: childId },
    "Only the lead or task creator can cancel tasks",
  );
  const cancelled = await expectToolOk(creator, "cancel-task", {
    taskId: childId,
    reason: `no longer needed ${ctx.nonce}`,
  });
  expect(asRecord(cancelled.data.task).status === "cancelled", "cancel-task returned a live task");
  const afterCancel = await readTask(ctx, childId);
  expect(
    afterCancel.status === "cancelled" && String(afterCancel.failureReason).includes(ctx.nonce),
    `Cancelled task is wrong: ${JSON.stringify(afterCancel)}`,
  );
  await expectToolError(
    creator,
    "cancel-task",
    { taskId: childId },
    "Cannot cancel task in status",
  );
  await expectToolError(creator, "cancel-task", { taskId: GHOST }, "not found");
  const byLead = await expectToolOk(lead, "cancel-task", {
    taskId: forcedId,
    reason: "lead cleanup",
  });
  expect(asRecord(byLead.data.task).status === "cancelled", "Lead could not cancel another's task");

  for (const id of [firstId, requestedId, offeredId, started.id as string]) {
    await cancelQuietly(ctx, id);
  }
}

/** defer-task completes the task now and books a wake-up the scheduler delivers. */
async function deferral(ctx: ScenarioContext, bystander: McpConnection) {
  const workerId = await registerWorker(ctx, "defer", { maxTasks: 2 });
  const taskId = await createAssignedTask(ctx, workerId, `Wait for the nightly build ${ctx.nonce}`);
  await claimTask(ctx, workerId, taskId);
  const base = {
    taskId,
    summary: `Triggered the build ${ctx.nonce}`,
    note: `Check the build result ${ctx.nonce}`,
  };

  await withMcp(ctx, workerId, async (worker) => {
    await expectToolError(worker, "defer-task", base, "Provide either delayMs or runAt");
    await expectToolError(
      worker,
      "defer-task",
      { ...base, delayMs: 1000, runAt: new Date(Date.now() + 60_000).toISOString() },
      "not both",
    );
    await expectToolError(
      worker,
      "defer-task",
      { ...base, runAt: new Date(Date.now() - 60_000).toISOString() },
      "must be in the future",
    );
    await expectToolError(
      bystander,
      "defer-task",
      { ...base, delayMs: 1000 },
      "not assigned to you",
    );
    await expectToolError(
      worker,
      "defer-task",
      { ...base, taskId: GHOST, delayMs: 1000 },
      "not found",
    );

    const deferred = await expectToolOk(worker, "defer-task", {
      ...base,
      delayMs: 1500,
      checks: ["build is green", "artifact uploaded"],
    });
    const scheduleId = String(deferred.data.scheduleId);
    expect(
      deferred.data.taskId === taskId && typeof deferred.data.nextRunAt === "string",
      "defer-task result lacks taskId or nextRunAt",
    );
    const done = await readTask(ctx, taskId);
    expect(done.status === "completed", `Deferred task is ${String(done.status)}`);
    expect(
      String(done.output).startsWith("Checking back"),
      `Deferred output: ${String(done.output)}`,
    );
    expect(
      Array.isArray(done.tags) && done.tags.includes("deferred"),
      "The deferred task is not tagged deferred",
    );
    const schedule = ctx.db.get<{
      targetAgentId: string;
      parentTaskId: string;
      taskType: string;
      scheduleType: string;
      taskTemplate: string;
      enabled: number;
    }>(
      "SELECT targetAgentId, parentTaskId, taskType, scheduleType, taskTemplate, enabled FROM scheduled_tasks WHERE id = ?",
      [scheduleId],
    );
    expect(
      schedule?.targetAgentId === workerId &&
        schedule.parentTaskId === taskId &&
        schedule.taskType === "deferred" &&
        schedule.scheduleType === "one_time" &&
        schedule.enabled === 1 &&
        schedule.taskTemplate.includes("build is green"),
      `Schedule row is wrong: ${JSON.stringify(schedule)}`,
    );

    // GET /api/scheduled-tasks lists the wake-up in both shapes and honours filters.
    let listing = await ctx.api("GET", "/api/scheduled-tasks?scheduleType=one_time&enabled=true");
    expectStatus(listing, [200], "list one-time schedules");
    let row = asRecords(listing.json, "scheduledTasks").find((entry) => entry.id === scheduleId);
    expect(
      row?.targetAgentId === workerId && String(row.taskTemplate).includes(ctx.nonce),
      "Full schedule list lacks the deferred wake-up",
    );
    listing = await ctx.api(
      "GET",
      "/api/scheduled-tasks?fields=slim&scheduleType=one_time&limit=500",
    );
    expectStatus(listing, [200], "slim schedule list");
    row = asRecords(listing.json, "scheduledTasks").find((entry) => entry.id === scheduleId);
    expect(
      row !== undefined && "taskTemplatePreview" in row && !("taskTemplate" in row),
      "Slim schedule list should carry taskTemplatePreview instead of taskTemplate",
    );
    listing = await ctx.api("GET", "/api/scheduled-tasks?scheduleType=recurring&name=nope");
    expect(
      asRecords(listing.json, "scheduledTasks").length === 0,
      "Recurring filter matched a deferral",
    );
    expectStatus(
      await ctx.api("GET", "/api/scheduled-tasks?limit=0"),
      [400],
      "schedule list with limit=0",
    );

    await expectToolError(worker, "defer-task", { ...base, delayMs: 1000 }, "already completed");

    // The scheduler wakes the worker with a child task.
    const sim = await ctx.startAgent({ agentId: workerId });
    const woke = await pollUntil(
      () =>
        ctx.db.get<{ id: string }>(
          "SELECT id FROM agent_tasks WHERE parentTaskId = ? AND agentId = ?",
          [taskId, workerId],
        ) !== null,
      40_000,
      500,
    );
    expect(woke, "The scheduler never created the wake-up task");
    const wake = ctx.db.get<{ id: string; task: string; taskType: string }>(
      "SELECT id, task, taskType FROM agent_tasks WHERE parentTaskId = ? AND agentId = ?",
      [taskId, workerId],
    );
    expect(
      wake?.taskType === "deferred" && wake.task.includes(`Check the build result ${ctx.nonce}`),
      `Wake-up task is wrong: ${JSON.stringify(wake)}`,
    );
    await sim.waitForTask(String(wake?.id));
    expect(
      (await readTask(ctx, String(wake?.id))).status === "completed",
      "Wake-up was not settled",
    );
    await sim.stop();
  });
}

/** The read-only SQL tool and route share one guard. */
async function sqlTools(ctx: ScenarioContext, conn: McpConnection, taskId: string) {
  let outcome = await expectToolOk(conn, "db-query", {
    sql: "SELECT id, status FROM agent_tasks WHERE id = ?",
    params: [taskId],
  });
  expect(
    JSON.stringify(outcome.data.columns) === JSON.stringify(["id", "status"]) &&
      outcome.data.total === 1 &&
      outcome.data.truncated === false,
    `db-query result is wrong: ${JSON.stringify(outcome.data)}`,
  );
  expect(asRecord({ r: outcome.data.rows }).r !== undefined, "db-query returned no rows");
  outcome = await expectToolOk(conn, "db-query", {
    sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 250) SELECT x FROM n",
  });
  expect(
    outcome.data.truncated === true &&
      outcome.data.total === 250 &&
      Number(outcome.data.rowLimit) < 250,
    `A 250-row result should be truncated: ${JSON.stringify({ ...outcome.data, rows: "<rows>" })}`,
  );
  await expectToolError(conn, "db-query", { sql: "DELETE FROM agents" }, "read-only");
  await expectToolError(conn, "db-query", { sql: "SELECT 1; SELECT 2" }, "one SQL statement");
  await expectToolError(conn, "db-query", { sql: "SELECT * FROM session_tokens" }, "credentials");
  expect((await callTool(conn, "db-query", {})).isError, "db-query accepted an empty call");

  // POST /api/db-query: same guard, plus the deprecated `query` alias.
  let response = await ctx.api("POST", "/api/db-query", {
    body: { sql: "SELECT id FROM agent_tasks WHERE id = ?", params: [taskId] },
  });
  expectStatus(response, [200], "db-query over HTTP");
  const result = asRecord(response.json);
  expect(
    result.total === 1 &&
      result.truncated === false &&
      typeof result.elapsed === "number" &&
      result.rowLimit !== undefined,
    `HTTP db-query result is wrong: ${response.text}`,
  );
  response = await ctx.api("POST", "/api/db-query", {
    body: { query: "SELECT COUNT(*) AS n FROM agents" },
  });
  expectStatus(response, [200], "db-query with the query alias");
  expect(
    JSON.stringify(asRecord(response.json).columns) === '["n"]',
    "query alias lost the column",
  );
  for (const [sql, label] of [
    ["DELETE FROM agents", "write"],
    ["SELECT 1; SELECT 2", "two statements"],
    ["SELECT * FROM session_tokens", "credential table"],
    ["SELECT * FROM no_such_table_here", "unknown table"],
  ] as const) {
    expectStatus(
      await ctx.api("POST", "/api/db-query", { body: { sql } }),
      [400],
      `db-query ${label}`,
    );
  }
  expectStatus(await ctx.api("POST", "/api/db-query", { body: {} }), [400], "db-query without sql");
  expectStatus(
    await ctx.api("POST", "/api/db-query", { apiKey: null, body: { sql: "SELECT 1" } }),
    [401],
    "db-query without credentials",
  );
}

export const coreTaskTools: Scenario = {
  name: "core-task-tools",
  order: 225,
  async run(ctx) {
    const creatorId = await registerWorker(ctx, "creator");
    const assigneeId = await registerWorker(ctx, "assignee", { maxTasks: 4 });
    const bystanderId = await registerWorker(ctx, "bystander");
    const leadId = await registerLead(ctx, "task-tools");
    try {
      await withMcp(ctx, creatorId, async (creator) => {
        await withMcp(ctx, assigneeId, async (assignee) => {
          await withMcp(ctx, bystanderId, async (bystander) => {
            await withMcp(ctx, leadId, async (lead) => {
              await delegation(ctx, creator, creatorId, assignee, assigneeId, bystander, lead);
              await deferral(ctx, bystander);
              const probe = await createAssignedTask(ctx, bystanderId, `sql probe ${ctx.nonce}`);
              await sqlTools(ctx, bystander, probe);
              await cancelQuietly(ctx, probe);
            });
          });
        });
      });
    } finally {
      await retireAgent(ctx, leadId);
    }
  },
};
