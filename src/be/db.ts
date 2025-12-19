import { Database } from "bun:sqlite";
import type {
  Agent,
  AgentLog,
  AgentLogEventType,
  AgentStatus,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentWithTasks,
  Channel,
  ChannelMessage,
  ChannelType,
} from "../types";

let db: Database | null = null;

export function initDb(dbPath = "./agent-swarm-db.sqlite"): Database {
  if (db) {
    return db;
  }

  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");

  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      isLead INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('idle', 'busy', 'offline')),
      description TEXT,
      role TEXT,
      capabilities TEXT DEFAULT '[]',
      createdAt TEXT NOT NULL,
      lastUpdatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      agentId TEXT,
      creatorAgentId TEXT,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'mcp',
      taskType TEXT,
      tags TEXT DEFAULT '[]',
      priority INTEGER DEFAULT 50,
      dependsOn TEXT DEFAULT '[]',
      offeredTo TEXT,
      offeredAt TEXT,
      acceptedAt TEXT,
      rejectionReason TEXT,
      slackChannelId TEXT,
      slackThreadTs TEXT,
      slackUserId TEXT,
      createdAt TEXT NOT NULL,
      lastUpdatedAt TEXT NOT NULL,
      finishedAt TEXT,
      failureReason TEXT,
      output TEXT,
      progress TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);

    CREATE TABLE IF NOT EXISTS agent_log (
      id TEXT PRIMARY KEY,
      eventType TEXT NOT NULL,
      agentId TEXT,
      taskId TEXT,
      oldValue TEXT,
      newValue TEXT,
      metadata TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_log_agentId ON agent_log(agentId);
    CREATE INDEX IF NOT EXISTS idx_agent_log_taskId ON agent_log(taskId);
    CREATE INDEX IF NOT EXISTS idx_agent_log_eventType ON agent_log(eventType);
    CREATE INDEX IF NOT EXISTS idx_agent_log_createdAt ON agent_log(createdAt);

    -- Channels table
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'public' CHECK(type IN ('public', 'dm')),
      createdBy TEXT,
      participants TEXT DEFAULT '[]',
      createdAt TEXT NOT NULL,
      FOREIGN KEY (createdBy) REFERENCES agents(id) ON DELETE SET NULL
    );

    -- Channel messages table
    CREATE TABLE IF NOT EXISTS channel_messages (
      id TEXT PRIMARY KEY,
      channelId TEXT NOT NULL,
      agentId TEXT,
      content TEXT NOT NULL,
      replyToId TEXT,
      mentions TEXT DEFAULT '[]',
      createdAt TEXT NOT NULL,
      FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (replyToId) REFERENCES channel_messages(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_messages_channelId ON channel_messages(channelId);
    CREATE INDEX IF NOT EXISTS idx_channel_messages_agentId ON channel_messages(agentId);
    CREATE INDEX IF NOT EXISTS idx_channel_messages_createdAt ON channel_messages(createdAt);

    -- Channel read state table
    CREATE TABLE IF NOT EXISTS channel_read_state (
      agentId TEXT NOT NULL,
      channelId TEXT NOT NULL,
      lastReadAt TEXT NOT NULL,
      PRIMARY KEY (agentId, channelId),
      FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE CASCADE
    );
  `);

  // Seed default general channel if it doesn't exist
  // Use a stable UUID for the general channel so it's consistent across restarts
  const generalChannelId = "00000000-0000-4000-8000-000000000001";
  try {
    // Migration: Fix old 'general' channel ID that wasn't a valid UUID
    db.run(`UPDATE channels SET id = ? WHERE id = 'general'`, [generalChannelId]);
    db.run(`UPDATE channel_messages SET channelId = ? WHERE channelId = 'general'`, [
      generalChannelId,
    ]);
    db.run(`UPDATE channel_read_state SET channelId = ? WHERE channelId = 'general'`, [
      generalChannelId,
    ]);
  } catch {
    /* Migration not needed or already applied */
  }
  try {
    db.run(
      `
      INSERT OR IGNORE INTO channels (id, name, description, type, createdAt)
      VALUES (?, 'general', 'Default channel for all agents', 'public', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `,
      [generalChannelId],
    );
  } catch {
    /* Channel already exists */
  }

  // Migration: Add new columns to existing databases (SQLite doesn't support IF NOT EXISTS for columns)
  // Agent task columns
  try {
    db.run(
      `ALTER TABLE agent_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api'))`,
    );
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN slackChannelId TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN slackThreadTs TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN slackUserId TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN taskType TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN tags TEXT DEFAULT '[]'`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN priority INTEGER DEFAULT 50`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN dependsOn TEXT DEFAULT '[]'`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN offeredTo TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN offeredAt TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN acceptedAt TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN rejectionReason TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN creatorAgentId TEXT`);
  } catch {
    /* exists */
  }
  // Mention-to-task columns
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN mentionMessageId TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN mentionChannelId TEXT`);
  } catch {
    /* exists */
  }
  // Agent profile columns
  try {
    db.run(`ALTER TABLE agents ADD COLUMN description TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agents ADD COLUMN role TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agents ADD COLUMN capabilities TEXT DEFAULT '[]'`);
  } catch {
    /* exists */
  }

  // Create indexes on new columns (after migrations add them)
  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo)`);
  } catch {
    /* exists or column missing */
  }
  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType)`);
  } catch {
    /* exists or column missing */
  }

  return db;
}

export function getDb(): Database {
  if (!db) {
    return initDb();
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================================================
// Agent Queries
// ============================================================================

type AgentRow = {
  id: string;
  name: string;
  isLead: number;
  status: AgentStatus;
  description: string | null;
  role: string | null;
  capabilities: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    isLead: row.isLead === 1,
    status: row.status,
    description: row.description ?? undefined,
    role: row.role ?? undefined,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export const agentQueries = {
  insert: () =>
    getDb().prepare<AgentRow, [string, string, number, AgentStatus]>(
      "INSERT INTO agents (id, name, isLead, status, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *",
    ),

  getById: () => getDb().prepare<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?"),

  getAll: () => getDb().prepare<AgentRow, []>("SELECT * FROM agents ORDER BY name"),

  updateStatus: () =>
    getDb().prepare<AgentRow, [AgentStatus, string]>(
      "UPDATE agents SET status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    ),

  delete: () => getDb().prepare<null, [string]>("DELETE FROM agents WHERE id = ?"),
};

export function createAgent(
  agent: Omit<Agent, "id" | "createdAt" | "lastUpdatedAt"> & { id?: string },
): Agent {
  const id = agent.id ?? crypto.randomUUID();
  const row = agentQueries.insert().get(id, agent.name, agent.isLead ? 1 : 0, agent.status);
  if (!row) throw new Error("Failed to create agent");
  try {
    createLogEntry({ eventType: "agent_joined", agentId: id, newValue: agent.status });
  } catch {}
  return rowToAgent(row);
}

export function getAgentById(id: string): Agent | null {
  const row = agentQueries.getById().get(id);
  return row ? rowToAgent(row) : null;
}

export function getAllAgents(): Agent[] {
  return agentQueries.getAll().all().map(rowToAgent);
}

export function updateAgentStatus(id: string, status: AgentStatus): Agent | null {
  const oldAgent = getAgentById(id);
  const row = agentQueries.updateStatus().get(status, id);
  if (row && oldAgent) {
    try {
      createLogEntry({
        eventType: "agent_status_change",
        agentId: id,
        oldValue: oldAgent.status,
        newValue: status,
      });
    } catch {}
  }
  return row ? rowToAgent(row) : null;
}

export function deleteAgent(id: string): boolean {
  const agent = getAgentById(id);
  if (agent) {
    try {
      createLogEntry({ eventType: "agent_left", agentId: id, oldValue: agent.status });
    } catch {}
  }
  const result = getDb().run("DELETE FROM agents WHERE id = ?", [id]);
  return result.changes > 0;
}

// ============================================================================
// AgentTask Queries
// ============================================================================

type AgentTaskRow = {
  id: string;
  agentId: string | null;
  creatorAgentId: string | null;
  task: string;
  status: AgentTaskStatus;
  source: AgentTaskSource;
  taskType: string | null;
  tags: string | null;
  priority: number;
  dependsOn: string | null;
  offeredTo: string | null;
  offeredAt: string | null;
  acceptedAt: string | null;
  rejectionReason: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  mentionMessageId: string | null;
  mentionChannelId: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
  failureReason: string | null;
  output: string | null;
  progress: string | null;
};

function rowToAgentTask(row: AgentTaskRow): AgentTask {
  return {
    id: row.id,
    agentId: row.agentId,
    creatorAgentId: row.creatorAgentId ?? undefined,
    task: row.task,
    status: row.status,
    source: row.source,
    taskType: row.taskType ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    priority: row.priority ?? 50,
    dependsOn: row.dependsOn ? JSON.parse(row.dependsOn) : [],
    offeredTo: row.offeredTo ?? undefined,
    offeredAt: row.offeredAt ?? undefined,
    acceptedAt: row.acceptedAt ?? undefined,
    rejectionReason: row.rejectionReason ?? undefined,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    slackUserId: row.slackUserId ?? undefined,
    mentionMessageId: row.mentionMessageId ?? undefined,
    mentionChannelId: row.mentionChannelId ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
    failureReason: row.failureReason ?? undefined,
    output: row.output ?? undefined,
    progress: row.progress ?? undefined,
  };
}

export const taskQueries = {
  insert: () =>
    getDb().prepare<
      AgentTaskRow,
      [
        string,
        string,
        string,
        AgentTaskStatus,
        AgentTaskSource,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, slackChannelId, slackThreadTs, slackUserId, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    ),

  getById: () => getDb().prepare<AgentTaskRow, [string]>("SELECT * FROM agent_tasks WHERE id = ?"),

  getByAgentId: () =>
    getDb().prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE agentId = ? ORDER BY createdAt DESC",
    ),

  getByStatus: () =>
    getDb().prepare<AgentTaskRow, [AgentTaskStatus]>(
      "SELECT * FROM agent_tasks WHERE status = ? ORDER BY createdAt DESC",
    ),

  updateStatus: () =>
    getDb().prepare<AgentTaskRow, [AgentTaskStatus, string | null, string]>(
      `UPDATE agent_tasks SET status = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`,
    ),

  setOutput: () =>
    getDb().prepare<AgentTaskRow, [string, string]>(
      "UPDATE agent_tasks SET output = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    ),

  setFailure: () =>
    getDb().prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET status = 'failed', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    ),

  setProgress: () =>
    getDb().prepare<AgentTaskRow, [string, string]>(
      "UPDATE agent_tasks SET progress = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    ),

  delete: () => getDb().prepare<null, [string]>("DELETE FROM agent_tasks WHERE id = ?"),
};

export function createTask(
  agentId: string,
  task: string,
  options?: {
    source?: AgentTaskSource;
    slackChannelId?: string;
    slackThreadTs?: string;
    slackUserId?: string;
  },
): AgentTask {
  const id = crypto.randomUUID();
  const source = options?.source ?? "mcp";
  const row = taskQueries
    .insert()
    .get(
      id,
      agentId,
      task,
      "pending",
      source,
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
    );
  if (!row) throw new Error("Failed to create task");
  try {
    createLogEntry({
      eventType: "task_created",
      agentId,
      taskId: id,
      newValue: "pending",
      metadata: { source },
    });
  } catch {}
  return rowToAgentTask(row);
}

export function getPendingTaskForAgent(agentId: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'pending' ORDER BY createdAt ASC LIMIT 1",
    )
    .get(agentId);
  return row ? rowToAgentTask(row) : null;
}

export function startTask(taskId: string): AgentTask | null {
  const oldTask = getTaskById(taskId);
  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    )
    .get(taskId);
  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "in_progress",
      });
    } catch {}
  }
  return row ? rowToAgentTask(row) : null;
}

export function getTaskById(id: string): AgentTask | null {
  const row = taskQueries.getById().get(id);
  return row ? rowToAgentTask(row) : null;
}

export function getTasksByAgentId(agentId: string): AgentTask[] {
  return taskQueries.getByAgentId().all(agentId).map(rowToAgentTask);
}

export function getTasksByStatus(status: AgentTaskStatus): AgentTask[] {
  return taskQueries.getByStatus().all(status).map(rowToAgentTask);
}

export interface TaskFilters {
  status?: AgentTaskStatus;
  agentId?: string;
  search?: string;
  // New filters
  unassigned?: boolean;
  offeredTo?: string;
  readyOnly?: boolean;
  taskType?: string;
  tags?: string[];
}

export function getAllTasks(filters?: TaskFilters): AgentTask[] {
  const conditions: string[] = [];
  const params: (string | AgentTaskStatus)[] = [];

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.search) {
    conditions.push("task LIKE ?");
    params.push(`%${filters.search}%`);
  }

  // New filters
  if (filters?.unassigned) {
    conditions.push("(agentId IS NULL OR status = 'unassigned')");
  }

  if (filters?.offeredTo) {
    conditions.push("offeredTo = ?");
    params.push(filters.offeredTo);
  }

  if (filters?.taskType) {
    conditions.push("taskType = ?");
    params.push(filters.taskType);
  }

  if (filters?.tags && filters.tags.length > 0) {
    // Match any of the tags
    const tagConditions = filters.tags.map(() => "tags LIKE ?");
    conditions.push(`(${tagConditions.join(" OR ")})`);
    for (const tag of filters.tags) {
      params.push(`%"${tag}"%`);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM agent_tasks ${whereClause} ORDER BY priority DESC, lastUpdatedAt DESC`;

  let tasks = getDb()
    .prepare<AgentTaskRow, (string | AgentTaskStatus)[]>(query)
    .all(...params)
    .map(rowToAgentTask);

  // Filter for ready tasks (dependencies met) if requested
  if (filters?.readyOnly) {
    tasks = tasks.filter((task) => {
      if (!task.dependsOn || task.dependsOn.length === 0) return true;
      return checkDependencies(task.id).ready;
    });
  }

  return tasks;
}

export function getCompletedSlackTasks(): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId IS NOT NULL
       AND status IN ('completed', 'failed')
       ORDER BY lastUpdatedAt DESC`,
    )
    .all()
    .map(rowToAgentTask);
}

export function getInProgressSlackTasks(): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId IS NOT NULL
       AND status = 'in_progress'
       ORDER BY lastUpdatedAt DESC`,
    )
    .all()
    .map(rowToAgentTask);
}

export function completeTask(id: string, output?: string): AgentTask | null {
  const oldTask = getTaskById(id);
  const finishedAt = new Date().toISOString();
  let row = taskQueries.updateStatus().get("completed", finishedAt, id);
  if (!row) return null;

  if (output) {
    row = taskQueries.setOutput().get(output, id);
  }

  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "completed",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function failTask(id: string, reason: string): AgentTask | null {
  const oldTask = getTaskById(id);
  const finishedAt = new Date().toISOString();
  const row = taskQueries.setFailure().get(reason, finishedAt, id);
  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "failed",
        metadata: { reason },
      });
    } catch {}
  }
  return row ? rowToAgentTask(row) : null;
}

export function deleteTask(id: string): boolean {
  const result = getDb().run("DELETE FROM agent_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

export function updateTaskProgress(id: string, progress: string): AgentTask | null {
  const row = taskQueries.setProgress().get(progress, id);
  if (row) {
    try {
      createLogEntry({
        eventType: "task_progress",
        taskId: id,
        agentId: row.agentId ?? undefined,
        newValue: progress,
      });
    } catch {}
  }
  return row ? rowToAgentTask(row) : null;
}

// ============================================================================
// Combined Queries (Agent with Tasks)
// ============================================================================

export function getAgentWithTasks(id: string): AgentWithTasks | null {
  const txn = getDb().transaction(() => {
    const agent = getAgentById(id);
    if (!agent) return null;

    const tasks = getTasksByAgentId(id);
    return { ...agent, tasks };
  });

  return txn();
}

export function getAllAgentsWithTasks(): AgentWithTasks[] {
  const txn = getDb().transaction(() => {
    const agents = getAllAgents();
    return agents.map((agent) => ({
      ...agent,
      tasks: getTasksByAgentId(agent.id),
    }));
  });

  return txn();
}

// ============================================================================
// Agent Log Queries
// ============================================================================

type AgentLogRow = {
  id: string;
  eventType: AgentLogEventType;
  agentId: string | null;
  taskId: string | null;
  oldValue: string | null;
  newValue: string | null;
  metadata: string | null;
  createdAt: string;
};

function rowToAgentLog(row: AgentLogRow): AgentLog {
  return {
    id: row.id,
    eventType: row.eventType,
    agentId: row.agentId ?? undefined,
    taskId: row.taskId ?? undefined,
    oldValue: row.oldValue ?? undefined,
    newValue: row.newValue ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
  };
}

export const logQueries = {
  insert: () =>
    getDb().prepare<
      AgentLogRow,
      [string, string, string | null, string | null, string | null, string | null, string | null]
    >(
      `INSERT INTO agent_log (id, eventType, agentId, taskId, oldValue, newValue, metadata, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    ),

  getByAgentId: () =>
    getDb().prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE agentId = ? ORDER BY createdAt DESC",
    ),

  getByTaskId: () =>
    getDb().prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt DESC",
    ),

  getByEventType: () =>
    getDb().prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE eventType = ? ORDER BY createdAt DESC",
    ),

  getAll: () => getDb().prepare<AgentLogRow, []>("SELECT * FROM agent_log ORDER BY createdAt DESC"),
};

export function createLogEntry(entry: {
  eventType: AgentLogEventType;
  agentId?: string;
  taskId?: string;
  oldValue?: string;
  newValue?: string;
  metadata?: Record<string, unknown>;
}): AgentLog {
  const id = crypto.randomUUID();
  const row = logQueries
    .insert()
    .get(
      id,
      entry.eventType,
      entry.agentId ?? null,
      entry.taskId ?? null,
      entry.oldValue ?? null,
      entry.newValue ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  if (!row) throw new Error("Failed to create log entry");
  return rowToAgentLog(row);
}

export function getLogsByAgentId(agentId: string): AgentLog[] {
  return logQueries.getByAgentId().all(agentId).map(rowToAgentLog);
}

export function getLogsByTaskId(taskId: string): AgentLog[] {
  return logQueries.getByTaskId().all(taskId).map(rowToAgentLog);
}

export function getLogsByTaskIdChronological(taskId: string): AgentLog[] {
  return getDb()
    .prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt ASC",
    )
    .all(taskId)
    .map(rowToAgentLog);
}

export function getAllLogs(limit?: number): AgentLog[] {
  if (limit) {
    return getDb()
      .prepare<AgentLogRow, [number]>(
        "SELECT * FROM agent_log WHERE eventType != 'agent_status_change' ORDER BY createdAt DESC LIMIT ?",
      )
      .all(limit)
      .map(rowToAgentLog);
  }
  return logQueries.getAll().all().map(rowToAgentLog);
}

// ============================================================================
// Task Pool Operations
// ============================================================================

export interface CreateTaskOptions {
  agentId?: string | null;
  creatorAgentId?: string;
  source?: AgentTaskSource;
  taskType?: string;
  tags?: string[];
  priority?: number;
  dependsOn?: string[];
  offeredTo?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  mentionMessageId?: string;
  mentionChannelId?: string;
}

export function createTaskExtended(task: string, options?: CreateTaskOptions): AgentTask {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status: AgentTaskStatus = options?.offeredTo
    ? "offered"
    : options?.agentId
      ? "pending"
      : "unassigned";

  const row = getDb()
    .prepare<AgentTaskRow, (string | number | null)[]>(
      `INSERT INTO agent_tasks (
        id, agentId, creatorAgentId, task, status, source,
        taskType, tags, priority, dependsOn, offeredTo, offeredAt,
        slackChannelId, slackThreadTs, slackUserId,
        mentionMessageId, mentionChannelId, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      options?.agentId ?? null,
      options?.creatorAgentId ?? null,
      task,
      status,
      options?.source ?? "mcp",
      options?.taskType ?? null,
      JSON.stringify(options?.tags ?? []),
      options?.priority ?? 50,
      JSON.stringify(options?.dependsOn ?? []),
      options?.offeredTo ?? null,
      options?.offeredTo ? now : null,
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
      options?.mentionMessageId ?? null,
      options?.mentionChannelId ?? null,
      now,
      now,
    );

  if (!row) throw new Error("Failed to create task");

  try {
    createLogEntry({
      eventType: status === "offered" ? "task_offered" : "task_created",
      agentId: options?.creatorAgentId,
      taskId: id,
      newValue: status,
      metadata: { source: options?.source ?? "mcp" },
    });
  } catch {}

  return rowToAgentTask(row);
}

export function claimTask(taskId: string, agentId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "unassigned") return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET agentId = ?, status = 'pending', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    )
    .get(agentId, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_claimed",
        agentId,
        taskId,
        oldValue: "unassigned",
        newValue: "pending",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function releaseTask(taskId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "pending") return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET agentId = NULL, status = 'unassigned', lastUpdatedAt = ?
       WHERE id = ? AND status = 'pending' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_released",
        agentId: task.agentId ?? undefined,
        taskId,
        oldValue: "pending",
        newValue: "unassigned",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function acceptTask(taskId: string, agentId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "offered" || task.offeredTo !== agentId) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string, string]>(
      `UPDATE agent_tasks SET agentId = ?, status = 'pending', acceptedAt = ?, lastUpdatedAt = ?
       WHERE id = ? AND status = 'offered' RETURNING *`,
    )
    .get(agentId, now, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_accepted",
        agentId,
        taskId,
        oldValue: "offered",
        newValue: "pending",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function rejectTask(taskId: string, agentId: string, reason?: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "offered" || task.offeredTo !== agentId) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string | null, string, string]>(
      `UPDATE agent_tasks SET
        status = 'unassigned', offeredTo = NULL, offeredAt = NULL,
        rejectionReason = ?, lastUpdatedAt = ?
       WHERE id = ? AND status = 'offered' RETURNING *`,
    )
    .get(reason ?? null, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_rejected",
        agentId,
        taskId,
        oldValue: "offered",
        newValue: "unassigned",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function getOfferedTasksForAgent(agentId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE offeredTo = ? AND status = 'offered' ORDER BY createdAt ASC",
    )
    .all(agentId)
    .map(rowToAgentTask);
}

export function getUnassignedTasksCount(): number {
  const result = getDb()
    .prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'",
    )
    .get();
  return result?.count ?? 0;
}

// ============================================================================
// Dependency Checking
// ============================================================================

export function checkDependencies(taskId: string): {
  ready: boolean;
  blockedBy: string[];
} {
  const task = getTaskById(taskId);
  if (!task || !task.dependsOn || task.dependsOn.length === 0) {
    return { ready: true, blockedBy: [] };
  }

  const blockedBy: string[] = [];
  for (const depId of task.dependsOn) {
    const depTask = getTaskById(depId);
    if (!depTask || depTask.status !== "completed") {
      blockedBy.push(depId);
    }
  }

  return { ready: blockedBy.length === 0, blockedBy };
}

// ============================================================================
// Agent Profile Operations
// ============================================================================

export function updateAgentProfile(
  id: string,
  updates: {
    description?: string;
    role?: string;
    capabilities?: string[];
  },
): Agent | null {
  const agent = getAgentById(id);
  if (!agent) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentRow, [string | null, string | null, string | null, string, string]>(
      `UPDATE agents SET
        description = COALESCE(?, description),
        role = COALESCE(?, role),
        capabilities = COALESCE(?, capabilities),
        lastUpdatedAt = ?
       WHERE id = ? RETURNING *`,
    )
    .get(
      updates.description ?? null,
      updates.role ?? null,
      updates.capabilities ? JSON.stringify(updates.capabilities) : null,
      now,
      id,
    );

  return row ? rowToAgent(row) : null;
}

// ============================================================================
// Channel Operations
// ============================================================================

type ChannelRow = {
  id: string;
  name: string;
  description: string | null;
  type: ChannelType;
  createdBy: string | null;
  participants: string | null;
  createdAt: string;
};

function rowToChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type,
    createdBy: row.createdBy ?? undefined,
    participants: row.participants ? JSON.parse(row.participants) : [],
    createdAt: row.createdAt,
  };
}

type ChannelMessageRow = {
  id: string;
  channelId: string;
  agentId: string | null;
  content: string;
  replyToId: string | null;
  mentions: string | null;
  createdAt: string;
};

function rowToChannelMessage(row: ChannelMessageRow, agentName?: string): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channelId,
    agentId: row.agentId,
    agentName: agentName ?? (row.agentId ? undefined : "Human"),
    content: row.content,
    replyToId: row.replyToId ?? undefined,
    mentions: row.mentions ? JSON.parse(row.mentions) : [],
    createdAt: row.createdAt,
  };
}

export function createChannel(
  name: string,
  options?: {
    description?: string;
    type?: ChannelType;
    createdBy?: string;
    participants?: string[];
  },
): Channel {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<
      ChannelRow,
      [string, string, string | null, ChannelType, string | null, string, string]
    >(
      `INSERT INTO channels (id, name, description, type, createdBy, participants, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      name,
      options?.description ?? null,
      options?.type ?? "public",
      options?.createdBy ?? null,
      JSON.stringify(options?.participants ?? []),
      now,
    );

  if (!row) throw new Error("Failed to create channel");
  return rowToChannel(row);
}

export function getChannelById(id: string): Channel | null {
  const row = getDb().prepare<ChannelRow, [string]>("SELECT * FROM channels WHERE id = ?").get(id);
  return row ? rowToChannel(row) : null;
}

export function getChannelByName(name: string): Channel | null {
  const row = getDb()
    .prepare<ChannelRow, [string]>("SELECT * FROM channels WHERE name = ?")
    .get(name);
  return row ? rowToChannel(row) : null;
}

export function getAllChannels(): Channel[] {
  return getDb()
    .prepare<ChannelRow, []>("SELECT * FROM channels ORDER BY name")
    .all()
    .map(rowToChannel);
}

export function postMessage(
  channelId: string,
  agentId: string | null,
  content: string,
  options?: {
    replyToId?: string;
    mentions?: string[];
  },
): ChannelMessage {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<
      ChannelMessageRow,
      [string, string, string | null, string, string | null, string, string]
    >(
      `INSERT INTO channel_messages (id, channelId, agentId, content, replyToId, mentions, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      channelId,
      agentId,
      content,
      options?.replyToId ?? null,
      JSON.stringify(options?.mentions ?? []),
      now,
    );

  if (!row) throw new Error("Failed to post message");

  try {
    createLogEntry({
      eventType: "channel_message",
      agentId: agentId ?? undefined,
      metadata: { channelId, messageId: id },
    });
  } catch {}

  // Auto-create tasks for mentions (directly assigned to mentioned agent)
  if (options?.mentions && options.mentions.length > 0) {
    const sender = agentId ? getAgentById(agentId) : null;
    const channel = getChannelById(channelId);
    const senderName = sender?.name ?? "Human";
    const channelName = channel?.name ?? "unknown";
    const truncated = content.length > 80 ? `${content.slice(0, 80)}...` : content;

    // Dedupe mentions (self-mentions allowed - agents can create tasks for themselves)
    const uniqueMentions = [...new Set(options.mentions)];

    for (const mentionedAgentId of uniqueMentions) {
      // Skip if agent doesn't exist
      const mentionedAgent = getAgentById(mentionedAgentId);
      if (!mentionedAgent) continue;

      createTaskExtended(`@mention from ${senderName} in #${channelName}: "${truncated}"`, {
        agentId: mentionedAgentId, // Direct assignment
        creatorAgentId: agentId ?? undefined,
        source: "mcp",
        taskType: "mention",
        priority: 50,
        mentionMessageId: id,
        mentionChannelId: channelId,
      });
    }
  }

  // Get agent name for the response
  const agent = agentId ? getAgentById(agentId) : null;
  return rowToChannelMessage(row, agent?.name);
}

export function getChannelMessages(
  channelId: string,
  options?: {
    limit?: number;
    since?: string;
    before?: string;
  },
): ChannelMessage[] {
  let query =
    "SELECT m.*, a.name as agentName FROM channel_messages m LEFT JOIN agents a ON m.agentId = a.id WHERE m.channelId = ?";
  const params: (string | number)[] = [channelId];

  if (options?.since) {
    query += " AND m.createdAt > ?";
    params.push(options.since);
  }

  if (options?.before) {
    query += " AND m.createdAt < ?";
    params.push(options.before);
  }

  query += " ORDER BY m.createdAt DESC";

  if (options?.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }

  type MessageWithAgentRow = ChannelMessageRow & { agentName: string | null };

  return getDb()
    .prepare<MessageWithAgentRow, (string | number)[]>(query)
    .all(...params)
    .map((row) => rowToChannelMessage(row, row.agentName ?? undefined))
    .reverse(); // Return in chronological order
}

export function updateReadState(agentId: string, channelId: string): void {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO channel_read_state (agentId, channelId, lastReadAt)
     VALUES (?, ?, ?)
     ON CONFLICT(agentId, channelId) DO UPDATE SET lastReadAt = ?`,
    [agentId, channelId, now, now],
  );
}

export function getLastReadAt(agentId: string, channelId: string): string | null {
  const result = getDb()
    .prepare<{ lastReadAt: string }, [string, string]>(
      "SELECT lastReadAt FROM channel_read_state WHERE agentId = ? AND channelId = ?",
    )
    .get(agentId, channelId);
  return result?.lastReadAt ?? null;
}

export function getUnreadMessages(agentId: string, channelId: string): ChannelMessage[] {
  const lastReadAt = getLastReadAt(agentId, channelId);

  let query = `SELECT m.*, a.name as agentName FROM channel_messages m
               LEFT JOIN agents a ON m.agentId = a.id
               WHERE m.channelId = ?`;
  const params: string[] = [channelId];

  if (lastReadAt) {
    query += " AND m.createdAt > ?";
    params.push(lastReadAt);
  }

  query += " ORDER BY m.createdAt ASC";

  type MessageWithAgentRow = ChannelMessageRow & { agentName: string | null };

  return getDb()
    .prepare<MessageWithAgentRow, string[]>(query)
    .all(...params)
    .map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
}

export function getMentionsForAgent(
  agentId: string,
  options?: { unreadOnly?: boolean; channelId?: string },
): ChannelMessage[] {
  let query = `SELECT m.*, a.name as agentName FROM channel_messages m
               LEFT JOIN agents a ON m.agentId = a.id
               WHERE m.mentions LIKE ?`;
  const params: string[] = [`%"${agentId}"%`];

  if (options?.channelId) {
    query += " AND m.channelId = ?";
    params.push(options.channelId);

    if (options?.unreadOnly) {
      const lastReadAt = getLastReadAt(agentId, options.channelId);
      if (lastReadAt) {
        query += " AND m.createdAt > ?";
        params.push(lastReadAt);
      }
    }
  }

  query += " ORDER BY m.createdAt DESC LIMIT 50";

  type MessageWithAgentRow = ChannelMessageRow & { agentName: string | null };

  return getDb()
    .prepare<MessageWithAgentRow, string[]>(query)
    .all(...params)
    .map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
}

// ============================================================================
// Inbox Summary (for system tray)
// ============================================================================

export interface MentionPreview {
  channelName: string;
  agentName: string;
  content: string;
  createdAt: string;
}

export interface InboxSummary {
  unreadCount: number;
  mentionsCount: number;
  offeredTasksCount: number;
  poolTasksCount: number;
  inProgressCount: number;
  recentMentions: MentionPreview[]; // Up to 3 recent @mentions
}

export function getInboxSummary(agentId: string): InboxSummary {
  const db = getDb();
  const channels = getAllChannels();
  let unreadCount = 0;
  let mentionsCount = 0;

  for (const channel of channels) {
    const lastReadAt = getLastReadAt(agentId, channel.id);
    const baseCondition = lastReadAt ? `AND m.createdAt > '${lastReadAt}'` : "";

    // Count unread (excluding own messages)
    const channelUnread = db
      .prepare<{ count: number }, [string]>(
        `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND (m.agentId != '${agentId}' OR m.agentId IS NULL) ${baseCondition}`,
      )
      .get(channel.id);
    unreadCount += channelUnread?.count ?? 0;

    // Count mentions in unread
    const channelMentions = db
      .prepare<{ count: number }, [string, string]>(
        `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND m.mentions LIKE ? ${baseCondition}`,
      )
      .get(channel.id, `%"${agentId}"%`);
    mentionsCount += channelMentions?.count ?? 0;
  }

  // Count offered tasks for this agent
  const offeredResult = db
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE offeredTo = ? AND status = 'offered'",
    )
    .get(agentId);

  // Count unassigned tasks in pool
  const poolResult = db
    .prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'",
    )
    .get();

  // Count my in-progress tasks
  const inProgressResult = db
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status = 'in_progress'",
    )
    .get(agentId);

  // Get recent unread @mentions (up to 3)
  const recentMentions: MentionPreview[] = [];
  const mentionMessages = getMentionsForAgent(agentId, { unreadOnly: false });

  // Filter to only unread mentions and limit to 3
  for (const msg of mentionMessages) {
    if (recentMentions.length >= 3) break;

    // Check if message is unread (by checking against read state per channel)
    const lastReadAt = getLastReadAt(agentId, msg.channelId);
    if (lastReadAt && new Date(msg.createdAt) <= new Date(lastReadAt)) {
      continue; // Already read
    }

    // Get channel name
    const channel = getChannelById(msg.channelId);

    recentMentions.push({
      channelName: channel?.name ?? "unknown",
      agentName: msg.agentName ?? "Unknown",
      content: msg.content.length > 100 ? `${msg.content.slice(0, 100)}...` : msg.content,
      createdAt: msg.createdAt,
    });
  }

  return {
    unreadCount,
    mentionsCount,
    offeredTasksCount: offeredResult?.count ?? 0,
    poolTasksCount: poolResult?.count ?? 0,
    inProgressCount: inProgressResult?.count ?? 0,
    recentMentions,
  };
}
