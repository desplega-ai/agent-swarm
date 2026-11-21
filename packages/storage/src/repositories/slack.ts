import { jsonText, likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlList } from "../sql";

/**
 * Domain: Slack (`slack_inbound_receipts`, and the outcome card groups in
 * `slack_messages`). Rows come back in the SQLite value shape on every engine
 * (timestamps as the text the column stores).
 */

export type SlackInboundReceiptRow = {
  id: string;
  dedup_key: string;
  transport: string;
  kind: string;
  payload_type: string;
  api_app_id: string | null;
  event_id: string | null;
  payload_ciphertext: string | null;
  payload_bytes: number;
  retry_num: number | null;
  retry_reason: string | null;
  state: string;
  attempts: number;
  duplicate_count: number;
  outcome_code: string | null;
  error_code: string | null;
  received_at: string;
  available_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  last_duplicate_at: string | null;
  payload_erased_at: string | null;
};

export type NewSlackInboundReceipt = {
  id: string;
  dedupKey: string;
  transport: string;
  kind: string;
  payloadType: string;
  apiAppId: string | null;
  eventId: string | null;
  retryNum: number | null;
  retryReason: string | null;
  now: string;
};

export type SlackOutcomeHostRow = {
  id: string;
  ts: string;
  task_id: string;
  context_key: string;
  permalink: string | null;
  conclusion_kind: string | null;
  finalized_at: string;
};

export type NewMergedSlackOutcome = {
  id: string;
  contextKey: string;
  channelId: string;
  threadTs: string;
  ts: string;
  taskId: string;
  permalink: string | null;
  hostId: string;
  actorId: string | null;
  now: string;
};

export type SlackMessageRow = {
  id: string;
  context_key: string;
  channel_id: string;
  thread_ts: string;
  ts: string;
  kind: string;
  task_id: string | null;
  permalink: string | null;
  finalized_at: string | null;
  stream_chunks_appended: number;
  conclusion_kind: string | null;
  deferral_resolved_at: string | null;
  deferral_abandoned_at: string | null;
  delivery_attempts: number;
  delivery_abandoned_at: string | null;
  delivery_last_error: string | null;
  closed_at: string | null;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

/** The outcome-card window of the render sweep (see src/be/db/slack-trees.ts). */
export type SlackOutcomeWindowParams = {
  finishedAfter: string;
  closureActiveAfter: string;
  delegationEnabled: boolean;
};

export type SlackThreadRef = { channelId: string; threadTs: string };

/** One page of a reconcile source: candidate rows past the cursor, by id. */
export type SlackReconcileCandidate = SlackThreadRef & { id: string; eligible: number };

export type SlackReconcileSource = "active" | "terminal" | "outcome" | "tree";

export interface SlackRepository {
  /** Counts a duplicate sighting of a stored key; returns the row, or null when the key is new. */
  touchInboundDuplicate(dedupKey: string, now: string): Promise<SlackInboundReceiptRow | null>;
  /** Receipts and payload bytes in `pending` or `processing`. */
  inboundBacklog(): Promise<{ receipts: number; bytes: number }>;
  /** Inserts a pending receipt with its payload; null when the key already exists. */
  insertInboundReceipt(
    row: NewSlackInboundReceipt & { payloadCiphertext: string; payloadBytes: number },
  ): Promise<SlackInboundReceiptRow | null>;
  /** Inserts a terminal `processed` tombstone (no payload); false when the key already exists. */
  insertInboundTombstone(row: NewSlackInboundReceipt): Promise<boolean>;
  /** Claims the receipt `id`, or the oldest available one (`received_at`, then `id`). */
  claimInboundReceipt(now: string, id?: string): Promise<SlackInboundReceiptRow | null>;
  /** Records the outcome of a `processing` receipt. True when updated. */
  completeInboundReceipt(
    id: string,
    outcome: {
      state: string;
      outcomeCode: string | null;
      errorCode: string | null;
      completedAt: string | null;
      erasePayload: boolean;
    },
    now: string,
  ): Promise<boolean>;
  /** Returns a `processing` receipt to `pending`. True when updated. */
  releaseInboundReceipt(
    id: string,
    errorCode: string,
    availableAt: string,
    now: string,
  ): Promise<boolean>;
  nextInboundAvailableAt(): Promise<string | null>;
  /** Moves every `processing` receipt to `uncertain`; returns the count. */
  markInterruptedInboundUncertain(now: string): Promise<number>;
  /** Deletes completed receipts at or before `cutoff`; returns the count. */
  deleteCompletedInboundBefore(cutoff: string): Promise<number>;
  /** Erases payloads still held by processed or ignored receipts; returns the count. */
  eraseCompletedInboundPayloads(now: string): Promise<number>;
  findInboundReceipt(id: string): Promise<SlackInboundReceiptRow | null>;
  findInboundReceiptByKey(dedupKey: string): Promise<SlackInboundReceiptRow | null>;
  /** Count and oldest `received_at` per state. Order: state. */
  inboundStateCounts(): Promise<{ state: string; n: number; oldest: string }[]>;
  inboundTotals(): Promise<{
    backlogBytes: number | null;
    duplicates: number | null;
    lastReceivedAt: string | null;
  } | null>;
  /** The newest receipt with an error code (ties: the first inserted). */
  lastInboundFailure(): Promise<{ error_code: string | null; updated_at: string } | null>;
  /** Uncertain receipts, newest `received_at` first (ties: newest insertion first). */
  listUncertainInbound(limit: number): Promise<SlackInboundReceiptRow[]>;

  /**
   * Open trees with render work, optionally in one thread. Order:
   * `created_at`, then insertion.
   */
  listTreesNeedingRender(thread?: SlackThreadRef): Promise<SlackMessageRow[]>;
  /** Closes the tree when the sweep has nothing left to do for it. True when closed. */
  closeTreeIfSettled(id: string, now: string): Promise<boolean>;
  /** True when the bot replied in the thread at or after `since`, other than `taskId`'s card. */
  threadHasBotReplySince(
    channelId: string,
    threadTs: string,
    since: string,
    taskId: string,
  ): Promise<boolean>;
  /** True when `agentId` sent a reply in the thread at or after `since` for one of `taskIds`. */
  threadHasAgentReplyOnTasksSince(
    channelId: string,
    threadTs: string,
    since: string,
    agentId: string,
    taskIds: readonly string[],
  ): Promise<boolean>;
  /** True while the thread still owes an outcome card. */
  threadHasOutcomeWork(thread: SlackThreadRef, window: SlackOutcomeWindowParams): Promise<boolean>;
  getTreeVisibility(): Promise<{
    task_tree_enabled: number | null;
    task_tree_enabled_at: string | null;
  } | null>;
  /**
   * Stores the visibility flag; turning it on from off stamps
   * `task_tree_enabled_at` with `now`. Returns the stored `task_tree_enabled_at`.
   */
  setTreeVisibility(enabled: boolean, now: string): Promise<string | null>;
  getReconcileCursors(): Promise<string | null>;
  setReconcileCursors(cursors: string): Promise<void>;
  /**
   * One page of a reconcile source after `cursor`. Order: id. `delegationEnabled`
   * gates the delegated-ask clause of the terminal page; `window` carries its
   * own flag for the outcome window.
   */
  pageReconcileCandidates(
    source: SlackReconcileSource,
    cursor: string,
    pageSize: number,
    delegationEnabled: boolean,
    window: SlackOutcomeWindowParams,
  ): Promise<SlackReconcileCandidate[]>;

  /** Task ids merged into the host card. Order: `created_at`, then `id`. */
  listMergedOutcomeTasks(hostId: string): Promise<{ task_id: string; created_at: string }[]>;
  /** The newest delivered, unmerged outcome card of the thread (`finalized_at`, then `created_at`). */
  findLatestOutcomeHost(channelId: string, threadTs: string): Promise<SlackOutcomeHostRow | null>;
  /** The host the message was merged into, or the message itself. Null when unknown. */
  findMergedIntoId(messageId: string): Promise<{ merged_into_id: string | null } | null>;
  /** The message when it is a delivered, unmerged outcome card. */
  findOutcomeHost(id: string): Promise<SlackOutcomeHostRow | null>;
  /** Inserts the finalized merged outcome row; false when the task already has an outcome row. */
  insertMergedOutcome(row: NewMergedSlackOutcome): Promise<boolean>;
}

export abstract class BaseSlackRepository implements SlackRepository {
  constructor(protected readonly db: SqlExecutor) {}

  touchInboundDuplicate(dedupKey: string, now: string): Promise<SlackInboundReceiptRow | null> {
    return this.db.get<SlackInboundReceiptRow>(sql`
      UPDATE slack_inbound_receipts
      SET duplicate_count = duplicate_count + 1, last_duplicate_at = ${now}, updated_at = ${now}
      WHERE dedup_key = ${dedupKey}
      RETURNING *`);
  }

  async inboundBacklog(): Promise<{ receipts: number; bytes: number }> {
    const row = await this.db.get<{ receipts: number; bytes: number | null }>(sql`
      SELECT COUNT(*) AS receipts, SUM(payload_bytes) AS bytes
      FROM slack_inbound_receipts
      WHERE state IN ('pending', 'processing')`);
    return { receipts: Number(row?.receipts ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  insertInboundReceipt(
    row: NewSlackInboundReceipt & { payloadCiphertext: string; payloadBytes: number },
  ): Promise<SlackInboundReceiptRow | null> {
    return this.db.get<SlackInboundReceiptRow>(sql`
      INSERT INTO slack_inbound_receipts (
        id, dedup_key, transport, kind, payload_type, api_app_id, event_id,
        payload_ciphertext, payload_bytes, retry_num, retry_reason,
        received_at, available_at, created_at, updated_at
      ) VALUES (${row.id}, ${row.dedupKey}, ${row.transport}, ${row.kind}, ${row.payloadType},
        ${row.apiAppId}, ${row.eventId}, ${row.payloadCiphertext}, ${row.payloadBytes},
        ${row.retryNum}, ${row.retryReason}, ${row.now}, ${row.now}, ${row.now}, ${row.now})
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING *`);
  }

  async insertInboundTombstone(row: NewSlackInboundReceipt): Promise<boolean> {
    const inserted = await this.db.get<{ id: string }>(sql`
      INSERT INTO slack_inbound_receipts (
        id, dedup_key, transport, kind, payload_type, api_app_id, event_id,
        payload_bytes, retry_num, retry_reason, state, attempts, outcome_code,
        received_at, available_at, completed_at, payload_erased_at, created_at, updated_at
      ) VALUES (${row.id}, ${row.dedupKey}, ${row.transport}, ${row.kind}, ${row.payloadType},
        ${row.apiAppId}, ${row.eventId}, 0, ${row.retryNum}, ${row.retryReason}, 'processed', 1,
        'ran_inline', ${row.now}, ${row.now}, ${row.now}, ${row.now}, ${row.now}, ${row.now})
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING id`);
    return !!inserted;
  }

  claimInboundReceipt(now: string, id?: string): Promise<SlackInboundReceiptRow | null> {
    if (id) {
      return this.db.get<SlackInboundReceiptRow>(sql`
        UPDATE slack_inbound_receipts
        SET state = 'processing', attempts = attempts + 1, claimed_at = ${now}, updated_at = ${now}
        WHERE id = ${id} AND state = 'pending' AND available_at <= ${now}
        RETURNING *`);
    }
    return this.db.get<SlackInboundReceiptRow>(sql`
      UPDATE slack_inbound_receipts
      SET state = 'processing', attempts = attempts + 1, claimed_at = ${now}, updated_at = ${now}
      WHERE id = (
          SELECT id FROM slack_inbound_receipts
          WHERE state = 'pending' AND available_at <= ${now}
          ORDER BY received_at, id
          LIMIT 1
        )
        AND state = 'pending'
      RETURNING *`);
  }

  async completeInboundReceipt(
    id: string,
    outcome: {
      state: string;
      outcomeCode: string | null;
      errorCode: string | null;
      completedAt: string | null;
      erasePayload: boolean;
    },
    now: string,
  ): Promise<boolean> {
    const erase = outcome.erasePayload
      ? sql`payload_ciphertext = NULL, payload_erased_at = ${now}`
      : sql`payload_ciphertext = payload_ciphertext, payload_erased_at = payload_erased_at`;
    const { changes } = await this.db.run(sql`
      UPDATE slack_inbound_receipts
      SET state = ${outcome.state}, outcome_code = ${outcome.outcomeCode},
        error_code = ${outcome.errorCode}, completed_at = ${outcome.completedAt},
        updated_at = ${now}, ${erase}
      WHERE id = ${id} AND state = 'processing'`);
    return changes > 0;
  }

  async releaseInboundReceipt(
    id: string,
    errorCode: string,
    availableAt: string,
    now: string,
  ): Promise<boolean> {
    const { changes } = await this.db.run(sql`
      UPDATE slack_inbound_receipts
      SET state = 'pending', error_code = ${errorCode}, available_at = ${availableAt},
        claimed_at = NULL, updated_at = ${now}
      WHERE id = ${id} AND state = 'processing'`);
    return changes > 0;
  }

  async nextInboundAvailableAt(): Promise<string | null> {
    const row = await this.db.get<{ next: string | null }>(sql`
      SELECT MIN(available_at) AS next FROM slack_inbound_receipts WHERE state = 'pending'`);
    return row?.next ?? null;
  }

  async markInterruptedInboundUncertain(now: string): Promise<number> {
    const { changes } = await this.db.run(sql`
      UPDATE slack_inbound_receipts
      SET state = 'uncertain', error_code = 'interrupted_during_processing', updated_at = ${now}
      WHERE state = 'processing'`);
    return changes;
  }

  async deleteCompletedInboundBefore(cutoff: string): Promise<number> {
    const { changes } = await this.db.run(sql`
      DELETE FROM slack_inbound_receipts
      WHERE state IN ('processed', 'ignored', 'failed') AND completed_at <= ${cutoff}`);
    return changes;
  }

  async eraseCompletedInboundPayloads(now: string): Promise<number> {
    const { changes } = await this.db.run(sql`
      UPDATE slack_inbound_receipts
      SET payload_ciphertext = NULL, payload_erased_at = ${now}, updated_at = ${now}
      WHERE state IN ('processed', 'ignored') AND payload_ciphertext IS NOT NULL`);
    return changes;
  }

  findInboundReceipt(id: string): Promise<SlackInboundReceiptRow | null> {
    return this.db.get<SlackInboundReceiptRow>(
      sql`SELECT * FROM slack_inbound_receipts WHERE id = ${id}`,
    );
  }

  findInboundReceiptByKey(dedupKey: string): Promise<SlackInboundReceiptRow | null> {
    return this.db.get<SlackInboundReceiptRow>(
      sql`SELECT * FROM slack_inbound_receipts WHERE dedup_key = ${dedupKey}`,
    );
  }

  inboundStateCounts(): Promise<{ state: string; n: number; oldest: string }[]> {
    return this.db.query<{ state: string; n: number; oldest: string }>(sql`
      SELECT state, COUNT(*) AS n, MIN(received_at) AS oldest
      FROM slack_inbound_receipts GROUP BY state ORDER BY state`);
  }

  inboundTotals(): Promise<{
    backlogBytes: number | null;
    duplicates: number | null;
    lastReceivedAt: string | null;
  } | null> {
    return this.db.get(sql`
      SELECT
        SUM(CASE WHEN state IN ('pending', 'processing') THEN payload_bytes ELSE 0 END)
          AS "backlogBytes",
        SUM(duplicate_count) AS duplicates,
        MAX(received_at) AS "lastReceivedAt"
      FROM slack_inbound_receipts`);
  }

  abstract lastInboundFailure(): Promise<{ error_code: string | null; updated_at: string } | null>;

  abstract listUncertainInbound(limit: number): Promise<SlackInboundReceiptRow[]>;

  abstract listTreesNeedingRender(thread?: SlackThreadRef): Promise<SlackMessageRow[]>;

  abstract closeTreeIfSettled(id: string, now: string): Promise<boolean>;

  async threadHasBotReplySince(
    channelId: string,
    threadTs: string,
    since: string,
    taskId: string,
  ): Promise<boolean> {
    const row = await this.db.get<{ found: number | boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM slack_messages reply
        WHERE reply.channel_id = ${channelId} AND reply.thread_ts = ${threadTs}
          AND reply.created_at >= ${since}
          AND (reply.kind = 'agent'
            OR (reply.kind = 'outcome' AND reply.finalized_at IS NOT NULL AND reply.task_id != ${taskId}))
      ) AS found`);
    return !!row?.found;
  }

  async threadHasAgentReplyOnTasksSince(
    channelId: string,
    threadTs: string,
    since: string,
    agentId: string,
    taskIds: readonly string[],
  ): Promise<boolean> {
    if (taskIds.length === 0) return false;
    const row = await this.db.get<{ found: number | boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM slack_messages reply
        WHERE reply.channel_id = ${channelId} AND reply.thread_ts = ${threadTs}
          AND reply.created_at >= ${since}
          AND reply.kind = 'agent' AND reply.created_by = ${agentId}
          AND reply.task_id IN (${sqlList(taskIds)})
      ) AS found`);
    return !!row?.found;
  }

  abstract threadHasOutcomeWork(
    thread: SlackThreadRef,
    window: SlackOutcomeWindowParams,
  ): Promise<boolean>;

  getTreeVisibility(): Promise<{
    task_tree_enabled: number | null;
    task_tree_enabled_at: string | null;
  } | null> {
    return this.db.get(sql`
      SELECT task_tree_enabled, task_tree_enabled_at FROM slack_render_v2_state WHERE id = 1`);
  }

  async setTreeVisibility(enabled: boolean, now: string): Promise<string | null> {
    const enabledAt = enabled
      ? sql`CASE WHEN task_tree_enabled = ${false} THEN ${now} ELSE task_tree_enabled_at END`
      : sql`task_tree_enabled_at`;
    const row = await this.db.get<{ task_tree_enabled_at: string | null }>(sql`
      UPDATE slack_render_v2_state SET
        task_tree_enabled_at = ${enabledAt},
        task_tree_enabled = ${enabled}
      WHERE id = 1 RETURNING task_tree_enabled_at`);
    return row?.task_tree_enabled_at ?? null;
  }

  async getReconcileCursors(): Promise<string | null> {
    const row = await this.db.get<{ reconcile_cursors: string }>(
      sql`SELECT reconcile_cursors FROM slack_render_v2_state WHERE id = 1`,
    );
    return row?.reconcile_cursors ?? null;
  }

  async setReconcileCursors(cursors: string): Promise<void> {
    await this.db.run(
      sql`UPDATE slack_render_v2_state SET reconcile_cursors = ${jsonText(cursors)} WHERE id = 1`,
    );
  }

  abstract pageReconcileCandidates(
    source: SlackReconcileSource,
    cursor: string,
    pageSize: number,
    delegationEnabled: boolean,
    window: SlackOutcomeWindowParams,
  ): Promise<SlackReconcileCandidate[]>;

  listMergedOutcomeTasks(hostId: string): Promise<{ task_id: string; created_at: string }[]> {
    return this.db.query<{ task_id: string; created_at: string }>(sql`
      SELECT task_id, created_at FROM slack_messages
      WHERE merged_into_id = ${hostId} AND kind = 'outcome' AND task_id IS NOT NULL
      ORDER BY created_at ASC, id ASC`);
  }

  /** A delivered, unmerged outcome card. */
  protected deliveredHost(): SqlQuery {
    return sql`kind = 'outcome' AND task_id IS NOT NULL AND merged_into_id IS NULL
      AND finalized_at IS NOT NULL AND delivery_abandoned_at IS NULL
      AND NOT ${likeAsciiCi(sql`ts`, sql`'pending:%'`)}
      AND NOT ${likeAsciiCi(sql`ts`, sql`'merged:%'`)}`;
  }

  abstract findLatestOutcomeHost(
    channelId: string,
    threadTs: string,
  ): Promise<SlackOutcomeHostRow | null>;

  findMergedIntoId(messageId: string): Promise<{ merged_into_id: string | null } | null> {
    return this.db.get<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM slack_messages WHERE id = ${messageId}`,
    );
  }

  findOutcomeHost(id: string): Promise<SlackOutcomeHostRow | null> {
    return this.db.get<SlackOutcomeHostRow>(sql`
      SELECT id, ts, task_id, context_key, permalink, conclusion_kind, finalized_at
      FROM slack_messages WHERE id = ${id} AND ${this.deliveredHost()}`);
  }

  async insertMergedOutcome(row: NewMergedSlackOutcome): Promise<boolean> {
    const inserted = await this.db.get<{ id: string }>(sql`
      INSERT INTO slack_messages (
        id, context_key, channel_id, thread_ts, ts, kind, task_id, permalink,
        finalized_at, merged_into_id, created_at, updated_at, created_by, updated_by
      ) VALUES (${row.id}, ${row.contextKey}, ${row.channelId}, ${row.threadTs}, ${row.ts},
        'outcome', ${row.taskId}, ${row.permalink}, ${row.now}, ${row.hostId}, ${row.now},
        ${row.now}, ${row.actorId}, ${row.actorId})
      ON CONFLICT DO NOTHING
      RETURNING id`);
    return !!inserted;
  }
}
