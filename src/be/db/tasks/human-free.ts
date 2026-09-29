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
 *
 * Reclassification is bounded per request, because its cost follows the size of
 * a task tree that a caller shapes: one batch runs inline and the rest of a
 * large tree waits in `human_free_reclassify_queue` for a background drain
 * (`src/be/human-free-drain.ts`). The invariant above holds once the queue is
 * empty.
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
 * How many tasks one reclassification batch may touch. A request that changes a
 * classifying input does at most this much work inline; whatever is left of the
 * subtree is queued and drained in batches of the same size.
 */
export const HUMAN_FREE_RECLASSIFY_BATCH = 500;

/**
 * How many batches deep a queued continuation may go. A legitimate chain needs
 * depth / batch size of them, so this is far past any real tree. It only stops
 * a parent cycle longer than one batch (which nothing in the product writes)
 * from re-queuing itself for ever.
 */
export const HUMAN_FREE_MAX_CONTINUATION_HOPS = 10_000;

export interface ReclassifyOptions {
  /** Tasks per batch. Defaults to `HUMAN_FREE_RECLASSIFY_BATCH`. */
  batchSize?: number;
}

let queueListener: (() => void) | undefined;

/**
 * The background drain registers here to hear about new queue rows, so it wakes
 * on demand instead of polling. Pass `undefined` to detach.
 */
export function setHumanFreeQueueListener(listener: (() => void) | undefined): void {
  queueListener = listener;
}

async function enqueueHumanFreeWork(
  taskIds: readonly string[],
  scope: "self" | "children",
  hops: number,
): Promise<void> {
  if (taskIds.length === 0) return;
  if (hops > HUMAN_FREE_MAX_CONTINUATION_HOPS) {
    console.error(
      `[human-free] dropping ${taskIds.length} ${scope} continuation(s) past ${HUMAN_FREE_MAX_CONTINUATION_HOPS} hops; the task graph likely has a parent cycle`,
    );
    return;
  }
  // `WHERE true` keeps the parser from reading ON CONFLICT as a join clause.
  // A repeat enqueue restarts the row: its subtree was reclassified again, so
  // the pages already walked are stale.
  await getDbClient().run(
    `INSERT INTO human_free_reclassify_queue (taskId, scope, afterRowid, hops)
       SELECT value, ?, 0, ? FROM json_each(?) WHERE true
       ON CONFLICT (taskId, scope) DO UPDATE SET
         afterRowid = 0,
         hops = MAX(hops, excluded.hops)`,
    [scope, hops, JSON.stringify(taskIds)],
  );
  // afterCommit: a rolled-back mutation queues nothing, so it must not wake the drain.
  getDbClient().afterCommit(() => queueListener?.());
}

/**
 * Reclassify `seedTaskIds` and their descendants, breadth first, until
 * `batchSize` tasks are covered, and queue the rest. `seedTaskIds` must not be
 * longer than `batchSize`.
 *
 * The rule is a reachability query: a task is free when it classifies on its
 * own, or when it is unattributed and its parent is free. So the new flags come
 * from a fixpoint over the batch, with no walk order to get wrong: `affected` is
 * the batch, and `free` starts from the affected tasks that are free on their
 * own or hang off an unaffected free parent (its stored flag is current) and
 * spreads to unattributed children inside the batch. A parent inside `affected`
 * is never read from the column, since that value may be exactly what is being
 * fixed.
 *
 * The batch is a prefix of a breadth-first walk, so every parent of an affected
 * task is affected too, except at the seeds. What a batch leaves behind are the
 * children of its tasks that it did not reach. Those are queued as `children`
 * rows keyed by the parent, so a very wide parent costs one row, not one per
 * child.
 */
async function reclassifyBatch(
  seedTaskIds: readonly string[],
  batchSize: number,
  hops: number,
): Promise<number> {
  const client = getDbClient();

  // The recursive walk over task ids alone, like the rule itself, so it still
  // terminates on a parent cycle. LIMIT stops the recursion once the batch is full.
  const affected = (
    await client.query<{ id: string }>(
      `WITH RECURSIVE affected(id) AS (
          SELECT value FROM json_each(?)

          UNION

          SELECT task.id
          FROM affected
          JOIN agent_tasks task ON task.parentTaskId = affected.id
          LIMIT ?
        )
        SELECT id FROM affected`,
      [JSON.stringify(seedTaskIds), batchSize],
    )
  ).map((row) => row.id);

  // The "WITH RECURSIVE affected" prefix is what the tests count subtree
  // recomputations by. The unary plus in the recursive step keeps the planner
  // from probing `task` by id once per batch member for every free row (a
  // quadratic scan of the batch, ~100ms at 500 tasks); it walks the
  // `parentTaskId` index instead, and the IN only filters what that finds.
  const result = await client.run(
    `WITH RECURSIVE affected(id) AS (
        SELECT value FROM json_each(?)
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
        WHERE +task.id IN (SELECT id FROM affected)
          AND ${UNATTRIBUTED_SQL}
      )
      UPDATE agent_tasks
      SET isHumanFree = CASE WHEN id IN (SELECT id FROM free) THEN 1 ELSE 0 END
      WHERE id IN (SELECT id FROM affected)
        AND isHumanFree != CASE WHEN id IN (SELECT id FROM free) THEN 1 ELSE 0 END`,
    [JSON.stringify(affected)],
  );

  // A short batch means the walk ran out of tree. A full one may have stopped
  // early, so find the affected tasks with a child outside the batch. EXISTS
  // stops at the first such child, so the cost tracks the batch, not the fan-out.
  if (affected.length >= batchSize) {
    const unfinished = await client.query<{ id: string }>(
      `WITH batch(id) AS (
          SELECT value FROM json_each(?)
        )
        SELECT batch.id
        FROM batch
        WHERE EXISTS (
          SELECT 1
          FROM agent_tasks child
          WHERE child.parentTaskId = batch.id
            AND child.id NOT IN (SELECT id FROM batch)
        )`,
      [JSON.stringify(affected)],
    );
    await enqueueHumanFreeWork(
      unfinished.map((row) => row.id),
      "children",
      hops,
    );
  }
  return result.changes;
}

/**
 * Recompute the stored flag for `seedTaskIds` and every descendant, after a
 * mutation changed a classifying input. Call it inside the mutating
 * transaction, once the new state is written, with ids gathered BEFORE the
 * write when the write erases what identifies them (a cleared requester).
 *
 * The work per call is bounded. One batch of `HUMAN_FREE_RECLASSIFY_BATCH`
 * tasks runs inline; a subtree or seed list larger than that leaves the rest in
 * `human_free_reclassify_queue`, written in the same transaction, for
 * `drainHumanFreeReclassifyQueue` to finish. Until it does, the stored flags of
 * the queued descendants are the pre-mutation ones, so the usage reports can
 * lag for a very large tree. They converge to what the rule selects over the
 * current rows once the queue is empty.
 *
 * Returns how many stored flags this call's inline batch changed.
 */
export async function reclassifyTaskHumanFree(
  seedTaskIds: readonly string[],
  options: ReclassifyOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? HUMAN_FREE_RECLASSIFY_BATCH;
  const seeds = [...new Set(seedTaskIds)];
  if (seeds.length === 0) return 0;
  await enqueueHumanFreeWork(seeds.slice(batchSize), "self", 1);
  return await reclassifyBatch(seeds.slice(0, batchSize), batchSize, 1);
}

interface QueueRow {
  seq: number;
  taskId: string;
  scope: "self" | "children";
  afterRowid: number;
  hops: number;
}

/** One batch of queued work, in its own transaction. Null when the queue is empty. */
async function drainOneBatch(batchSize: number): Promise<number | null> {
  return await getDbClient().transaction(async (tx) => {
    const head = await tx.get<QueueRow>(
      "SELECT * FROM human_free_reclassify_queue ORDER BY seq LIMIT 1",
    );
    if (!head) return null;

    if (head.scope === "self") {
      const rows = await tx.query<QueueRow>(
        "SELECT * FROM human_free_reclassify_queue WHERE scope = 'self' ORDER BY seq LIMIT ?",
        [batchSize],
      );
      const seeds = rows.map((row) => row.taskId);
      const hops = Math.max(...rows.map((row) => row.hops)) + 1;
      await tx.run(
        "DELETE FROM human_free_reclassify_queue WHERE seq IN (SELECT value FROM json_each(?))",
        [JSON.stringify(rows.map((row) => row.seq))],
      );
      return await reclassifyBatch(seeds, batchSize, hops);
    }

    // Children are paged by rowid: the parentTaskId index is ordered by it, so
    // each page is an index range scan however wide the parent is.
    const page = await tx.query<{ id: string; position: number }>(
      `SELECT id, rowid AS position
       FROM agent_tasks
       WHERE parentTaskId = ? AND rowid > ?
       ORDER BY rowid
       LIMIT ?`,
      [head.taskId, head.afterRowid, batchSize],
    );
    // Move the cursor before reclassifying: the batch may queue this very row
    // again (a parent cycle), and that restart must win.
    if (page.length < batchSize) {
      await tx.run("DELETE FROM human_free_reclassify_queue WHERE seq = ?", [head.seq]);
    } else {
      await tx.run("UPDATE human_free_reclassify_queue SET afterRowid = ? WHERE seq = ?", [
        page[page.length - 1]?.position ?? head.afterRowid,
        head.seq,
      ]);
    }
    if (page.length === 0) return 0;
    return await reclassifyBatch(
      page.map((row) => row.id),
      batchSize,
      head.hops + 1,
    );
  });
}

export interface DrainResult {
  /** Batches run. */
  batches: number;
  /** Stored flags changed across those batches. */
  changed: number;
  /** Queue rows left. */
  remaining: number;
}

export async function pendingHumanFreeReclassifications(): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM human_free_reclassify_queue",
  );
  return row?.count ?? 0;
}

/**
 * Work the reclassification queue: up to `maxBatches` batches (default: until
 * the queue is empty), each in its own transaction so the write lock is held
 * for one bounded batch at a time. Anything a batch leaves behind goes back on
 * the queue, so the queue empties only once every task matches the rule.
 */
export async function drainHumanFreeReclassifyQueue(
  options: ReclassifyOptions & { maxBatches?: number } = {},
): Promise<DrainResult> {
  const batchSize = options.batchSize ?? HUMAN_FREE_RECLASSIFY_BATCH;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  let batches = 0;
  let changed = 0;
  while (batches < maxBatches) {
    const batchChanged = await drainOneBatch(batchSize);
    if (batchChanged === null) break;
    batches += 1;
    changed += batchChanged;
  }
  return { batches, changed, remaining: await pendingHumanFreeReclassifications() };
}
