import type { SqlExecutor } from "../executor";
import { sql } from "../sql";
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
}
