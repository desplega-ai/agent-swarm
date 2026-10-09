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

/** Waiting `sub-workflow` steps whose child run is already terminal. */
export async function getSettledChildRunParentSteps(): Promise<string[]> {
  const rows = await getDbClient().query<{ parentStepId: string }>(
    `SELECT c.parentStepId
       FROM workflow_runs c
       JOIN workflow_run_steps s ON s.id = c.parentStepId AND s.status = 'waiting'
      WHERE c.status IN ('completed', 'failed', 'cancelled', 'skipped')`,
  );
  return rows.map((row) => row.parentStepId);
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
  if (!TERMINAL_STATUSES.has(status)) return;
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
