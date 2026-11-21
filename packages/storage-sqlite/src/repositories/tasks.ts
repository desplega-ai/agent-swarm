import { BaseTasksRepository, sql } from "@desplega/storage";

export class SqliteTasksRepository extends BaseTasksRepository {
  async listDeliveredSlackMessageTs(
    channelId: string,
    threadTs: string,
  ): Promise<(string | null)[]> {
    const rows = await this.db.query<{ ts: string | null }>(sql`
      SELECT "slackTriggerMessageTs" AS ts FROM agent_tasks
        WHERE "slackChannelId" = ${channelId} AND "slackThreadTs" = ${threadTs}
          AND "slackTriggerMessageTs" IS NOT NULL
      UNION
      SELECT CASE WHEN json_valid(l.metadata) THEN json_extract(l.metadata, '$.slackMessageTs') END AS ts
        FROM agent_log l
        JOIN agent_tasks t ON t.id = l."taskId"
        WHERE t."slackChannelId" = ${channelId} AND t."slackThreadTs" = ${threadTs}
          AND l."eventType" = 'task_steering' AND l."newValue" = 'slack_reaction'`);
    return rows.map((row) => row.ts);
  }
}
