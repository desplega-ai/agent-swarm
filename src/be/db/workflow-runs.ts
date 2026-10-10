import type { WorkflowRunStatus } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient } from "./runtime";

// Parent/child links between workflow runs (migration 203): a `sub-workflow`
// step starts a child run that records the step in `parentStepId`.

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

/** The id of the child run a `sub-workflow` step started, if any. */
export async function getChildWorkflowRunId(parentStepId: string): Promise<string | null> {
  const row = await getDbClient().get<{ id: string }>(
    "SELECT id FROM workflow_runs WHERE parentStepId = ?",
    [parentStepId],
  );
  return row?.id ?? null;
}

/**
 * Workflow ids of a run and the ancestor runs that started it, nearest first.
 * Stops `maxDepth` ancestors up, so it returns at most `maxDepth + 1` ids.
 */
export async function getWorkflowRunLineage(runId: string, maxDepth: number): Promise<string[]> {
  const rows = await getDbClient().query<{ workflowId: string }>(
    `WITH RECURSIVE lineage(id, workflowId, parentStepId, depth) AS (
       SELECT id, workflowId, parentStepId, 0 FROM workflow_runs WHERE id = ?
       UNION ALL
       SELECT r.id, r.workflowId, r.parentStepId, l.depth + 1
         FROM lineage l
         JOIN workflow_run_steps s ON s.id = l.parentStepId
         JOIN workflow_runs r ON r.id = s.runId
        WHERE l.depth < ?
     )
     SELECT workflowId FROM lineage ORDER BY depth`,
    [runId, maxDepth],
  );
  return rows.map((row) => row.workflowId);
}

/** Waiting `sub-workflow` steps whose child run is terminal or deleted. */
export async function getSettledChildRunParentSteps(): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string }>(
    `SELECT s.id
       FROM workflow_run_steps s
       LEFT JOIN workflow_runs c ON c.parentStepId = s.id
      WHERE s.status = 'waiting' AND s.nodeType = 'sub-workflow'
        AND (c.id IS NULL OR c.status IN ('completed', 'failed', 'cancelled', 'skipped'))`,
  );
  return rows.map((row) => row.id);
}

/**
 * Before a workflow's runs are deleted, queue a wake-up for every step that
 * started one of them as a child, so the step fails instead of waiting forever.
 */
export async function wakeParentsOfDeletedRuns(workflowId: string): Promise<void> {
  const rows = await getDbClient().query<{ id: string; parentStepId: string }>(
    "SELECT id, parentStepId FROM workflow_runs WHERE workflowId = ? AND parentStepId IS NOT NULL",
    [workflowId],
  );
  for (const row of rows) emitAfterCommit(row.id, row.parentStepId);
}

/**
 * Wake the waiting `sub-workflow` step once its child run is terminal. Emitted
 * after commit; a missed event is caught by the recovery sweep
 * (`getSettledChildRunParentSteps`).
 */
export function emitChildRunFinished(
  childRunId: string,
  parentStepId: string,
  status: WorkflowRunStatus,
): void {
  if (TERMINAL_STATUSES.has(status)) emitAfterCommit(childRunId, parentStepId);
}

function emitAfterCommit(childRunId: string, parentStepId: string): void {
  getDbClient().afterCommit(() => {
    import("../../workflows/event-bus")
      .then(({ workflowEventBus }) => {
        workflowEventBus.emit("workflow.child.finished", { childRunId, parentStepId });
      })
      .catch((err) =>
        console.error(
          "[db] workflow.child.finished event not emitted:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      );
  });
}
