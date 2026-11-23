import {
  BaseMcpServersRepository,
  type McpEventSubscriptionRow,
  SqlQuery,
  sql,
} from "@desplega/storage";

export class SqliteMcpServersRepository extends BaseMcpServersRepository {
  protected insertionOrder(alias?: string): SqlQuery {
    return new SqlQuery([alias ? `${alias}.rowid` : "rowid"], []);
  }

  listLiveSubscriptions(
    userId: string,
    eventName: string,
    now: string,
  ): Promise<McpEventSubscriptionRow[]> {
    // The order SQLite returned before the move: idx_mcp_event_subscriptions_user_event
    // (userId, eventName, expiresAt), then rowid.
    return this.db.query<McpEventSubscriptionRow>(sql`
      SELECT * FROM mcp_event_subscriptions
      WHERE "userId" = ${userId} AND "eventName" = ${eventName} AND "expiresAt" > ${now}
      ORDER BY "expiresAt", rowid`);
  }
}
