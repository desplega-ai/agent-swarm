import { getDbClient } from "./runtime";

/**
 * Install-wide counts behind the dashboard's feedback pop-up triggers, plus
 * the oldest agent registration as a fallback install-age anchor.
 */
export async function getInstanceFeedbackSignals(): Promise<{
  first_seen_at: string | null;
  tasks_completed: number;
  tasks_failed: number;
  workflow_runs_completed: number;
}> {
  const client = getDbClient();
  const agents = await client.get<{ first: string | null }>(
    "SELECT MIN(createdAt) AS first FROM agents",
  );
  const tasks = await client.get<{ completed: number | null; failed: number | null }>(
    `SELECT SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed
       FROM agent_tasks WHERE status IN ('completed', 'failed')`,
  );
  const runs = await client.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM workflow_runs WHERE status = 'completed'",
  );
  return {
    first_seen_at: agents?.first ?? null,
    tasks_completed: tasks?.completed ?? 0,
    tasks_failed: tasks?.failed ?? 0,
    workflow_runs_completed: runs?.count ?? 0,
  };
}
