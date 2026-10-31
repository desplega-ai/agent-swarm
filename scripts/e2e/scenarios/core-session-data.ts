import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  asUser,
  cancelQuietly,
  claimTask,
  createAssignedTask,
  createUser,
  readTask,
  registerWorker,
  UUID,
} from "./core-helpers";

const GHOST = "00000000-0000-4000-8000-00000000dead";

/** Worker log batches: stored per task, scrubbed on write, readable by the session's viewers. */
async function sessionLogs(ctx: ScenarioContext, taskId: string, owner: string, stranger: string) {
  const secret = `sk-ant-api03-${"A".repeat(90)}`;
  let response = await ctx.api("POST", "/api/session-logs", {
    body: {
      sessionId: `core-sl-${ctx.nonce}`,
      iteration: 1,
      taskId,
      cli: "claude",
      lines: [`{"type":"assistant","text":"hello ${ctx.nonce}"}`, `leaked ${secret} here`],
    },
  });
  expectStatus(response, [201], "store a log batch");
  expect(
    asRecord(response.json).success === true && asRecord(response.json).count === 2,
    "Batch count",
  );
  response = await ctx.api("POST", "/api/session-logs", {
    body: {
      sessionId: `core-sl-${ctx.nonce}`,
      iteration: 2,
      taskId,
      lines: [`second iteration ${ctx.nonce}`],
    },
  });
  expectStatus(response, [201], "store a second iteration");

  response = await ctx.api("GET", `/api/tasks/${taskId}/session-logs`);
  expectStatus(response, [200], "read session logs");
  const logs = asRecords(response.json, "logs");
  expect(logs.length === 3, `Expected 3 log rows, got ${logs.length}`);
  expect(
    logs.every((row) => row.taskId === taskId && row.sessionId === `core-sl-${ctx.nonce}`),
    "Log rows carry another task or session",
  );
  expect(logs[0]?.lineNumber === 0 && logs[1]?.lineNumber === 1, "Line numbers do not start at 0");
  expect(logs[0]?.cli === "claude" && logs[2]?.cli === "claude", "The cli defaults to claude");
  expect(String(logs[0]?.content).includes(`hello ${ctx.nonce}`), "First line was altered");
  expect(
    String(logs[1]?.content).includes("[REDACTED") && !String(logs[1]?.content).includes(secret),
    `The leaked key was not scrubbed: ${String(logs[1]?.content)}`,
  );
  expect(
    ctx.db.query<{ content: string }>(
      "SELECT content FROM session_logs WHERE taskId = ? AND content LIKE '%AAAAAAAAAA%'",
      [taskId],
    ).length === 0,
    "The raw secret reached the session_logs table",
  );
  response = await ctx.api("GET", `/api/tasks/${taskId}/session-logs?limit=1`);
  expect(
    asRecords(response.json, "logs").length === 1 &&
      String(asRecords(response.json, "logs")[0]?.content).includes("second iteration"),
    "limit=1 should return the last row",
  );
  expectStatus(await ctx.api("GET", `/api/tasks/${taskId}/session-logs?limit=0`), [400], "limit=0");
  expectStatus(
    await ctx.api("GET", `/api/tasks/${GHOST}/session-logs`),
    [404],
    "logs of an unknown task",
  );
  expectStatus(
    await ctx.api("GET", `/api/tasks/${taskId}/session-logs`, { headers: asUser(owner) }),
    [200],
    "the session owner reads the logs",
  );
  expectStatus(
    await ctx.api("GET", `/api/tasks/${taskId}/session-logs`, { headers: asUser(stranger) }),
    [403],
    "a stranger reads the logs",
  );
  for (const [body, label] of [
    [{ sessionId: "", iteration: 1, lines: ["x"] }, "empty session id"],
    [{ sessionId: "s", iteration: 0, lines: ["x"] }, "iteration 0"],
    [{ sessionId: "s", iteration: 1, lines: [] }, "no lines"],
  ] as const) {
    expectStatus(
      await ctx.api("POST", "/api/session-logs", { body }),
      [400],
      `log batch: ${label}`,
    );
  }
}

/** Cost rows, the pricing recompute and the usage reports built on them. */
async function sessionCosts(
  ctx: ScenarioContext,
  workerId: string,
  taskId: string,
  userId: string,
) {
  // The provider's own bill wins when the adapter marks it billed.
  let response = await ctx.api("POST", "/api/session-costs", {
    body: {
      sessionId: `core-cost-billed-${ctx.nonce}`,
      agentId: workerId,
      taskId,
      totalCostUsd: 0.25,
      harnessCostBilled: true,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      durationMs: 5000,
      numTurns: 3,
      model: "core-billed-model",
      provider: "codex",
    },
  });
  expectStatus(response, [201], "store a billed cost row");
  const billed = asRecord(asRecord(response.json).cost);
  expect(UUID.test(String(billed.id)) && asRecord(response.json).success === true, "Cost response");
  expect(
    billed.totalCostUsd === 0.25 && billed.costSource === "harness" && billed.taskId === taskId,
    `A billed cost must keep the provider's figure: ${JSON.stringify(billed)}`,
  );
  // Otherwise the server prices the tokens from its table and keeps the adapter figure aside.
  response = await ctx.api("POST", "/api/session-costs", {
    body: {
      sessionId: `core-cost-priced-${ctx.nonce}`,
      agentId: workerId,
      taskId,
      totalCostUsd: 0.5,
      inputTokens: 1000,
      outputTokens: 200,
      model: "claude-sonnet-4-5",
      provider: "claude",
      models: [
        {
          model: "claude-sonnet-4-5",
          inputTokens: 600,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          model: "claude-haiku-4-5",
          inputTokens: 400,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    },
  });
  expectStatus(response, [201], "store a priced cost row");
  const priced = asRecord(asRecord(response.json).cost);
  expect(
    priced.costSource !== "harness" && priced.harnessCostUsd === 0.5,
    `A priced row should keep the adapter figure aside: ${JSON.stringify(priced)}`,
  );
  expect(
    priced.inputTokens === 1000 && priced.outputTokens === 200,
    "Row token totals do not sum the per-model breakdown",
  );
  expect(Array.isArray(priced.modelBreakdown), "No model breakdown stored");
  expect(
    ctx.db.query<{ id: string }>("SELECT id FROM session_costs WHERE taskId = ?", [taskId])
      .length === 2,
    "session_costs does not hold both rows",
  );

  for (const [body, label] of [
    [{ agentId: workerId, totalCostUsd: 1 }, "no sessionId"],
    [{ sessionId: "s", totalCostUsd: 1 }, "no agentId"],
    [{ sessionId: "s", agentId: workerId, totalCostUsd: 1, inputTokens: -5 }, "negative tokens"],
  ] as const) {
    expectStatus(await ctx.api("POST", "/api/session-costs", { body }), [400], `cost: ${label}`);
  }

  // GET /api/session-costs
  response = await ctx.api("GET", `/api/session-costs?taskId=${taskId}`);
  expectStatus(response, [200], "costs by task");
  expect(asRecords(response.json, "costs").length === 2, "Task filter lost a row");
  response = await ctx.api("GET", `/api/session-costs?agentId=${workerId}&limit=1`);
  expect(asRecords(response.json, "costs").length === 1, "limit=1 returned several rows");
  response = await ctx.api("GET", `/api/session-costs?agentId=${workerId}&startDate=2020-01-01`);
  expect(asRecords(response.json, "costs").length === 2, "startDate filter dropped today's rows");
  response = await ctx.api("GET", `/api/session-costs?agentId=${workerId}&startDate=2099-01-01`);
  expect(asRecords(response.json, "costs").length === 0, "A future startDate matched rows");
  expectStatus(await ctx.api("GET", "/api/session-costs?limit=0"), [400], "costs with limit=0");

  // Reports. Each filter combination is unique to this scenario: the server caches reports.
  response = await ctx.api("GET", "/api/session-costs/dashboard");
  expectStatus(response, [200], "dashboard costs");
  const dashboard = asRecord(response.json);
  expect(
    Number(dashboard.costToday) >= 0.25 && Number(dashboard.costMtd) >= Number(dashboard.costToday),
    `Dashboard totals ${JSON.stringify(dashboard)}`,
  );
  response = await ctx.api("GET", `/api/session-costs/summary?groupBy=agent&agentId=${workerId}`);
  expectStatus(response, [200], "summary by agent");
  const summary = asRecord(response.json);
  const totals = asRecord(summary.totals);
  expect(
    totals.totalSessions === 2 &&
      totals.totalInputTokens === 1000 + 1000 &&
      Number(totals.totalCostUsd) > 0.25,
    `Summary totals ${JSON.stringify(totals)}`,
  );
  expect(
    asRecords(summary, "byAgent").some((row) => row.agentId === workerId && row.sessions === 2),
    "byAgent lacks the worker",
  );
  response = await ctx.api("GET", `/api/session-costs/summary?groupBy=day&agentId=${workerId}`);
  const today = new Date().toISOString().slice(0, 10);
  expect(
    asRecords(response.json, "daily").some((row) => row.date === today),
    "groupBy=day has no row for today",
  );
  response = await ctx.api("GET", `/api/session-costs/summary?groupBy=both&agentId=${workerId}`);
  expect(
    Array.isArray(asRecord(response.json).byCredential) &&
      asRecords(response.json, "byAgent").length === 1,
    "groupBy=both lacks byAgent or byCredential",
  );
  response = await ctx.api("GET", `/api/session-costs/summary?groupBy=user&userId=${userId}`);
  expectStatus(response, [200], "summary by user");
  expect(
    asRecords(response.json, "byUser").some(
      (row) => row.userId === userId && Number(row.costUsd) >= 0.25,
    ),
    `byUser lacks the requesting user: ${response.text.slice(0, 300)}`,
  );
  expectStatus(
    await ctx.api("GET", "/api/session-costs/summary?groupBy=week"),
    [400],
    "summary with an unknown grouping",
  );

  // GET /api/attribution/by-person: the user requested the task, so they initiated a problem.
  const endDate = `2099-12-31T00:00:00.${String(Number.parseInt(ctx.nonce.slice(0, 3), 16) % 1000).padStart(3, "0")}Z`;
  response = await ctx.api(
    "GET",
    `/api/attribution/by-person?startDate=2020-01-01&endDate=${endDate}`,
  );
  expectStatus(response, [200], "attribution by person");
  const row = asRecords(response.json, "rows").find((entry) => entry.userId === userId);
  expect(
    row !== undefined && Number(row.problemsInitiated) >= 1 && Number(row.agentsReached) >= 1,
    `Attribution lacks the requesting user: ${response.text.slice(0, 300)}`,
  );
  expect(row.firstPassYield === null, "firstPassYield is not null");
}

/** Active-session rows a worker keeps while it runs a task, and orphan recovery. */
async function activeSessions(ctx: ScenarioContext, workerId: string, otherId: string) {
  const taskId = await createAssignedTask(ctx, workerId, `active session task ${ctx.nonce}`);
  await claimTask(ctx, workerId, taskId);

  let response = await ctx.api("POST", "/api/active-sessions", {
    body: {
      agentId: workerId,
      taskId,
      triggerType: "task_assigned",
      taskDescription: `active session task ${ctx.nonce}`,
      runnerSessionId: `runner-${ctx.nonce}`,
    },
  });
  expectStatus(response, [201], "create an active session");
  const session = asRecord(asRecord(response.json).session);
  const sessionId = String(session.id);
  expect(
    UUID.test(sessionId) &&
      session.agentId === workerId &&
      session.taskId === taskId &&
      session.runnerSessionId === `runner-${ctx.nonce}` &&
      session.providerSessionId === null,
    `Unexpected active session ${JSON.stringify(session)}`,
  );
  expectStatus(
    await ctx.api("POST", "/api/active-sessions", { body: { agentId: workerId } }),
    [400],
    "active session without a trigger type",
  );

  response = await ctx.api("GET", `/api/active-sessions?agentId=${workerId}`);
  expectStatus(response, [200], "list active sessions");
  expect(
    asRecords(response.json, "sessions").length === 1 &&
      asRecords(response.json, "sessions")[0]?.id === sessionId,
    "The agent filter should return exactly its session",
  );
  response = await ctx.api("GET", "/api/active-sessions");
  expect(
    asRecords(response.json, "sessions").some((row) => row.id === sessionId),
    "The unfiltered list omits the session",
  );
  response = await ctx.api("GET", `/api/active-sessions?agentId=${otherId}`);
  expect(asRecords(response.json, "sessions").length === 0, "Another agent has the session");

  // Heartbeat and provider session id.
  const before = ctx.db.get<{ lastHeartbeatAt: string }>(
    "SELECT lastHeartbeatAt FROM active_sessions WHERE id = ?",
    [sessionId],
  );
  const beat = await pollUntil(
    async () => {
      const result = await ctx.api("PUT", `/api/active-sessions/heartbeat/${taskId}`);
      expectStatus(result, [200], "heartbeat");
      const after = ctx.db.get<{ lastHeartbeatAt: string }>(
        "SELECT lastHeartbeatAt FROM active_sessions WHERE id = ?",
        [sessionId],
      );
      return (
        asRecord(result.json).updated === true && after?.lastHeartbeatAt !== before?.lastHeartbeatAt
      );
    },
    5_000,
    50,
  );
  expect(beat, "The heartbeat never advanced lastHeartbeatAt");
  response = await ctx.api("PUT", `/api/active-sessions/heartbeat/${GHOST}`);
  expect(
    asRecord(response.json).updated === false,
    "Heartbeat of an unknown task reported an update",
  );
  response = await ctx.api("PUT", `/api/active-sessions/provider-session/${taskId}`, {
    body: { providerSessionId: `prov-${ctx.nonce}` },
  });
  expect(asRecord(response.json).updated === true, "Provider session id was not stored");
  response = await ctx.api("GET", `/api/active-sessions?agentId=${workerId}`);
  expect(
    asRecords(response.json, "sessions")[0]?.providerSessionId === `prov-${ctx.nonce}`,
    "providerSessionId not listed",
  );
  expectStatus(
    await ctx.api("PUT", `/api/active-sessions/provider-session/${taskId}`, { body: {} }),
    [400],
    "provider session without an id",
  );
  response = await ctx.api("PUT", `/api/active-sessions/provider-session/${GHOST}`, {
    body: { providerSessionId: "x" },
  });
  expect(asRecord(response.json).updated === false, "Provider id of an unknown task was stored");

  // A live session shields its task from orphan recovery.
  expectStatus(
    await ctx.api("POST", "/api/active-sessions/recover-orphaned-tasks", {
      body: { agentId: workerId, minAgeSeconds: 1 },
    }),
    [403],
    "recover without the agent header",
  );
  expectStatus(
    await ctx.api("POST", "/api/active-sessions/recover-orphaned-tasks", {
      agentId: otherId,
      body: { agentId: workerId, minAgeSeconds: 1 },
    }),
    [403],
    "recover for another agent",
  );
  // Recovery only considers tasks idle for at least minAgeSeconds, so wait until this one is.
  const idle = await pollUntil(
    async () =>
      Date.now() - Date.parse(String((await readTask(ctx, taskId)).lastUpdatedAt)) > 2_000,
    10_000,
    200,
  );
  expect(idle, "The task never became old enough for orphan recovery");
  response = await ctx.api("POST", "/api/active-sessions/recover-orphaned-tasks", {
    agentId: workerId,
    body: { agentId: workerId, minAgeSeconds: 1 },
  });
  expectStatus(response, [200], "recover with a live session");
  expect(asRecord(response.json).recovered === 0, "A task with a live session was recovered");

  // Deleting the session by task orphans the task: recovery sends it back to pending.
  response = await ctx.api("DELETE", `/api/active-sessions/by-task/${taskId}`);
  expect(asRecord(response.json).deleted === true, "Delete by task reported nothing deleted");
  response = await ctx.api("DELETE", `/api/active-sessions/by-task/${taskId}`);
  expect(asRecord(response.json).deleted === false, "A second delete by task deleted something");
  let recovered: Record<string, unknown> = {};
  const ok = await pollUntil(
    async () => {
      const result = await ctx.api("POST", "/api/active-sessions/recover-orphaned-tasks", {
        agentId: workerId,
        body: { agentId: workerId, minAgeSeconds: 1 },
      });
      expectStatus(result, [200], "recover the orphan");
      recovered = asRecord(result.json);
      return recovered.recovered === 1;
    },
    15_000,
    300,
  );
  expect(ok, `The orphaned task was never recovered: ${JSON.stringify(recovered)}`);
  const tasks = asRecords(recovered, "tasks");
  expect(tasks[0]?.id === taskId && tasks[0]?.status === "pending", "Recovered task is wrong");
  expect((await readTask(ctx, taskId)).status === "pending", "Recovery did not persist");

  // Delete by id, and the bulk cleanups.
  await claimTask(ctx, workerId, taskId);
  response = await ctx.api("POST", "/api/active-sessions", {
    body: { agentId: workerId, taskId, triggerType: "task_assigned" },
  });
  const secondId = String(asRecord(asRecord(response.json).session).id);
  response = await ctx.api("POST", "/api/active-sessions/cleanup", {
    body: { maxAgeMinutes: 100_000 },
  });
  expectStatus(response, [200], "stale cleanup");
  expect(typeof asRecord(response.json).cleaned === "number", "cleanup has no count");
  expect(
    ctx.db.get<{ id: string }>("SELECT id FROM active_sessions WHERE id = ?", [secondId]) !== null,
    "A fresh session was cleaned as stale",
  );
  response = await ctx.api("POST", "/api/active-sessions/cleanup", { body: { agentId: workerId } });
  expectStatus(response, [200], "agent cleanup");
  expect(
    asRecord(response.json).cleaned === 1,
    `Agent cleanup removed ${String(asRecord(response.json).cleaned)}`,
  );
  response = await ctx.api("POST", "/api/active-sessions", {
    body: { agentId: workerId, triggerType: "unread_mentions" },
  });
  const thirdId = String(asRecord(asRecord(response.json).session).id);
  response = await ctx.api("DELETE", `/api/active-sessions/${thirdId}`);
  expect(asRecord(response.json).deleted === true, "Delete by id reported nothing deleted");
  response = await ctx.api("DELETE", `/api/active-sessions/${thirdId}`);
  expect(asRecord(response.json).deleted === false, "A second delete by id deleted something");
  expectStatus(
    await ctx.api("POST", "/api/active-sessions/cleanup"),
    [200],
    "cleanup without a body",
  );
  await cancelQuietly(ctx, taskId);
}

export const coreSessionData: Scenario = {
  name: "core-session-data",
  order: 245,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "session-data", { maxTasks: 3 });
    const otherId = await registerWorker(ctx, "session-data-other");
    const owner = await createUser(ctx, "data-owner");
    const stranger = await createUser(ctx, "data-stranger");
    const taskId = await createAssignedTask(ctx, workerId, `session data task ${ctx.nonce}`, {
      requestedByUserId: owner,
    });
    await claimTask(ctx, workerId, taskId);
    await sessionLogs(ctx, taskId, owner, stranger);
    await sessionCosts(ctx, workerId, taskId, owner);
    // Orphan recovery is per agent: a dedicated worker keeps the logs task out of it.
    const activeWorkerId = await registerWorker(ctx, "active-sessions", { maxTasks: 2 });
    await activeSessions(ctx, activeWorkerId, otherId);
    await cancelQuietly(ctx, taskId);
  },
};
