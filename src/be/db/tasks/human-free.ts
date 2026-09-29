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
 * (migration 176 backfilled history), so the usage reports read a column
 * instead of rebuilding a recursive CTE over every task per query.
 *
 * Every classifying input (`taskType`, `tags`, `source`, `requestedByUserId`,
 * `requestedByUserIdInherited`, `parentTaskId`, `workflowRunId`) is fixed at
 * insert. Adding a code path that rewrites one of them must re-run
 * `classifyTaskHumanFree` for that task and its descendants.
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
 * migration 176 backfill used, so a task classified here and one classified by
 * the backfill can never disagree. The parent must already be stored.
 */
export async function classifyTaskHumanFree(input: HumanFreeInput): Promise<boolean> {
  const row = await getDbClient().get<{ humanFree: number }>(
    `WITH task(taskType, tags, source, requestedByUserId, requestedByUserIdInherited, parentTaskId, workflowRunId) AS (
        VALUES (?, ?, ?, ?, ?, ?, ?)
      )
      SELECT CASE
        WHEN ${HUMAN_FREE_BASE_SQL} THEN 1
        WHEN parent.isHumanFree = 1
          AND (task.requestedByUserId IS NULL OR task.requestedByUserIdInherited = 1) THEN 1
        ELSE 0
      END AS humanFree
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
