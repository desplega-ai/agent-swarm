import { jsonText, likeAsciiCi, nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlList, sqlWhere } from "../sql";
import type { TaskRow } from "./tasks";

/**
 * Domain: messaging (`channels`, `channel_messages`, `channel_read_state`,
 * `channel_activity_cursors`, `inbox_messages`, `inbox_item_state`,
 * `agentmail_inbox_mappings`, `slack_relay_obligations`,
 * `chat_relay_obligations`). Rows come back in the SQLite value shape on every
 * engine (flags 0/1, JSON as text, timestamps as the text the column stores).
 */

/** A pending Chat SDK relay: the terminal task plus its obligation bookkeeping. */
export type PendingChatRelayRow = TaskRow & {
  relay_created_at: string;
  relay_last_error: string | null;
};

/** One `channels` row (`participants` as JSON text). */
export type ChannelRow = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  createdBy: string | null;
  participants: string | null;
  createdAt: string;
};

/** One `channel_messages` row; list reads add the sender's `agentName`. */
export type ChannelMessageRow = {
  id: string;
  channelId: string;
  agentId: string | null;
  content: string;
  replyToId: string | null;
  mentions: string | null;
  createdAt: string;
  agentName?: string | null;
};

export type ChannelReadStateRow = { lastReadAt: string | null; processing_since: string | null };

/** One `inbox_messages` row. */
export type InboxMessageRow = {
  id: string;
  agentId: string;
  content: string;
  source: string;
  status: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  matchedText: string | null;
  delegatedToTaskId: string | null;
  responseText: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

/** One `agentmail_inbox_mappings` row. */
export type AgentMailInboxMappingRow = {
  id: string;
  inboxId: string;
  agentId: string;
  inboxEmail: string | null;
  createdAt: string;
};

/** One `channel_activity_cursors` row. */
export type ChannelActivityCursorRow = { channelId: string; lastSeenTs: string; updatedAt: string };

/** One `inbox_item_state` row. */
export type InboxItemStateRow = {
  id: string;
  userId: string;
  itemType: string;
  itemId: string;
  status: string;
  snoozeUntil: string | null;
  dismissedAt: string | null;
  doneAt: string | null;
  readAt: string | null;
  lastReadAt: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

export interface MessagingRepository {
  // ---- slack_relay_obligations ----
  /**
   * Terminal tasks with an undelivered Slack relay obligation (at most 200):
   * never-attempted first, then the oldest attempt, then the oldest
   * obligation, then insertion order.
   */
  listPendingSlackRelayTasks(): Promise<TaskRow[]>;
  markSlackRelayAttempted(taskId: string, now: string): Promise<number>;
  markSlackRelayDelivered(taskId: string, now: string): Promise<number>;
  /** Delivers obligations whose renderer-v2 outcome message is finalized. */
  markFinalizedSlackRelaysDelivered(now: string): Promise<number>;

  // ---- chat_relay_obligations ----
  /**
   * Terminal tasks with a pending chat relay out of backoff at `now`, whose
   * `task:chat-sdk:<adapter>:` contextKey names one of `adapters` (lowercase
   * letters only; none returns no rows). Same order as the Slack relay list.
   */
  listPendingChatRelayTasks(
    now: string,
    limit: number,
    adapters: readonly string[],
  ): Promise<PendingChatRelayRow[]>;
  giveUpChatRelaysCreatedBefore(cutoff: string, now: string, reason: string): Promise<number>;
  /** Claims a pending relay out of backoff at `now`: bumps the attempt count. */
  markChatRelayAttempted(taskId: string, now: string): Promise<number>;
  recordChatRelayError(taskId: string, error: string, now: string): Promise<number>;
  markChatRelayDelivered(taskId: string, now: string): Promise<number>;
  markChatRelayGivenUp(taskId: string, error: string, now: string): Promise<number>;
  // ---- channels ----
  insertChannel(row: ChannelRow): Promise<ChannelRow | null>;
  findChannelById(id: string): Promise<ChannelRow | null>;
  findChannelByName(name: string): Promise<ChannelRow | null>;
  /** By name (unique). */
  listChannels(): Promise<ChannelRow[]>;
  deleteChannel(id: string): Promise<number>;

  // ---- channel_messages ----
  insertChannelMessage(
    row: Omit<ChannelMessageRow, "agentName">,
  ): Promise<ChannelMessageRow | null>;
  findChannelMessage(id: string): Promise<ChannelMessageRow | null>;
  /** The message with its sender's `agentName`. */
  findChannelMessageWithAgent(id: string): Promise<ChannelMessageRow | null>;
  setChannelMessageContent(id: string, content: string): Promise<void>;
  /**
   * One channel's messages (with `agentName`) after `since` / before `before`:
   * newest first, then insertion order (newest first), at most `limit`.
   */
  listChannelMessages(
    channelId: string,
    f: { since?: string; before?: string; limit?: number },
  ): Promise<ChannelMessageRow[]>;
  /** One channel's messages (with `agentName`) after `since`: oldest first, then insertion order. */
  listChannelMessagesSince(channelId: string, since: string | null): Promise<ChannelMessageRow[]>;
  /**
   * Messages whose `mentions` JSON names `agentId` (with `agentName`), optionally
   * in one channel after `since`: newest first, then insertion order (newest first), at most 50.
   */
  listMentionMessages(
    agentId: string,
    f: { channelId?: string; since?: string | null },
  ): Promise<ChannelMessageRow[]>;
  /** Messages in a channel after `since` that are not the agent's own. */
  countUnreadChannelMessages(
    channelId: string,
    agentId: string,
    since: string | null,
  ): Promise<number>;
  /** Messages in a channel after `since` that mention the agent. */
  countChannelMentions(channelId: string, agentId: string, since: string | null): Promise<number>;

  // ---- channel_read_state ----
  setChannelLastRead(agentId: string, channelId: string, now: string): Promise<void>;
  findChannelReadState(agentId: string, channelId: string): Promise<ChannelReadStateRow | null>;
  /** Sets `processing_since` unless the channel is already being processed; returns the changes. */
  claimChannelMentions(
    agentId: string,
    channelId: string,
    lastReadAt: string,
    now: string,
  ): Promise<number>;
  releaseChannelProcessing(agentId: string, channelIds: readonly string[]): Promise<void>;
  releaseChannelProcessingBefore(cutoff: string): Promise<number>;

  // ---- inbox_messages ----
  insertInboxMessage(row: InboxMessageRow): Promise<InboxMessageRow | null>;
  findInboxMessage(id: string): Promise<InboxMessageRow | null>;
  /** One agent's unread messages, oldest first, then insertion order. */
  listUnreadInboxMessages(agentId: string, limit?: number): Promise<InboxMessageRow[]>;
  /** unread -> processing for the given ids. Rows come back in no particular order. */
  markInboxMessagesProcessing(ids: readonly string[], now: string): Promise<InboxMessageRow[]>;
  markInboxMessageRead(id: string, now: string): Promise<InboxMessageRow | null>;
  /** unread/processing -> responded. */
  markInboxMessageResponded(
    id: string,
    responseText: string,
    now: string,
  ): Promise<InboxMessageRow | null>;
  /** unread/processing -> delegated. */
  markInboxMessageDelegated(
    id: string,
    taskId: string,
    now: string,
  ): Promise<InboxMessageRow | null>;
  releaseInboxProcessingBefore(cutoff: string, now: string): Promise<number>;
  /** Messages being processed, newest first, then insertion order (newest first). */
  listProcessingInboxMessages(): Promise<
    Pick<
      InboxMessageRow,
      "id" | "content" | "source" | "slackChannelId" | "slackThreadTs" | "createdAt"
    >[]
  >;

  // ---- agentmail_inbox_mappings ----
  findAgentMailInboxMapping(inboxId: string): Promise<AgentMailInboxMappingRow | null>;
  /** Newest first, then insertion order (newest first); optionally one agent's. */
  listAgentMailInboxMappings(agentId?: string): Promise<AgentMailInboxMappingRow[]>;
  /**
   * Inserts, or refreshes the email of an inbox the same agent owns. Null, and
   * no change, when the inbox is mapped to another agent.
   */
  upsertAgentMailInboxMapping(
    row: AgentMailInboxMappingRow,
  ): Promise<AgentMailInboxMappingRow | null>;
  deleteAgentMailInboxMapping(inboxId: string): Promise<number>;

  // ---- channel_activity_cursors ----
  /** In insertion order. */
  listChannelActivityCursors(): Promise<ChannelActivityCursorRow[]>;
  findChannelActivityCursor(channelId: string): Promise<ChannelActivityCursorRow | null>;
  /** Upsert; `updatedAt` takes the database clock. */
  upsertChannelActivityCursor(channelId: string, lastSeenTs: string): Promise<void>;

  // ---- inbox_item_state ----
  /** One user's states, newest `lastUpdatedAt` first, then insertion order (newest first). */
  listInboxItemStates(f: {
    userId: string;
    status?: string;
    itemType?: string;
  }): Promise<InboxItemStateRow[]>;
  /**
   * Upsert on (userId, itemType, itemId). `readAt` is sticky (the first
   * non-null value wins); `lastReadAt` changes only when `setLastReadAt`.
   */
  upsertInboxItemState(
    row: Omit<InboxItemStateRow, "id">,
    setLastReadAt: boolean,
  ): Promise<InboxItemStateRow | null>;
}

export abstract class BaseMessagingRepository implements MessagingRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // ---- slack_relay_obligations ----

  abstract listPendingSlackRelayTasks(): Promise<TaskRow[]>;

  async markSlackRelayAttempted(taskId: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE slack_relay_obligations
      SET attempt_count = attempt_count + 1, last_attempt_at = ${now}, updated_at = ${now}
      WHERE task_id = ${taskId} AND delivered_at IS NULL`);
    return result.changes;
  }

  async markSlackRelayDelivered(taskId: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE slack_relay_obligations SET delivered_at = ${now}, updated_at = ${now}
      WHERE task_id = ${taskId} AND delivered_at IS NULL`);
    return result.changes;
  }

  async markFinalizedSlackRelaysDelivered(now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE slack_relay_obligations AS obligation
      SET delivered_at = ${now}, updated_at = ${now}
      WHERE obligation.delivered_at IS NULL
        AND EXISTS (
          SELECT 1 FROM slack_messages message
          WHERE message.kind = 'outcome'
            AND message.task_id = obligation.task_id
            AND message.finalized_at IS NOT NULL
        )`);
    return result.changes;
  }

  // ---- chat_relay_obligations ----

  abstract listPendingChatRelayTasks(
    now: string,
    limit: number,
    adapters: readonly string[],
  ): Promise<PendingChatRelayRow[]>;

  async giveUpChatRelaysCreatedBefore(
    cutoff: string,
    now: string,
    reason: string,
  ): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE chat_relay_obligations
      SET given_up_at = ${now}, last_error = ${reason}, updated_at = ${now}
      WHERE delivered_at IS NULL AND given_up_at IS NULL AND created_at < ${cutoff}`);
    return result.changes;
  }

  abstract markChatRelayAttempted(taskId: string, now: string): Promise<number>;

  async recordChatRelayError(taskId: string, error: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE chat_relay_obligations SET last_error = ${error}, updated_at = ${now}
      WHERE task_id = ${taskId} AND delivered_at IS NULL`);
    return result.changes;
  }

  async markChatRelayDelivered(taskId: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE chat_relay_obligations SET delivered_at = ${now}, updated_at = ${now}
      WHERE task_id = ${taskId} AND delivered_at IS NULL`);
    return result.changes;
  }

  async markChatRelayGivenUp(taskId: string, error: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE chat_relay_obligations
      SET given_up_at = ${now}, last_error = ${error}, updated_at = ${now}
      WHERE task_id = ${taskId} AND delivered_at IS NULL AND given_up_at IS NULL`);
    return result.changes;
  }

  /** The insertion-order column (SQLite `rowid`), for ORDER BY tiebreaks only. */
  protected abstract insertionOrder(alias?: string): SqlQuery;

  // ---- channels ----

  insertChannel(r: ChannelRow): Promise<ChannelRow | null> {
    return this.db.get<ChannelRow>(sql`
      INSERT INTO channels (id, name, description, type, "createdBy", participants, "createdAt")
      VALUES (${r.id}, ${r.name}, ${r.description}, ${r.type}, ${r.createdBy}, ${jsonText(r.participants)},
        ${r.createdAt})
      RETURNING *`);
  }

  findChannelById(id: string): Promise<ChannelRow | null> {
    return this.db.get<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${id}`);
  }

  findChannelByName(name: string): Promise<ChannelRow | null> {
    return this.db.get<ChannelRow>(sql`SELECT * FROM channels WHERE name = ${name}`);
  }

  listChannels(): Promise<ChannelRow[]> {
    return this.db.query<ChannelRow>(sql`SELECT * FROM channels ORDER BY name`);
  }

  async deleteChannel(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM channels WHERE id = ${id}`)).changes;
  }

  // ---- channel_messages ----

  private readonly messageWithAgent = sql`SELECT m.*, a.name as "agentName" FROM channel_messages m
    LEFT JOIN agents a ON m."agentId" = a.id`;

  insertChannelMessage(r: Omit<ChannelMessageRow, "agentName">): Promise<ChannelMessageRow | null> {
    return this.db.get<ChannelMessageRow>(sql`
      INSERT INTO channel_messages (id, "channelId", "agentId", content, "replyToId", mentions, "createdAt")
      VALUES (${r.id}, ${r.channelId}, ${r.agentId}, ${r.content}, ${r.replyToId}, ${jsonText(r.mentions)},
        ${r.createdAt})
      RETURNING *`);
  }

  findChannelMessage(id: string): Promise<ChannelMessageRow | null> {
    return this.db.get<ChannelMessageRow>(sql`SELECT * FROM channel_messages WHERE id = ${id}`);
  }

  findChannelMessageWithAgent(id: string): Promise<ChannelMessageRow | null> {
    return this.db.get<ChannelMessageRow>(sql`${this.messageWithAgent} WHERE m.id = ${id}`);
  }

  async setChannelMessageContent(id: string, content: string): Promise<void> {
    await this.db.run(sql`UPDATE channel_messages SET content = ${content} WHERE id = ${id}`);
  }

  listChannelMessages(
    channelId: string,
    f: { since?: string; before?: string; limit?: number },
  ): Promise<ChannelMessageRow[]> {
    const since = f.since ? sql` AND m."createdAt" > ${f.since}` : EMPTY;
    const before = f.before ? sql` AND m."createdAt" < ${f.before}` : EMPTY;
    const limit = f.limit ? sql` LIMIT ${f.limit}` : EMPTY;
    return this.db.query<ChannelMessageRow>(sql`
      ${this.messageWithAgent} WHERE m."channelId" = ${channelId}${since}${before}
      ORDER BY m."createdAt" DESC, ${this.insertionOrder("m")} DESC${limit}`);
  }

  listChannelMessagesSince(channelId: string, since: string | null): Promise<ChannelMessageRow[]> {
    const after = since ? sql` AND m."createdAt" > ${since}` : EMPTY;
    return this.db.query<ChannelMessageRow>(sql`
      ${this.messageWithAgent} WHERE m."channelId" = ${channelId}${after}
      ORDER BY m."createdAt" ASC, ${this.insertionOrder("m")} ASC`);
  }

  private mentions(agentId: string): SqlQuery {
    // CAST: the column is JSON text on SQLite (a no-op there) and jsonb elsewhere.
    return sql`${likeAsciiCi(sql`CAST(m.mentions AS text)`, sql`${`%"${agentId}"%`}`)}`;
  }

  listMentionMessages(
    agentId: string,
    f: { channelId?: string; since?: string | null },
  ): Promise<ChannelMessageRow[]> {
    const channel = f.channelId ? sql` AND m."channelId" = ${f.channelId}` : EMPTY;
    const after = f.channelId && f.since ? sql` AND m."createdAt" > ${f.since}` : EMPTY;
    return this.db.query<ChannelMessageRow>(sql`
      ${this.messageWithAgent} WHERE ${this.mentions(agentId)}${channel}${after}
      ORDER BY m."createdAt" DESC, ${this.insertionOrder("m")} DESC LIMIT 50`);
  }

  async countUnreadChannelMessages(
    channelId: string,
    agentId: string,
    since: string | null,
  ): Promise<number> {
    const after = since ? sql` AND m."createdAt" > ${since}` : EMPTY;
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM channel_messages m
      WHERE m."channelId" = ${channelId} AND (m."agentId" != ${agentId} OR m."agentId" IS NULL)${after}`);
    return row?.count ?? 0;
  }

  async countChannelMentions(
    channelId: string,
    agentId: string,
    since: string | null,
  ): Promise<number> {
    const after = since ? sql` AND m."createdAt" > ${since}` : EMPTY;
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM channel_messages m
      WHERE m."channelId" = ${channelId} AND ${this.mentions(agentId)}${after}`);
    return row?.count ?? 0;
  }

  // ---- channel_read_state ----

  async setChannelLastRead(agentId: string, channelId: string, now: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO channel_read_state ("agentId", "channelId", "lastReadAt")
      VALUES (${agentId}, ${channelId}, ${now})
      ON CONFLICT("agentId", "channelId") DO UPDATE SET "lastReadAt" = ${now}`);
  }

  findChannelReadState(agentId: string, channelId: string): Promise<ChannelReadStateRow | null> {
    return this.db.get<ChannelReadStateRow>(sql`
      SELECT "lastReadAt", processing_since FROM channel_read_state
      WHERE "agentId" = ${agentId} AND "channelId" = ${channelId}`);
  }

  async claimChannelMentions(
    agentId: string,
    channelId: string,
    lastReadAt: string,
    now: string,
  ): Promise<number> {
    const result = await this.db.run(sql`
      INSERT INTO channel_read_state ("agentId", "channelId", "lastReadAt", processing_since)
      VALUES (${agentId}, ${channelId}, ${lastReadAt}, ${now})
      ON CONFLICT("agentId", "channelId") DO UPDATE SET
        processing_since = CASE
          WHEN channel_read_state.processing_since IS NULL THEN ${now}
          ELSE channel_read_state.processing_since
        END
      WHERE channel_read_state.processing_since IS NULL`);
    return result.changes;
  }

  async releaseChannelProcessing(agentId: string, channelIds: readonly string[]): Promise<void> {
    if (channelIds.length === 0) return;
    await this.db.run(sql`
      UPDATE channel_read_state SET processing_since = NULL
      WHERE "agentId" = ${agentId} AND "channelId" IN (${sqlList(channelIds)})`);
  }

  async releaseChannelProcessingBefore(cutoff: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE channel_read_state SET processing_since = NULL
      WHERE processing_since IS NOT NULL AND processing_since < ${cutoff}`);
    return result.changes;
  }

  // ---- inbox_messages ----

  insertInboxMessage(r: InboxMessageRow): Promise<InboxMessageRow | null> {
    return this.db.get<InboxMessageRow>(sql`
      INSERT INTO inbox_messages (id, "agentId", content, source, status, "slackChannelId",
        "slackThreadTs", "slackUserId", "matchedText", "delegatedToTaskId", "responseText",
        "createdAt", "lastUpdatedAt")
      VALUES (${r.id}, ${r.agentId}, ${r.content}, ${r.source}, ${r.status}, ${r.slackChannelId},
        ${r.slackThreadTs}, ${r.slackUserId}, ${r.matchedText}, ${r.delegatedToTaskId},
        ${r.responseText}, ${r.createdAt}, ${r.lastUpdatedAt})
      RETURNING *`);
  }

  findInboxMessage(id: string): Promise<InboxMessageRow | null> {
    return this.db.get<InboxMessageRow>(sql`SELECT * FROM inbox_messages WHERE id = ${id}`);
  }

  listUnreadInboxMessages(agentId: string, limit?: number): Promise<InboxMessageRow[]> {
    const cap = limit === undefined ? EMPTY : sql` LIMIT ${limit}`;
    return this.db.query<InboxMessageRow>(sql`
      SELECT * FROM inbox_messages WHERE "agentId" = ${agentId} AND status = 'unread'
      ORDER BY "createdAt" ASC, ${this.insertionOrder()} ASC${cap}`);
  }

  markInboxMessagesProcessing(ids: readonly string[], now: string): Promise<InboxMessageRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.query<InboxMessageRow>(sql`
      UPDATE inbox_messages SET status = 'processing', "lastUpdatedAt" = ${now}
      WHERE id IN (${sqlList(ids)}) AND status = 'unread' RETURNING *`);
  }

  markInboxMessageRead(id: string, now: string): Promise<InboxMessageRow | null> {
    return this.db.get<InboxMessageRow>(sql`
      UPDATE inbox_messages SET status = 'read', "lastUpdatedAt" = ${now} WHERE id = ${id} RETURNING *`);
  }

  markInboxMessageResponded(
    id: string,
    responseText: string,
    now: string,
  ): Promise<InboxMessageRow | null> {
    return this.db.get<InboxMessageRow>(sql`
      UPDATE inbox_messages SET status = 'responded', "responseText" = ${responseText},
        "lastUpdatedAt" = ${now}
      WHERE id = ${id} AND status IN ('unread', 'processing') RETURNING *`);
  }

  markInboxMessageDelegated(
    id: string,
    taskId: string,
    now: string,
  ): Promise<InboxMessageRow | null> {
    return this.db.get<InboxMessageRow>(sql`
      UPDATE inbox_messages SET status = 'delegated', "delegatedToTaskId" = ${taskId},
        "lastUpdatedAt" = ${now}
      WHERE id = ${id} AND status IN ('unread', 'processing') RETURNING *`);
  }

  async releaseInboxProcessingBefore(cutoff: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE inbox_messages SET status = 'unread', "lastUpdatedAt" = ${now}
      WHERE status = 'processing' AND "lastUpdatedAt" < ${cutoff}`);
    return result.changes;
  }

  listProcessingInboxMessages(): Promise<
    Pick<
      InboxMessageRow,
      "id" | "content" | "source" | "slackChannelId" | "slackThreadTs" | "createdAt"
    >[]
  > {
    return this.db.query(sql`
      SELECT id, content, source, "slackChannelId", "slackThreadTs", "createdAt" FROM inbox_messages
      WHERE status = 'processing'
      ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC`);
  }

  // ---- agentmail_inbox_mappings ----

  findAgentMailInboxMapping(inboxId: string): Promise<AgentMailInboxMappingRow | null> {
    return this.db.get<AgentMailInboxMappingRow>(
      sql`SELECT * FROM agentmail_inbox_mappings WHERE "inboxId" = ${inboxId}`,
    );
  }

  listAgentMailInboxMappings(agentId?: string): Promise<AgentMailInboxMappingRow[]> {
    const where = agentId ? sql` WHERE "agentId" = ${agentId}` : EMPTY;
    return this.db.query<AgentMailInboxMappingRow>(sql`
      SELECT * FROM agentmail_inbox_mappings${where}
      ORDER BY "createdAt" DESC, ${this.insertionOrder()} DESC`);
  }

  upsertAgentMailInboxMapping(
    r: AgentMailInboxMappingRow,
  ): Promise<AgentMailInboxMappingRow | null> {
    return this.db.get<AgentMailInboxMappingRow>(sql`
      INSERT INTO agentmail_inbox_mappings (id, "inboxId", "agentId", "inboxEmail", "createdAt")
      VALUES (${r.id}, ${r.inboxId}, ${r.agentId}, ${r.inboxEmail}, ${r.createdAt})
      ON CONFLICT("inboxId") DO UPDATE SET "inboxEmail" = excluded."inboxEmail"
        WHERE agentmail_inbox_mappings."agentId" = excluded."agentId"
      RETURNING *`);
  }

  async deleteAgentMailInboxMapping(inboxId: string): Promise<number> {
    const result = await this.db.run(
      sql`DELETE FROM agentmail_inbox_mappings WHERE "inboxId" = ${inboxId}`,
    );
    return result.changes;
  }

  // ---- channel_activity_cursors ----

  listChannelActivityCursors(): Promise<ChannelActivityCursorRow[]> {
    return this.db.query<ChannelActivityCursorRow>(
      sql`SELECT * FROM channel_activity_cursors ORDER BY ${this.insertionOrder()}`,
    );
  }

  findChannelActivityCursor(channelId: string): Promise<ChannelActivityCursorRow | null> {
    return this.db.get<ChannelActivityCursorRow>(
      sql`SELECT * FROM channel_activity_cursors WHERE "channelId" = ${channelId}`,
    );
  }

  async upsertChannelActivityCursor(channelId: string, lastSeenTs: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO channel_activity_cursors ("channelId", "lastSeenTs", "updatedAt")
      VALUES (${channelId}, ${lastSeenTs}, ${nowIso})
      ON CONFLICT("channelId") DO UPDATE SET "lastSeenTs" = excluded."lastSeenTs",
        "updatedAt" = excluded."updatedAt"`);
  }

  // ---- inbox_item_state ----

  listInboxItemStates(f: {
    userId: string;
    status?: string;
    itemType?: string;
  }): Promise<InboxItemStateRow[]> {
    const conditions = [sql`"userId" = ${f.userId}`];
    if (f.status) conditions.push(sql`status = ${f.status}`);
    if (f.itemType) conditions.push(sql`"itemType" = ${f.itemType}`);
    return this.db.query<InboxItemStateRow>(sql`
      SELECT * FROM inbox_item_state${sqlWhere(conditions)}
      ORDER BY "lastUpdatedAt" DESC, ${this.insertionOrder()} DESC`);
  }

  upsertInboxItemState(
    r: Omit<InboxItemStateRow, "id">,
    setLastReadAt: boolean,
  ): Promise<InboxItemStateRow | null> {
    // `triageSessionList` in src/be/db/session-tree.ts copies these conflict rules.
    return this.db.get<InboxItemStateRow>(sql`
      INSERT INTO inbox_item_state ("userId", "itemType", "itemId", status, "snoozeUntil",
        "dismissedAt", "doneAt", "readAt", "lastReadAt", "createdAt", "lastUpdatedAt")
      VALUES (${r.userId}, ${r.itemType}, ${r.itemId}, ${r.status}, ${r.snoozeUntil},
        ${r.dismissedAt}, ${r.doneAt}, ${r.readAt}, ${r.lastReadAt}, ${r.createdAt},
        ${r.lastUpdatedAt})
      ON CONFLICT("userId", "itemType", "itemId") DO UPDATE SET
        status = excluded.status,
        "snoozeUntil" = excluded."snoozeUntil",
        "dismissedAt" = excluded."dismissedAt",
        "doneAt" = excluded."doneAt",
        "readAt" = COALESCE(inbox_item_state."readAt", excluded."readAt"),
        "lastReadAt" = CASE WHEN ${setLastReadAt} THEN excluded."lastReadAt"
          ELSE inbox_item_state."lastReadAt" END,
        "lastUpdatedAt" = excluded."lastUpdatedAt"
      RETURNING *`);
  }
}
