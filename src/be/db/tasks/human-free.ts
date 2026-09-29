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
 * `deleteTask` (a parent row disappears) and `completeTask` with `addTags`,
 * which only needs it when `tagWriteChangesHumanFree` says the tag write can
 * change the outcome.
 */

/**
 * The tags the classification reads. The SQL below is generated from this list
 * and `tagWriteChangesHumanFree` reads it too, so the guard on tag writes cannot
 * drift from the classifier. Keep each entry to plain word characters: the SQL
 * matches it with `LIKE`, where `%` and `_` are wildcards.
 */
export const HUMAN_FREE_TAGS = ["heartbeat"] as const;

const HUMAN_FREE_TAG_SQL = HUMAN_FREE_TAGS.map(
  (tag) => `COALESCE(task.tags, '[]') LIKE '%"${tag}"%'`,
).join("\n        OR ");

/**
 * Non-propagated part of the classification, over the alias `task` (the row)
 * and `parent` (a LEFT JOIN of `agent_tasks` on `task.parentTaskId`).
 */
const HUMAN_FREE_BASE_SQL = `(
        COALESCE(task.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
        OR ${HUMAN_FREE_TAG_SQL}
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
 * Whether a task stays unattributed, so the parent's classification propagates
 * to it: no requester, or one copied from the parent. Over the alias `task`.
 */
const UNATTRIBUTED_SQL = "(task.requestedByUserId IS NULL OR task.requestedByUserIdInherited = 1)";

/**
 * The classification as a 0/1 expression over the aliases `task` (the row) and
 * `parent` (see above). `parentFlag` is the SQL expression for the parent's
 * already-decided flag: the stored column for a task classified on its own, the
 * freshly computed value while reclassifying a tree top-down.
 */
function humanFreeCase(parentFlag: string): string {
  return `CASE
        WHEN ${HUMAN_FREE_BASE_SQL} THEN 1
        WHEN ${parentFlag} = 1 AND ${UNATTRIBUTED_SQL} THEN 1
        ELSE 0
      END`;
}

function carriesHumanFreeTag(tagsJson: string | null | undefined): boolean {
  // Mirror the SQL: `LIKE` matches the quoted tag inside the JSON text and is
  // ASCII case-insensitive. Lowercasing is at least as broad, so this can only
  // over-report a change, never miss one.
  const haystack = (tagsJson ?? "[]").toLowerCase();
  return HUMAN_FREE_TAGS.some((tag) => haystack.includes(`"${tag}"`));
}

/**
 * Whether rewriting a task's `tags` column from `previousTagsJson` to
 * `nextTagsJson` can change its classification. A tag write that adds or drops
 * no tag from `HUMAN_FREE_TAGS` (a `deferred` tag, say) cannot, so the caller
 * skips `reclassifyTaskHumanFree` and its walk over the task's whole subtree.
 */
export function tagWriteChangesHumanFree(
  previousTagsJson: string | null | undefined,
  nextTagsJson: string | null | undefined,
): boolean {
  return carriesHumanFreeTag(previousTagsJson) !== carriesHumanFreeTag(nextTagsJson);
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
 * The rule is a reachability query: a task is free when it classifies on its
 * own, or when it is unattributed and its parent is free. So the new flags come
 * from a fixpoint over the affected set, with no walk order to get wrong:
 * `affected` is the seeds plus all descendants, and `free` starts from the
 * affected tasks that are free on their own or hang off an unaffected free
 * parent (its stored flag is current) and spreads to unattributed children. A
 * parent inside `affected` is never read from the column, since that value may
 * be exactly what is being fixed.
 *
 * Both sets are recursive over task ids alone, like the rule itself, so they
 * cover a tree of any depth and still terminate on a parent cycle.
 * Returns how many stored flags changed.
 */
export async function reclassifyTaskHumanFree(seedTaskIds: readonly string[]): Promise<number> {
  if (seedTaskIds.length === 0) return 0;
  const result = await getDbClient().run(
    `WITH RECURSIVE affected(id) AS (
        SELECT value FROM json_each(?)

        UNION

        SELECT task.id
        FROM affected
        JOIN agent_tasks task ON task.parentTaskId = affected.id
      ),
      free(id) AS (
        SELECT task.id
        FROM agent_tasks task
        LEFT JOIN agent_tasks parent ON parent.id = task.parentTaskId
        WHERE task.id IN (SELECT id FROM affected)
          AND (
            ${HUMAN_FREE_BASE_SQL}
            OR (
              parent.isHumanFree = 1
              AND parent.id NOT IN (SELECT id FROM affected)
              AND ${UNATTRIBUTED_SQL}
            )
          )

        UNION

        SELECT task.id
        FROM free
        JOIN agent_tasks task ON task.parentTaskId = free.id
        WHERE ${UNATTRIBUTED_SQL}
      )
      UPDATE agent_tasks
      SET isHumanFree = CASE WHEN id IN (SELECT id FROM free) THEN 1 ELSE 0 END
      WHERE id IN (SELECT id FROM affected)
        AND isHumanFree != CASE WHEN id IN (SELECT id FROM free) THEN 1 ELSE 0 END`,
    [JSON.stringify(seedTaskIds)],
  );
  return result.changes;
}
