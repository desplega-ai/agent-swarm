import {
  type AgentHistoryRow,
  type AgentLogRow,
  type AgentRow,
  BaseAgentsRepository,
  type ContextVersionRow,
  type ServiceRow,
  SqlQuery,
  sql,
  sqlIdent,
  sqlJoin,
  sqlList,
} from "@desplega/storage";

export class SqliteAgentsRepository extends BaseAgentsRepository {
  protected logOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }

  countLiveAgents(
    minutes: number,
  ): Promise<{ leads_alive: number | null; workers_alive: number | null } | null> {
    return this.db.get(sql`
      SELECT
        SUM(CASE WHEN "isLead" = 1 THEN 1 ELSE 0 END) AS leads_alive,
        SUM(CASE WHEN "isLead" = 0 THEN 1 ELSE 0 END) AS workers_alive
      FROM agents
      WHERE "lastActivityAt" IS NOT NULL
        AND "lastActivityAt" >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ${minutes} || ' minutes')
        AND status != 'offline'`);
  }

  listAgents(opts: { includeExtensions: boolean }): Promise<AgentRow[]> {
    return this.db.query<AgentRow>(
      opts.includeExtensions
        ? sql`SELECT * FROM agents ORDER BY name, rowid`
        : sql`SELECT * FROM agents WHERE ${this.notExtensionAgent()} ORDER BY name, rowid`,
    );
  }

  listAgentsByHarnessProvider(provider: string): Promise<AgentRow[]> {
    return this.db.query<AgentRow>(
      sql`SELECT * FROM agents WHERE harness_provider = ${provider} ORDER BY name, rowid`,
    );
  }

  async insertAgentSnapshot(columns: string[], values: (string | number | null)[]): Promise<void> {
    const names = sqlJoin(
      columns.map((column) => sql`${sqlIdent(column)}`),
      sql`, `,
    );
    await this.db.run(sql`INSERT INTO agents (${names}) VALUES (${sqlList(values)})`);
  }

  async listAgentColumns(): Promise<string[]> {
    const rows = await this.db.query<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('agents')`,
    );
    return rows.map((row) => row.name);
  }

  latestHistory(agentId: string): Promise<AgentHistoryRow | null> {
    return this.db.get<AgentHistoryRow>(sql`
      SELECT * FROM agent_history WHERE agent_id = ${agentId}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  }

  listHistory(agentId: string | undefined, limit: number): Promise<AgentHistoryRow[]> {
    const where = agentId === undefined ? sql`` : sql` WHERE agent_id = ${agentId}`;
    return this.db.query<AgentHistoryRow>(sql`
      SELECT * FROM agent_history${where}
      ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`);
  }

  latestContextVersion(agentId: string, field: string): Promise<ContextVersionRow | null> {
    return this.db.get<ContextVersionRow>(sql`
      SELECT * FROM context_versions WHERE "agentId" = ${agentId} AND field = ${field}
      ORDER BY version DESC, rowid ASC LIMIT 1`);
  }

  listContextVersions(
    agentId: string,
    field: string | undefined,
    limit: number,
  ): Promise<ContextVersionRow[]> {
    return field === undefined
      ? this.db.query<ContextVersionRow>(sql`
          SELECT * FROM context_versions WHERE "agentId" = ${agentId}
          ORDER BY "createdAt" DESC, rowid ASC LIMIT ${limit}`)
      : this.db.query<ContextVersionRow>(sql`
          SELECT * FROM context_versions WHERE "agentId" = ${agentId} AND field = ${field}
          ORDER BY version DESC, rowid ASC LIMIT ${limit}`);
  }

  listLogsByTask(taskId: string, limit: number): Promise<AgentLogRow[]> {
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log WHERE "taskId" = ${taskId}
      ORDER BY "createdAt" DESC, rowid ASC LIMIT ${limit}`);
  }

  listLogsByTaskChronological(taskId: string, eventType?: string): Promise<AgentLogRow[]> {
    const event = eventType === undefined ? sql`` : sql` AND "eventType" = ${eventType}`;
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log WHERE "taskId" = ${taskId}${event}
      ORDER BY "createdAt" ASC, rowid ASC`);
  }

  listLogsByEventType(eventType: string): Promise<AgentLogRow[]> {
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log WHERE "eventType" = ${eventType}
      ORDER BY "createdAt" DESC, rowid ASC`);
  }

  async countRecentQueuePickups(since: string): Promise<number> {
    // Unary + keeps eventType off idx_agent_log_eventType, so the short
    // createdAt window drives through idx_agent_log_createdAt instead of every
    // status-change row ever logged. The hint stays unquoted: the query-audit
    // plan test reverts it by text.
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count
        FROM agent_log
       WHERE ${new SqlQuery(["+eventType"], [])} IN ('task_status_change', 'task_claimed')
         AND "oldValue" IN ('pending', 'unassigned')
         AND "newValue" = 'in_progress'
         AND "createdAt" >= ${since}`);
    return row?.count ?? 0;
  }

  listServices(filters: {
    agentId?: string;
    nameLike?: string;
    status?: string;
  }): Promise<ServiceRow[]> {
    return this.db.query<ServiceRow>(sql`
      SELECT * FROM services${this.serviceFilters(filters)}
      ORDER BY CASE status
        WHEN 'healthy' THEN 1
        WHEN 'starting' THEN 2
        WHEN 'unhealthy' THEN 3
        WHEN 'stopped' THEN 4
      END, name, rowid`);
  }

  async dailyTaskCounts(
    agentId: string,
    sinceDay: string,
  ): Promise<{ date: string; count: number }[]> {
    const rows = await this.db.query<{ date: string; count: number | string }>(sql`
      SELECT substr("createdAt", 1, 10) AS date, COUNT(*) AS count
        FROM agent_tasks
       WHERE "agentId" = ${agentId} AND "createdAt" >= ${sinceDay}
       GROUP BY date
       ORDER BY date`);
    return rows.map((row) => ({ date: row.date, count: Number(row.count) }));
  }

  async listAgentNames(): Promise<(string | null)[]> {
    const rows = await this.db.query<{ name: string | null }>(
      sql`SELECT name FROM agents ORDER BY rowid`,
    );
    return rows.map((row) => row.name);
  }
}
