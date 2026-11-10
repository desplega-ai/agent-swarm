import { getDbClient } from "../db";

/**
 * True when the tree sweep has render work for `tree` (aliases `tree` and
 * `state` must be in scope). Shared by the sweep (getSlackTreeMessages) and by
 * closeSlackTreeIfSettled, so a closed tree is exactly one the sweep would
 * skip. Visibility is independent of outcome delivery; migration 278 remains
 * the historical backfill and must not be modified.
 */
export const SLACK_TREE_VISIBLE_SQL = `(COALESCE(state.task_tree_enabled, 1) = 1 AND (
  state.task_tree_enabled_at IS NULL OR EXISTS (
    SELECT 1 FROM agent_tasks visible_task
    WHERE visible_task.slackChannelId = tree.channel_id
      AND visible_task.slackThreadTs = tree.thread_ts
      AND (visible_task.status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped')
        OR visible_task.finishedAt > state.task_tree_enabled_at)
  )
))`;

export const SLACK_TREE_NEEDS_RENDER_SQL = `(${SLACK_TREE_VISIBLE_SQL} AND (
         (tree.ts LIKE 'pending:%' AND tree.created_at >= state.activated_at)
         OR EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task.slackChannelId = tree.channel_id
           AND task.slackThreadTs = tree.thread_ts
           AND task.source = 'slack'
           AND task.createdAt >= state.activated_at
           AND task.status IN ('completed', 'failed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM slack_messages outcome
             WHERE outcome.kind = 'outcome'
             AND outcome.task_id = task.id
             AND (outcome.finalized_at IS NOT NULL OR outcome.delivery_abandoned_at IS NOT NULL)
           )
         )
         OR
         EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task.slackChannelId = tree.channel_id
           AND task.slackThreadTs = tree.thread_ts
           AND task.createdAt >= state.activated_at
           AND task.status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped')
         )
         OR EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task.slackChannelId = tree.channel_id
           AND task.slackThreadTs = tree.thread_ts
           AND task.createdAt >= state.activated_at
           AND task.lastUpdatedAt > tree.updated_at
         )
         OR EXISTS (
           SELECT 1 FROM slack_messages outcome
           JOIN agent_tasks task ON task.id = outcome.task_id
           WHERE outcome.kind = 'outcome'
           AND outcome.channel_id = tree.channel_id
           AND outcome.thread_ts = tree.thread_ts
           AND task.createdAt >= state.activated_at
           AND (
             (outcome.finalized_at IS NULL AND outcome.delivery_abandoned_at IS NULL)
             OR outcome.updated_at > tree.updated_at
           )
         )
       ))`;

/**
 * Close a tree once the sweep has nothing left to do for it: every task in
 * the thread is terminal, every outcome card is finalized or abandoned, and no
 * task or card changed after the tree. One statement, so a write that lands
 * before it is seen by the predicate; a write after it reopens the tree
 * through migration 278's triggers. Returns true when the tree was closed.
 */
export async function closeSlackTreeIfSettled(id: string): Promise<boolean> {
  const result = await getDbClient().run(
    `UPDATE slack_messages AS tree SET closed_at = ?
       WHERE tree.id = ?
       AND tree.kind = 'tree'
       AND tree.closed_at IS NULL
       AND (tree.ts NOT LIKE 'pending:%' OR EXISTS (
         SELECT 1 FROM slack_render_v2_state state WHERE state.id = 1 AND NOT ${SLACK_TREE_VISIBLE_SQL}
       ))
       AND EXISTS (
         SELECT 1 FROM slack_render_v2_state state
         WHERE state.id = 1 AND NOT ${SLACK_TREE_NEEDS_RENDER_SQL}
       )`,
    [new Date().toISOString(), id],
  );
  return result.changes > 0;
}

const THREAD_LOOKUP_CHUNK = 500;

/**
 * The Slack threads the given tasks belong to, for the event-driven render.
 * `wakeTouched` is true when any of them is a deferral wake-up, whose
 * settling can resolve a ⏳ card in another thread.
 */
export async function getSlackThreadsOfTasks(taskIds: string[]): Promise<{
  threads: { channelId: string; threadTs: string }[];
  wakeTouched: boolean;
}> {
  const threads = new Map<string, { channelId: string; threadTs: string }>();
  let wakeTouched = false;
  for (let i = 0; i < taskIds.length; i += THREAD_LOOKUP_CHUNK) {
    const chunk = taskIds.slice(i, i + THREAD_LOOKUP_CHUNK);
    const rows = await getDbClient().query<{
      slackChannelId: string | null;
      slackThreadTs: string | null;
      taskType: string | null;
    }>(
      `SELECT slackChannelId, slackThreadTs, taskType FROM agent_tasks
         WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const row of rows) {
      if (row.taskType === "deferred") wakeTouched = true;
      if (!row.slackChannelId || !row.slackThreadTs) continue;
      threads.set(`${row.slackChannelId}\u0000${row.slackThreadTs}`, {
        channelId: row.slackChannelId,
        threadTs: row.slackThreadTs,
      });
    }
  }
  return { threads: [...threads.values()], wakeTouched };
}

/**
 * True while the thread still owes an outcome card: a terminal Slack task
 * whose card is not finalized or abandoned, or a card still in flight. These
 * wait on time (conclusion settle, delivery backoff), not on a task event.
 */
export async function slackThreadHasOutcomeWork(thread: {
  channelId: string;
  threadTs: string;
}): Promise<boolean> {
  const row = await getDbClient().get<{ pending: number }>(
    `SELECT EXISTS (
         SELECT 1 FROM agent_tasks task, slack_render_v2_state state
         WHERE state.id = 1
         AND task.slackChannelId = ? AND task.slackThreadTs = ?
         AND task.source = 'slack'
         AND task.createdAt >= state.activated_at
         AND task.status IN ('completed', 'failed', 'cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM slack_messages outcome
           WHERE outcome.kind = 'outcome'
           AND outcome.task_id = task.id
           AND (outcome.finalized_at IS NOT NULL OR outcome.delivery_abandoned_at IS NOT NULL)
         )
       ) OR EXISTS (
         SELECT 1 FROM slack_messages outcome
         WHERE outcome.kind = 'outcome'
         AND outcome.channel_id = ? AND outcome.thread_ts = ?
         AND outcome.finalized_at IS NULL AND outcome.delivery_abandoned_at IS NULL
       ) AS pending`,
    [thread.channelId, thread.threadTs, thread.channelId, thread.threadTs],
  );
  return !!row?.pending;
}

export type SlackRenderThread = { channelId: string; threadTs: string };

/** Persist only actual visibility transitions. Never reset the V2 activation boundary. */
export async function observeSlackTreeVisibility(enabled: boolean): Promise<string | null> {
  const current = await getDbClient().get<{
    task_tree_enabled: number | null;
    task_tree_enabled_at: string | null;
  }>("SELECT task_tree_enabled, task_tree_enabled_at FROM slack_render_v2_state WHERE id = 1");
  if (!current || current.task_tree_enabled === Number(enabled)) {
    return current?.task_tree_enabled_at ?? null;
  }
  const row = await getDbClient().get<{ task_tree_enabled_at: string | null }>(
    `UPDATE slack_render_v2_state SET
       task_tree_enabled_at = CASE WHEN task_tree_enabled = 0 AND ? = 1
         THEN ? ELSE task_tree_enabled_at END,
       task_tree_enabled = ?
     WHERE id = 1 RETURNING task_tree_enabled_at`,
    [Number(enabled), new Date().toISOString(), Number(enabled)],
  );
  return row?.task_tree_enabled_at ?? null;
}

/** Four independent pages reserve capacity for outcomes even when active work never drains. */
export const SLACK_RECONCILE_PAGE_SIZE = 50;

/**
 * Page raw candidates BEFORE checking eligibility. This bounds index visits even
 * when most terminal rows already have outcomes. Persist the last scanned id,
 * not the last eligible id, so sparse history cannot stall recovery. Each source
 * wraps independently; a crash can delay a page until the next lap, never lose it.
 */
export async function getSlackProcessingThreads(
  delegationEnabled: boolean,
  treesEnabled = false,
): Promise<SlackRenderThread[]> {
  return getDbClient().transaction(async () => {
    const state = await getDbClient().get<{ reconcile_cursors: string }>(
      "SELECT reconcile_cursors FROM slack_render_v2_state WHERE id = 1",
    );
    if (!state) return [];
    const cursors = JSON.parse(state.reconcile_cursors) as Record<string, string>;
    const threads = new Map<string, SlackRenderThread>();
    async function page(source: string, sql: string, extra: (number | string)[] = []) {
      const rows = await getDbClient().query<SlackRenderThread & { id: string; eligible: number }>(
        sql,
        [cursors[source] ?? "", SLACK_RECONCILE_PAGE_SIZE, ...extra],
      );
      cursors[source] = rows.length < SLACK_RECONCILE_PAGE_SIZE ? "" : rows.at(-1)!.id;
      for (const row of rows) {
        if (row.eligible)
          threads.set(`${row.channelId}\u0000${row.threadTs}`, {
            channelId: row.channelId,
            threadTs: row.threadTs,
          });
      }
    }
    await page(
      "active",
      `WITH candidates AS MATERIALIZED (
      SELECT id, slackChannelId, slackThreadTs, createdAt FROM agent_tasks INDEXED BY idx_slack_reconcile_active
      WHERE slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL
        AND status IN ('offered', 'reviewing', 'pending', 'in_progress', 'paused')
        AND id > ? ORDER BY id LIMIT ?
    ) SELECT task.id, task.slackChannelId AS channelId, task.slackThreadTs AS threadTs,
      task.createdAt >= state.activated_at AS eligible
      FROM candidates task, slack_render_v2_state state WHERE state.id = 1 ORDER BY task.id`,
    );
    await page(
      "terminal",
      `WITH candidates AS MATERIALIZED (
      SELECT * FROM agent_tasks INDEXED BY idx_slack_reconcile_terminal
      WHERE slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL
        AND status IN ('completed', 'failed', 'cancelled')
        AND id > ? ORDER BY id LIMIT ?
    ) SELECT task.id, task.slackChannelId AS channelId, task.slackThreadTs AS threadTs,
      (task.createdAt >= state.activated_at
       AND (task.source = 'slack'
         OR (task.source = 'schedule' AND task.taskType = 'deferred')
         OR (? = 1 AND task.parentTaskId IS NOT NULL AND task.createdAt >= state.delegation_activated_at
           AND task.status IN ('completed', 'failed') AND task.slackReplySent = 0
           AND COALESCE(task.taskType, '') NOT IN ('follow-up', 'reroute-decision')))
       AND NOT EXISTS (
         SELECT 1 FROM agent_tasks parent JOIN slack_messages parent_card ON parent_card.task_id = parent.id
         WHERE task.source = 'schedule' AND task.taskType = 'deferred' AND parent.id = task.parentTaskId
           AND parent.deferredAt IS NOT NULL AND parent_card.kind = 'outcome'
           AND parent_card.finalized_at IS NOT NULL AND parent_card.deferral_abandoned_at IS NULL
       )
       AND NOT EXISTS (SELECT 1 FROM slack_messages card WHERE card.kind = 'outcome'
         AND card.task_id = task.id
         AND (card.finalized_at IS NOT NULL OR card.delivery_abandoned_at IS NOT NULL))) AS eligible
      FROM candidates task, slack_render_v2_state state WHERE state.id = 1 ORDER BY task.id`,
      [Number(delegationEnabled)],
    );
    await page(
      "outcome",
      `SELECT id, channel_id AS channelId, thread_ts AS threadTs, 1 AS eligible
      FROM slack_messages INDEXED BY idx_slack_reconcile_outcome
      WHERE kind = 'outcome' AND finalized_at IS NULL AND delivery_abandoned_at IS NULL
        AND id > ? ORDER BY id LIMIT ?`,
    );
    if (treesEnabled)
      await page(
        "tree",
        `WITH candidates AS MATERIALIZED (
      SELECT * FROM slack_messages INDEXED BY idx_slack_reconcile_tree
      WHERE kind = 'tree' AND closed_at IS NULL AND id > ? ORDER BY id LIMIT ?
    ) SELECT tree.id, tree.channel_id AS channelId, tree.thread_ts AS threadTs,
      ${SLACK_TREE_NEEDS_RENDER_SQL} AS eligible
      FROM candidates tree, slack_render_v2_state state WHERE state.id = 1 ORDER BY tree.id`,
      );
    const next = JSON.stringify(cursors);
    if (next !== state.reconcile_cursors)
      await getDbClient().run(
        "UPDATE slack_render_v2_state SET reconcile_cursors = ? WHERE id = 1",
        [next],
      );
    return [...threads.values()];
  });
}
