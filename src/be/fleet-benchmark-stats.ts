/**
 * Local numbers for the fleet benchmark card, with the definitions the
 * telemetry proxy uses for the fleet: tasks created and tasks finished since
 * the window start (or the install's first event, when newer), and the
 * registered agent count (the same count `org.snapshot` reports as
 * `agents_total`).
 *
 * The proxy anchors an install at its first event ever. Locally that is when
 * the install ID was minted: the `telemetry_installation_id` row's `createdAt`,
 * which upserts never change and which exists for installs older than the
 * `telemetry_installed_at` anchor too. Without that row, the first task stands in.
 */
import { fleetCountStart, type LocalFleetStats } from "../fleet-benchmark";
import { getDbClient } from "./db/runtime";

export async function getLocalFleetStats(now = new Date()): Promise<LocalFleetStats> {
  const client = getDbClient();
  const anchor = await client.get<{ firstSeenAt: string | null }>(
    `SELECT COALESCE(
              (SELECT createdAt FROM swarm_config
                WHERE scope = 'global' AND key = 'telemetry_installation_id'
                ORDER BY createdAt LIMIT 1),
              (SELECT MIN(createdAt) FROM agent_tasks)
            ) AS firstSeenAt`,
  );
  const firstSeenAt = anchor?.firstSeenAt ?? null;
  const since = fleetCountStart(firstSeenAt, now).toISOString();
  const tasks = await client.get<{
    created: number | null;
    completed: number | null;
    failed: number | null;
  }>(
    `SELECT SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END) AS created,
            SUM(CASE WHEN status = 'completed' AND finishedAt >= ? THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' AND finishedAt >= ? THEN 1 ELSE 0 END) AS failed
       FROM agent_tasks`,
    [since, since, since],
  );
  const agents = await client.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents");
  return {
    tasksCreated: Number(tasks?.created ?? 0),
    tasksCompleted: Number(tasks?.completed ?? 0),
    tasksFailed: Number(tasks?.failed ?? 0),
    firstSeenAt,
    agents: Number(agents?.n ?? 0),
  };
}
