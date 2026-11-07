import { getDbClient } from "./runtime";
import { reclassifyTaskHumanFreeAtomically } from "./tasks/human-free";
import { deleteOrphanedRunDefinitions } from "./workflow-run-definitions";
import { WORKFLOW_RUN_TREE_MAX_DEPTH } from "./workflow-runs";

const TERMINAL_SQL = "('completed', 'failed', 'skipped', 'cancelled')";

/**
 * Retire terminal trees from the root down. A surviving parent step always
 * keeps its child, including children from older attempts. Any live/recent
 * descendant protects the whole tree. Remaining expired children cannot retry
 * after their ancestor is removed (getRunLineageBlock fails closed).
 *
 * The depth guard rejects a truncated traversal, including corrupt cycles.
 * Both recursive joins use incoming-reference indexes; no payload is read.
 */
const ELIGIBLE_SQL = `r.status IN ${TERMINAL_SQL} AND r.finishedAt < ?1
  AND NOT EXISTS (SELECT 1 FROM workflow_run_steps parent WHERE parent.id = r.parentStepId)
  AND NOT EXISTS (
    WITH RECURSIVE descendants(id, status, finishedAt, depth) AS (
      SELECT r.id, r.status, r.finishedAt, 0
      UNION ALL
      SELECT child.id, child.status, child.finishedAt, descendants.depth + 1
      FROM descendants
      JOIN workflow_run_steps step ON step.runId = descendants.id
      JOIN workflow_runs child ON child.parentStepId = step.id
      WHERE descendants.depth < ${WORKFLOW_RUN_TREE_MAX_DEPTH}
    )
    SELECT 1 FROM descendants
    WHERE status NOT IN ${TERMINAL_SQL} OR finishedAt IS NULL OR finishedAt >= ?1
      OR depth = ${WORKFLOW_RUN_TREE_MAX_DEPTH}
  )`;

export const WORKFLOW_RETENTION_CANDIDATES_SQL = `SELECT r.id, r.definitionHash
  FROM workflow_runs r WHERE ${ELIGIBLE_SQL} ORDER BY r.finishedAt, r.id LIMIT ?2`;

export function workflowRunRetentionStatements(cutoff: string) {
  return {
    backlogSql: `SELECT COUNT(*) AS n FROM workflow_runs r WHERE ${ELIGIBLE_SQL}`,
    // Exposed alongside the other policies for EXPLAIN tests. Execution must
    // use deleteWorkflowRunRetentionBatch to unlink dependents atomically.
    deleteSql: `DELETE FROM workflow_runs WHERE id IN (
      SELECT r.id FROM workflow_runs r WHERE ${ELIGIBLE_SQL}
      ORDER BY r.finishedAt, r.id LIMIT ?2
    )`,
    params: [cutoff],
  };
}

/** One bounded run batch, with all associated mutations in the same write transaction. */
export async function deleteWorkflowRunRetentionBatch(
  cutoff: string,
  limit: number,
  deadlineAt: number,
): Promise<{ changes: number; executionMs: number }> {
  const client = getDbClient();
  return await client.transaction(
    async (tx) => {
      // Start after BEGIN: lock queueing and BUSY backoff are not execution time.
      const started = performance.now();
      const runs = await tx.query<{ id: string; definitionHash: string | null }>(
        WORKFLOW_RETENTION_CANDIDATES_SQL,
        [cutoff, limit],
      );
      if (runs.length === 0) return { changes: 0, executionMs: performance.now() - started };
      const ids = JSON.stringify(runs.map((run) => run.id));
      const runIds = "SELECT value FROM json_each(?)";
      const stepIds = `SELECT id FROM workflow_run_steps WHERE runId IN (${runIds})`;
      const taskWhere = `workflowRunId IN (${runIds}) OR workflowRunStepId IN (${stepIds})`;
      const tasks = await tx.query<{ id: string }>(
        `SELECT id FROM agent_tasks WHERE ${taskWhere}`,
        [ids, ids],
      );
      await tx.run(
        `UPDATE agent_tasks SET workflowRunId = NULL, workflowRunStepId = NULL WHERE ${taskWhere}`,
        [ids, ids],
      );
      // These logical dependents have no ON DELETE action. Remove them before
      // their steps so pollers cannot keep trying to resume deleted history.
      for (const table of ["approval_requests", "wait_states"] as const) {
        await tx.run(
          `DELETE FROM ${table} WHERE workflowRunId IN (${runIds}) OR workflowRunStepId IN (${stepIds})`,
          [ids, ids],
        );
      }
      await tx.run(`DELETE FROM workflow_run_steps WHERE runId IN (${runIds})`, [ids]);
      await tx.run(`DELETE FROM workflow_runs WHERE id IN (${runIds})`, [ids]);
      await reclassifyTaskHumanFreeAtomically(
        tasks.map((task) => task.id),
        deadlineAt,
      );
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
