import { sql } from "../db";
import { type ApiResponse, asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerWorker } from "./core-helpers";

const FAN_OUT = 10;

// Read-then-write claim paths hit by many identical requests at once. Each one must
// keep exactly one winner (one task, one workflow, one run, one counter step per call).
export const divergenceConcurrentScheduleClaim: Scenario = {
  name: "divergence-concurrent-schedule-claim",
  order: 9_431,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "claim-target");
    await scheduleOccurrence(ctx, workerId);
    await taskIdempotencyRace(ctx, workerId);
    await workflowIdempotencyRace(ctx);
    await kvIncrRace(ctx, workerId);
  },
};

const fanOut = (send: () => Promise<ApiResponse>) =>
  Promise.all(Array.from({ length: FAN_OUT }, () => send()));

const replayed = (response: ApiResponse) => response.headers.get("idempotent-replayed") === "true";

/**
 * A due occurrence fires once from the scheduler, however many manual runs land on the
 * same schedule at the same time. A manual run is its own task every time and never
 * consumes the occurrence.
 */
async function scheduleOccurrence(ctx: ScenarioContext, workerId: string): Promise<void> {
  const created = await ctx.api("POST", "/api/schedules", {
    body: {
      name: `e2e-claim-schedule-${ctx.nonce}`,
      intervalMs: 3_600_000,
      taskTemplate: `Concurrent schedule claim ${ctx.nonce}`,
      targetAgentId: workerId,
    },
  });
  expectStatus(created, [201], "create recurring schedule");
  const schedule = asRecord(created.json);
  const scheduleId = asString(schedule.id, "schedule id");
  const plannedRunAt = asString(schedule.nextRunAt, "schedule nextRunAt");

  const tasksOf = () =>
    ctx.db
      .query<{ id: string; tags: string | null }>(
        sql`SELECT id, tags FROM agent_tasks WHERE "scheduleId" = ${scheduleId}`,
      )
      .map((row) => ({ id: row.id, manual: (row.tags ?? "").includes("manual-run") }));

  const manualRun = () => ctx.api("POST", `/api/schedules/${scheduleId}/run`);
  const firstBurst = await fanOut(manualRun);
  const manualIds = new Set<string>();
  for (const response of firstBurst) {
    expectStatus(response, [200], "concurrent run-now");
    manualIds.add(asString(asRecord(asRecord(response.json).task).id, "run-now task id"));
  }
  expect(manualIds.size === FAN_OUT, `${FAN_OUT} run-now calls made ${manualIds.size} tasks`);
  const afterManual = await ctx.api("GET", `/api/schedules/${scheduleId}`);
  expectStatus(afterManual, [200], "read schedule after run-now");
  expect(
    asRecord(afterManual.json).nextRunAt === plannedRunAt,
    "a manual run moved nextRunAt (it must not consume the occurrence)",
  );

  // Make the occurrence due, then hammer run-now while the scheduler claims it.
  const due = new Date(Date.now() - 1_000).toISOString();
  const patched = await ctx.api("PATCH", `/api/schedules/${scheduleId}`, {
    body: { nextRunAt: due },
  });
  expectStatus(patched, [200], "make the occurrence due");
  expect(asRecord(patched.json).nextRunAt === due, "PATCH did not store the due nextRunAt");

  const started = Date.now();
  let bursts = 0;
  let fired = false;
  while (!fired && Date.now() - started < 30_000) {
    for (const response of await fanOut(manualRun)) {
      expectStatus(response, [200], "run-now while the occurrence is due");
    }
    bursts++;
    const current = asRecord((await ctx.api("GET", `/api/schedules/${scheduleId}`)).json);
    fired = typeof current.nextRunAt === "string" && current.nextRunAt > due;
    if (!fired) await Bun.sleep(500);
  }
  expect(fired, "the scheduler never claimed the due occurrence within 30 s");

  // Let a second scheduler tick pass: it must find nothing due.
  await Bun.sleep(11_000);
  const tasks = tasksOf();
  const occurrenceTasks = tasks.filter((task) => !task.manual);
  expect(
    occurrenceTasks.length === 1,
    `one due occurrence produced ${occurrenceTasks.length} scheduler tasks`,
  );
  expect(
    tasks.length === 1 + FAN_OUT * (1 + bursts),
    `expected ${1 + FAN_OUT * (1 + bursts)} tasks, found ${tasks.length}`,
  );
  const final = asRecord((await ctx.api("GET", `/api/schedules/${scheduleId}`)).json);
  const nextRunAt = Date.parse(asString(final.nextRunAt, "advanced nextRunAt"));
  expect(
    nextRunAt > Date.now() + 50 * 60_000,
    `the occurrence advanced nextRunAt to ${final.nextRunAt}, expected about an hour ahead`,
  );
  expect(typeof final.lastRunAt === "string", "the claim did not set lastRunAt");
  ctx.log(`schedule: ${bursts} run-now bursts while due, ${tasks.length} tasks, 1 occurrence`);

  expectStatus(await ctx.api("DELETE", `/api/schedules/${scheduleId}`), [200], "delete schedule");
}

/** N creates with one Idempotency-Key: one task row, one non-replayed answer. */
async function taskIdempotencyRace(ctx: ScenarioContext, workerId: string): Promise<void> {
  const body = {
    task: `Concurrent keyed create ${ctx.nonce}`,
    agentId: workerId,
    routingReason: "human_pinned",
    source: "ui",
  };
  const responses = await fanOut(() =>
    ctx.api("POST", "/api/tasks", {
      headers: { "Idempotency-Key": `race-task-${ctx.nonce}` },
      body,
    }),
  );
  const ids = new Set<string>();
  for (const response of responses) {
    expectStatus(response, [201], "concurrent keyed task create");
    ids.add(asString(asRecord(response.json).id, "keyed task id"));
  }
  expect(ids.size === 1, `one key returned ${ids.size} different tasks`);
  const fresh = responses.filter((response) => !replayed(response)).length;
  expect(fresh === 1, `${fresh} responses claim to have created the task (want 1)`);
  const rows = ctx.db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM agent_tasks WHERE task = ${body.task}`,
  );
  expect(Number(rows?.n) === 1, `the keyed race left ${rows?.n} task rows`);
  const keys = ctx.db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM task_idempotency_keys WHERE "taskId" = ${[...ids][0]}`,
  );
  expect(Number(keys?.n) === 1, `the keyed race left ${keys?.n} idempotency rows`);
}

/** N workflow creates, then N triggers, each under one key: one workflow, one run. */
async function workflowIdempotencyRace(ctx: ScenarioContext): Promise<void> {
  const createBody = {
    name: `e2e-claim-workflow-${ctx.nonce}`,
    definition: {
      nodes: [{ id: "a", type: "script", config: { runtime: "bash", script: "echo claim" } }],
    },
  };
  const creates = await fanOut(() =>
    ctx.api("POST", "/api/workflows", {
      headers: { "Idempotency-Key": `race-wf-${ctx.nonce}` },
      body: createBody,
    }),
  );
  const workflowIds = new Set<string>();
  for (const response of creates) {
    expectStatus(response, [201], "concurrent keyed workflow create");
    workflowIds.add(asString(asRecord(response.json).id, "keyed workflow id"));
  }
  expect(workflowIds.size === 1, `one key created ${workflowIds.size} workflows`);
  expect(
    creates.filter((response) => !replayed(response)).length === 1,
    "more than one workflow create answered as the original",
  );
  const workflowId = [...workflowIds][0]!;
  const named = ctx.db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM workflows WHERE name = ${createBody.name}`,
  );
  expect(Number(named?.n) === 1, `the keyed create left ${named?.n} workflow rows`);

  const triggers = await fanOut(() =>
    ctx.api("POST", `/api/workflows/${workflowId}/trigger`, {
      headers: { "Idempotency-Key": `race-run-${ctx.nonce}` },
      body: { n: 1 },
    }),
  );
  const runIds = new Set<string>();
  for (const response of triggers) {
    expectStatus(response, [201], "concurrent keyed trigger");
    runIds.add(asString(asRecord(response.json).runId, "keyed run id"));
  }
  expect(runIds.size === 1, `one trigger key started ${runIds.size} runs`);
  expect(
    triggers.filter((response) => !replayed(response)).length === 1,
    "more than one trigger answered as the original",
  );
  const runs = ctx.db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM workflow_runs WHERE "workflowId" = ${workflowId}`,
  );
  expect(Number(runs?.n) === 1, `the keyed trigger left ${runs?.n} runs`);
  const runId = [...runIds][0]!;
  const settled = await pollUntil(
    () =>
      ctx.db.get<{ status: string }>(sql`SELECT status FROM workflow_runs WHERE id = ${runId}`)
        ?.status === "completed",
    20_000,
    200,
  );
  expect(settled, `keyed run ${runId} never completed`);
  expectStatus(await ctx.api("DELETE", `/api/workflows/${workflowId}`), [204], "delete workflow");
}

/** N increments at once: every caller sees its own step, none is lost. */
async function kvIncrRace(ctx: ScenarioContext, agentId: string): Promise<void> {
  const key = `race-counter-${ctx.nonce}`;
  const responses = await Promise.all(
    Array.from({ length: FAN_OUT * 2 }, () =>
      ctx.api("POST", `/api/kv/${key}/incr`, { agentId, body: { by: 1 } }),
    ),
  );
  const seen = responses.map((response) => {
    expectStatus(response, [200], "concurrent kv incr");
    return Number(asRecord(response.json).value);
  });
  const expected = Array.from({ length: FAN_OUT * 2 }, (_, i) => i + 1);
  expect(
    JSON.stringify([...seen].sort((a, b) => a - b)) === JSON.stringify(expected),
    `concurrent increments returned ${JSON.stringify(seen)}`,
  );
  const final = await ctx.api("GET", `/api/kv/${key}`, { agentId });
  expectStatus(final, [200], "read the counter");
  expect(
    Number(asRecord(final.json).value) === FAN_OUT * 2,
    `the counter ended at ${asRecord(final.json).value}, want ${FAN_OUT * 2}`,
  );
}
