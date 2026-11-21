import type { AgentTask, RuntimeInstance, RuntimePool } from "../../types";
import { checkDependencies } from "../db";
import { type AgentTaskRow, rowToAgentTask } from "../db/tasks/read";
import { getStorage } from "../storage";

export async function pendingWorkForAgent(agentId: string): Promise<{
  work: number;
  topTask: AgentTask | null;
}> {
  const repo = getStorage().repos.runtimePools;
  const rows = await repo.listPendingWork<AgentTaskRow>(agentId);
  const tasks: AgentTask[] = [];
  for (const row of rows) {
    const task = rowToAgentTask(row);
    if (task.status === "offered" || (await checkDependencies(task.id)).ready) tasks.push(task);
  }
  // claimMentions claims one channel at a time, regardless of its message count.
  const mentions = await repo.countUnreadMentionChannels(agentId);
  return { work: tasks.length + mentions, topTask: tasks[0] ?? null };
}

export interface AgentDemand {
  agentId: string;
  maxTasks: number;
  work: number;
  current: number;
  freeSlots: number;
  provisioning: number;
}

/** The most runtimes one agent may hold: `maxTasks` split into whole runtimes. */
export function agentRuntimeLimit(maxTasks: number, slotsPerRuntime: number): number {
  return Math.floor(maxTasks / slotsPerRuntime);
}

/** Runtimes that count against a pool's `maxRuntimes`: provisioning, or active and fresh. */
export function countPoolRuntimes(
  runtimes: Pick<RuntimeInstance, "status" | "lastSeenAt">[],
  now: Date,
  staleMinutes: number,
): number {
  return runtimes.filter(
    (r) =>
      r.status === "provisioning" ||
      (r.status === "active" && Date.parse(r.lastSeenAt) >= now.getTime() - staleMinutes * 60_000),
  ).length;
}

export function computeDesired(
  pool: Pick<RuntimePool, "slotsPerRuntime" | "minRuntimes" | "maxRuntimes">,
  agents: AgentDemand[],
): Map<string, number> {
  const desired = new Map<string, number>();
  // Existing runtimes consume the pool cap before any agent receives new capacity.
  let remaining = Math.max(
    0,
    (pool.maxRuntimes ?? Infinity) - agents.reduce((n, a) => n + a.current, 0),
  );
  for (const agent of agents) {
    const uncovered = Math.max(
      0,
      agent.work - agent.freeSlots - agent.provisioning * pool.slotsPerRuntime,
    );
    const limit = agentRuntimeLimit(agent.maxTasks, pool.slotsPerRuntime);
    const count = Math.min(
      limit,
      Math.max(pool.minRuntimes, agent.current + Math.ceil(uncovered / pool.slotsPerRuntime)),
    );
    const added = Math.min(remaining, Math.max(0, count - agent.current));
    desired.set(agent.agentId, Math.min(count, agent.current + added));
    remaining -= added;
  }
  return desired;
}
