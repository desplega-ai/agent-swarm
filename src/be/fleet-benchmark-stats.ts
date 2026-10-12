/**
 * Local numbers for the fleet benchmark card, with the definitions the
 * telemetry proxy uses for the fleet: tasks created and tasks finished since
 * the proxy started counting this install (`fleetCountStart`), and the
 * registered agent count (the same count `org.snapshot` reports as
 * `agents_total`).
 *
 * Null when that start is unknown: no accepted event is recorded yet, or the
 * earliest one is inside the window.
 */
import { fleetCountStart, type LocalFleetStats } from "../fleet-benchmark";
import { getDbClient } from "./db/runtime";
import { getTelemetryIngestAnchor } from "./telemetry-ingest-anchor";

export async function getLocalFleetStats(now = new Date()): Promise<LocalFleetStats | null> {
  const start = fleetCountStart(await getTelemetryIngestAnchor(), now);
  if (!start) return null;
  const since = start.toISOString();
  const client = getDbClient();
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
    countStart: since,
    agents: Number(agents?.n ?? 0),
  };
}
