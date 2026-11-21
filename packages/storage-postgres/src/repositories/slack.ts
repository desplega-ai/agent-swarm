import type { TaskRow } from "@desplega/storage";
import {
  BaseSlackRepository,
  EMPTY,
  likeAsciiCi,
  type SlackInboundReceiptRow,
  type SlackMessageRow,
  type SlackOutcomeHostRow,
  type SlackOutcomeWindowParams,
  type SlackReconcileCandidate,
  type SlackReconcileSource,
  type SlackThreadRef,
  type SqlQuery,
  sql,
} from "@desplega/storage";

/**
 * True when the tree sweep has render work for `tree` (aliases `tree` and
 * `state` must be in scope). Shared by the sweep and by closeTreeIfSettled, so
 * a closed tree is exactly one the sweep would skip. Visibility is independent
 * of outcome delivery; migration 278 remains the historical backfill.
 */
const TREE_VISIBLE = sql`(COALESCE(state.task_tree_enabled, true) = true AND (
  state.task_tree_enabled_at IS NULL OR EXISTS (
    SELECT 1 FROM agent_tasks visible_task
    WHERE visible_task."slackChannelId" = tree.channel_id
      AND visible_task."slackThreadTs" = tree.thread_ts
      AND (visible_task.status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped')
        OR visible_task."finishedAt" > state.task_tree_enabled_at)
  )
))`;

/** SQLite's `tree.ts LIKE 'pending:%'` (LIKE folds ASCII case there). */
const PENDING_TS = likeAsciiCi(sql`tree.ts`, sql`'pending:%'`);

const TREE_NEEDS_RENDER = sql`(${TREE_VISIBLE} AND (
         (${PENDING_TS} AND tree.created_at >= state.activated_at)
         OR EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task."slackChannelId" = tree.channel_id
           AND task."slackThreadTs" = tree.thread_ts
           AND task.source = 'slack'
           AND task."createdAt" >= state.activated_at
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
           WHERE task."slackChannelId" = tree.channel_id
           AND task."slackThreadTs" = tree.thread_ts
           AND task."createdAt" >= state.activated_at
           AND task.status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped')
         )
         OR EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task."slackChannelId" = tree.channel_id
           AND task."slackThreadTs" = tree.thread_ts
           AND task."createdAt" >= state.activated_at
           AND task."lastUpdatedAt" > tree.updated_at
         )
         OR EXISTS (
           SELECT 1 FROM slack_messages outcome
           JOIN agent_tasks task ON task.id = outcome.task_id
           WHERE outcome.kind = 'outcome'
           AND outcome.channel_id = tree.channel_id
           AND outcome.thread_ts = tree.thread_ts
           AND task."createdAt" >= state.activated_at
           AND (
             (outcome.finalized_at IS NULL AND outcome.delivery_abandoned_at IS NULL)
             OR outcome.updated_at > tree.updated_at
           )
         )
       ))`;

/**
 * A Lead follow-up or resume task that may owe an outcome card. Needs alias
 * `task`. Over-selects on purpose: the renderer's isSlackLeadFollowUp also
 * checks the Slack ask ancestor and the channel.
 */
const LEAD_FOLLOW_UP = sql`(task.source = 'system'
  AND task."taskType" IN ('follow-up', 'resume') AND task."slackReplySent" = false
  AND task.status IN ('completed', 'failed', 'cancelled')
  AND EXISTS (SELECT 1 FROM agents lead WHERE lead.id = task."agentId" AND lead."isLead" = true))`;

/**
 * Needs aliases `task` and `state` in scope. Thread activity stands in for
 * closure activity (see SlackOutcomeWindow in src/be/db/slack-trees.ts).
 */
function outcomeWindow(window: SlackOutcomeWindowParams): SqlQuery {
  return sql`(COALESCE(task."finishedAt", task."lastUpdatedAt") >= ${window.finishedAfter}
  OR (${window.delegationEnabled} AND task.source = 'slack' AND task."createdAt" >= state.delegation_activated_at
    AND EXISTS (SELECT 1 FROM agent_tasks recent
      WHERE recent."slackChannelId" = task."slackChannelId" AND recent."slackThreadTs" = task."slackThreadTs"
        AND recent."lastUpdatedAt" >= ${window.closureActiveAfter})))`;
}

/**
 * A Lead deferred wake whose answer already reached the thread. Needs alias
 * `task`. Keep in step with threadHasBotReplySince.
 */
const WAKE_ALREADY_ANSWERED = sql`(task."slackReplySent" = true OR EXISTS (
  SELECT 1 FROM slack_messages reply
  WHERE reply.channel_id = task."slackChannelId" AND reply.thread_ts = task."slackThreadTs"
    AND reply.created_at >= task."createdAt"
    AND (reply.kind = 'agent'
      OR (reply.kind = 'outcome' AND reply.finalized_at IS NOT NULL AND reply.task_id != task.id))))`;

export class PostgresSlackRepository extends BaseSlackRepository {
  lastInboundFailure(): Promise<{ error_code: string | null; updated_at: string } | null> {
    // Ties: the sort over the table scan returned the first inserted before the move.
    return this.db.get<{ error_code: string | null; updated_at: string }>(sql`
      SELECT error_code, updated_at FROM slack_inbound_receipts
      WHERE error_code IS NOT NULL
      ORDER BY updated_at DESC, "_rowid" ASC LIMIT 1`);
  }

  listUncertainInbound(limit: number): Promise<SlackInboundReceiptRow[]> {
    // Ties: idx_slack_inbound_receipts_state (state, received_at) walked
    // backwards returned the newest insertion first before the move.
    return this.db.query<SlackInboundReceiptRow>(sql`
      SELECT * FROM slack_inbound_receipts WHERE state = 'uncertain'
      ORDER BY received_at DESC, "_rowid" DESC LIMIT ${limit}`);
  }

  findLatestOutcomeHost(channelId: string, threadTs: string): Promise<SlackOutcomeHostRow | null> {
    // Ties: the sort over idx_slack_messages_thread returned the first inserted before the move.
    return this.db.get<SlackOutcomeHostRow>(sql`
      SELECT id, ts, task_id, context_key, permalink, conclusion_kind, finalized_at
      FROM slack_messages
      WHERE channel_id = ${channelId} AND thread_ts = ${threadTs} AND ${this.deliveredHost()}
      ORDER BY finalized_at DESC NULLS LAST, created_at DESC, "_rowid" ASC
      LIMIT 1`);
  }

  listTreesNeedingRender(thread?: SlackThreadRef): Promise<SlackMessageRow[]> {
    // Ties: idx_slack_messages_open_trees (created_at) returned insertion order before the move.
    return this.db.query<SlackMessageRow>(sql`
      SELECT tree.*
      FROM slack_messages tree
      JOIN slack_render_v2_state state ON state.id = 1
      WHERE tree.kind = 'tree'
      AND tree.closed_at IS NULL
      ${thread ? sql`AND tree.channel_id = ${thread.channelId} AND tree.thread_ts = ${thread.threadTs}` : EMPTY}
      AND ${TREE_NEEDS_RENDER}
      ORDER BY tree.created_at ASC, tree."_rowid" ASC`);
  }

  async closeTreeIfSettled(id: string, now: string): Promise<boolean> {
    const result = await this.db.run(sql`
      UPDATE slack_messages AS tree SET closed_at = ${now}
      WHERE tree.id = ${id}
      AND tree.kind = 'tree'
      AND tree.closed_at IS NULL
      AND (NOT ${PENDING_TS} OR EXISTS (
        SELECT 1 FROM slack_render_v2_state state WHERE state.id = 1 AND NOT ${TREE_VISIBLE}
      ))
      AND EXISTS (
        SELECT 1 FROM slack_render_v2_state state
        WHERE state.id = 1 AND NOT ${TREE_NEEDS_RENDER}
      )`);
    return result.changes > 0;
  }

  async threadHasOutcomeWork(
    thread: SlackThreadRef,
    window: SlackOutcomeWindowParams,
  ): Promise<boolean> {
    const row = await this.db.get<{ pending: number }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM agent_tasks task, slack_render_v2_state state
        WHERE state.id = 1
        AND task."slackChannelId" = ${thread.channelId} AND task."slackThreadTs" = ${thread.threadTs}
        AND (task.source = 'slack' OR ${LEAD_FOLLOW_UP})
        AND task."createdAt" >= state.activated_at
        AND task.status IN ('completed', 'failed', 'cancelled')
        AND ${outcomeWindow(window)}
        AND NOT EXISTS (
          SELECT 1 FROM slack_messages outcome
          WHERE outcome.kind = 'outcome'
          AND outcome.task_id = task.id
          AND (outcome.finalized_at IS NOT NULL OR outcome.delivery_abandoned_at IS NOT NULL)
        )
      ) OR EXISTS (
        SELECT 1 FROM slack_messages outcome
        WHERE outcome.kind = 'outcome'
        AND outcome.channel_id = ${thread.channelId} AND outcome.thread_ts = ${thread.threadTs}
        AND outcome.finalized_at IS NULL AND outcome.delivery_abandoned_at IS NULL
      ) AS pending`);
    return !!row?.pending;
  }

  pageReconcileCandidates(
    source: SlackReconcileSource,
    cursor: string,
    pageSize: number,
    delegationEnabled: boolean,
    window: SlackOutcomeWindowParams,
  ): Promise<SlackReconcileCandidate[]> {
    // SQLite pins these plans with INDEXED BY; Postgres plans them itself.
    switch (source) {
      case "active":
        return this.db.query<SlackReconcileCandidate>(sql`WITH candidates AS MATERIALIZED (
      SELECT id, "slackChannelId", "slackThreadTs", "createdAt" FROM agent_tasks
      WHERE "slackChannelId" IS NOT NULL AND "slackThreadTs" IS NOT NULL
        AND status IN ('offered', 'reviewing', 'pending', 'in_progress', 'paused')
        AND id > ${cursor} ORDER BY id LIMIT ${pageSize}
    ) SELECT task.id, task."slackChannelId" AS "channelId", task."slackThreadTs" AS "threadTs",
      task."createdAt" >= state.activated_at AS eligible
      FROM candidates task, slack_render_v2_state state WHERE state.id = 1 ORDER BY task.id`);
      case "terminal":
        return this.db.query<SlackReconcileCandidate>(sql`WITH candidates AS MATERIALIZED (
      SELECT * FROM agent_tasks
      WHERE "slackChannelId" IS NOT NULL AND "slackThreadTs" IS NOT NULL
        AND status IN ('completed', 'failed', 'cancelled')
        AND id > ${cursor} ORDER BY id LIMIT ${pageSize}
    ) SELECT task.id, task."slackChannelId" AS "channelId", task."slackThreadTs" AS "threadTs",
      (task."createdAt" >= state.activated_at
       AND (task.source = 'slack'
         OR (task.source = 'schedule' AND task."taskType" = 'deferred')
         OR ${LEAD_FOLLOW_UP}
         OR (${delegationEnabled} AND task."parentTaskId" IS NOT NULL AND task."createdAt" >= state.delegation_activated_at
           AND task.status IN ('completed', 'failed') AND task."slackReplySent" = false
           AND COALESCE(task."taskType", '') NOT IN ('follow-up', 'reroute-decision')))
       AND ${outcomeWindow(window)}
       AND NOT (task.source = 'schedule' AND task."taskType" = 'deferred'
         AND ${WAKE_ALREADY_ANSWERED})
       AND NOT EXISTS (
         SELECT 1 FROM agent_tasks parent JOIN slack_messages parent_card ON parent_card.task_id = parent.id
         WHERE task.source = 'schedule' AND task."taskType" = 'deferred' AND parent.id = task."parentTaskId"
           AND parent."deferredAt" IS NOT NULL AND parent_card.kind = 'outcome'
           AND parent_card.finalized_at IS NOT NULL AND parent_card.deferral_abandoned_at IS NULL
       )
       AND NOT EXISTS (SELECT 1 FROM slack_messages card WHERE card.kind = 'outcome'
         AND card.task_id = task.id
         AND (card.finalized_at IS NOT NULL OR card.delivery_abandoned_at IS NOT NULL))) AS eligible
      FROM candidates task, slack_render_v2_state state WHERE state.id = 1 ORDER BY task.id`);
      case "outcome":
        return this.db.query<SlackReconcileCandidate>(sql`
      SELECT id, channel_id AS "channelId", thread_ts AS "threadTs", 1 AS eligible
      FROM slack_messages
      WHERE kind = 'outcome' AND finalized_at IS NULL AND delivery_abandoned_at IS NULL
        AND id > ${cursor} ORDER BY id LIMIT ${pageSize}`);
      case "tree":
        return this.db.query<SlackReconcileCandidate>(sql`WITH candidates AS MATERIALIZED (
      SELECT * FROM slack_messages
      WHERE kind = 'tree' AND closed_at IS NULL AND id > ${cursor} ORDER BY id LIMIT ${pageSize}
    ) SELECT tree.id, tree.channel_id AS "channelId", tree.thread_ts AS "threadTs",
      ${TREE_NEEDS_RENDER} AS eligible
      FROM candidates tree, slack_render_v2_state state WHERE state.id = 1 ORDER BY tree.id`);
    }
  }

  listResolvableDeferralOutcomes(
    limit: number,
  ): Promise<(SlackMessageRow & { wake_task_id: string })[]> {
    // The SQLite query without its planner hints (CROSS JOIN order, unary +).
    return this.db.query<SlackMessageRow & { wake_task_id: string }>(sql`
      WITH RECURSIVE chain(card_id, task_id) AS (
        SELECT card.id, deferred.id FROM agent_tasks deferred
        JOIN slack_messages card ON card.task_id = deferred.id AND card.kind = 'outcome'
        WHERE deferred."deferredAt" IS NOT NULL
          AND card.deferral_resolved_at IS NULL AND card.finalized_at IS NOT NULL
          AND card.ts NOT ILIKE 'pending:%'
        UNION
        SELECT chain.card_id, wake.id FROM chain
        JOIN agent_tasks parent ON parent.id = chain.task_id AND parent."deferredAt" IS NOT NULL
        JOIN agent_tasks wake ON wake."parentTaskId" = parent.id AND wake."taskType" = 'deferred'
      )
      SELECT card.*, wake.id AS wake_task_id
      FROM chain
      JOIN slack_messages card ON card.id = chain.card_id
      JOIN agent_tasks wake ON wake.id = chain.task_id AND wake.id != card.task_id
      WHERE card.kind = 'outcome'
        AND card.finalized_at IS NOT NULL
        AND card.deferral_resolved_at IS NULL
        AND card.ts NOT ILIKE 'pending:%'
        AND NOT EXISTS (
          SELECT 1 FROM agent_tasks child
          WHERE child."parentTaskId" = wake.id AND child."taskType" = 'deferred'
        )
        AND (wake."deferredAt" IS NULL OR wake."finishedAt" > card.updated_at)
        AND wake.status IN ('completed', 'failed', 'cancelled', 'skipped')
      ORDER BY wake."finishedAt" ASC NULLS FIRST, card."_rowid" ASC, wake."_rowid" ASC
      LIMIT ${limit}`);
  }

  listSlackTasksMissingTree(
    scope: { thread: SlackThreadRef } | { since: string },
  ): Promise<TaskRow[]> {
    // Ties: SQLite reads idx_agent_tasks_slack_last_updated (lastUpdatedAt DESC),
    // whose equal keys stay in rowid order.
    const scoped =
      "thread" in scope
        ? sql`task."slackChannelId" = ${scope.thread.channelId}
            AND task."slackThreadTs" = ${scope.thread.threadTs}`
        : sql`task."lastUpdatedAt" >= ${scope.since}`;
    return this.db.query<TaskRow>(sql`
      SELECT task.* FROM slack_render_v2_state state
      CROSS JOIN agent_tasks task
      WHERE state.id = 1
        AND ${scoped}
        AND task.source = 'slack'
        AND task."slackChannelId" IS NOT NULL
        AND task."slackThreadTs" IS NOT NULL
        AND task."createdAt" >= state.activated_at
        AND task.status NOT IN ('backlog', 'unassigned', 'superseded')
        AND NOT EXISTS (
          SELECT 1 FROM agent_tasks earlier
          WHERE earlier.source = 'slack'
            AND earlier."slackChannelId" = task."slackChannelId"
            AND earlier."slackThreadTs" = task."slackThreadTs"
            AND earlier."createdAt" < state.activated_at
        )
        AND NOT EXISTS (
          SELECT 1 FROM slack_messages tree
          WHERE tree.kind = 'tree'
            AND tree.channel_id = task."slackChannelId"
            AND tree.thread_ts = task."slackThreadTs"
        )
      ORDER BY task."lastUpdatedAt" DESC, task."_rowid" ASC
      LIMIT 200`);
  }
}
