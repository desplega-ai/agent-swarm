import type { SqlQuery } from "@desplega/storage";
import { BaseMcpServersRepository, type McpEventSubscriptionRow, sql } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

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
    return notOnPostgresYet("PostgresMcpServersRepository.insertionOrder");
  }
}
