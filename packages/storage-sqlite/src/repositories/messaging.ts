import {
  BaseMessagingRepository,
  type PendingChatRelayRow,
  SqlQuery,
  sql,
  sqlJoin,
  type TaskRow,
} from "@desplega/storage";

/**
 * Backoff gate for a chat relay obligation: eligible when never attempted, or
 * when `min(3 s * 2^attempt_count, 10 min)` passed since `last_attempt_at`.
 * `attempt_count >= 8` is already past the cap (3 s * 2^8 = 768 s).
 */
function chatRelayEligible(now: string): SqlQuery {
  return sql`(obligation.last_attempt_at IS NULL
    OR (julianday(${now}) - julianday(obligation.last_attempt_at)) * 86400000.0 >=
       CASE WHEN obligation.attempt_count >= 8 THEN 600000
            ELSE 3000 * (1 << obligation.attempt_count) END)`;
}

export class SqliteMessagingRepository extends BaseMessagingRepository {
  protected insertionOrder(alias?: string): SqlQuery {
    return new SqlQuery([alias ? `${alias}.rowid` : "rowid"], []);
  }

  listPendingSlackRelayTasks(): Promise<TaskRow[]> {
    return this.db.query<TaskRow>(sql`
      SELECT task.* FROM slack_relay_obligations obligation
      JOIN agent_tasks task ON task.id = obligation.task_id
      WHERE obligation.delivered_at IS NULL
        AND task.status IN ('completed', 'failed', 'cancelled')
      ORDER BY obligation.last_attempt_at IS NOT NULL,
               obligation.last_attempt_at ASC,
               obligation.created_at ASC,
               obligation.rowid ASC
      LIMIT 200`);
  }

  listPendingChatRelayTasks(
    now: string,
    limit: number,
    adapters: readonly string[],
  ): Promise<PendingChatRelayRow[]> {
    if (adapters.length === 0) return Promise.resolve([]);
    for (const adapter of adapters) {
      if (!/^[a-z]+$/.test(adapter)) throw new Error(`invalid chat adapter name: ${adapter}`);
    }
    const adapterFilter = sqlJoin(
      adapters.map((adapter) => sql`task."contextKey" GLOB ${`task:chat-sdk:${adapter}:*`}`),
      sql` OR `,
    );
    return this.db.query<PendingChatRelayRow>(sql`
      SELECT task.*,
             obligation.created_at AS relay_created_at,
             obligation.last_error AS relay_last_error
      FROM chat_relay_obligations obligation
      JOIN agent_tasks task ON task.id = obligation.task_id
      WHERE obligation.delivered_at IS NULL
        AND obligation.given_up_at IS NULL
        AND task.status IN ('completed', 'failed', 'cancelled')
        AND (${adapterFilter})
        AND ${chatRelayEligible(now)}
      ORDER BY obligation.last_attempt_at IS NOT NULL,
               obligation.last_attempt_at ASC,
               obligation.created_at ASC,
               obligation.rowid ASC
      LIMIT ${limit}`);
  }

  async markChatRelayAttempted(taskId: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE chat_relay_obligations AS obligation
      SET attempt_count = attempt_count + 1, last_attempt_at = ${now}, updated_at = ${now}
      WHERE task_id = ${taskId}
        AND delivered_at IS NULL
        AND given_up_at IS NULL
        AND ${chatRelayEligible(now)}`);
    return result.changes;
  }
}
