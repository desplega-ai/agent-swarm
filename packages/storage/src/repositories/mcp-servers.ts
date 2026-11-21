import { nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, sql } from "../sql";

/**
 * Domain: MCP servers and MCP Events (`mcp_servers`, `mcp_event_subscriptions`).
 * Rows come back in the SQLite value shape on every engine (flags 0/1, JSON as
 * text, timestamps as the text the column stores).
 */

export type McpEventSubscriptionRow = {
  id: string;
  userId: string;
  tokenId: string;
  eventName: string;
  argumentsJson: string;
  url: string;
  secretSealed: string;
  previousSecretSealed: string | null;
  previousSecretUntil: string | null;
  verifiedAt: string;
  expiresAt: string;
  lastDeliveryAt: string | null;
  lastError: string | null;
  failedSince: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewMcpEventSubscription = {
  id: string;
  userId: string;
  tokenId: string;
  eventName: string;
  argumentsJson: string;
  url: string;
  secretSealed: string;
  verifiedAt: string;
  expiresAt: string;
  now: string;
};

export type McpEventSubscriptionRenewal = {
  tokenId: string;
  secretSealed: string;
  previousSecretSealed: string | null;
  previousSecretUntil: string | null;
  verifiedAt: string;
  expiresAt: string;
  now: string;
  actor: string;
};

export interface McpServersRepository {
  /** `mcp_servers.authMethod`; null when the server does not exist. */
  getAuthMethod(mcpServerId: string): Promise<string | null>;
  /** Sets `authMethod` and stamps `lastUpdatedAt`. */
  setAuthMethod(mcpServerId: string, authMethod: string): Promise<void>;
  findSubscription(id: string): Promise<McpEventSubscriptionRow | null>;
  /** Subscriptions of `userId` that expire after `now`, `excludeId` aside. */
  countLiveSubscriptions(userId: string, now: string, excludeId?: string): Promise<number>;
  /** The newest `verifiedAt` after `since` of the user's live subscriptions to `url`. */
  latestVerification(
    userId: string,
    url: string,
    since: string,
    now: string,
  ): Promise<string | null>;
  deleteExpiredSubscriptions(now: string): Promise<number>;
  insertSubscription(row: NewMcpEventSubscription): Promise<void>;
  renewSubscription(id: string, renewal: McpEventSubscriptionRenewal): Promise<void>;
  /** True when a subscription of `userId` with `id` was removed. */
  deleteSubscription(id: string, userId: string): Promise<boolean>;
  /** Live subscriptions of a user to one event. Order: `expiresAt`, then insertion. */
  listLiveSubscriptions(
    userId: string,
    eventName: string,
    now: string,
  ): Promise<McpEventSubscriptionRow[]>;
  recordDeliverySuccess(id: string, at: string): Promise<void>;
  /** Sets `lastError`; `failedSince` keeps the first failure time. */
  recordDeliveryFailure(id: string, category: string, at: string): Promise<void>;
}

export abstract class BaseMcpServersRepository implements McpServersRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async getAuthMethod(mcpServerId: string): Promise<string | null> {
    const row = await this.db.get<{ authMethod: string }>(
      sql`SELECT "authMethod" FROM mcp_servers WHERE id = ${mcpServerId}`,
    );
    return row?.authMethod ?? null;
  }

  async setAuthMethod(mcpServerId: string, authMethod: string): Promise<void> {
    await this.db.run(sql`
      UPDATE mcp_servers SET "authMethod" = ${authMethod}, "lastUpdatedAt" = ${nowIso}
      WHERE id = ${mcpServerId}`);
  }

  findSubscription(id: string): Promise<McpEventSubscriptionRow | null> {
    return this.db.get<McpEventSubscriptionRow>(
      sql`SELECT * FROM mcp_event_subscriptions WHERE id = ${id}`,
    );
  }

  async countLiveSubscriptions(userId: string, now: string, excludeId?: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM mcp_event_subscriptions
      WHERE "userId" = ${userId} AND "expiresAt" > ${now}${
        excludeId === undefined ? EMPTY : sql` AND id != ${excludeId}`
      }`);
    return Number(row?.n ?? 0);
  }

  async latestVerification(
    userId: string,
    url: string,
    since: string,
    now: string,
  ): Promise<string | null> {
    const row = await this.db.get<{ verifiedAt: string | null }>(sql`
      SELECT MAX("verifiedAt") AS "verifiedAt" FROM mcp_event_subscriptions
      WHERE "userId" = ${userId} AND url = ${url} AND "verifiedAt" > ${since} AND "expiresAt" > ${now}`);
    return row?.verifiedAt ?? null;
  }

  async deleteExpiredSubscriptions(now: string): Promise<number> {
    const result = await this.db.run(
      sql`DELETE FROM mcp_event_subscriptions WHERE "expiresAt" <= ${now}`,
    );
    return result.changes;
  }

  async insertSubscription(row: NewMcpEventSubscription): Promise<void> {
    await this.db.run(sql`
      INSERT INTO mcp_event_subscriptions
        (id, "userId", "tokenId", "eventName", "argumentsJson", url, "secretSealed", "verifiedAt",
         "expiresAt", "createdAt", "updatedAt", created_by, updated_by)
      VALUES (${row.id}, ${row.userId}, ${row.tokenId}, ${row.eventName}, ${row.argumentsJson},
        ${row.url}, ${row.secretSealed}, ${row.verifiedAt}, ${row.expiresAt}, ${row.now}, ${row.now},
        ${row.userId}, ${row.userId})`);
  }

  async renewSubscription(id: string, renewal: McpEventSubscriptionRenewal): Promise<void> {
    await this.db.run(sql`
      UPDATE mcp_event_subscriptions
      SET "tokenId" = ${renewal.tokenId},
          "secretSealed" = ${renewal.secretSealed},
          "previousSecretSealed" = ${renewal.previousSecretSealed},
          "previousSecretUntil" = ${renewal.previousSecretUntil},
          "verifiedAt" = ${renewal.verifiedAt},
          "expiresAt" = ${renewal.expiresAt},
          "updatedAt" = ${renewal.now},
          updated_by = ${renewal.actor}
      WHERE id = ${id}`);
  }

  async deleteSubscription(id: string, userId: string): Promise<boolean> {
    const result = await this.db.run(
      sql`DELETE FROM mcp_event_subscriptions WHERE id = ${id} AND "userId" = ${userId}`,
    );
    return result.changes > 0;
  }

  abstract listLiveSubscriptions(
    userId: string,
    eventName: string,
    now: string,
  ): Promise<McpEventSubscriptionRow[]>;

  async recordDeliverySuccess(id: string, at: string): Promise<void> {
    await this.db.run(sql`
      UPDATE mcp_event_subscriptions
      SET "lastDeliveryAt" = ${at}, "lastError" = NULL, "failedSince" = NULL
      WHERE id = ${id}`);
  }

  async recordDeliveryFailure(id: string, category: string, at: string): Promise<void> {
    await this.db.run(sql`
      UPDATE mcp_event_subscriptions
      SET "lastError" = ${category}, "failedSince" = COALESCE("failedSince", ${at})
      WHERE id = ${id}`);
  }
}
