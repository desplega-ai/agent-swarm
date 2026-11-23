import { likeAsciiCi, nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlIdent, sqlJoin } from "../sql";

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

/** One `mcp_servers` row. */
export type McpServerRow = {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  ownerAgentId: string | null;
  transport: string;
  command: string | null;
  args: string | null;
  url: string | null;
  headers: string | null;
  envConfigKeys: string | null;
  headerConfigKeys: string | null;
  extraAuthorizeParams: string | null;
  authMethod: string | null;
  isEnabled: number;
  version: number;
  createdAt: string;
  lastUpdatedAt: string;
};

export type McpServerWithInstallRow = McpServerRow & { isActive: number; installedAt: string };

/** The columns of a new server (enabled, version 1). */
export type NewMcpServerRow = Omit<McpServerRow, "authMethod" | "isEnabled" | "version">;

/** Columns a server update may set (`isEnabled` as a JS boolean). */
export type McpServerColumnUpdate = Partial<
  Omit<McpServerRow, "id" | "isEnabled" | "version" | "createdAt" | "lastUpdatedAt">
> & { isEnabled?: boolean };

export type McpServerListFilter = {
  scope?: string;
  ownerAgentId?: string;
  transport?: string;
  isEnabled?: boolean;
  /** Substring of the name or description (case-insensitive for ASCII). */
  search?: string;
};

/** Update columns whose change bumps the server's `version`. */
const MCP_CONFIG_COLUMNS = [
  "command",
  "args",
  "url",
  "headers",
  "envConfigKeys",
  "headerConfigKeys",
  "extraAuthorizeParams",
  "transport",
] as const;

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

  // ---- mcp_servers ----
  insertMcpServer(row: NewMcpServerRow): Promise<McpServerRow | null>;
  countMcpServers(): Promise<number>;
  /** Sets the given columns and `lastUpdatedAt`; bumps `version` when a config column is set. */
  updateMcpServer(
    id: string,
    update: McpServerColumnUpdate,
    now: string,
  ): Promise<McpServerRow | null>;
  /** Deletes the server and its script connections. */
  deleteMcpServerCascade(id: string): Promise<{ servers: number; scriptConnections: number }>;
  findMcpServerById(id: string): Promise<McpServerRow | null>;
  /** Owner NULL matches `ownerAgentId` ''. */
  findMcpServerByName(
    name: string,
    scope: string,
    ownerAgentId: string,
  ): Promise<McpServerRow | null>;
  /** By name, then insertion order. */
  listMcpServers(f: McpServerListFilter): Promise<McpServerRow[]>;
  /** The agent's installed, enabled servers (active only when `activeOnly`), by name then insertion order. */
  listAgentMcpServers(agentId: string, activeOnly: boolean): Promise<McpServerWithInstallRow[]>;
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

  /** The insertion-order column (SQLite `rowid`), for ORDER BY tiebreaks only. */
  protected abstract insertionOrder(alias?: string): SqlQuery;

  // ---- mcp_servers ----

  insertMcpServer(r: NewMcpServerRow): Promise<McpServerRow | null> {
    return this.db.get<McpServerRow>(sql`
      INSERT INTO mcp_servers (
        id, name, description, scope, "ownerAgentId", transport,
        command, args, url, headers,
        "envConfigKeys", "headerConfigKeys", "extraAuthorizeParams",
        "isEnabled", version, "createdAt", "lastUpdatedAt"
      ) VALUES (${r.id}, ${r.name}, ${r.description}, ${r.scope}, ${r.ownerAgentId}, ${r.transport},
        ${r.command}, ${r.args}, ${r.url}, ${r.headers}, ${r.envConfigKeys}, ${r.headerConfigKeys},
        ${r.extraAuthorizeParams}, ${true}, 1, ${r.createdAt}, ${r.lastUpdatedAt})
      RETURNING *`);
  }

  async countMcpServers(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM mcp_servers`,
    );
    return row?.count ?? 0;
  }

  updateMcpServer(id: string, u: McpServerColumnUpdate, now: string): Promise<McpServerRow | null> {
    const columns: (keyof McpServerColumnUpdate)[] = [
      "name",
      "description",
      "scope",
      "transport",
      "command",
      "args",
      "url",
      "headers",
      "envConfigKeys",
      "headerConfigKeys",
      "extraAuthorizeParams",
      "isEnabled",
      "ownerAgentId",
      "authMethod",
    ];
    const sets: SqlQuery[] = [sql`"lastUpdatedAt" = ${now}`];
    for (const column of columns) {
      const value = u[column];
      if (value !== undefined) sets.push(sql`${sqlIdent(column)} = ${value}`);
    }
    if (MCP_CONFIG_COLUMNS.some((column) => u[column] !== undefined)) {
      sets.push(sql`version = version + 1`);
    }
    return this.db.get<McpServerRow>(
      sql`UPDATE mcp_servers SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async deleteMcpServerCascade(
    id: string,
  ): Promise<{ servers: number; scriptConnections: number }> {
    const connections = await this.db.run(
      sql`DELETE FROM script_connections WHERE mcp_server_id = ${id}`,
    );
    const servers = await this.db.run(sql`DELETE FROM mcp_servers WHERE id = ${id}`);
    return { servers: servers.changes, scriptConnections: connections.changes };
  }

  findMcpServerById(id: string): Promise<McpServerRow | null> {
    return this.db.get<McpServerRow>(sql`SELECT * FROM mcp_servers WHERE id = ${id}`);
  }

  findMcpServerByName(
    name: string,
    scope: string,
    ownerAgentId: string,
  ): Promise<McpServerRow | null> {
    return this.db.get<McpServerRow>(sql`
      SELECT * FROM mcp_servers
      WHERE name = ${name} AND scope = ${scope} AND COALESCE("ownerAgentId", '') = ${ownerAgentId}`);
  }

  listMcpServers(f: McpServerListFilter): Promise<McpServerRow[]> {
    const c: SqlQuery[] = [sql`1=1`];
    if (f.scope) c.push(sql`scope = ${f.scope}`);
    if (f.ownerAgentId) c.push(sql`"ownerAgentId" = ${f.ownerAgentId}`);
    if (f.transport) c.push(sql`transport = ${f.transport}`);
    if (f.isEnabled !== undefined) c.push(sql`"isEnabled" = ${f.isEnabled}`);
    if (f.search) {
      const term = sql`${`%${f.search}%`}`;
      c.push(sql`(${likeAsciiCi(sql`name`, term)} OR ${likeAsciiCi(sql`description`, term)})`);
    }
    return this.db.query<McpServerRow>(sql`
      SELECT * FROM mcp_servers WHERE ${sqlJoin(c, sql` AND `)}
      ORDER BY name ASC, ${this.insertionOrder()} ASC`);
  }

  listAgentMcpServers(agentId: string, activeOnly: boolean): Promise<McpServerWithInstallRow[]> {
    const active = activeOnly ? sql` AND ams."isActive" = ${true}` : EMPTY;
    return this.db.query<McpServerWithInstallRow>(sql`
      SELECT ms.*, ams."isActive", ams."installedAt"
      FROM mcp_servers ms
      JOIN agent_mcp_servers ams ON ms.id = ams."mcpServerId"
      WHERE ams."agentId" = ${agentId}${active}
        AND ms."isEnabled" = ${true}
      ORDER BY ms.name ASC, ${this.insertionOrder("ms")} ASC`);
  }
}
