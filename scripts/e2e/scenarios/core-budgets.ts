import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { createAssignedTask, createUser, readTask, registerWorker } from "./core-helpers";

type BudgetRow = { daily_budget_usd: number };

function storedBudget(ctx: ScenarioContext, scope: string, scopeId: string): BudgetRow | null {
  return ctx.db.get<BudgetRow>(
    "SELECT daily_budget_usd FROM budgets WHERE scope = ? AND scope_id = ?",
    [scope, scopeId],
  );
}

/** CRUD on budget rows for one scope. */
async function crud(ctx: ScenarioContext, agentId: string) {
  const path = `/api/budgets/agent/${agentId}`;
  expectStatus(await ctx.api("GET", path), [404], "no budget yet");
  expectStatus(await ctx.api("DELETE", path), [404], "delete a missing budget");

  let response = await ctx.api("PUT", path, { body: { dailyBudgetUsd: 12.5 } });
  expectStatus(response, [200], "create a budget");
  let row = asRecord(response.json);
  expect(
    row.scope === "agent" &&
      row.scopeId === agentId &&
      row.dailyBudgetUsd === 12.5 &&
      typeof row.createdAt === "number",
    `Unexpected budget row ${response.text}`,
  );
  expect(
    storedBudget(ctx, "agent", agentId)?.daily_budget_usd === 12.5,
    "budgets table lacks the row",
  );
  const createdAt = row.createdAt;

  response = await ctx.api("PUT", path, { body: { dailyBudgetUsd: 3 } });
  expectStatus(response, [200], "update the budget");
  row = asRecord(response.json);
  expect(
    row.dailyBudgetUsd === 3 && row.createdAt === createdAt,
    "An update must keep createdAt and change the amount",
  );
  response = await ctx.api("GET", path);
  expectStatus(response, [200], "read the budget");
  expect(asRecord(response.json).dailyBudgetUsd === 3, "GET returned a stale budget");
  response = await ctx.api("GET", "/api/budgets");
  expectStatus(response, [200], "list budgets");
  expect(
    asRecords(response.json, "budgets").some((entry) => entry.scopeId === agentId),
    "The list omits the budget",
  );
  const audit = ctx.db.query<{ eventType: string }>(
    "SELECT eventType FROM agent_log WHERE eventType LIKE 'budget.%' AND metadata LIKE ?",
    [`%${agentId}%`],
  );
  expect(
    audit.some((entry) => entry.eventType === "budget.upserted"),
    "No budget.upserted audit entry",
  );

  expectStatus(
    await ctx.api("PUT", path, { body: { dailyBudgetUsd: -1 } }),
    [400],
    "negative budget",
  );
  expectStatus(await ctx.api("PUT", path, { body: {} }), [400], "budget without an amount");
  expectStatus(
    await ctx.api("PUT", `/api/budgets/team/${agentId}`, { body: { dailyBudgetUsd: 1 } }),
    [400],
    "unknown scope",
  );
  expectStatus(
    await ctx.api("PUT", path, { apiKey: null, body: { dailyBudgetUsd: 1 } }),
    [401],
    "budget write without credentials",
  );
  // The global row is addressed as `_global`. Reading it must not require one to exist.
  const globalRead = await ctx.api("GET", "/api/budgets/global/_global");
  expectStatus(globalRead, [200, 404], "read the global budget");

  expectStatus(await ctx.api("DELETE", path), [204], "delete the budget");
  expect(storedBudget(ctx, "agent", agentId) === null, "The budget row survived the delete");
  expect(
    ctx.db.query<{ eventType: string }>(
      "SELECT eventType FROM agent_log WHERE eventType = 'budget.deleted' AND metadata LIKE ?",
      [`%${agentId}%`],
    ).length === 1,
    "No budget.deleted audit entry",
  );
  expectStatus(await ctx.api("GET", path), [404], "read the deleted budget");
}

/** A zero budget refuses claims; lifting it lets the same task run. */
async function refusals(ctx: ScenarioContext) {
  const agentId = await registerWorker(ctx, "budget-agent");
  const userAgentId = await registerWorker(ctx, "budget-user");
  const user = await createUser(ctx, "budgeted");
  const agentPath = `/api/budgets/agent/${agentId}`;
  const userPath = `/api/budgets/user/${user}`;

  expectStatus(
    await ctx.api("PUT", agentPath, { body: { dailyBudgetUsd: 0 } }),
    [200],
    "zero agent budget",
  );
  expectStatus(
    await ctx.api("PUT", userPath, { body: { dailyBudgetUsd: 0 } }),
    [200],
    "zero user budget",
  );
  const agentTask = await createAssignedTask(ctx, agentId, `agent budgeted task ${ctx.nonce}`);
  const userTask = await createAssignedTask(ctx, userAgentId, `user budgeted task ${ctx.nonce}`, {
    requestedByUserId: user,
  });

  const agentSim = await ctx.startAgent({ agentId });
  const userSim = await ctx.startAgent({ agentId: userAgentId });
  const seen = (sim: typeof agentSim) =>
    sim.triggers.find((trigger) => trigger.type === "budget_refused");
  const refused = await pollUntil(
    () => seen(agentSim) !== undefined && seen(userSim) !== undefined,
    20_000,
    100,
  );
  expect(refused, "A zero budget never produced a budget_refused trigger");

  const agentRefusal = asRecord(seen(agentSim));
  expect(
    agentRefusal.cause === "agent" &&
      agentRefusal.agentBudget === 0 &&
      typeof agentRefusal.resetAt === "string" &&
      new Date(String(agentRefusal.resetAt)).getUTCHours() === 0,
    `Agent refusal trigger ${JSON.stringify(agentRefusal)}`,
  );
  const userRefusal = asRecord(seen(userSim));
  expect(
    userRefusal.cause === "user" && userRefusal.userBudget === 0,
    `User refusal trigger ${JSON.stringify(userRefusal)}`,
  );
  expect((await readTask(ctx, agentTask)).status === "pending", "A refused task left pending");
  expect((await readTask(ctx, userTask)).status === "pending", "A refused user task left pending");

  let response = await ctx.api("GET", "/api/budgets/refusals?limit=500");
  expectStatus(response, [200], "list refusals");
  const rows = asRecords(response.json, "refusals");
  const agentRow = rows.find((entry) => entry.taskId === agentTask);
  const userRow = rows.find((entry) => entry.taskId === userTask);
  expect(
    agentRow?.cause === "agent" &&
      agentRow.agentId === agentId &&
      agentRow.agentBudgetUsd === 0 &&
      userRow?.cause === "user" &&
      userRow.userBudgetUsd === 0,
    `Refusal rows are wrong: ${JSON.stringify([agentRow, userRow])}`,
  );
  // One notification per task and day, however often the worker polls.
  expect(
    ctx.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM budget_refusal_notifications WHERE task_id = ?",
      [agentTask],
    )[0]?.n === 1,
    "A repeated refusal wrote a second notification",
  );
  response = await ctx.api("GET", "/api/budgets/refusals?limit=1");
  expect(asRecords(response.json, "refusals").length === 1, "limit=1 returned several refusals");
  expectStatus(await ctx.api("GET", "/api/budgets/refusals?limit=0"), [400], "refusals limit=0");
  expectStatus(
    await ctx.api("GET", "/api/budgets/refusals?limit=501"),
    [400],
    "refusals limit=501",
  );

  // Lift the agent budget: the same task now runs to completion.
  expectStatus(await ctx.api("PUT", agentPath, { body: { dailyBudgetUsd: 1000 } }), [200], "raise");
  const ran = await agentSim.waitForTask(agentTask);
  expect(ran.status === "completed", "The task did not complete after the budget was raised");
  expect((await readTask(ctx, agentTask)).status === "completed", "Task not completed in the API");
  // Deleting the user budget does the same for the user-capped task.
  expectStatus(await ctx.api("DELETE", userPath), [204], "delete the user budget");
  await userSim.waitForTask(userTask);
  expect((await readTask(ctx, userTask)).status === "completed", "User task not completed");
  expectStatus(await ctx.api("DELETE", agentPath), [204], "delete the agent budget");
  await agentSim.stop();
  await userSim.stop();
}

export const coreBudgets: Scenario = {
  name: "core-budgets",
  order: 255,
  async run(ctx) {
    const crudAgent = await registerWorker(ctx, "budget-crud");
    await crud(ctx, crudAgent);
    await refusals(ctx);
  },
};
