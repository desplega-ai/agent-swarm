import {
  type AgentHistoryRow,
  type AgentLogRow,
  type AgentRow,
  BaseAgentsRepository,
  type ContextVersionRow,
  type ServiceRow,
  type SqlQuery,
  sql,
  sqlIdent,
  sqlJoin,
} from "@desplega/storage";

/** The `agents` columns in table order, without the `_rowid` surrogate. */
const AGENT_COLUMNS = sql`
  SELECT column_name AS name, data_type AS type FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name <> '_rowid'
   ORDER BY ordinal_position`;

/** A value in the SQLite shape, converted to a column of `type`. */
function snapshotValue(value: string | number | null, type: string | undefined): SqlQuery {
  switch (type) {
    case "boolean":
      // Flags arrive as 0/1 (or text digits from an old snapshot).
      return sql`(CAST(CAST(${value === null ? null : String(value)} AS text) AS numeric) <> 0)`;
    case "jsonb":
      return sql`CAST(CAST(${value === null ? null : String(value)} AS text) AS jsonb)`;
    default:
      return sql`${value}`;
  }
}

export class PostgresAgentsRepository extends BaseAgentsRepository {
  listAgents(opts: { includeExtensions: boolean }): Promise<AgentRow[]> {
    return this.db.query<AgentRow>(
      opts.includeExtensions
        ? sql`SELECT * FROM agents ORDER BY name, "_rowid"`
        : sql`SELECT * FROM agents WHERE ${this.notExtensionAgent()} ORDER BY name, "_rowid"`,
    );
  }

  listAgentsByHarnessProvider(provider: string): Promise<AgentRow[]> {
    return this.db.query<AgentRow>(
      sql`SELECT * FROM agents WHERE harness_provider = ${provider} ORDER BY name, "_rowid"`,
    );
  }

  async insertAgentSnapshot(columns: string[], values: (string | number | null)[]): Promise<void> {
    const types = new Map(
      (await this.db.query<{ name: string; type: string }>(AGENT_COLUMNS)).map((c) => [
        c.name,
        c.type,
      ]),
    );
    const names = sqlJoin(
      columns.map((column) => sql`${sqlIdent(column)}`),
      sql`, `,
    );
    const converted = sqlJoin(
      columns.map((column, i) => snapshotValue(values[i] ?? null, types.get(column))),
      sql`, `,
    );
    await this.db.run(sql`INSERT INTO agents (${names}) VALUES (${converted})`);
  }

  async listAgentColumns(): Promise<string[]> {
    const rows = await this.db.query<{ name: string }>(AGENT_COLUMNS);
    return rows.map((row) => row.name);
  }

  latestHistory(agentId: string): Promise<AgentHistoryRow | null> {
    return this.db.get<AgentHistoryRow>(sql`
      SELECT * FROM agent_history WHERE agent_id = ${agentId}
      ORDER BY created_at DESC, "_rowid" DESC LIMIT 1`);
  }

  listHistory(agentId: string | undefined, limit: number): Promise<AgentHistoryRow[]> {
    const where = agentId === undefined ? sql`` : sql` WHERE agent_id = ${agentId}`;
    return this.db.query<AgentHistoryRow>(sql`
      SELECT * FROM agent_history${where}
      ORDER BY created_at DESC, "_rowid" DESC LIMIT ${limit}`);
  }

  latestContextVersion(agentId: string, field: string): Promise<ContextVersionRow | null> {
    return this.db.get<ContextVersionRow>(sql`
      SELECT * FROM context_versions WHERE "agentId" = ${agentId} AND field = ${field}
      ORDER BY version DESC, "_rowid" ASC LIMIT 1`);
  }

  listContextVersions(
    agentId: string,
    field: string | undefined,
    limit: number,
  ): Promise<ContextVersionRow[]> {
    return field === undefined
      ? this.db.query<ContextVersionRow>(sql`
          SELECT * FROM context_versions WHERE "agentId" = ${agentId}
          ORDER BY "createdAt" DESC, "_rowid" ASC LIMIT ${limit}`)
      : this.db.query<ContextVersionRow>(sql`
          SELECT * FROM context_versions WHERE "agentId" = ${agentId} AND field = ${field}
          ORDER BY version DESC, "_rowid" ASC LIMIT ${limit}`);
  }

  listLogsByTask(taskId: string, limit: number): Promise<AgentLogRow[]> {
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log WHERE "taskId" = ${taskId}
      ORDER BY "createdAt" DESC, "_rowid" ASC LIMIT ${limit}`);
  }

  listLogsByTaskChronological(taskId: string, eventType?: string): Promise<AgentLogRow[]> {
    const event = eventType === undefined ? sql`` : sql` AND "eventType" = ${eventType}`;
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log WHERE "taskId" = ${taskId}${event}
      ORDER BY "createdAt" ASC, "_rowid" ASC`);
  }

  listLogsByEventType(eventType: string): Promise<AgentLogRow[]> {
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log WHERE "eventType" = ${eventType}
      ORDER BY "createdAt" DESC, "_rowid" ASC`);
  }

  listServices(filters: {
    agentId?: string;
    nameLike?: string;
    status?: string;
  }): Promise<ServiceRow[]> {
    // A status outside the four sorts NULL on SQLite, which comes first.
    return this.db.query<ServiceRow>(sql`
      SELECT * FROM services${this.serviceFilters(filters)}
      ORDER BY CASE status
        WHEN 'healthy' THEN 1
        WHEN 'starting' THEN 2
        WHEN 'unhealthy' THEN 3
        WHEN 'stopped' THEN 4
      END NULLS FIRST, name, "_rowid"`);
  }

  async dailyTaskCounts(
    agentId: string,
    sinceDay: string,
  ): Promise<{ date: string; count: number }[]> {
    // The UTC day of the ISO text SQLite stores; the session time zone is UTC.
    const rows = await this.db.query<{ date: string; count: number | string }>(sql`
      SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, COUNT(*) AS count
        FROM agent_tasks
       WHERE "agentId" = ${agentId} AND "createdAt" >= CAST(${sinceDay} AS timestamptz)
       GROUP BY 1
       ORDER BY 1`);
    return rows.map((row) => ({ date: row.date, count: Number(row.count) }));
  }

  async listAgentNames(): Promise<(string | null)[]> {
    const rows = await this.db.query<{ name: string | null }>(
      sql`SELECT name FROM agents ORDER BY "_rowid"`,
    );
    return rows.map((row) => row.name);
  }

  async countRecentQueuePickups(since: string): Promise<number> {
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count
        FROM agent_log
       WHERE "eventType" IN ('task_status_change', 'task_claimed')
         AND "oldValue" IN ('pending', 'unassigned')
         AND "newValue" = 'in_progress'
         AND "createdAt" >= ${since}`);
    return row?.count ?? 0;
  }

  protected logOrder(): SqlQuery {
    return sql`"_rowid"`;
  }

  countLiveAgents(
    minutes: number,
  ): Promise<{ leads_alive: number | null; workers_alive: number | null } | null> {
    return this.db.get(sql`
      SELECT
        SUM(CASE WHEN "isLead" = ${true} THEN 1 ELSE 0 END) AS leads_alive,
        SUM(CASE WHEN "isLead" = ${false} THEN 1 ELSE 0 END) AS workers_alive
      FROM agents
      WHERE "lastActivityAt" IS NOT NULL
        AND "lastActivityAt" >= statement_timestamp() - CAST(${minutes} AS double precision) * interval '1 minute'
        AND status != 'offline'`);
  }
}
