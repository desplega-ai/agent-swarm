import { sql, sqlList } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { createUser, registerLead, retireAgent, withMcp } from "./core-helpers";

const WORKERS = 12;
const ROUNDS = 6;

// A poll lists pool candidates, checks the budget of the first one's requester, then
// claims down the list. When the first candidate is locked or already taken (concurrent
// polls on Postgres), the claim falls back to the next one. That fallback must check
// the next requester's budget too. Here every round adds one task for a user with
// budget (higher priority, so it is first) and one for a user with a zero budget,
// then all workers poll at once. The zero-budget tasks must never be claimed.
export const budgetPoolFallback: Scenario = {
  name: "budget-pool-fallback",
  order: 9_445,
  async run(ctx) {
    const capability = `budget-fallback-${ctx.nonce}`;
    const register = async (name: string) => {
      const response = await ctx.api("POST", "/api/agents", {
        body: { name, role: "worker", status: "online", maxTasks: 1 },
      });
      expectStatus(response, [201], `register ${name}`);
      return asString(asRecord(response.json).id, `${name} id`);
    };
    // A lead may name the requester of a pool task (send-task without agentId).
    const creatorId = await registerLead(ctx, "budget-fallback");
    const workers = await Promise.all(
      Array.from({ length: WORKERS }, async (_, i) => {
        const agentId = await register(`e2e-budget-fallback-${i}-${ctx.nonce}`);
        expectStatus(
          await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
            body: { capabilities: [capability] },
          }),
          [200],
          "give the worker the fallback capability",
        );
        return agentId;
      }),
    );

    const paying = await createUser(ctx, "fallback-paying");
    const broke = await createUser(ctx, "fallback-broke");
    expectStatus(
      await ctx.api("PUT", `/api/budgets/user/${broke}`, { body: { dailyBudgetUsd: 0 } }),
      [200],
      "zero budget for the second requester",
    );
    const brokeTasks = new Set<string>();
    const payingTasks = new Set<string>();
    const wrongClaims: string[] = [];
    await withMcp(ctx, creatorId, async (conn) => {
      const pool = async (requester: string, priority: number, label: string) => {
        const result = asRecord(
          await conn.callTool("send-task", {
            task: `Fallback ${label} ${ctx.nonce}`,
            requestedByUserId: requester,
            requiredCapabilities: [capability],
            priority,
          }),
        );
        const data = asRecord(result.structuredContent);
        expect(result.isError !== true, `send-task ${label} failed: ${JSON.stringify(data)}`);
        const task = asRecord(data.task);
        expect(
          task.requestedByUserId === requester,
          `${label} has requester ${task.requestedByUserId}`,
        );
        return asString(task.id ?? data.taskId, `${label} task id`);
      };

      for (let round = 0; round < ROUNDS; round++) {
        payingTasks.add(await pool(paying, 91, `paying ${round}`));
        brokeTasks.add(await pool(broke, 90, `broke ${round}`));
        const claimed = await Promise.all(
          workers.map(async (agentId) => {
            const response = await ctx.api("GET", "/api/poll", { agentId });
            expectStatus(response, [200], "fallback poll");
            const trigger = asRecord(response.json).trigger;
            if (!trigger) return null;
            const record = asRecord(trigger);
            if (record.type !== "task_assigned" || typeof record.taskId !== "string") return null;
            if (brokeTasks.has(record.taskId)) wrongClaims.push(`${agentId} got ${record.taskId}`);
            return { agentId, taskId: record.taskId };
          }),
        );
        for (const hit of claimed) {
          if (!hit) continue;
          expectStatus(
            await ctx.api("POST", `/api/tasks/${hit.taskId}/finish`, {
              agentId: hit.agentId,
              body: { status: "completed", output: `fallback done ${hit.taskId}` },
            }),
            [200],
            `finish ${hit.taskId}`,
          );
        }
      }
    });

    const started = ctx.db.query<{ id: string; status: string }>(
      sql`SELECT id, status FROM agent_tasks WHERE id IN (${sqlList([...brokeTasks])}) AND status IN ('in_progress', 'completed')`,
    );
    expect(
      wrongClaims.length === 0 && started.length === 0,
      `zero-budget tasks were claimed: ${wrongClaims.slice(0, 5).join("; ")} ${JSON.stringify(started.slice(0, 5))}`,
    );

    for (const id of brokeTasks) {
      await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: { reason: "e2e cleanup" } });
    }
    await retireAgent(ctx, creatorId);
  },
};
