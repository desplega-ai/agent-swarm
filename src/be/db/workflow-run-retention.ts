import { getStorage } from "../storage";
import {
  sqliteWorkflowRunRetentionStatements,
  workflowRetentionCandidatesSql,
} from "../storage-root";
import { reclassifyTaskHumanFree } from "./tasks/human-free";
import { deleteOrphanedRunDefinitions } from "./workflow-run-definitions";
import { WORKFLOW_RUN_TREE_MAX_DEPTH } from "./workflow-runs";

/**
 * The candidate SELECT the retention batch runs (the statement text lives in
 * the SQLite storage package; this name stays for the query-plan test).
 * Params: ?1 the cutoff, ?2 the batch limit.
 */
export const WORKFLOW_RETENTION_CANDIDATES_SQL = workflowRetentionCandidatesSql(
  WORKFLOW_RUN_TREE_MAX_DEPTH,
);

/**
 * The backlog COUNT and the reference DELETE of the workflow-run policy, for
 * EXPLAIN tests. Execution must use deleteWorkflowRunRetentionBatch to unlink
 * dependents atomically.
 */
export function workflowRunRetentionStatements(cutoff: string) {
  return sqliteWorkflowRunRetentionStatements(cutoff, WORKFLOW_RUN_TREE_MAX_DEPTH);
}

/** One bounded run batch, with all associated mutations in the same write transaction. */
export async function deleteWorkflowRunRetentionBatch(
  cutoff: string,
  limit: number,
  deadlineAt: number,
): Promise<{ changes: number; executionMs: number }> {
  const storage = getStorage();
  const retention = storage.repos.retention;
  return await storage.transaction(
    async () => {
      // Start after BEGIN: lock queueing and BUSY backoff are not execution time.
      const started = performance.now();
      const runs = await retention.listWorkflowRunCandidates(
        cutoff,
        limit,
        WORKFLOW_RUN_TREE_MAX_DEPTH,
      );
      if (runs.length === 0) return { changes: 0, executionMs: performance.now() - started };
      // Unlinks the tasks, removes approval requests and wait states, then the
      // steps and the runs.
      const taskIds = await retention.deleteWorkflowRuns(runs.map((run) => run.id));
      // Reclassify one bounded task batch. Overflow is queued in this same
      // transaction and drained after commit, so a large task tree cannot
      // repeatedly exhaust the retention deadline and roll back its run.
      await reclassifyTaskHumanFree(taskIds);
      await deleteOrphanedRunDefinitions([
        ...new Set(runs.flatMap((run) => (run.definitionHash ? [run.definitionHash] : []))),
      ]);
      // workflow_idempotency_keys intentionally survives. Its original runId
      // response still replays, even though that run's detail now returns 404.
      return { changes: runs.length, executionMs: performance.now() - started };
    },
    { deadlineAt },
  );
}
