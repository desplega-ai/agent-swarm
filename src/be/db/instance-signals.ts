import { getStorage } from "../storage";
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
  const { repos } = getStorage();
  const firstSeenAt = await repos.agents.firstAgentCreatedAt();
  const tasks = await getDbClient().get<{ completed: number | null; failed: number | null }>(
    `SELECT SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed
       FROM agent_tasks WHERE status IN ('completed', 'failed')`,
  );
  const runsCompleted = await repos.workflows.countCompletedRunsAll();
  return {
    first_seen_at: firstSeenAt,
    tasks_completed: tasks?.completed ?? 0,
    tasks_failed: tasks?.failed ?? 0,
    workflow_runs_completed: runsCompleted,
  };
}
