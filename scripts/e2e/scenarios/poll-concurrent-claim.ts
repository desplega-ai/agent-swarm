import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

const WORKERS = 6;
const TASKS = 3;
const MAX_ROUNDS = 5;

// Idle polls run read-only and only rerun under the write lock when they find
// work, so this pins the claim contract: workers polling at once never share a task.
export const pollConcurrentClaim: Scenario = {
  name: "poll-concurrent-claim",
  // Before any scenario registers a lead: POST /api/tasks hands a task with no
  // agentId to the lead when one exists, so it would never reach the pool.
  order: 32,
  async run(ctx) {
    const agentIds: string[] = [];
    for (let i = 0; i < WORKERS; i++) {
      const response = await ctx.api("POST", "/api/agents", {
        body: { name: `e2e-claimer-${i}-${ctx.nonce}`, role: "worker", status: "online" },
      });
      expectStatus(response, [201], "register claiming worker");
      agentIds.push(String(asRecord(response.json).id));
    }

    const taskIds = new Set<string>();
    for (let i = 0; i < TASKS; i++) {
      const response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `E2E concurrent claim ${i} ${ctx.nonce}`,
          priority: 100,
          followUpConfig: { disabled: true },
        },
      });
      expectStatus(response, [201], "create pool task");
      const task = asRecord(response.json);
      expect(
        task.status === "unassigned",
        `Pool task started ${String(task.status)} (a lead registered before this scenario?)`,
      );
      taskIds.add(String(task.id));
    }

    // Every worker polls in the same tick, for a few rounds, until all tasks are claimed.
    const winners = new Map<string, string[]>();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const polls = await Promise.all(
        agentIds.map((agentId) => ctx.api("GET", "/api/poll", { agentId })),
      );
      polls.forEach((poll, i) => {
        expectStatus(poll, [200], "concurrent poll");
        const trigger = asRecord(poll.json).trigger;
        if (!trigger) return;
        const taskId = String(asRecord(trigger).taskId);
        if (!taskIds.has(taskId)) return;
        winners.set(taskId, [...(winners.get(taskId) ?? []), agentIds[i]!]);
      });
      if (winners.size === TASKS) break;
    }

    for (const taskId of taskIds) {
      const won = winners.get(taskId) ?? [];
      expect(won.length === 1, `Task ${taskId} was handed to ${won.length} workers: ${won}`);
      const row = ctx.db.get<{ agentId: string | null; status: string }>(
        "SELECT agentId, status FROM agent_tasks WHERE id = ?",
        [taskId],
      );
      expect(
        row?.agentId === won[0] && row?.status === "in_progress",
        `Task ${taskId} row is ${row?.status}/${row?.agentId}, poll winner was ${won[0]}`,
      );
    }
  },
};
