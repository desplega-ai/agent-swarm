import {
  BaseMcpServersRepository,
  type McpEventSubscriptionRow,
  SqlQuery,
  sql,
} from "@desplega/storage";

export class PostgresMcpServersRepository extends BaseMcpServersRepository {
  listLiveSubscriptions(
    userId: string,
    eventName: string,
    now: string,
  ): Promise<McpEventSubscriptionRow[]> {
    // The SQLite order: idx_mcp_event_subscriptions_user_event (userId,
    // eventName, expiresAt), then insertion order. expiresAt is NOT NULL.
    return this.db.query<McpEventSubscriptionRow>(sql`
      SELECT * FROM mcp_event_subscriptions
      WHERE "userId" = ${userId} AND "eventName" = ${eventName} AND "expiresAt" > ${now}
      ORDER BY "expiresAt", "_rowid"`);
  }

  protected insertionOrder(alias?: string): SqlQuery {
    return new SqlQuery([alias ? `${alias}."_rowid"` : '"_rowid"'], []);
  }
}
