import type { AgentTask, RuntimePool } from "../../types";
import { checkDependencies, getDbClient } from "../db";
import { type AgentTaskRow, rowToAgentTask } from "../db/tasks/read";

export async function pendingWorkForAgent(agentId: string): Promise<{
  work: number;
  topTask: AgentTask | null;
}> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks WHERE (agentId = ? AND status = 'pending')
       OR (offeredTo = ? AND status = 'offered') ORDER BY priority DESC, createdAt, rowid`,
    [agentId, agentId],
  );
  const tasks: AgentTask[] = [];
  for (const row of rows) {
    const task = rowToAgentTask(row);
    if (task.status === "offered" || (await checkDependencies(task.id)).ready) tasks.push(task);
  }
  // claimMentions claims one channel at a time, regardless of its message count.
  const mentions = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(DISTINCT m.channelId) AS count FROM channel_messages m
     JOIN channels c ON c.id = m.channelId
     LEFT JOIN channel_read_state s ON s.channelId = m.channelId AND s.agentId = ?
     WHERE m.mentions LIKE ? AND s.processing_since IS NULL
       AND (s.lastReadAt IS NULL OR m.createdAt > s.lastReadAt)`,
    [agentId, `%"${agentId}"%`],
  );
  return { work: tasks.length + (mentions?.count ?? 0), topTask: tasks[0] ?? null };
}

export interface AgentDemand {
  agentId: string;
  maxTasks: number;
  work: number;
  current: number;
  freeSlots: number;
  provisioning: number;
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
    const limit = Math.floor(agent.maxTasks / pool.slotsPerRuntime);
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
