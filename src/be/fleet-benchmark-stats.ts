/**
 * Local numbers for the fleet benchmark card, with the definitions the
 * telemetry proxy uses for the fleet: tasks created and tasks finished since
 * the proxy started counting this install (`fleetCountStart`), and the
 * registered agent count (the same count `org.snapshot` reports as
 * `agents_total`).
 *
 * Comparisons require a known ingest start. With telemetry off, callers can
 * use the local 30-day window without an ingest anchor.
 */
import { FLEET_WINDOW_DAYS, fleetCountStart, type LocalFleetStats } from "../fleet-benchmark";
import { getStorage } from "./storage";
import { getTelemetryIngestAnchor } from "./telemetry-ingest-anchor";

export async function getLocalFleetStats(
  now = new Date(),
  { requireIngestAnchor = true } = {},
): Promise<LocalFleetStats | null> {
  const start = requireIngestAnchor
    ? fleetCountStart(await getTelemetryIngestAnchor(), now)
    : new Date(now.getTime() - FLEET_WINDOW_DAYS * 86_400_000);
  if (!start) return null;
  const since = start.toISOString();
  const tasks = await getStorage().repos.tasks.countTaskActivitySince(since);
  const agentCount = await getStorage().repos.agents.countAllAgents();
  return {
    tasksCreated: Number(tasks?.created ?? 0),
    tasksCompleted: Number(tasks?.completed ?? 0),
    tasksFailed: Number(tasks?.failed ?? 0),
    countStart: since,
    agents: Number(agentCount),
  };
}
