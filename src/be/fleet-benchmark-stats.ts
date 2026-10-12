/**
 * Local numbers for the fleet benchmark card, with the definitions the
 * telemetry proxy uses for the fleet: tasks created and tasks finished in the
 * last 30 days, the first task ever, and the registered agent count (the same
 * count `org.snapshot` reports as `agents_total`).
 */
import { FLEET_WINDOW_DAYS, type LocalFleetStats } from "../fleet-benchmark";
import { getDbClient } from "./db/runtime";

export async function getLocalFleetStats(now = new Date()): Promise<LocalFleetStats> {
  const since = new Date(now.getTime() - FLEET_WINDOW_DAYS * 86_400_000).toISOString();
  const client = getDbClient();
  const tasks = await client.get<{
    created: number | null;
    completed: number | null;
    failed: number | null;
    firstTaskAt: string | null;
  }>(
    `SELECT SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END) AS created,
            SUM(CASE WHEN status = 'completed' AND finishedAt >= ? THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' AND finishedAt >= ? THEN 1 ELSE 0 END) AS failed,
            MIN(createdAt) AS firstTaskAt
       FROM agent_tasks`,
    [since, since, since],
  );
  const agents = await client.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents");
  return {
    tasksCreated: Number(tasks?.created ?? 0),
    tasksCompleted: Number(tasks?.completed ?? 0),
    tasksFailed: Number(tasks?.failed ?? 0),
    firstTaskAt: tasks?.firstTaskAt ?? null,
    agents: Number(agents?.n ?? 0),
  };
}
