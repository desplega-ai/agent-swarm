import { getDbClient } from "../db";

/**
 * True when the tree sweep has render work for `tree` (aliases `tree` and
 * `state` must be in scope). Shared by the sweep (getSlackTreeMessages) and by
 * closeSlackTreeIfSettled, so a closed tree is exactly one the sweep would
 * skip. Migration 278 backfills closed_at with the same predicate; keep the
 * two in step.
 */
export const SLACK_TREE_NEEDS_RENDER_SQL = `(
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
       )`;

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
       AND tree.ts NOT LIKE 'pending:%'
       AND EXISTS (
         SELECT 1 FROM slack_render_v2_state state
         WHERE state.id = 1 AND NOT ${SLACK_TREE_NEEDS_RENDER_SQL}
       )`,
    [new Date().toISOString(), id],
  );
  return result.changes > 0;
}
