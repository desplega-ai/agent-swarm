import { getDbClient } from "../runtime";

/**
 * Structurally-human-free tasks: the swarm maintaining itself, with no human
 * requester by construction. Heartbeat and boot-triage tasks, scheduled runs
 * without a human creator (including workflow roots launched by such a
 * schedule), and `source='system'` follow-ups whose parent itself has no human
 * requester. The classification propagates to a child while the child stays
 * unattributed (no requester, or one copied from the parent), so autonomous
 * fan-out cannot leak back into the human denominator. An explicitly attributed
 * child is an independent handoff and stops propagation down that branch.
 *
 * The result is stored on `agent_tasks.isHumanFree` when the task is created
 * (migration 182 backfilled history), so the usage reports read a column
 * instead of rebuilding a recursive CTE over every task per query.
 *
 * The stored flag must equal what the rule selects over the CURRENT rows, so a
 * code path that rewrites a classifying input has to call
 * `reclassifyTaskHumanFree` in the same transaction. The inputs are
 * `agent_tasks.{taskType,tags,source,requestedByUserId,requestedByUserIdInherited,parentTaskId,workflowRunId}`,
 * `workflow_runs.{triggerType,created_by}`, and the existence of the parent and
 * run rows. Today these mutate in four places: `deleteUser` (requester and
 * workflow creator cleared), `deleteWorkflow` (run link cleared, runs deleted),
 * `deleteTask` (a parent row disappears) and `completeTask` with `addTags`.
 */

/**
 * Non-propagated part of the classification, over the alias `task` (the row)
 * and `parent` (a LEFT JOIN of `agent_tasks` on `task.parentTaskId`).
 */
const HUMAN_FREE_BASE_SQL = `(
        COALESCE(task.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
        OR COALESCE(task.tags, '[]') LIKE '%"heartbeat"%'
        OR (COALESCE(task.source, '') = 'schedule' AND task.requestedByUserId IS NULL)
        OR (
          task.parentTaskId IS NULL
          AND COALESCE(task.source, '') = 'workflow'
          AND task.requestedByUserId IS NULL
          AND EXISTS (
            SELECT 1
            FROM workflow_runs run
            WHERE run.id = task.workflowRunId
              AND run.triggerType = 'schedule'
              AND run.created_by IS NULL
          )
        )
        OR (
          COALESCE(task.source, '') = 'system'
          AND parent.id IS NOT NULL
          AND parent.requestedByUserId IS NULL
        )
      )`;

/**
 * The classification as a 0/1 expression over the aliases `task` (the row) and
 * `parent` (see above). `parentFlag` is the SQL expression for the parent's
 * already-decided flag: the stored column for a task classified on its own, the
 * freshly computed value while reclassifying a tree top-down.
 */
function humanFreeCase(parentFlag: string): string {
  return `CASE
        WHEN ${HUMAN_FREE_BASE_SQL} THEN 1
        WHEN ${parentFlag} = 1
          AND (task.requestedByUserId IS NULL OR task.requestedByUserIdInherited = 1) THEN 1
        ELSE 0
      END`;
}

export interface HumanFreeInput {
  taskType?: string | null;
  /** The JSON-encoded `tags` column value. */
  tags?: string | null;
  source?: string | null;
  requestedByUserId?: string | null;
  requestedByUserIdInherited?: boolean;
  parentTaskId?: string | null;
  workflowRunId?: string | null;
}

/**
 * Classify a task about to be inserted. Runs the same SQL predicate the
 * migration 182 backfill used, so a task classified here and one classified by
 * the backfill can never disagree. The parent must already be stored.
 */
export async function classifyTaskHumanFree(input: HumanFreeInput): Promise<boolean> {
  const row = await getDbClient().get<{ humanFree: number }>(
    `WITH task(taskType, tags, source, requestedByUserId, requestedByUserIdInherited, parentTaskId, workflowRunId) AS (
        VALUES (?, ?, ?, ?, ?, ?, ?)
      )
      SELECT ${humanFreeCase("parent.isHumanFree")} AS humanFree
      FROM task
      LEFT JOIN agent_tasks parent ON parent.id = task.parentTaskId`,
    [
      input.taskType ?? null,
      input.tags ?? null,
      input.source ?? null,
      input.requestedByUserId ?? null,
      input.requestedByUserIdInherited ? 1 : 0,
      input.parentTaskId ?? null,
      input.workflowRunId ?? null,
    ],
  );
  return row?.humanFree === 1;
}

/**
 * Recompute the stored flag for `seedTaskIds` and every descendant, after a
 * mutation changed a classifying input. Call it inside the mutating
 * transaction, once the new state is written, with ids gathered BEFORE the
 * write when the write erases what identifies them (a cleared requester).
 *
 * The tree is walked top-down so each task reads its parent's new flag. Seeds
 * can be descendants of other seeds (a root and its inherited child both
 * lose the same requester), which yields two candidate rows for one task: the
 * seed row read a parent flag that may be stale, the walked row read the fresh
 * one. The row at the greatest depth came through the topmost seed, so it wins.
 * Returns how many stored flags changed.
 */
export async function reclassifyTaskHumanFree(seedTaskIds: readonly string[]): Promise<number> {
  if (seedTaskIds.length === 0) return 0;
  const result = await getDbClient().run(
    `WITH RECURSIVE reclassified(id, humanFree, depth) AS (
        SELECT task.id, ${humanFreeCase("parent.isHumanFree")}, 0
        FROM agent_tasks task
        LEFT JOIN agent_tasks parent ON parent.id = task.parentTaskId
        WHERE task.id IN (SELECT value FROM json_each(?))

        UNION

        SELECT task.id, ${humanFreeCase("reclassified.humanFree")}, reclassified.depth + 1
        FROM reclassified
        JOIN agent_tasks task ON task.parentTaskId = reclassified.id
        LEFT JOIN agent_tasks parent ON parent.id = task.parentTaskId
        WHERE reclassified.depth < 1000
      )
      UPDATE agent_tasks
      SET isHumanFree = decided.humanFree
      FROM (
        SELECT id, humanFree, MAX(depth) AS depth
        FROM reclassified
        GROUP BY id
      ) AS decided
      WHERE agent_tasks.id = decided.id
        AND agent_tasks.isHumanFree != decided.humanFree`,
    [JSON.stringify(seedTaskIds)],
  );
  return result.changes;
}
