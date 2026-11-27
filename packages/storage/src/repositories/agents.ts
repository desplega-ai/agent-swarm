import { forUpdate, jsonText, likeAsciiCi, nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlIdent, sqlJoin, sqlList, sqlWhere } from "../sql";
import { readableSessionSql } from "./tasks";

/**
 * Domain: agents (`agents`, `agent_log`, `agent_history`, `agent_mcp_servers`,
 * `agent_skills`, `active_sessions`, `services`, `context_versions`). Rows
 * come back in the SQLite value shape on every engine (flags 0/1, JSON as
 * text, timestamps as the text the column stores).
 */

/** The values the `agents.status` CHECK constraint allows, on both engines. */
export const AGENT_STATUSES = ["idle", "busy", "offline", "waiting_for_credentials"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type AgentRow = {
  id: string;
  name: string;
  isLead: number;
  status: AgentStatus;
  description: string | null;
  role: string | null;
  capabilities: string | null;
  maxTasks: number | null;
  emptyPollCount: number | null;
  claudeMd: string | null;
  soulMd: string | null;
  identityMd: string | null;
  setupScript: string | null;
  toolsMd: string | null;
  heartbeatMd: string | null;
  lastActivityAt: string | null;
  provider: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  credentialMissing: string | null;
  harness_provider: string | null;
  cred_status: string | null;
  avatar: string | null;
  slack_icon: string | null;
  runtime_pool_id: string | null;
  runtime_provision_attempts: number;
  runtime_provision_retry_at: string | null;
};

export type NewAgent = {
  id: string;
  name: string;
  isLead: boolean;
  status: AgentStatus;
  maxTasks: number;
  provider: string | null;
  harnessProvider: string | null;
};

/** Profile columns an update may set. `undefined`/`null` keeps the stored value. */
export type AgentProfileUpdate = {
  name: string | null;
  description: string | null;
  role: string | null;
  capabilities: string | null;
  claudeMd: string | null;
  soulMd: string | null;
  identityMd: string | null;
  setupScript: string | null;
  toolsMd: string | null;
  heartbeatMd: string | null;
  /** `set: true` writes `value` (null resets); `set: false` keeps the column. */
  avatar: { set: boolean; value: string | null };
  slackIcon: { set: boolean; value: string | null };
  now: string;
};

/** Single agent columns a plain setter may write. */
export type AgentSimpleColumn =
  | "status"
  | "maxTasks"
  | "provider"
  | "harness_provider"
  | "cred_status"
  | "credentialMissing";

/** Values for `setAgentColumns`: `status` takes only the statuses the CHECK allows. */
export type AgentColumnValues = Partial<
  { status: AgentStatus } & Record<Exclude<AgentSimpleColumn, "status">, string | number | null>
>;

export type AgentHistoryRow = {
  id: string;
  agent_id: string;
  event: "deleted" | "restored";
  actor_ref: string;
  reason: string;
  snapshot_json: string;
  created_at: string;
};

export type ContextVersionRow = {
  id: string;
  agentId: string;
  field: string;
  content: string;
  version: number;
  changeSource: string;
  changedByAgentId: string | null;
  changeReason: string | null;
  contentHash: string;
  previousVersionId: string | null;
  createdAt: string;
};

export type ActiveSessionRow = {
  id: string;
  agentId: string;
  taskId: string | null;
  triggerType: string;
  inboxMessageId: string | null;
  taskDescription: string | null;
  runnerSessionId: string | null;
  providerSessionId: string | null;
  runtimeInstanceId: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
};

export type NewActiveSession = {
  id: string;
  agentId: string;
  taskId: string | null;
  triggerType: string;
  inboxMessageId: string | null;
  taskDescription: string | null;
  runnerSessionId: string | null;
  runtimeInstanceId: string | null;
  now: string;
};

export type AgentLogRow = {
  id: string;
  eventType: string;
  agentId: string | null;
  taskId: string | null;
  oldValue: string | null;
  newValue: string | null;
  metadata: string | null;
  createdAt: string;
};

export type NewAgentLog = Omit<AgentLogRow, "createdAt">;

export type ServiceRow = {
  id: string;
  agentId: string;
  name: string;
  port: number;
  description: string | null;
  url: string | null;
  healthCheckPath: string | null;
  status: "starting" | "healthy" | "unhealthy" | "stopped";
  script: string;
  cwd: string | null;
  interpreter: string | null;
  args: string | null;
  env: string | null;
  metadata: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

/** The definition columns of a service (insert and upsert). */
export type ServiceDefinition = {
  port: number;
  description: string | null;
  url: string | null;
  healthCheckPath: string | null;
  script: string;
  cwd: string | null;
  interpreter: string | null;
  args: string | null;
  env: string | null;
  metadata: string;
};

export type AgentInstallRow = {
  id: string;
  agentId: string;
  isActive: number;
  installedAt: string;
};

/** Counts of the rows that refuse an agent delete, by blocker code. */
export type AgentDeleteBlockerCounts = {
  open_tasks: number;
  schedules: number;
  owned_skills: number;
  owned_mcp_servers: number;
  inboxes: number;
};

/** The role an extension identity row carries; such rows are hidden from listings. */
const EXTENSION_ROLE = "extension";

const notExtension = sql`COALESCE(role, '') != ${EXTENSION_ROLE}`;

export interface AgentsRepository {
  // ---- agents ----
  findAgentById(id: string): Promise<AgentRow | null>;
  /** The full row as a plain record (an agent_history snapshot). */
  findAgentSnapshot(id: string): Promise<Record<string, unknown> | null>;
  /** An agent named `name` other than `exceptId` (any agent when omitted). */
  findAgentIdByName(name: string, exceptId?: string): Promise<string | null>;
  findAgentByNameExcept(name: string, exceptId: string): Promise<AgentRow | null>;
  /**
   * Agents ordered by name, then insertion order. Extension identities are
   * left out unless `includeExtensions`.
   */
  listAgents(opts: { includeExtensions: boolean }): Promise<AgentRow[]>;
  /** Agents whose harness provider is `provider`, by name then insertion order. */
  listAgentsByHarnessProvider(provider: string): Promise<AgentRow[]>;
  /** Non-extension agents counted by status, in status order. */
  countAgentsByStatus(): Promise<{ status: string; count: number }[]>;
  /** Agents with a harness provider counted by it, in provider order. */
  countAgentsByHarnessProvider(): Promise<{ provider: string; count: number }[]>;
  insertAgent(agent: NewAgent): Promise<AgentRow | null>;
  /** Re-inserts a snapshot row; `columns` are names that exist on `agents`. */
  insertAgentSnapshot(columns: string[], values: (string | number | null)[]): Promise<void>;
  /** Column names of `agents` in table order. */
  listAgentColumns(): Promise<string[]>;
  /** Sets the given columns plus `lastUpdatedAt` to now. */
  setAgentColumns(id: string, values: AgentColumnValues): Promise<AgentRow | null>;
  /** COALESCE profile update; see {@link AgentProfileUpdate}. */
  updateAgentProfile(id: string, update: AgentProfileUpdate): Promise<AgentRow | null>;
  touchAgentActivity(id: string): Promise<void>;
  /** Sets only `lastUpdatedAt` to now; returns it, or null for an unknown agent. */
  touchAgentUpdatedAt(id: string): Promise<string | null>;
  /** Returns the new count, or null for an unknown agent. */
  incrementEmptyPollCount(id: string): Promise<number | null>;
  resetEmptyPollCount(id: string): Promise<void>;
  deleteAgent(id: string): Promise<number>;
  /** Rows of other tables that refuse deleting the agent. */
  countDeleteBlockers(
    agentId: string,
    terminalTaskStatuses: readonly string[],
  ): Promise<AgentDeleteBlockerCounts>;

  // ---- agent_history ----
  insertHistory(row: AgentHistoryRow): Promise<AgentHistoryRow | null>;
  /** The newest event of the agent (ties: the later insert). */
  latestHistory(agentId: string): Promise<AgentHistoryRow | null>;
  /** Newest first (ties: later insert first); at most `limit` rows. */
  listHistory(agentId: string | undefined, limit: number): Promise<AgentHistoryRow[]>;

  // ---- agent_skills / agent_mcp_servers (install rows only) ----
  deleteAgentSkills(agentId: string): Promise<void>;
  deleteAgentMcpServers(agentId: string): Promise<void>;

  // ---- agent_log ----
  /** Inserts the entry with `createdAt` = now. */
  insertLog(entry: NewAgentLog): Promise<AgentLogRow | null>;
  /** The task's entries, newest first (ties: insertion order); at most `limit`. */
  listLogsByTask(taskId: string, limit: number): Promise<AgentLogRow[]>;
  /** The task's entries, oldest first (ties: insertion order); optionally one event type. */
  listLogsByTaskChronological(taskId: string, eventType?: string): Promise<AgentLogRow[]>;
  /** Entries of one event type, newest first (ties: insertion order). */
  listLogsByEventType(eventType: string): Promise<AgentLogRow[]>;
  /** True when the task has an entry of `eventType`. */
  hasTaskLogEvent(taskId: string, eventType: string): Promise<boolean>;
  /**
   * The task's newest entry of `eventType` by `createdAt` (a tie picks the
   * row the engine meets first).
   */
  findLatestTaskLog(
    taskId: string,
    eventType: string,
  ): Promise<{ id: string; metadata: string | null } | null>;
  /** Replaces an entry's metadata. Returns the changed count. */
  setLogMetadata(id: string, metadata: string): Promise<number>;
  /**
   * Status changes and claims from `pending`/`unassigned` to `in_progress`
   * logged at or after `since`.
   */
  countRecentQueuePickups(since: string): Promise<number>;

  // ---- services ----
  insertService(
    s: ServiceDefinition & { id: string; agentId: string; name: string; now: string },
  ): Promise<ServiceRow | null>;
  findServiceById(id: string): Promise<ServiceRow | null>;
  findServiceByAgentAndName(agentId: string, name: string): Promise<ServiceRow | null>;
  /** The agent's services by name (unique per agent). */
  listServicesByAgent(agentId: string): Promise<ServiceRow[]>;
  /**
   * Services matching the filters (`nameLike` is a substring, ASCII case
   * folded). Ordered healthy, starting, unhealthy, stopped; then name; then
   * insertion order.
   */
  listServices(filters: {
    agentId?: string;
    nameLike?: string;
    status?: string;
  }): Promise<ServiceRow[]>;
  setServiceStatus(id: string, status: string, now: string): Promise<ServiceRow | null>;
  updateServiceDefinition(
    id: string,
    d: ServiceDefinition,
    now: string,
  ): Promise<ServiceRow | null>;
  deleteService(id: string): Promise<number>;
  deleteServicesByAgent(agentId: string): Promise<number>;

  // ---- agent_skills / agent_mcp_servers installs ----
  /** Insert, or re-activate the `(agentId, skillId)` row. */
  installSkill(
    id: string,
    agentId: string,
    skillId: string,
    now: string,
  ): Promise<(AgentInstallRow & { skillId: string }) | null>;
  uninstallSkill(agentId: string, skillId: string): Promise<number>;
  setSkillActive(agentId: string, skillId: string, isActive: boolean): Promise<number>;
  /** Insert, or re-activate the `(agentId, mcpServerId)` row. */
  installMcpServer(
    id: string,
    agentId: string,
    mcpServerId: string,
    now: string,
  ): Promise<(AgentInstallRow & { mcpServerId: string }) | null>;
  uninstallMcpServer(agentId: string, mcpServerId: string): Promise<number>;

  // ---- context_versions ----
  insertContextVersion(row: ContextVersionRow): Promise<ContextVersionRow | null>;
  /** Highest version of the field (ties: the earlier insert). */
  latestContextVersion(agentId: string, field: string): Promise<ContextVersionRow | null>;
  findContextVersion(id: string): Promise<ContextVersionRow | null>;
  /**
   * With `field`: that field's versions, highest first. Without: every field,
   * newest first. Ties: insertion order. At most `limit` rows.
   */
  listContextVersions(
    agentId: string,
    field: string | undefined,
    limit: number,
  ): Promise<ContextVersionRow[]>;

  // ---- active_sessions ----
  insertActiveSession(row: NewActiveSession): Promise<ActiveSessionRow | null>;
  findActiveSessionById(id: string): Promise<ActiveSessionRow | null>;
  findActiveSessionByTask(taskId: string): Promise<ActiveSessionRow | null>;
  deleteActiveSessionByTask(taskId: string): Promise<number>;
  deleteActiveSessionById(id: string): Promise<number>;
  deleteActiveSessionsByAgent(agentId: string): Promise<number>;
  deleteActiveSessionsBefore(cutoff: string): Promise<number>;
  /** Sets `lastHeartbeatAt`; with `onlyBefore`, only when the stored value is older. */
  heartbeatActiveSession(taskId: string, now: string, onlyBefore?: string): Promise<number>;
  setActiveSessionProviderSessionId(taskId: string, providerSessionId: string): Promise<number>;

  // ---- capacity and activity (reads of agent_tasks keyed by agent) ----
  /** Tasks in one of the agent's slots: its in-progress tasks and the offers it is reviewing. */
  countActiveTasks(agentId: string): Promise<number>;
  /** `countActiveTasks` for many agents in one statement. Agents with no active task are absent. */
  countActiveTasksByAgent(agentIds: readonly string[]): Promise<Map<string, number>>;
  /**
   * Locks the agent row for the rest of the transaction (Postgres `FOR UPDATE`).
   * Serializes the transactions that hold it for one agent. True when the row exists.
   */
  lockAgent(agentId: string): Promise<boolean>;
  /**
   * Tasks created per UTC day (`YYYY-MM-DD`) on or after `sinceDay`, oldest
   * first. Days with no task are absent.
   */
  dailyTaskCounts(agentId: string, sinceDay: string): Promise<{ date: string; count: number }[]>;

  // ---- worker-reported model columns ----
  /** The stored `modelTierOverrides` JSON text; null when unset or no agent. */
  getModelTierOverrides(id: string): Promise<string | null>;
  /** True when the agent exists and its `modelTierOverrides` differs from `next` (NULL-safe). */
  modelTierOverridesDiffer(id: string, next: string | null): Promise<boolean>;
  /** Sets `modelTierOverrides`; no write when the stored value equals `next` (NULL-safe). */
  setModelTierOverrides(id: string, next: string | null): Promise<void>;
  /** The stored `harnessCliVersion`; null when unset or no agent. */
  getHarnessCliVersion(id: string): Promise<string | null>;
  /** Sets `harnessCliVersion`; no write when the stored value equals `next` (NULL-safe). */
  setHarnessCliVersion(id: string, next: string | null): Promise<void>;
  /** Ids of up to `limit` non-extension agents named `name`. Ordered by id (unique). */
  listNonExtensionAgentIdsByName(name: string | null, limit: number): Promise<string[]>;
  /** Installs an active skill unless the agent has it already. True when a row was written. */
  installSkillIfAbsent(id: string, agentId: string, skillId: string, now: string): Promise<boolean>;
  /** Active installs per MCP server id; servers with no active install are absent. Ordered by server id. */
  countActiveMcpServerInstalls(): Promise<{ mcpServerId: string; installs: number }[]>;
  /** Every agent name (extension rows too). Insertion order. */
  listAgentNames(): Promise<(string | null)[]>;
  /** The earliest agent `createdAt`, or null with no agent. */
  firstAgentCreatedAt(): Promise<string | null>;
  /** `isLead`, `provider`, `harness_provider` of the agents among `ids`. Ordered by id. */
  listSteeringFieldsByIds(
    ids: readonly string[],
  ): Promise<
    { id: string; isLead: number; provider: string | null; harness_provider: string | null }[]
  >;
  /** Every agent row, extension identities included. */
  countAllAgents(): Promise<number>;
  /** Agents that are not extension identities. */
  countNonExtensionAgents(): Promise<number>;
  // ---- agent_log: agent and global feeds ----
  /** One agent's log, newest first, then insertion order (newest first). */
  listLogsByAgent(agentId: string, readableBy?: { userId: string | null }): Promise<AgentLogRow[]>;
  /**
   * The log, newest first, then insertion order (newest first). With `limit`,
   * agent status changes are left out.
   */
  listAllLogs(
    limit: number | undefined,
    readableBy?: { userId: string | null },
  ): Promise<AgentLogRow[]>;

  // ---- active_sessions ----
  /** Newest `startedAt` first, then insertion order (newest first). */
  listActiveSessions(
    agentId: string | undefined,
    readableBy?: { userId: string | null },
  ): Promise<ActiveSessionRow[]>;
  countActiveSessions(): Promise<number>;

  // ---- agents: counts ----
  /** Idle non-lead agents, in insertion order. */
  listIdleWorkers(): Promise<AgentRow[]>;
  /** Non-offline leads and workers active in the last `minutes` (database clock). */
  countLiveAgents(
    minutes: number,
  ): Promise<{ leads_alive: number | null; workers_alive: number | null } | null>;
  /** Idle or busy leads and workers, extensions left out. */
  countReadyAgents(): Promise<{ leads: number | null; workers: number | null } | null>;
}

export abstract class BaseAgentsRepository implements AgentsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // ---- agents ----

  findAgentById(id: string): Promise<AgentRow | null> {
    return this.db.get<AgentRow>(sql`SELECT * FROM agents WHERE id = ${id}`);
  }

  findAgentSnapshot(id: string): Promise<Record<string, unknown> | null> {
    return this.db.get<Record<string, unknown>>(sql`SELECT * FROM agents WHERE id = ${id}`);
  }

  async findAgentIdByName(name: string, exceptId?: string): Promise<string | null> {
    const except = exceptId === undefined ? sql`` : sql` AND id != ${exceptId}`;
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM agents WHERE name = ${name}${except}`,
    );
    return row?.id ?? null;
  }

  findAgentByNameExcept(name: string, exceptId: string): Promise<AgentRow | null> {
    return this.db.get<AgentRow>(
      sql`SELECT * FROM agents WHERE name = ${name} AND id != ${exceptId}`,
    );
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listAgents(opts: { includeExtensions: boolean }): Promise<AgentRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listAgentsByHarnessProvider(provider: string): Promise<AgentRow[]>;

  protected notExtensionAgent(): SqlQuery {
    return notExtension;
  }

  async lockAgent(agentId: string): Promise<boolean> {
    return (
      (await this.db.get(sql`SELECT id FROM agents WHERE id = ${agentId}${forUpdate}`)) !== null
    );
  }

  async countActiveTasks(agentId: string): Promise<number> {
    const row = await this.db.get<{ count: number | string }>(sql`
      SELECT COUNT(*) AS count FROM agent_tasks
      WHERE ("agentId" = ${agentId} AND status = 'in_progress')
         OR ("offeredTo" = ${agentId} AND status = 'reviewing')`);
    return Number(row?.count ?? 0);
  }

  async countActiveTasksByAgent(agentIds: readonly string[]): Promise<Map<string, number>> {
    if (agentIds.length === 0) return new Map();
    // A task is either in_progress or reviewing, never both, so UNION ALL counts no row twice.
    const rows = await this.db.query<{ agent_id: string; count: number | string }>(sql`
      SELECT agent_id, COUNT(*) AS count FROM (
        SELECT "agentId" AS agent_id FROM agent_tasks
         WHERE status = 'in_progress' AND "agentId" IN (${sqlList(agentIds)})
        UNION ALL
        SELECT "offeredTo" AS agent_id FROM agent_tasks
         WHERE status = 'reviewing' AND "offeredTo" IN (${sqlList(agentIds)})
      ) slots GROUP BY agent_id`);
    return new Map(rows.map((row) => [row.agent_id, Number(row.count)]));
  }

  /** The day of a timestamp column differs per engine (text on SQLite). */
  abstract dailyTaskCounts(
    agentId: string,
    sinceDay: string,
  ): Promise<{ date: string; count: number }[]>;

  async countAgentsByStatus(): Promise<{ status: string; count: number }[]> {
    const rows = await this.db.query<{ status: string; count: number | string }>(sql`
      SELECT status, COUNT(*) AS count FROM agents WHERE ${notExtension}
      GROUP BY status ORDER BY status`);
    return rows.map((row) => ({ status: row.status, count: Number(row.count) }));
  }

  async countAgentsByHarnessProvider(): Promise<{ provider: string; count: number }[]> {
    const rows = await this.db.query<{ provider: string; count: number | string }>(sql`
      SELECT harness_provider AS provider, COUNT(*) AS count
      FROM agents
      WHERE harness_provider IS NOT NULL
      GROUP BY harness_provider
      ORDER BY harness_provider`);
    return rows.map((row) => ({ provider: row.provider, count: Number(row.count) }));
  }

  insertAgent(a: NewAgent): Promise<AgentRow | null> {
    return this.db.get<AgentRow>(sql`
      INSERT INTO agents (
        id, name, "isLead", status, "maxTasks", provider, harness_provider, "createdAt", "lastUpdatedAt"
      ) VALUES (
        ${a.id}, ${a.name}, ${a.isLead}, ${a.status}, ${a.maxTasks}, ${a.provider}, ${a.harnessProvider},
        ${nowIso}, ${nowIso}
      ) RETURNING *`);
  }

  /**
   * Values come in the SQLite value shape (flags 0/1, JSON as text): the
   * conversion to each column's type differs per engine.
   */
  abstract insertAgentSnapshot(
    columns: string[],
    values: (string | number | null)[],
  ): Promise<void>;

  /** Catalog query differs per engine (SQLite `pragma_table_info`). */
  abstract listAgentColumns(): Promise<string[]>;

  setAgentColumns(id: string, values: AgentColumnValues): Promise<AgentRow | null> {
    const sets: SqlQuery[] = [];
    for (const [column, value] of Object.entries(values)) {
      if (value === undefined) continue;
      sets.push(sql`${sqlIdent(column)} = ${value}`);
    }
    sets.push(sql`"lastUpdatedAt" = ${nowIso}`);
    return this.db.get<AgentRow>(
      sql`UPDATE agents SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  updateAgentProfile(id: string, u: AgentProfileUpdate): Promise<AgentRow | null> {
    return this.db.get<AgentRow>(sql`
      UPDATE agents SET
        name = COALESCE(${u.name}, name),
        description = COALESCE(${u.description}, description),
        role = COALESCE(${u.role}, role),
        capabilities = COALESCE(${jsonText(u.capabilities)}, capabilities),
        "claudeMd" = COALESCE(${u.claudeMd}, "claudeMd"),
        "soulMd" = COALESCE(${u.soulMd}, "soulMd"),
        "identityMd" = COALESCE(${u.identityMd}, "identityMd"),
        "setupScript" = COALESCE(${u.setupScript}, "setupScript"),
        "toolsMd" = COALESCE(${u.toolsMd}, "toolsMd"),
        "heartbeatMd" = COALESCE(${u.heartbeatMd}, "heartbeatMd"),
        avatar = CASE WHEN ${u.avatar.set} THEN ${u.avatar.value} ELSE avatar END,
        slack_icon = CASE WHEN ${u.slackIcon.set} THEN ${u.slackIcon.value} ELSE slack_icon END,
        "lastUpdatedAt" = ${u.now}
      WHERE id = ${id} RETURNING *`);
  }

  async touchAgentActivity(id: string): Promise<void> {
    await this.db.run(sql`UPDATE agents SET "lastActivityAt" = ${nowIso} WHERE id = ${id}`);
  }

  async touchAgentUpdatedAt(id: string): Promise<string | null> {
    const row = await this.db.get<{ lastUpdatedAt: string }>(
      sql`UPDATE agents SET "lastUpdatedAt" = ${nowIso} WHERE id = ${id} RETURNING "lastUpdatedAt"`,
    );
    return row?.lastUpdatedAt ?? null;
  }

  async incrementEmptyPollCount(id: string): Promise<number | null> {
    const row = await this.db.get<{ emptyPollCount: number }>(sql`
      UPDATE agents
      SET "emptyPollCount" = "emptyPollCount" + 1, "lastUpdatedAt" = ${nowIso}
      WHERE id = ${id}
      RETURNING "emptyPollCount"`);
    return row ? row.emptyPollCount : null;
  }

  async resetEmptyPollCount(id: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agents SET "emptyPollCount" = 0, "lastUpdatedAt" = ${nowIso} WHERE id = ${id}`);
  }

  async deleteAgent(id: string): Promise<number> {
    const result = await this.db.run(sql`DELETE FROM agents WHERE id = ${id}`);
    return result.changes;
  }

  async countDeleteBlockers(
    agentId: string,
    terminalTaskStatuses: readonly string[],
  ): Promise<AgentDeleteBlockerCounts> {
    const count = async (query: SqlQuery): Promise<number> =>
      Number((await this.db.get<{ n: number | string }>(query))?.n ?? 0);
    return {
      open_tasks: await count(sql`
        SELECT COUNT(*) AS n FROM agent_tasks
        WHERE ("agentId" = ${agentId} OR "offeredTo" = ${agentId})
          AND status NOT IN (${sqlList(terminalTaskStatuses)})`),
      schedules: await count(sql`
        SELECT COUNT(*) AS n FROM scheduled_tasks
        WHERE "targetAgentId" = ${agentId} AND enabled = ${true}`),
      owned_skills: await count(
        sql`SELECT COUNT(*) AS n FROM skills WHERE "ownerAgentId" = ${agentId}`,
      ),
      owned_mcp_servers: await count(
        sql`SELECT COUNT(*) AS n FROM mcp_servers WHERE "ownerAgentId" = ${agentId}`,
      ),
      inboxes: await count(
        sql`SELECT COUNT(*) AS n FROM agentmail_inbox_mappings WHERE "agentId" = ${agentId}`,
      ),
    };
  }

  // ---- agent_history ----

  insertHistory(r: AgentHistoryRow): Promise<AgentHistoryRow | null> {
    return this.db.get<AgentHistoryRow>(sql`
      INSERT INTO agent_history (id, agent_id, event, actor_ref, reason, snapshot_json, created_at)
      VALUES (${r.id}, ${r.agent_id}, ${r.event}, ${r.actor_ref}, ${r.reason}, ${jsonText(r.snapshot_json)}, ${r.created_at})
      RETURNING *`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract latestHistory(agentId: string): Promise<AgentHistoryRow | null>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listHistory(agentId: string | undefined, limit: number): Promise<AgentHistoryRow[]>;

  // ---- agent_skills / agent_mcp_servers ----

  async deleteAgentSkills(agentId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM agent_skills WHERE "agentId" = ${agentId}`);
  }

  async deleteAgentMcpServers(agentId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM agent_mcp_servers WHERE "agentId" = ${agentId}`);
  }

  // ---- agent_log ----

  insertLog(e: NewAgentLog): Promise<AgentLogRow | null> {
    return this.db.get<AgentLogRow>(sql`
      INSERT INTO agent_log (id, "eventType", "agentId", "taskId", "oldValue", "newValue", metadata, "createdAt")
      VALUES (${e.id}, ${e.eventType}, ${e.agentId}, ${e.taskId}, ${e.oldValue}, ${e.newValue}, ${e.metadata}, ${nowIso})
      RETURNING *`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listLogsByTask(taskId: string, limit: number): Promise<AgentLogRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listLogsByTaskChronological(taskId: string, eventType?: string): Promise<AgentLogRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listLogsByEventType(eventType: string): Promise<AgentLogRow[]>;

  async hasTaskLogEvent(taskId: string, eventType: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM agent_log WHERE "taskId" = ${taskId} AND "eventType" = ${eventType} LIMIT 1`);
    return row != null;
  }

  findLatestTaskLog(
    taskId: string,
    eventType: string,
  ): Promise<{ id: string; metadata: string | null } | null> {
    return this.db.get(sql`
      SELECT id, metadata
        FROM agent_log
       WHERE "taskId" = ${taskId} AND "eventType" = ${eventType}
       ORDER BY "createdAt" DESC
       LIMIT 1`);
  }

  async setLogMetadata(id: string, metadata: string): Promise<number> {
    const result = await this.db.run(
      sql`UPDATE agent_log SET metadata = ${metadata} WHERE id = ${id}`,
    );
    return result.changes;
  }

  /** Keeps the SQLite index hint (unary `+`) that the query plan depends on. */
  abstract countRecentQueuePickups(since: string): Promise<number>;

  // ---- services ----

  insertService(
    s: ServiceDefinition & { id: string; agentId: string; name: string; now: string },
  ): Promise<ServiceRow | null> {
    return this.db.get<ServiceRow>(sql`
      INSERT INTO services (
        id, "agentId", name, port, description, url, "healthCheckPath", status, script, cwd,
        interpreter, args, env, metadata, "createdAt", "lastUpdatedAt"
      ) VALUES (
        ${s.id}, ${s.agentId}, ${s.name}, ${s.port}, ${s.description}, ${s.url}, ${s.healthCheckPath}, 'starting',
        ${s.script}, ${s.cwd}, ${s.interpreter}, ${jsonText(s.args)}, ${jsonText(s.env)}, ${jsonText(s.metadata)}, ${s.now}, ${s.now}
      ) RETURNING *`);
  }

  findServiceById(id: string): Promise<ServiceRow | null> {
    return this.db.get<ServiceRow>(sql`SELECT * FROM services WHERE id = ${id}`);
  }

  findServiceByAgentAndName(agentId: string, name: string): Promise<ServiceRow | null> {
    return this.db.get<ServiceRow>(
      sql`SELECT * FROM services WHERE "agentId" = ${agentId} AND name = ${name}`,
    );
  }

  listServicesByAgent(agentId: string): Promise<ServiceRow[]> {
    return this.db.query<ServiceRow>(
      sql`SELECT * FROM services WHERE "agentId" = ${agentId} ORDER BY name`,
    );
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listServices(filters: {
    agentId?: string;
    nameLike?: string;
    status?: string;
  }): Promise<ServiceRow[]>;

  protected serviceFilters(filters: {
    agentId?: string;
    nameLike?: string;
    status?: string;
  }): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (filters.agentId) conditions.push(sql`"agentId" = ${filters.agentId}`);
    if (filters.nameLike) {
      conditions.push(sql`${likeAsciiCi(sql`name`, sql`${`%${filters.nameLike}%`}`)}`);
    }
    if (filters.status) conditions.push(sql`status = ${filters.status}`);
    return sqlWhere(conditions);
  }

  setServiceStatus(id: string, status: string, now: string): Promise<ServiceRow | null> {
    return this.db.get<ServiceRow>(
      sql`UPDATE services SET status = ${status}, "lastUpdatedAt" = ${now} WHERE id = ${id} RETURNING *`,
    );
  }

  updateServiceDefinition(
    id: string,
    d: ServiceDefinition,
    now: string,
  ): Promise<ServiceRow | null> {
    return this.db.get<ServiceRow>(sql`
      UPDATE services SET
        port = ${d.port}, description = ${d.description}, url = ${d.url}, "healthCheckPath" = ${d.healthCheckPath},
        script = ${d.script}, cwd = ${d.cwd}, interpreter = ${d.interpreter}, args = ${jsonText(d.args)}, env = ${jsonText(d.env)},
        metadata = ${jsonText(d.metadata)}, "lastUpdatedAt" = ${now}
      WHERE id = ${id} RETURNING *`);
  }

  async deleteService(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM services WHERE id = ${id}`)).changes;
  }

  async deleteServicesByAgent(agentId: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM services WHERE "agentId" = ${agentId}`)).changes;
  }

  // ---- agent_skills / agent_mcp_servers installs ----

  installSkill(
    id: string,
    agentId: string,
    skillId: string,
    now: string,
  ): Promise<(AgentInstallRow & { skillId: string }) | null> {
    return this.db.get(sql`
      INSERT INTO agent_skills (id, "agentId", "skillId", "isActive", "installedAt")
      VALUES (${id}, ${agentId}, ${skillId}, ${true}, ${now})
      ON CONFLICT ("agentId", "skillId") DO UPDATE SET "isActive" = ${true}
      RETURNING *`);
  }

  async uninstallSkill(agentId: string, skillId: string): Promise<number> {
    return (
      await this.db.run(
        sql`DELETE FROM agent_skills WHERE "agentId" = ${agentId} AND "skillId" = ${skillId}`,
      )
    ).changes;
  }

  async setSkillActive(agentId: string, skillId: string, isActive: boolean): Promise<number> {
    return (
      await this.db.run(
        sql`UPDATE agent_skills SET "isActive" = ${isActive} WHERE "agentId" = ${agentId} AND "skillId" = ${skillId}`,
      )
    ).changes;
  }

  installMcpServer(
    id: string,
    agentId: string,
    mcpServerId: string,
    now: string,
  ): Promise<(AgentInstallRow & { mcpServerId: string }) | null> {
    return this.db.get(sql`
      INSERT INTO agent_mcp_servers (id, "agentId", "mcpServerId", "isActive", "installedAt")
      VALUES (${id}, ${agentId}, ${mcpServerId}, ${true}, ${now})
      ON CONFLICT ("agentId", "mcpServerId") DO UPDATE SET "isActive" = ${true}
      RETURNING *`);
  }

  async uninstallMcpServer(agentId: string, mcpServerId: string): Promise<number> {
    return (
      await this.db.run(
        sql`DELETE FROM agent_mcp_servers WHERE "agentId" = ${agentId} AND "mcpServerId" = ${mcpServerId}`,
      )
    ).changes;
  }

  // ---- context_versions ----

  insertContextVersion(r: ContextVersionRow): Promise<ContextVersionRow | null> {
    return this.db.get<ContextVersionRow>(sql`
      INSERT INTO context_versions (
        id, "agentId", field, content, version, "changeSource", "changedByAgentId",
        "changeReason", "contentHash", "previousVersionId", "createdAt"
      ) VALUES (
        ${r.id}, ${r.agentId}, ${r.field}, ${r.content}, ${r.version}, ${r.changeSource}, ${r.changedByAgentId},
        ${r.changeReason}, ${r.contentHash}, ${r.previousVersionId}, ${r.createdAt}
      ) RETURNING *`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract latestContextVersion(agentId: string, field: string): Promise<ContextVersionRow | null>;

  findContextVersion(id: string): Promise<ContextVersionRow | null> {
    return this.db.get<ContextVersionRow>(sql`SELECT * FROM context_versions WHERE id = ${id}`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listContextVersions(
    agentId: string,
    field: string | undefined,
    limit: number,
  ): Promise<ContextVersionRow[]>;

  // ---- active_sessions ----

  insertActiveSession(s: NewActiveSession): Promise<ActiveSessionRow | null> {
    return this.db.get<ActiveSessionRow>(sql`
      INSERT INTO active_sessions (
        id, "agentId", "taskId", "triggerType", "inboxMessageId", "taskDescription",
        "runnerSessionId", "runtimeInstanceId", "startedAt", "lastHeartbeatAt"
      ) VALUES (
        ${s.id}, ${s.agentId}, ${s.taskId}, ${s.triggerType}, ${s.inboxMessageId}, ${s.taskDescription},
        ${s.runnerSessionId}, ${s.runtimeInstanceId}, ${s.now}, ${s.now}
      ) RETURNING *`);
  }

  findActiveSessionById(id: string): Promise<ActiveSessionRow | null> {
    return this.db.get<ActiveSessionRow>(sql`SELECT * FROM active_sessions WHERE id = ${id}`);
  }

  findActiveSessionByTask(taskId: string): Promise<ActiveSessionRow | null> {
    return this.db.get<ActiveSessionRow>(
      sql`SELECT * FROM active_sessions WHERE "taskId" = ${taskId} LIMIT 1`,
    );
  }

  async deleteActiveSessionByTask(taskId: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM active_sessions WHERE "taskId" = ${taskId}`)).changes;
  }

  async deleteActiveSessionById(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM active_sessions WHERE id = ${id}`)).changes;
  }

  async deleteActiveSessionsByAgent(agentId: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM active_sessions WHERE "agentId" = ${agentId}`))
      .changes;
  }

  async deleteActiveSessionsBefore(cutoff: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM active_sessions WHERE "lastHeartbeatAt" < ${cutoff}`))
      .changes;
  }

  async heartbeatActiveSession(taskId: string, now: string, onlyBefore?: string): Promise<number> {
    const guard = onlyBefore === undefined ? sql`` : sql` AND "lastHeartbeatAt" < ${onlyBefore}`;
    return (
      await this.db.run(
        sql`UPDATE active_sessions SET "lastHeartbeatAt" = ${now} WHERE "taskId" = ${taskId}${guard}`,
      )
    ).changes;
  }

  async setActiveSessionProviderSessionId(
    taskId: string,
    providerSessionId: string,
  ): Promise<number> {
    return (
      await this.db.run(
        sql`UPDATE active_sessions SET "providerSessionId" = ${providerSessionId} WHERE "taskId" = ${taskId}`,
      )
    ).changes;
  }

  // ---- worker-reported model columns ----

  async getModelTierOverrides(id: string): Promise<string | null> {
    const row = await this.db.get<{ modelTierOverrides: string | null }>(
      sql`SELECT "modelTierOverrides" FROM agents WHERE id = ${id}`,
    );
    return row?.modelTierOverrides ?? null;
  }

  async modelTierOverridesDiffer(id: string, next: string | null): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM agents WHERE id = ${id} AND "modelTierOverrides" IS DISTINCT FROM ${next}`,
    );
    return row !== null;
  }

  async setModelTierOverrides(id: string, next: string | null): Promise<void> {
    await this.db.run(sql`
      UPDATE agents SET "modelTierOverrides" = ${next}
       WHERE id = ${id} AND "modelTierOverrides" IS DISTINCT FROM ${next}`);
  }

  async getHarnessCliVersion(id: string): Promise<string | null> {
    const row = await this.db.get<{ harnessCliVersion: string | null }>(
      sql`SELECT "harnessCliVersion" FROM agents WHERE id = ${id}`,
    );
    return row?.harnessCliVersion ?? null;
  }

  async setHarnessCliVersion(id: string, next: string | null): Promise<void> {
    await this.db.run(sql`
      UPDATE agents SET "harnessCliVersion" = ${next}
       WHERE id = ${id} AND "harnessCliVersion" IS DISTINCT FROM ${next}`);
  }

  async listNonExtensionAgentIdsByName(name: string | null, limit: number): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM agents WHERE name = ${name} AND ${notExtension} ORDER BY id LIMIT ${limit}`,
    );
    return rows.map((row) => row.id);
  }

  async installSkillIfAbsent(
    id: string,
    agentId: string,
    skillId: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO agent_skills (id, "agentId", "skillId", "isActive", "installedAt")
      VALUES (${id}, ${agentId}, ${skillId}, ${true}, ${now})
      ON CONFLICT ("agentId", "skillId") DO NOTHING`);
    return result.changes > 0;
  }

  countActiveMcpServerInstalls(): Promise<{ mcpServerId: string; installs: number }[]> {
    return this.db.query<{ mcpServerId: string; installs: number }>(sql`
      SELECT "mcpServerId", COUNT(*) AS installs
        FROM agent_mcp_servers
       WHERE "isActive" = ${true}
       GROUP BY "mcpServerId"
       ORDER BY "mcpServerId"`);
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listAgentNames(): Promise<(string | null)[]>;

  async firstAgentCreatedAt(): Promise<string | null> {
    const row = await this.db.get<{ first: string | null }>(
      sql`SELECT MIN("createdAt") AS first FROM agents`,
    );
    return row?.first ?? null;
  }

  async listSteeringFieldsByIds(
    ids: readonly string[],
  ): Promise<
    { id: string; isLead: number; provider: string | null; harness_provider: string | null }[]
  > {
    if (ids.length === 0) return [];
    return this.db.query<{
      id: string;
      isLead: number;
      provider: string | null;
      harness_provider: string | null;
    }>(sql`
      SELECT id, "isLead", provider, harness_provider FROM agents
       WHERE id IN (${sqlList(ids)}) ORDER BY id`);
  }

  async countAllAgents(): Promise<number> {
    const row = await this.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM agents`);
    return row?.n ?? 0;
  }

  async countNonExtensionAgents(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM agents WHERE ${notExtension}`,
    );
    return row?.count ?? 0;
  }

  // ---- agent_log: agent and global feeds ----

  protected abstract logOrder(): SqlQuery;

  listLogsByAgent(agentId: string, readableBy?: { userId: string | null }): Promise<AgentLogRow[]> {
    const readable = readableBy
      ? sql` AND ${readableSessionSql(readableBy.userId, sql`agent_log."taskId"`, { nullable: true })}`
      : EMPTY;
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log WHERE "agentId" = ${agentId}${readable}
      ORDER BY "createdAt" DESC, ${this.logOrder()} DESC`);
  }

  listAllLogs(
    limit: number | undefined,
    readableBy?: { userId: string | null },
  ): Promise<AgentLogRow[]> {
    const conditions: SqlQuery[] = [];
    if (limit) conditions.push(sql`"eventType" != 'agent_status_change'`);
    if (readableBy) {
      conditions.push(
        readableSessionSql(readableBy.userId, sql`agent_log."taskId"`, { nullable: true }),
      );
    }
    const cap = limit ? sql` LIMIT ${limit}` : EMPTY;
    return this.db.query<AgentLogRow>(sql`
      SELECT * FROM agent_log${sqlWhere(conditions)}
      ORDER BY "createdAt" DESC, ${this.logOrder()} DESC${cap}`);
  }

  // ---- active_sessions ----

  listActiveSessions(
    agentId: string | undefined,
    readableBy?: { userId: string | null },
  ): Promise<ActiveSessionRow[]> {
    const conditions: SqlQuery[] = [];
    if (agentId) conditions.push(sql`"agentId" = ${agentId}`);
    if (readableBy) {
      conditions.push(
        readableSessionSql(readableBy.userId, sql`active_sessions."taskId"`, { nullable: true }),
      );
    }
    return this.db.query<ActiveSessionRow>(sql`
      SELECT * FROM active_sessions${sqlWhere(conditions)}
      ORDER BY "startedAt" DESC, ${this.logOrder()} DESC`);
  }

  async countActiveSessions(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM active_sessions`,
    );
    return row?.count ?? 0;
  }

  // ---- agents: counts ----

  listIdleWorkers(): Promise<AgentRow[]> {
    return this.db.query<AgentRow>(sql`
      SELECT * FROM agents WHERE status = 'idle' AND "isLead" = ${false}
      ORDER BY ${this.logOrder()}`);
  }

  abstract countLiveAgents(
    minutes: number,
  ): Promise<{ leads_alive: number | null; workers_alive: number | null } | null>;

  countReadyAgents(): Promise<{ leads: number | null; workers: number | null } | null> {
    return this.db.get(sql`
      SELECT SUM(CASE WHEN "isLead" = ${true} THEN 1 ELSE 0 END) AS leads,
        SUM(CASE WHEN "isLead" = ${false} THEN 1 ELSE 0 END) AS workers
      FROM agents
      WHERE status IN ('idle', 'busy') AND ${this.notExtensionAgent()}`);
  }
}
