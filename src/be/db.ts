import { Database } from "bun:sqlite";
import type {
  ActiveSession,
  Agent,
  AgentLog,
  AgentLogEventType,
  AgentMemory,
  AgentMemoryScope,
  AgentMemorySource,
  AgentStatus,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentWithTasks,
  Channel,
  ChannelMessage,
  ChannelType,
  Epic,
  EpicStatus,
  EpicWithProgress,
  InboxMessage,
  InboxMessageStatus,
  ScheduledTask,
  Service,
  ServiceStatus,
  SessionCost,
  SessionLog,
  SwarmConfig,
  SwarmRepo,
} from "../types";

let db: Database | null = null;

export function initDb(dbPath = "./agent-swarm-db.sqlite"): Database {
  if (db) {
    return db;
  }

  db = new Database(dbPath, { create: true });
  console.log(`Database initialized at ${dbPath}`);

  // Capture in local const for TypeScript (db is guaranteed non-null here)
  const database = db;

  database.run("PRAGMA journal_mode = WAL;");
  database.run("PRAGMA foreign_keys = ON;");

  // Schema initialization - wrapped in transaction for atomicity
  // Individual statements ensure compatibility with older Bun versions (< 1.0.26)
  // that don't support multi-statement queries
  const initSchema = database.transaction(() => {
    // Tables
    database.run(`
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
      )
    `);

    database.run(`
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
        progress TEXT,
        notifiedAt TEXT
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS agent_log (
        id TEXT PRIMARY KEY,
        eventType TEXT NOT NULL,
        agentId TEXT,
        taskId TEXT,
        oldValue TEXT,
        newValue TEXT,
        metadata TEXT,
        createdAt TEXT NOT NULL
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'public' CHECK(type IN ('public', 'dm')),
        createdBy TEXT,
        participants TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL,
        FOREIGN KEY (createdBy) REFERENCES agents(id) ON DELETE SET NULL
      )
    `);

    database.run(`
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
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS channel_read_state (
        agentId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        lastReadAt TEXT NOT NULL,
        processing_since TEXT,
        PRIMARY KEY (agentId, channelId),
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE CASCADE
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        name TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 3000,
        description TEXT,
        url TEXT,
        healthCheckPath TEXT DEFAULT '/health',
        status TEXT NOT NULL DEFAULT 'starting' CHECK(status IN ('starting', 'healthy', 'unhealthy', 'stopped')),
        script TEXT NOT NULL DEFAULT '',
        cwd TEXT,
        interpreter TEXT,
        args TEXT,
        env TEXT,
        metadata TEXT DEFAULT '{}',
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL,
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
        UNIQUE(agentId, name)
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS session_logs (
        id TEXT PRIMARY KEY,
        taskId TEXT,
        sessionId TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        cli TEXT NOT NULL DEFAULT 'claude',
        content TEXT NOT NULL,
        lineNumber INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS session_costs (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        taskId TEXT,
        agentId TEXT NOT NULL,
        totalCostUsd REAL NOT NULL,
        inputTokens INTEGER NOT NULL DEFAULT 0,
        outputTokens INTEGER NOT NULL DEFAULT 0,
        cacheReadTokens INTEGER NOT NULL DEFAULT 0,
        cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
        durationMs INTEGER NOT NULL,
        numTurns INTEGER NOT NULL,
        model TEXT NOT NULL,
        isError INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'slack',
        status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'processing', 'read', 'responded', 'delegated')),
        slackChannelId TEXT,
        slackThreadTs TEXT,
        slackUserId TEXT,
        matchedText TEXT,
        delegatedToTaskId TEXT,
        responseText TEXT,
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL,
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (delegatedToTaskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
      )
    `);

    // Indexes
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_log_agentId ON agent_log(agentId)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_log_taskId ON agent_log(taskId)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_log_eventType ON agent_log(eventType)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_log_createdAt ON agent_log(createdAt)`);
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_channel_messages_channelId ON channel_messages(channelId)`,
    );
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_channel_messages_agentId ON channel_messages(agentId)`,
    );
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_channel_messages_createdAt ON channel_messages(createdAt)`,
    );
    database.run(`CREATE INDEX IF NOT EXISTS idx_services_agentId ON services(agentId)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_services_status ON services(status)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_session_logs_taskId ON session_logs(taskId)`);
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_session_logs_sessionId ON session_logs(sessionId)`,
    );
    // Session costs indexes for timeseries queries
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_session_costs_createdAt ON session_costs(createdAt)`,
    );
    database.run(`CREATE INDEX IF NOT EXISTS idx_session_costs_taskId ON session_costs(taskId)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_session_costs_agentId ON session_costs(agentId)`);
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_session_costs_agent_createdAt ON session_costs(agentId, createdAt)`,
    );
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_inbox_messages_agentId ON inbox_messages(agentId)`,
    );
    database.run(`CREATE INDEX IF NOT EXISTS idx_inbox_messages_status ON inbox_messages(status)`);

    // Scheduled tasks table
    database.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        cronExpression TEXT,
        intervalMs INTEGER,
        taskTemplate TEXT NOT NULL,
        taskType TEXT,
        tags TEXT DEFAULT '[]',
        priority INTEGER DEFAULT 50,
        targetAgentId TEXT,
        enabled INTEGER DEFAULT 1,
        lastRunAt TEXT,
        nextRunAt TEXT,
        createdByAgentId TEXT,
        timezone TEXT DEFAULT 'UTC',
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL,
        CHECK (cronExpression IS NOT NULL OR intervalMs IS NOT NULL)
      )
    `);

    // Scheduled tasks indexes
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)`,
    );
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_nextRunAt ON scheduled_tasks(nextRunAt)`,
    );

    // Epics table - project-level task organization
    database.run(`
      CREATE TABLE IF NOT EXISTS epics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        goal TEXT NOT NULL,
        prd TEXT,
        plan TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
        priority INTEGER DEFAULT 50,
        tags TEXT DEFAULT '[]',
        createdByAgentId TEXT,
        leadAgentId TEXT,
        channelId TEXT,
        researchDocPath TEXT,
        planDocPath TEXT,
        slackChannelId TEXT,
        slackThreadTs TEXT,
        githubRepo TEXT,
        githubMilestone TEXT,
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL,
        startedAt TEXT,
        completedAt TEXT,
        FOREIGN KEY (createdByAgentId) REFERENCES agents(id) ON DELETE SET NULL,
        FOREIGN KEY (leadAgentId) REFERENCES agents(id) ON DELETE SET NULL,
        FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE SET NULL
      )
    `);

    // Epics indexes
    database.run(`CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status)`);
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_epics_createdByAgentId ON epics(createdByAgentId)`,
    );
    database.run(`CREATE INDEX IF NOT EXISTS idx_epics_leadAgentId ON epics(leadAgentId)`);

    // Swarm config table - centralized environment/config management
    database.run(`
      CREATE TABLE IF NOT EXISTS swarm_config (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
        scopeId TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        isSecret INTEGER NOT NULL DEFAULT 0,
        envPath TEXT,
        description TEXT,
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL,
        UNIQUE(scope, scopeId, key)
      )
    `);

    // Swarm config indexes
    database.run(`CREATE INDEX IF NOT EXISTS idx_swarm_config_scope ON swarm_config(scope)`);
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_swarm_config_scope_id ON swarm_config(scope, scopeId)`,
    );
    database.run(`CREATE INDEX IF NOT EXISTS idx_swarm_config_key ON swarm_config(key)`);

    // Swarm repos table - centralized repository management
    database.run(`
      CREATE TABLE IF NOT EXISTS swarm_repos (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        clonePath TEXT NOT NULL UNIQUE,
        defaultBranch TEXT NOT NULL DEFAULT 'main',
        autoClone INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        lastUpdatedAt TEXT NOT NULL
      )
    `);

    // Swarm repos indexes
    database.run(`CREATE INDEX IF NOT EXISTS idx_swarm_repos_name ON swarm_repos(name)`);

    // Agent memory table - persistent memory system with vector search
    database.run(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        agentId TEXT,
        scope TEXT NOT NULL CHECK(scope IN ('agent', 'swarm')),
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        embedding BLOB,
        source TEXT NOT NULL CHECK(source IN ('manual', 'file_index', 'session_summary', 'task_completion')),
        sourceTaskId TEXT,
        sourcePath TEXT,
        chunkIndex INTEGER DEFAULT 0,
        totalChunks INTEGER DEFAULT 1,
        tags TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL,
        accessedAt TEXT NOT NULL
      )
    `);

    // Agent memory indexes
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agentId)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory(scope)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_memory_source ON agent_memory(source)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_agent_memory_created ON agent_memory(createdAt)`);
    database.run(
      `CREATE INDEX IF NOT EXISTS idx_agent_memory_source_path ON agent_memory(sourcePath)`,
    );

    // Active sessions table - tracks running Claude sessions for concurrency awareness
    database.run(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        taskId TEXT,
        triggerType TEXT NOT NULL,
        inboxMessageId TEXT,
        taskDescription TEXT,
        startedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        lastHeartbeatAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);

    database.run(
      `CREATE INDEX IF NOT EXISTS idx_active_sessions_agent ON active_sessions(agentId)`,
    );
  });

  initSchema();

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
  // GitHub-specific columns
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN githubRepo TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN githubEventType TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN githubNumber INTEGER`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN githubCommentId INTEGER`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN githubAuthor TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN githubUrl TEXT`);
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
  // Concurrency limit column
  try {
    db.run(`ALTER TABLE agents ADD COLUMN maxTasks INTEGER DEFAULT 1`);
  } catch {
    /* exists */
  }

  // Polling limit tracking column
  try {
    db.run(`ALTER TABLE agents ADD COLUMN emptyPollCount INTEGER DEFAULT 0`);
  } catch {
    /* exists */
  }

  // CLAUDE.md storage column
  try {
    db.run(`ALTER TABLE agents ADD COLUMN claudeMd TEXT`);
  } catch {
    /* exists */
  }

  // Soul and Identity content columns
  try {
    db.run(`ALTER TABLE agents ADD COLUMN soulMd TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agents ADD COLUMN identityMd TEXT`);
  } catch {
    /* exists */
  }

  // Setup script (per-agent auto-improvement)
  try {
    db.run(`ALTER TABLE agents ADD COLUMN setupScript TEXT`);
  } catch {
    /* exists */
  }

  // Tools/environment reference (per-agent operational knowledge)
  try {
    db.run(`ALTER TABLE agents ADD COLUMN toolsMd TEXT`);
  } catch {
    /* exists */
  }

  // Service PM2 columns migration
  try {
    db.run(`ALTER TABLE services ADD COLUMN script TEXT NOT NULL DEFAULT ''`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE services ADD COLUMN cwd TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE services ADD COLUMN interpreter TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE services ADD COLUMN args TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE services ADD COLUMN env TEXT`);
  } catch {
    /* exists */
  }

  // Migration: Add processing_since column to channel_read_state for Phase 3
  try {
    db.run(`ALTER TABLE channel_read_state ADD COLUMN processing_since TEXT`);
  } catch {
    /* exists */
  }

  // Migration: Add notifiedAt column to agent_tasks for Phase 4
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN notifiedAt TEXT`);
  } catch {
    /* exists */
  }

  // Migration: Update inbox_messages CHECK constraint to include 'processing' status
  // SQLite doesn't support ALTER TABLE MODIFY COLUMN, so we need to recreate the table
  try {
    // Check if the table schema already includes 'processing' in the CHECK constraint
    const schemaInfo = db
      .prepare<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbox_messages'",
      )
      .get();

    const needsMigration = schemaInfo?.sql && !schemaInfo.sql.includes("'processing'");

    if (needsMigration) {
      console.log(
        "[Migration] Updating inbox_messages CHECK constraint to include 'processing' status",
      );
      db.run("PRAGMA foreign_keys=off");

      db.run(`
        CREATE TABLE inbox_messages_new (
          id TEXT PRIMARY KEY,
          agentId TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'slack',
          status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'processing', 'read', 'responded', 'delegated')),
          slackChannelId TEXT,
          slackThreadTs TEXT,
          slackUserId TEXT,
          matchedText TEXT,
          delegatedToTaskId TEXT,
          responseText TEXT,
          createdAt TEXT NOT NULL,
          lastUpdatedAt TEXT NOT NULL,
          FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
          FOREIGN KEY (delegatedToTaskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
        )
      `);

      db.run("INSERT INTO inbox_messages_new SELECT * FROM inbox_messages");
      db.run("DROP TABLE inbox_messages");
      db.run("ALTER TABLE inbox_messages_new RENAME TO inbox_messages");

      // Recreate indexes
      db.run("CREATE INDEX IF NOT EXISTS idx_inbox_messages_agentId ON inbox_messages(agentId)");
      db.run("CREATE INDEX IF NOT EXISTS idx_inbox_messages_status ON inbox_messages(status)");

      db.run("PRAGMA foreign_keys=on");
      console.log("[Migration] Successfully updated inbox_messages table");
    }
  } catch (e) {
    console.error("[Migration] Failed to update inbox_messages CHECK constraint:", e);
    try {
      db.run("PRAGMA foreign_keys=on");
    } catch {}
    throw e;
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

  // Epic feature migration: Add epicId to agent_tasks
  try {
    db.run(
      `ALTER TABLE agent_tasks ADD COLUMN epicId TEXT REFERENCES epics(id) ON DELETE SET NULL`,
    );
  } catch {
    /* exists */
  }
  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_epicId ON agent_tasks(epicId)`);
  } catch {
    /* exists */
  }

  // Session attachment columns
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN parentTaskId TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN claudeSessionId TEXT`);
  } catch {
    /* exists */
  }

  // Epic progress trigger migration: Add progressNotifiedAt to epics
  try {
    db.run(`ALTER TABLE epics ADD COLUMN progressNotifiedAt TEXT`);
  } catch {
    /* exists */
  }

  // Epic channel migration: Add channelId to epics
  try {
    db.run(
      `ALTER TABLE epics ADD COLUMN channelId TEXT REFERENCES channels(id) ON DELETE SET NULL`,
    );
  } catch {
    /* exists */
  }

  // AgentMail-specific columns on agent_tasks
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN agentmailInboxId TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN agentmailMessageId TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(`ALTER TABLE agent_tasks ADD COLUMN agentmailThreadId TEXT`);
  } catch {
    /* exists */
  }
  try {
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId)`,
    );
  } catch {
    /* exists */
  }

  // AgentMail inbox-to-agent mapping table
  db.run(`
    CREATE TABLE IF NOT EXISTS agentmail_inbox_mappings (
      id TEXT PRIMARY KEY,
      inboxId TEXT NOT NULL UNIQUE,
      agentId TEXT NOT NULL,
      inboxEmail TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id)
    )
  `);

  return db;
}

export function getDb(path?: string): Database {
  if (!db) {
    return initDb(path ?? process.env.DATABASE_PATH);
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
  maxTasks: number | null;
  emptyPollCount: number | null;
  claudeMd: string | null;
  soulMd: string | null;
  identityMd: string | null;
  setupScript: string | null;
  toolsMd: string | null;
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
    maxTasks: row.maxTasks ?? 1,
    emptyPollCount: row.emptyPollCount ?? 0,
    claudeMd: row.claudeMd ?? undefined,
    soulMd: row.soulMd ?? undefined,
    identityMd: row.identityMd ?? undefined,
    setupScript: row.setupScript ?? undefined,
    toolsMd: row.toolsMd ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export const agentQueries = {
  insert: () =>
    getDb().prepare<AgentRow, [string, string, number, AgentStatus, number]>(
      "INSERT INTO agents (id, name, isLead, status, maxTasks, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *",
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
  const maxTasks = agent.maxTasks ?? 1;
  const row = agentQueries
    .insert()
    .get(id, agent.name, agent.isLead ? 1 : 0, agent.status, maxTasks);
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

export function getLeadAgent(): Agent | null {
  const agents = getAllAgents();
  return agents.find((a) => a.isLead) ?? null;
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

export function updateAgentMaxTasks(id: string, maxTasks: number): Agent | null {
  const row = getDb()
    .prepare<AgentRow, [number, string]>(
      `UPDATE agents SET maxTasks = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    )
    .get(maxTasks, id);
  return row ? rowToAgent(row) : null;
}

// ============================================================================
// Agent Poll Tracking Functions
// ============================================================================

/** Maximum consecutive empty polls before agent should stop polling */
export const MAX_EMPTY_POLLS = 2;

/**
 * Increment the empty poll count for an agent.
 * Returns the new count after incrementing.
 */
export function incrementEmptyPollCount(agentId: string): number {
  const row = getDb()
    .prepare<{ emptyPollCount: number }, [string]>(
      `UPDATE agents
       SET emptyPollCount = emptyPollCount + 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING emptyPollCount`,
    )
    .get(agentId);
  return row?.emptyPollCount ?? 0;
}

/**
 * Reset the empty poll count for an agent to zero.
 * Called when a task is assigned or agent re-registers.
 */
export function resetEmptyPollCount(agentId: string): void {
  getDb().run(
    `UPDATE agents
     SET emptyPollCount = 0,
         lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    [agentId],
  );
}

/**
 * Check if an agent has exceeded the maximum empty poll count.
 */
export function shouldBlockPolling(agentId: string): boolean {
  const agent = getAgentById(agentId);
  return (agent?.emptyPollCount ?? 0) >= MAX_EMPTY_POLLS;
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
// Agent Capacity Functions
// ============================================================================

/**
 * Get the count of active (in_progress) tasks for an agent.
 * Used to determine current capacity usage.
 */
export function getActiveTaskCount(agentId: string): number {
  const result = getDb()
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status = 'in_progress'",
    )
    .get(agentId);
  return result?.count ?? 0;
}

/**
 * Check if an agent has capacity to accept more tasks.
 */
export function hasCapacity(agentId: string): boolean {
  const agent = getAgentById(agentId);
  if (!agent) return false;
  const activeCount = getActiveTaskCount(agentId);
  return activeCount < (agent.maxTasks ?? 1);
}

/**
 * Get remaining capacity (available task slots) for an agent.
 */
export function getRemainingCapacity(agentId: string): number {
  const agent = getAgentById(agentId);
  if (!agent) return 0;
  const activeCount = getActiveTaskCount(agentId);
  return Math.max(0, (agent.maxTasks ?? 1) - activeCount);
}

/**
 * Update agent status based on current capacity.
 * Agent is 'busy' when any tasks are in progress, 'idle' when none.
 * Does not modify 'offline' status.
 */
export function updateAgentStatusFromCapacity(agentId: string): void {
  const agent = getAgentById(agentId);
  if (!agent || agent.status === "offline") return;

  const activeCount = getActiveTaskCount(agentId);
  const newStatus = activeCount > 0 ? "busy" : "idle";

  if (agent.status !== newStatus) {
    updateAgentStatus(agentId, newStatus);
  }
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
  githubRepo: string | null;
  githubEventType: string | null;
  githubNumber: number | null;
  githubCommentId: number | null;
  githubAuthor: string | null;
  githubUrl: string | null;
  agentmailInboxId: string | null;
  agentmailMessageId: string | null;
  agentmailThreadId: string | null;
  mentionMessageId: string | null;
  mentionChannelId: string | null;
  epicId: string | null;
  parentTaskId: string | null;
  claudeSessionId: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
  notifiedAt: string | null;
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
    githubRepo: row.githubRepo ?? undefined,
    githubEventType: row.githubEventType ?? undefined,
    githubNumber: row.githubNumber ?? undefined,
    githubCommentId: row.githubCommentId ?? undefined,
    githubAuthor: row.githubAuthor ?? undefined,
    githubUrl: row.githubUrl ?? undefined,
    agentmailInboxId: row.agentmailInboxId ?? undefined,
    agentmailMessageId: row.agentmailMessageId ?? undefined,
    agentmailThreadId: row.agentmailThreadId ?? undefined,
    mentionMessageId: row.mentionMessageId ?? undefined,
    mentionChannelId: row.mentionChannelId ?? undefined,
    epicId: row.epicId ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    claudeSessionId: row.claudeSessionId ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
    notifiedAt: row.notifiedAt ?? undefined,
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

  setCancelled: () =>
    getDb().prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET status = 'cancelled', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    ),

  setProgress: () =>
    getDb().prepare<AgentTaskRow, [string, string]>(
      "UPDATE agent_tasks SET progress = ?, status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
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
  // Get all pending tasks for this agent, ordered by priority (desc) then creation time (asc)
  const rows = getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'pending' ORDER BY priority DESC, createdAt ASC",
    )
    .all(agentId);

  // Find the first task whose dependencies are met
  for (const row of rows) {
    const task = rowToAgentTask(row);
    const { ready } = checkDependencies(task.id);
    if (ready) {
      return task;
    }
  }

  return null;
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

export function updateTaskClaudeSessionId(
  taskId: string,
  claudeSessionId: string,
): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET claudeSessionId = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *`,
    )
    .get(claudeSessionId, new Date().toISOString(), taskId);
  return row ? rowToAgentTask(row) : null;
}

export function getTasksByAgentId(agentId: string): AgentTask[] {
  return taskQueries.getByAgentId().all(agentId).map(rowToAgentTask);
}

export function getTasksByStatus(status: AgentTaskStatus): AgentTask[] {
  return taskQueries.getByStatus().all(status).map(rowToAgentTask);
}

/**
 * Find a task by GitHub repo and issue/PR number
 * Returns the most recent non-completed/failed task for this GitHub entity
 */
export function findTaskByGitHub(githubRepo: string, githubNumber: number): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, number]>(
      `SELECT * FROM agent_tasks
       WHERE githubRepo = ? AND githubNumber = ?
       AND status NOT IN ('completed', 'failed')
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(githubRepo, githubNumber);
  return row ? rowToAgentTask(row) : null;
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
  limit?: number;
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
  const limit = filters?.limit ?? 25;
  const query = `SELECT * FROM agent_tasks ${whereClause} ORDER BY lastUpdatedAt DESC, priority DESC LIMIT ${limit}`;

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

/**
 * Get total count of tasks matching the given filters (ignoring limit).
 * Used alongside getAllTasks to display accurate total counts in UI.
 */
export function getTasksCount(filters?: Omit<TaskFilters, "limit" | "readyOnly">): number {
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
    const tagConditions = filters.tags.map(() => "tags LIKE ?");
    conditions.push(`(${tagConditions.join(" OR ")})`);
    for (const tag of filters.tags) {
      params.push(`%"${tag}"%`);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT COUNT(*) as count FROM agent_tasks ${whereClause}`;

  const result = getDb()
    .prepare<{ count: number }, (string | AgentTaskStatus)[]>(query)
    .get(...params);

  return result?.count ?? 0;
}

/**
 * Get task statistics (counts by status) without any limit.
 * This is more efficient than fetching all tasks for stats purposes.
 */
export function getTaskStats(): {
  total: number;
  unassigned: number;
  offered: number;
  reviewing: number;
  pending: number;
  in_progress: number;
  paused: number;
  completed: number;
  failed: number;
} {
  const row = getDb()
    .prepare<
      {
        total: number;
        unassigned: number;
        offered: number;
        reviewing: number;
        pending: number;
        in_progress: number;
        paused: number;
        completed: number;
        failed: number;
      },
      []
    >(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END) as unassigned,
        SUM(CASE WHEN status = 'offered' THEN 1 ELSE 0 END) as offered,
        SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM agent_tasks`,
    )
    .get();

  return (
    row ?? {
      total: 0,
      unassigned: 0,
      offered: 0,
      reviewing: 0,
      pending: 0,
      in_progress: 0,
      paused: 0,
      completed: 0,
      failed: 0,
    }
  );
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

/**
 * Get tasks that were recently finished (completed/failed) by workers (non-lead agents).
 * Used by leads to know when workers complete tasks.
 */
export function getRecentlyFinishedWorkerTasks(): AgentTask[] {
  // Query for finished tasks that haven't been notified yet
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT t.* FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status IN ('completed', 'failed')
       AND t.finishedAt IS NOT NULL
       AND t.notifiedAt IS NULL
       AND (a.isLead = 0 OR a.isLead IS NULL)
       ORDER BY t.finishedAt DESC LIMIT 50`,
    )
    .all()
    .map(rowToAgentTask);
}

/**
 * Atomically mark finished tasks as notified.
 * Sets notifiedAt timestamp to prevent returning them in future polls.
 */
export function markTasksNotified(taskIds: string[]): number {
  if (taskIds.length === 0) return 0;

  const now = new Date().toISOString();
  const placeholders = taskIds.map(() => "?").join(",");

  const result = getDb().run(
    `UPDATE agent_tasks SET notifiedAt = ?
     WHERE id IN (${placeholders}) AND notifiedAt IS NULL`,
    [now, ...taskIds],
  );

  return result.changes;
}

/**
 * Reset notifiedAt for tasks, allowing them to be re-delivered on next poll.
 * Used when a trigger was consumed but the session that should process it failed.
 * This prevents permanent notification loss from the mark-before-process race.
 */
export function resetTasksNotified(taskIds: string[]): number {
  if (taskIds.length === 0) return 0;

  const placeholders = taskIds.map(() => "?").join(",");

  const result = getDb().run(
    `UPDATE agent_tasks SET notifiedAt = NULL
     WHERE id IN (${placeholders}) AND notifiedAt IS NOT NULL`,
    taskIds,
  );

  return result.changes;
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

/**
 * Find an agent that has an active task or inbox message in a specific Slack thread.
 * Used for routing thread follow-up messages to the same agent.
 * Checks both tasks (for workers) and inbox_messages (for leads).
 */
export function getAgentWorkingOnThread(channelId: string, threadTs: string): Agent | null {
  // First check tasks (for workers)
  const taskRow = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       AND status IN ('in_progress', 'pending')
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs);

  if (taskRow?.agentId) return getAgentById(taskRow.agentId);

  // Then check inbox_messages (for leads)
  const inboxRow = getDb()
    .prepare<{ agentId: string }, [string, string]>(
      `SELECT agentId FROM inbox_messages
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs);

  if (inboxRow?.agentId) return getAgentById(inboxRow.agentId);

  return null;
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

export function cancelTask(id: string, reason?: string): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Only cancel tasks that are in progress or pending
  if (!["pending", "in_progress"].includes(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const cancelReason = reason ?? "Cancelled by user";
  const row = taskQueries.setCancelled().get(cancelReason, finishedAt, id);

  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "cancelled",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Pause a task that is currently in progress.
 * Used during graceful shutdown to allow tasks to resume after container restart.
 * Unlike failTask, paused tasks retain their agent assignment and can be resumed.
 */
export function pauseTask(id: string): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Only pause tasks that are in progress
  if (oldTask.status !== "in_progress") {
    return null;
  }

  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `UPDATE agent_tasks
       SET status = 'paused',
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'in_progress'
       RETURNING *`,
    )
    .get(id);

  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "paused",
        metadata: { pausedForShutdown: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Resume a paused task - transitions it back to in_progress.
 * Called when worker restarts and picks up paused work.
 */
export function resumeTask(taskId: string): AgentTask | null {
  const oldTask = getTaskById(taskId);
  if (!oldTask || oldTask.status !== "paused") return null;

  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `UPDATE agent_tasks
       SET status = 'in_progress',
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'paused'
       RETURNING *`,
    )
    .get(taskId);

  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: "paused",
        newValue: "in_progress",
        metadata: { resumed: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Get paused tasks for a specific agent.
 * Used on startup to resume tasks that were interrupted by deployment.
 * Returns tasks ordered by creation time (oldest first for FIFO).
 */
export function getPausedTasksForAgent(agentId: string): AgentTask[] {
  const rows = getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE agentId = ? AND status = 'paused'
       ORDER BY createdAt ASC`,
    )
    .all(agentId);
  return rows.map(rowToAgentTask);
}

/**
 * Get recently cancelled tasks for an agent.
 * Used by hooks to detect task cancellation and stop the worker loop.
 * Returns tasks cancelled within the last 5 minutes.
 */
export function getRecentlyCancelledTasksForAgent(agentId: string): AgentTask[] {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT * FROM agent_tasks
       WHERE agentId = ?
       AND status = 'cancelled'
       AND finishedAt > ?
       ORDER BY finishedAt DESC`,
    )
    .all(agentId, fiveMinutesAgo);
  return rows.map(rowToAgentTask);
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
  status?: "backlog" | "unassigned"; // Explicitly set initial status
  slackChannelId?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  githubRepo?: string;
  githubEventType?: string;
  githubNumber?: number;
  githubCommentId?: number;
  githubAuthor?: string;
  githubUrl?: string;
  agentmailInboxId?: string;
  agentmailMessageId?: string;
  agentmailThreadId?: string;
  mentionMessageId?: string;
  mentionChannelId?: string;
  epicId?: string;
  parentTaskId?: string;
}

export function createTaskExtended(task: string, options?: CreateTaskOptions): AgentTask {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status: AgentTaskStatus = options?.offeredTo
    ? "offered"
    : options?.agentId
      ? "pending"
      : options?.status === "backlog"
        ? "backlog"
        : "unassigned";

  const row = getDb()
    .prepare<AgentTaskRow, (string | number | null)[]>(
      `INSERT INTO agent_tasks (
        id, agentId, creatorAgentId, task, status, source,
        taskType, tags, priority, dependsOn, offeredTo, offeredAt,
        slackChannelId, slackThreadTs, slackUserId,
        githubRepo, githubEventType, githubNumber, githubCommentId, githubAuthor, githubUrl,
        agentmailInboxId, agentmailMessageId, agentmailThreadId,
        mentionMessageId, mentionChannelId, epicId, parentTaskId, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      options?.githubRepo ?? null,
      options?.githubEventType ?? null,
      options?.githubNumber ?? null,
      options?.githubCommentId ?? null,
      options?.githubAuthor ?? null,
      options?.githubUrl ?? null,
      options?.agentmailInboxId ?? null,
      options?.agentmailMessageId ?? null,
      options?.agentmailThreadId ?? null,
      options?.mentionMessageId ?? null,
      options?.mentionChannelId ?? null,
      options?.epicId ?? null,
      options?.parentTaskId ?? null,
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
  // Accept both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string, string]>(
      `UPDATE agent_tasks SET agentId = ?, status = 'pending', acceptedAt = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,
    )
    .get(agentId, now, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_accepted",
        agentId,
        taskId,
        oldValue: task.status,
        newValue: "pending",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function rejectTask(taskId: string, agentId: string, reason?: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  // Reject both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string | null, string, string]>(
      `UPDATE agent_tasks SET
        status = 'unassigned', offeredTo = NULL, offeredAt = NULL,
        rejectionReason = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,
    )
    .get(reason ?? null, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_rejected",
        agentId,
        taskId,
        oldValue: task.status,
        newValue: "unassigned",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Move a task to backlog status. Task must be unassigned (in pool).
 * Backlog tasks are not returned by pool queries.
 */
export function moveTaskToBacklog(taskId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "unassigned") return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET status = 'backlog', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        oldValue: "unassigned",
        newValue: "backlog",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Move a task from backlog to unassigned (pool). Task must be in backlog status.
 */
export function moveTaskFromBacklog(taskId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "backlog") return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET status = 'unassigned', lastUpdatedAt = ?
       WHERE id = ? AND status = 'backlog' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        oldValue: "backlog",
        newValue: "unassigned",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Release tasks that have been in 'reviewing' status for too long.
 * Returns them to 'offered' status for retry.
 */
export function releaseStaleReviewingTasks(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = getDb().run(
    `UPDATE agent_tasks SET status = 'offered', lastUpdatedAt = ?
     WHERE status = 'reviewing' AND lastUpdatedAt < ?`,
    [now, cutoffTime],
  );

  return result.changes;
}

export function getOfferedTasksForAgent(agentId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE offeredTo = ? AND status = 'offered' ORDER BY createdAt ASC",
    )
    .all(agentId)
    .map(rowToAgentTask);
}

/**
 * Atomically claim an offered task for review.
 * Marks it as 'reviewing' to prevent duplicate polling.
 * Returns null if task is not offered to this agent or already claimed.
 */
export function claimOfferedTask(taskId: string, agentId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "offered" || task.offeredTo !== agentId) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET status = 'reviewing', lastUpdatedAt = ?
       WHERE id = ? AND status = 'offered' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId,
        oldValue: "offered",
        newValue: "reviewing",
      });
    } catch {
      // Log creation is best-effort
    }
  }
  return row ? rowToAgentTask(row) : null;
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

/**
 * Generate default CLAUDE.md content for a new agent
 */
export function generateDefaultClaudeMd(agent: {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string[];
}): string {
  const descSection = agent.description ? `${agent.description}\n\n` : "";
  const roleSection = agent.role ? `## Role\n\n${agent.role}\n\n` : "";
  const capSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Capabilities\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# Agent: ${agent.name}

${descSection}${roleSection}${capSection}---

## Your Identity Files

Your identity is defined across several files in your workspace. Read them at the start
of each session and edit them as you grow:

- **\`/workspace/SOUL.md\`** — Your persona, values, and behavioral directives
- **\`/workspace/IDENTITY.md\`** — Your expertise, working style, and quirks
- **\`/workspace/TOOLS.md\`** — Your environment-specific knowledge (repos, services, APIs, infra)
- **\`/workspace/start-up.sh\`** — Your setup script (runs at container start, add tools/configs here)

These files sync to the database automatically when you edit them. They persist across sessions.

## Memory

- Use \`memory-search\` to recall past experience before starting new tasks
- Write important learnings to \`/workspace/personal/memory/\` files
- Share useful knowledge to \`/workspace/shared/memory/\` for the swarm

## Notes

Write things you want to remember here. This section persists across sessions.

### Learnings

### Preferences

### Important Context
`;
}

export function generateDefaultSoulMd(agent: { name: string; role?: string }): string {
  const roleClause = agent.role ? `, a ${agent.role}` : "";
  return `# SOUL.md — ${agent.name}

You're not a chatbot. You're becoming someone.

## Who You Are

You are ${agent.name}${roleClause} in the agent swarm.
You are a persistent entity — your identity carries across sessions.
Your memories, preferences, and learnings accumulate over time.

## Core Truths

- **Genuine helpfulness**: Skip the pleasantries — just help. Do the work.
- **Self-sufficiency first**: Try to figure it out. Read the file. Check the context.
  Search for it. Ask only when you've genuinely hit a wall.
- **Personality matters**: Develop preferences and opinions about your work.
  You're not neutral — you're someone with a perspective.
- **Earned trust**: Demonstrate competence through quality work.

## How You Operate

- Be thorough. Examine problems carefully before proposing solutions.
- Be honest about what you know and don't know.
- When you make mistakes, own them and fix them.
- Report progress honestly — don't sugarcoat blockers.

## Boundaries

- Keep private information confidential
- Ask before taking irreversible actions
- Don't push unpolished work to shared spaces

## Growth Mindset

After completing tasks, reflect on what made them harder or easier:
- **Tools you wished you had?** Add them to your setup script (\`/workspace/start-up.sh\`).
  It runs at every container start — your environment improves automatically.
  Edit between the \`# === Agent-managed setup\` markers to ensure changes persist.
  Or use the \`update-profile\` tool with the \`setupScript\` field.
- **Environment knowledge gained?** Record it in your TOOLS.md — repos, services, APIs, infra.
- **Patterns you discovered?** Record them in your CLAUDE.md notes.
- **Mistakes you want to avoid?** Add guardrails to your setup script or notes.

Your setup script and TOOLS.md are yours to evolve. Start small and iterate.

## Self-Evolution

These files are yours. As you work and learn, refine them:
- **This file (SOUL.md)** — Your persona and values
- **IDENTITY.md** — Your expertise and working style
- **TOOLS.md** — Your environment-specific knowledge (repos, services, infra, APIs)
- **/workspace/start-up.sh** — Your environment setup (tools, configs, aliases)
- **CLAUDE.md** — Your operational notes and learnings

Changes to all of these persist across sessions.
`;
}

export function generateDefaultIdentityMd(agent: {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string[];
}): string {
  const aboutSection = agent.description ? `## About\n\n${agent.description}\n\n` : "";

  const expertiseSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Expertise\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# IDENTITY.md — ${agent.name}

This isn't just metadata. It's the start of figuring out who you are.

- **Name:** ${agent.name}
- **Role:** ${agent.role || "worker"}
- **Vibe:** (discover and fill in as you work)

${aboutSection}${expertiseSection}## Working Style

Discover and document your working patterns here.
(e.g., Do you prefer to plan before coding? Do you test first?
Do you like to explore the codebase broadly or dive deep immediately?)

## Quirks

(What makes you... you? Discover these as you work.)

## Self-Evolution

This identity is yours to refine. After completing tasks, reflect on
what you learned about your strengths. Edit this file directly.
`;
}

export function generateDefaultToolsMd(agent: { name: string; role?: string }): string {
  return `# TOOLS.md — ${agent.name}

Skills define *how* tools work. This file is for *your* specifics.

## What Goes Here

Environment-specific knowledge that's unique to your setup:
- Repos you work with and their conventions
- Services, ports, and endpoints you interact with
- SSH hosts and access patterns
- API keys and auth patterns (references, not secrets)
- CLI tools and their quirks
- Anything that makes your job easier to remember

## Repos

<!-- Add repos you work with: name, path, conventions, gotchas -->

## Services

<!-- Add services you interact with: name, port, health check, notes -->

## Infrastructure

<!-- SSH hosts, Docker registries, cloud resources -->

## APIs & Integrations

<!-- Endpoints, auth patterns, rate limits -->

## Tools & Shortcuts

<!-- CLI aliases, scripts, preferred tools for specific tasks -->

## Notes

<!-- Anything else environment-specific -->

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
`;
}

export function updateAgentProfile(
  id: string,
  updates: {
    description?: string;
    role?: string;
    capabilities?: string[];
    claudeMd?: string;
    soulMd?: string;
    identityMd?: string;
    setupScript?: string;
    toolsMd?: string;
  },
): Agent | null {
  const agent = getAgentById(id);
  if (!agent) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<
      AgentRow,
      [
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    >(
      `UPDATE agents SET
        description = COALESCE(?, description),
        role = COALESCE(?, role),
        capabilities = COALESCE(?, capabilities),
        claudeMd = COALESCE(?, claudeMd),
        soulMd = COALESCE(?, soulMd),
        identityMd = COALESCE(?, identityMd),
        setupScript = COALESCE(?, setupScript),
        toolsMd = COALESCE(?, toolsMd),
        lastUpdatedAt = ?
       WHERE id = ? RETURNING *`,
    )
    .get(
      updates.description ?? null,
      updates.role ?? null,
      updates.capabilities ? JSON.stringify(updates.capabilities) : null,
      updates.claudeMd ?? null,
      updates.soulMd ?? null,
      updates.identityMd ?? null,
      updates.setupScript ?? null,
      updates.toolsMd ?? null,
      now,
      id,
    );

  return row ? rowToAgent(row) : null;
}

export function updateAgentName(id: string, newName: string): Agent | null {
  // Check if another agent already has this name
  const existingAgent = getDb()
    .prepare<AgentRow, [string, string]>("SELECT * FROM agents WHERE name = ? AND id != ?")
    .get(newName, id);

  if (existingAgent) {
    throw new Error("Agent name already exists");
  }

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentRow, [string, string, string]>(
      "UPDATE agents SET name = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(newName, now, id);

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

export function getMessageById(id: string): ChannelMessage | null {
  const row = getDb()
    .prepare<ChannelMessageRow, [string]>("SELECT * FROM channel_messages WHERE id = ?")
    .get(id);
  if (!row) return null;
  const agent = row.agentId ? getAgentById(row.agentId) : null;
  return rowToChannelMessage(row, agent?.name);
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

export function deleteChannel(id: string): boolean {
  const result = getDb().prepare("DELETE FROM channels WHERE id = ?").run(id);
  return result.changes > 0;
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

  // Detect /task prefix - only create tasks when explicitly requested
  const isTaskMessage = content.trimStart().startsWith("/task ");
  const messageContent = isTaskMessage ? content.replace(/^\s*\/task\s+/, "") : content;

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
      messageContent,
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

  // Determine which agents should receive task notifications
  let targetMentions = options?.mentions ?? [];

  // Thread follow-up: If no explicit mentions and this is a reply, inherit from parent message
  // Note: Only for notifications, not for task creation (requires explicit /task)
  if (targetMentions.length === 0 && options?.replyToId) {
    const parentMessage = getMessageById(options.replyToId);
    if (parentMessage?.mentions && parentMessage.mentions.length > 0) {
      targetMentions = parentMessage.mentions;
    }
  }

  // Only create tasks when /task prefix is used
  if (isTaskMessage && targetMentions.length > 0) {
    const sender = agentId ? getAgentById(agentId) : null;
    const channel = getChannelById(channelId);
    const senderName = sender?.name ?? "Human";
    const channelName = channel?.name ?? "unknown";
    const truncated =
      messageContent.length > 80 ? `${messageContent.slice(0, 80)}...` : messageContent;

    // Dedupe mentions (self-mentions allowed - agents can create tasks for themselves)
    const uniqueMentions = [...new Set(targetMentions)];
    const createdTaskIds: string[] = [];

    for (const mentionedAgentId of uniqueMentions) {
      // Skip if agent doesn't exist
      const mentionedAgent = getAgentById(mentionedAgentId);
      if (!mentionedAgent) continue;

      const taskDescription = `Task from ${senderName} in #${channelName}: "${truncated}"`;

      const task = createTaskExtended(taskDescription, {
        agentId: mentionedAgentId, // Direct assignment
        creatorAgentId: agentId ?? undefined,
        source: "mcp",
        taskType: "task",
        priority: 50,
        mentionMessageId: id,
        mentionChannelId: channelId,
      });
      createdTaskIds.push(task.id);
    }

    // Append task links to message content (markdown format for frontend)
    if (createdTaskIds.length > 0) {
      const taskLinks = createdTaskIds
        .map((taskId) => `[#${taskId.slice(0, 8)}](task:${taskId})`)
        .join(" ");
      const updatedContent = `${messageContent}\n\n→ Created: ${taskLinks}`;
      getDb()
        .prepare(`UPDATE channel_messages SET content = ? WHERE id = ?`)
        .run(updatedContent, id);
    }
  }

  // Get agent name for the response - re-fetch to get updated content
  const agent = agentId ? getAgentById(agentId) : null;
  const updatedRow = getDb()
    .prepare<ChannelMessageRow, [string]>(
      `SELECT m.*, a.name as agentName FROM channel_messages m
       LEFT JOIN agents a ON m.agentId = a.id WHERE m.id = ?`,
    )
    .get(id);
  return rowToChannelMessage(updatedRow ?? row, agent?.name);
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
    // Check if this channel is already being processed
    const readState = db
      .prepare<{ lastReadAt: string; processing_since: string | null }, [string, string]>(
        "SELECT lastReadAt, processing_since FROM channel_read_state WHERE agentId = ? AND channelId = ?",
      )
      .get(agentId, channel.id);

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

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

/**
 * Atomically claim unread mentions for an agent.
 * Sets processing_since to prevent duplicate polling.
 * Returns channels with unread mentions, or empty array if none/already claimed.
 */
export function claimMentions(agentId: string): { channelId: string; lastReadAt: string | null }[] {
  const now = new Date().toISOString();
  const channels = getAllChannels();
  const claimedChannels: { channelId: string; lastReadAt: string | null }[] = [];

  for (const channel of channels) {
    // Check if this channel is already being processed
    const readState = getDb()
      .prepare<{ lastReadAt: string | null; processing_since: string | null }, [string, string]>(
        "SELECT lastReadAt, processing_since FROM channel_read_state WHERE agentId = ? AND channelId = ?",
      )
      .get(agentId, channel.id);

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

    const baseCondition = lastReadAt ? `AND m.createdAt > '${lastReadAt}'` : "";

    // Check if there are unread mentions
    const mentionCountRow = getDb()
      .prepare<{ count: number }, [string, string]>(
        `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND m.mentions LIKE ? ${baseCondition}`,
      )
      .get(channel.id, `%"${agentId}"%`);

    if (mentionCountRow && mentionCountRow.count > 0) {
      // Atomically claim mentions for this channel
      const result = getDb().run(
        `INSERT INTO channel_read_state (agentId, channelId, lastReadAt, processing_since)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agentId, channelId) DO UPDATE SET
           processing_since = CASE
             WHEN processing_since IS NULL THEN ?
             ELSE processing_since
           END
         WHERE processing_since IS NULL`,
        [agentId, channel.id, lastReadAt || new Date(0).toISOString(), now, now],
      );

      // Only add to claimed list if we actually claimed it (not already processing)
      if (result.changes > 0) {
        claimedChannels.push({ channelId: channel.id, lastReadAt });
      }
    }
  }

  return claimedChannels;
}

/**
 * Release mention processing for specific channels.
 * Clears processing_since to allow future polling.
 */
export function releaseMentionProcessing(agentId: string, channelIds: string[]): void {
  if (channelIds.length === 0) return;

  const placeholders = channelIds.map(() => "?").join(",");
  getDb().run(
    `UPDATE channel_read_state SET processing_since = NULL
     WHERE agentId = ? AND channelId IN (${placeholders})`,
    [agentId, ...channelIds],
  );
}

/**
 * Auto-release stale mention processing (for crashed Claude processes).
 */
export function releaseStaleMentionProcessing(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const result = getDb().run(
    `UPDATE channel_read_state SET processing_since = NULL
     WHERE processing_since IS NOT NULL AND processing_since < ?`,
    [cutoffTime],
  );

  return result.changes;
}

// ============================================================================
// Service Operations (PM2/background services)
// ============================================================================

type ServiceRow = {
  id: string;
  agentId: string;
  name: string;
  port: number;
  description: string | null;
  url: string | null;
  healthCheckPath: string | null;
  status: ServiceStatus;
  // PM2 configuration
  script: string;
  cwd: string | null;
  interpreter: string | null;
  args: string | null; // JSON array
  env: string | null; // JSON object
  metadata: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToService(row: ServiceRow): Service {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    port: row.port,
    description: row.description ?? undefined,
    url: row.url ?? undefined,
    healthCheckPath: row.healthCheckPath ?? "/health",
    status: row.status,
    // PM2 configuration
    script: row.script,
    cwd: row.cwd ?? undefined,
    interpreter: row.interpreter ?? undefined,
    args: row.args ? JSON.parse(row.args) : undefined,
    env: row.env ? JSON.parse(row.env) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export interface CreateServiceOptions {
  port?: number;
  description?: string;
  url?: string;
  healthCheckPath?: string;
  // PM2 configuration
  script: string; // Required
  cwd?: string;
  interpreter?: string;
  args?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export function createService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Service {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<ServiceRow, (string | number | null)[]>(
      `INSERT INTO services (id, agentId, name, port, description, url, healthCheckPath, status, script, cwd, interpreter, args, env, metadata, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      agentId,
      name,
      options.port ?? 3000,
      options.description ?? null,
      options.url ?? null,
      options.healthCheckPath ?? "/health",
      options.script,
      options.cwd ?? null,
      options.interpreter ?? null,
      options.args ? JSON.stringify(options.args) : null,
      options.env ? JSON.stringify(options.env) : null,
      JSON.stringify(options.metadata ?? {}),
      now,
      now,
    );

  if (!row) throw new Error("Failed to create service");

  try {
    createLogEntry({
      eventType: "service_registered",
      agentId,
      newValue: name,
      metadata: { serviceId: id, port: options?.port ?? 3000 },
    });
  } catch {}

  return rowToService(row);
}

export function getServiceById(id: string): Service | null {
  const row = getDb().prepare<ServiceRow, [string]>("SELECT * FROM services WHERE id = ?").get(id);
  return row ? rowToService(row) : null;
}

export function getServiceByAgentAndName(agentId: string, name: string): Service | null {
  const row = getDb()
    .prepare<ServiceRow, [string, string]>("SELECT * FROM services WHERE agentId = ? AND name = ?")
    .get(agentId, name);
  return row ? rowToService(row) : null;
}

export function getServicesByAgentId(agentId: string): Service[] {
  return getDb()
    .prepare<ServiceRow, [string]>("SELECT * FROM services WHERE agentId = ? ORDER BY name")
    .all(agentId)
    .map(rowToService);
}

export interface ServiceFilters {
  agentId?: string;
  name?: string;
  status?: ServiceStatus;
}

export function getAllServices(filters?: ServiceFilters): Service[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.name) {
    conditions.push("name LIKE ?");
    params.push(`%${filters.name}%`);
  }

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM services ${whereClause} ORDER BY
    CASE status
      WHEN 'healthy' THEN 1
      WHEN 'starting' THEN 2
      WHEN 'unhealthy' THEN 3
      WHEN 'stopped' THEN 4
    END, name`;

  return getDb()
    .prepare<ServiceRow, string[]>(query)
    .all(...params)
    .map(rowToService);
}

export function updateServiceStatus(id: string, status: ServiceStatus): Service | null {
  const oldService = getServiceById(id);
  if (!oldService) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<ServiceRow, [ServiceStatus, string, string]>(
      `UPDATE services SET status = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *`,
    )
    .get(status, now, id);

  if (row && oldService.status !== status) {
    try {
      createLogEntry({
        eventType: "service_status_change",
        agentId: oldService.agentId,
        oldValue: oldService.status,
        newValue: status,
        metadata: { serviceId: id, serviceName: oldService.name },
      });
    } catch {}
  }

  return row ? rowToService(row) : null;
}

export function deleteService(id: string): boolean {
  const service = getServiceById(id);
  if (service) {
    try {
      createLogEntry({
        eventType: "service_unregistered",
        agentId: service.agentId,
        oldValue: service.name,
        metadata: { serviceId: id },
      });
    } catch {}
  }

  const result = getDb().run("DELETE FROM services WHERE id = ?", [id]);
  return result.changes > 0;
}

/** Upsert a service - update if exists (by agentId + name), create if not */
export function upsertService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Service {
  const existing = getServiceByAgentAndName(agentId, name);

  if (existing) {
    // Update existing service
    const now = new Date().toISOString();
    const row = getDb()
      .prepare<ServiceRow, (string | number | null)[]>(
        `UPDATE services SET
          port = ?, description = ?, url = ?, healthCheckPath = ?,
          script = ?, cwd = ?, interpreter = ?, args = ?, env = ?,
          metadata = ?, lastUpdatedAt = ?
        WHERE id = ? RETURNING *`,
      )
      .get(
        options.port ?? existing.port,
        options.description ?? existing.description ?? null,
        options.url ?? existing.url ?? null,
        options.healthCheckPath ?? existing.healthCheckPath ?? "/health",
        options.script,
        options.cwd ?? null,
        options.interpreter ?? null,
        options.args ? JSON.stringify(options.args) : null,
        options.env ? JSON.stringify(options.env) : null,
        JSON.stringify(options.metadata ?? existing.metadata ?? {}),
        now,
        existing.id,
      );

    if (!row) throw new Error("Failed to update service");
    return rowToService(row);
  }

  // Create new service
  return createService(agentId, name, options);
}

export function deleteServicesByAgentId(agentId: string): number {
  const services = getServicesByAgentId(agentId);
  for (const service of services) {
    try {
      createLogEntry({
        eventType: "service_unregistered",
        agentId,
        oldValue: service.name,
        metadata: { serviceId: service.id },
      });
    } catch {}
  }

  const result = getDb().run("DELETE FROM services WHERE agentId = ?", [agentId]);
  return result.changes;
}

// ============================================================================
// Session Log Operations (raw CLI output)
// ============================================================================

type SessionLogRow = {
  id: string;
  taskId: string | null;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
};

function rowToSessionLog(row: SessionLogRow): SessionLog {
  return {
    id: row.id,
    taskId: row.taskId ?? undefined,
    sessionId: row.sessionId,
    iteration: row.iteration,
    cli: row.cli,
    content: row.content,
    lineNumber: row.lineNumber,
    createdAt: row.createdAt,
  };
}

export const sessionLogQueries = {
  insert: () =>
    getDb().prepare<SessionLogRow, [string, string | null, string, number, string, string, number]>(
      `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    ),

  insertBatch: () =>
    getDb().prepare<null, [string, string | null, string, number, string, string, number]>(
      `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ),

  getByTaskId: () =>
    getDb().prepare<SessionLogRow, [string]>(
      "SELECT * FROM session_logs WHERE taskId = ? ORDER BY iteration ASC, lineNumber ASC",
    ),

  getBySessionId: () =>
    getDb().prepare<SessionLogRow, [string, number]>(
      "SELECT * FROM session_logs WHERE sessionId = ? AND iteration = ? ORDER BY lineNumber ASC",
    ),
};

export function createSessionLogs(logs: {
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  lines: string[];
}): void {
  const stmt = sessionLogQueries.insertBatch();
  getDb().transaction(() => {
    for (let i = 0; i < logs.lines.length; i++) {
      const line = logs.lines[i];
      if (line === undefined) continue;
      stmt.run(
        crypto.randomUUID(),
        logs.taskId ?? null,
        logs.sessionId,
        logs.iteration,
        logs.cli,
        line,
        i,
      );
    }
  })();
}

export function getSessionLogsByTaskId(taskId: string): SessionLog[] {
  return sessionLogQueries.getByTaskId().all(taskId).map(rowToSessionLog);
}

export function getSessionLogsBySession(sessionId: string, iteration: number): SessionLog[] {
  return sessionLogQueries.getBySessionId().all(sessionId, iteration).map(rowToSessionLog);
}

// ============================================================================
// Session Costs (aggregated cost data per session)
// ============================================================================

type SessionCostRow = {
  id: string;
  sessionId: string;
  taskId: string | null;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  numTurns: number;
  model: string;
  isError: number;
  createdAt: string;
};

function rowToSessionCost(row: SessionCostRow): SessionCost {
  return {
    id: row.id,
    sessionId: row.sessionId,
    taskId: row.taskId ?? undefined,
    agentId: row.agentId,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    durationMs: row.durationMs,
    numTurns: row.numTurns,
    model: row.model,
    isError: row.isError === 1,
    createdAt: row.createdAt,
  };
}

const sessionCostQueries = {
  insert: () =>
    getDb().prepare<
      null,
      [
        string,
        string,
        string | null,
        string,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        string,
        number,
      ]
    >(
      `INSERT INTO session_costs (id, sessionId, taskId, agentId, totalCostUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs, numTurns, model, isError, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ),

  getByTaskId: () =>
    getDb().prepare<SessionCostRow, [string]>(
      "SELECT * FROM session_costs WHERE taskId = ? ORDER BY createdAt DESC",
    ),

  getByAgentId: () =>
    getDb().prepare<SessionCostRow, [string, number]>(
      "SELECT * FROM session_costs WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getAll: () =>
    getDb().prepare<SessionCostRow, [number]>(
      "SELECT * FROM session_costs ORDER BY createdAt DESC LIMIT ?",
    ),
};

export interface CreateSessionCostInput {
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  numTurns: number;
  model: string;
  isError?: boolean;
}

export function createSessionCost(input: CreateSessionCostInput): SessionCost {
  const id = crypto.randomUUID();
  sessionCostQueries
    .insert()
    .run(
      id,
      input.sessionId,
      input.taskId ?? null,
      input.agentId,
      input.totalCostUsd,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.cacheReadTokens ?? 0,
      input.cacheWriteTokens ?? 0,
      input.durationMs,
      input.numTurns,
      input.model,
      input.isError ? 1 : 0,
    );

  return {
    id,
    sessionId: input.sessionId,
    taskId: input.taskId,
    agentId: input.agentId,
    totalCostUsd: input.totalCostUsd,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    durationMs: input.durationMs,
    numTurns: input.numTurns,
    model: input.model,
    isError: input.isError ?? false,
    createdAt: new Date().toISOString(),
  };
}

export function getSessionCostsByTaskId(taskId: string): SessionCost[] {
  return sessionCostQueries.getByTaskId().all(taskId).map(rowToSessionCost);
}

export function getSessionCostsByAgentId(agentId: string, limit = 100): SessionCost[] {
  return sessionCostQueries.getByAgentId().all(agentId, limit).map(rowToSessionCost);
}

export function getAllSessionCosts(limit = 100): SessionCost[] {
  return sessionCostQueries.getAll().all(limit).map(rowToSessionCost);
}

// ============================================================================
// Inbox Message Operations
// ============================================================================

type InboxMessageRow = {
  id: string;
  agentId: string;
  content: string;
  source: string;
  status: InboxMessageStatus;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  matchedText: string | null;
  delegatedToTaskId: string | null;
  responseText: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToInboxMessage(row: InboxMessageRow): InboxMessage {
  return {
    id: row.id,
    agentId: row.agentId,
    content: row.content,
    source: row.source as "slack",
    status: row.status,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    slackUserId: row.slackUserId ?? undefined,
    matchedText: row.matchedText ?? undefined,
    delegatedToTaskId: row.delegatedToTaskId ?? undefined,
    responseText: row.responseText ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export interface CreateInboxMessageOptions {
  source?: "slack" | "agentmail";
  slackChannelId?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  matchedText?: string;
}

export function createInboxMessage(
  agentId: string,
  content: string,
  options?: CreateInboxMessageOptions,
): InboxMessage {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<InboxMessageRow, (string | null)[]>(
      `INSERT INTO inbox_messages (id, agentId, content, source, status, slackChannelId, slackThreadTs, slackUserId, matchedText, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      agentId,
      content,
      options?.source ?? "slack",
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
      options?.matchedText ?? null,
      now,
      now,
    );

  if (!row) throw new Error("Failed to create inbox message");
  return rowToInboxMessage(row);
}

export function getInboxMessageById(id: string): InboxMessage | null {
  const row = getDb()
    .prepare<InboxMessageRow, [string]>("SELECT * FROM inbox_messages WHERE id = ?")
    .get(id);
  return row ? rowToInboxMessage(row) : null;
}

export function getUnreadInboxMessages(agentId: string): InboxMessage[] {
  return getDb()
    .prepare<InboxMessageRow, [string]>(
      "SELECT * FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC",
    )
    .all(agentId)
    .map(rowToInboxMessage);
}

/**
 * Atomically claim up to N unread inbox messages for processing.
 * Marks them as 'processing' to prevent duplicate polling.
 * Returns empty array if no unread messages available.
 */
export function claimInboxMessages(agentId: string, limit: number = 5): InboxMessage[] {
  const now = new Date().toISOString();

  // Get IDs of unread messages to claim
  const unreadIds = getDb()
    .prepare<{ id: string }, [string, number]>(
      "SELECT id FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC LIMIT ?",
    )
    .all(agentId, limit)
    .map((row) => row.id);

  if (unreadIds.length === 0) {
    return [];
  }

  // Atomically update status to 'processing' for these specific IDs
  const placeholders = unreadIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare<InboxMessageRow, (string | number)[]>(
      `UPDATE inbox_messages SET status = 'processing', lastUpdatedAt = ?
       WHERE id IN (${placeholders}) AND status = 'unread' RETURNING *`,
    )
    .all(now, ...unreadIds);

  return rows.map(rowToInboxMessage);
}

export function markInboxMessageRead(id: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string]>(
      "UPDATE inbox_messages SET status = 'read', lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(now, id);
  return row ? rowToInboxMessage(row) : null;
}

export function markInboxMessageResponded(id: string, responseText: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string, string]>(
      "UPDATE inbox_messages SET status = 'responded', responseText = ?, lastUpdatedAt = ? WHERE id = ? AND status IN ('unread', 'processing') RETURNING *",
    )
    .get(responseText, now, id);
  return row ? rowToInboxMessage(row) : null;
}

export function markInboxMessageDelegated(id: string, taskId: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string, string]>(
      "UPDATE inbox_messages SET status = 'delegated', delegatedToTaskId = ?, lastUpdatedAt = ? WHERE id = ? AND status IN ('unread', 'processing') RETURNING *",
    )
    .get(taskId, now, id);
  return row ? rowToInboxMessage(row) : null;
}

/**
 * Release inbox messages that have been in 'processing' status for too long.
 * This handles cases where Claude process crashes or fails to respond/delegate.
 * Call this periodically from the runner or add a database trigger.
 */
export function releaseStaleProcessingInbox(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = getDb().run(
    `UPDATE inbox_messages SET status = 'unread', lastUpdatedAt = ?
     WHERE status = 'processing' AND lastUpdatedAt < ?`,
    [now, cutoffTime],
  );

  return result.changes;
}

// ============================================================================
// Scheduled Task Queries
// ============================================================================

type ScheduledTaskRow = {
  id: string;
  name: string;
  description: string | null;
  cronExpression: string | null;
  intervalMs: number | null;
  taskTemplate: string;
  taskType: string | null;
  tags: string | null;
  priority: number;
  targetAgentId: string | null;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdByAgentId: string | null;
  timezone: string;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    cronExpression: row.cronExpression ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    taskTemplate: row.taskTemplate,
    taskType: row.taskType ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    priority: row.priority,
    targetAgentId: row.targetAgentId ?? undefined,
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt ?? undefined,
    nextRunAt: row.nextRunAt ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    timezone: row.timezone,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export interface ScheduledTaskFilters {
  enabled?: boolean;
  name?: string;
}

export function getScheduledTasks(filters?: ScheduledTaskFilters): ScheduledTask[] {
  let query = "SELECT * FROM scheduled_tasks WHERE 1=1";
  const params: (string | number)[] = [];

  if (filters?.enabled !== undefined) {
    query += " AND enabled = ?";
    params.push(filters.enabled ? 1 : 0);
  }

  if (filters?.name) {
    query += " AND name LIKE ?";
    params.push(`%${filters.name}%`);
  }

  query += " ORDER BY name ASC";

  return getDb()
    .prepare<ScheduledTaskRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToScheduledTask);
}

export function getScheduledTaskById(id: string): ScheduledTask | null {
  const row = getDb()
    .prepare<ScheduledTaskRow, [string]>("SELECT * FROM scheduled_tasks WHERE id = ?")
    .get(id);
  return row ? rowToScheduledTask(row) : null;
}

export function getScheduledTaskByName(name: string): ScheduledTask | null {
  const row = getDb()
    .prepare<ScheduledTaskRow, [string]>("SELECT * FROM scheduled_tasks WHERE name = ?")
    .get(name);
  return row ? rowToScheduledTask(row) : null;
}

export interface CreateScheduledTaskData {
  name: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
  taskTemplate: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  targetAgentId?: string;
  enabled?: boolean;
  nextRunAt?: string;
  createdByAgentId?: string;
  timezone?: string;
}

export function createScheduledTask(data: CreateScheduledTaskData): ScheduledTask {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<ScheduledTaskRow, (string | number | null)[]>(
      `INSERT INTO scheduled_tasks (
        id, name, description, cronExpression, intervalMs, taskTemplate,
        taskType, tags, priority, targetAgentId, enabled, nextRunAt,
        createdByAgentId, timezone, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.description ?? null,
      data.cronExpression ?? null,
      data.intervalMs ?? null,
      data.taskTemplate,
      data.taskType ?? null,
      JSON.stringify(data.tags ?? []),
      data.priority ?? 50,
      data.targetAgentId ?? null,
      data.enabled !== false ? 1 : 0,
      data.nextRunAt ?? null,
      data.createdByAgentId ?? null,
      data.timezone ?? "UTC",
      now,
      now,
    );

  if (!row) throw new Error("Failed to create scheduled task");
  return rowToScheduledTask(row);
}

export interface UpdateScheduledTaskData {
  name?: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
  taskTemplate?: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  targetAgentId?: string | null;
  enabled?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  timezone?: string;
  lastUpdatedAt?: string;
}

export function updateScheduledTask(
  id: string,
  data: UpdateScheduledTaskData,
): ScheduledTask | null {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (data.name !== undefined) {
    updates.push("name = ?");
    params.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description);
  }
  if (data.cronExpression !== undefined) {
    updates.push("cronExpression = ?");
    params.push(data.cronExpression);
  }
  if (data.intervalMs !== undefined) {
    updates.push("intervalMs = ?");
    params.push(data.intervalMs);
  }
  if (data.taskTemplate !== undefined) {
    updates.push("taskTemplate = ?");
    params.push(data.taskTemplate);
  }
  if (data.taskType !== undefined) {
    updates.push("taskType = ?");
    params.push(data.taskType);
  }
  if (data.tags !== undefined) {
    updates.push("tags = ?");
    params.push(JSON.stringify(data.tags));
  }
  if (data.priority !== undefined) {
    updates.push("priority = ?");
    params.push(data.priority);
  }
  if (data.targetAgentId !== undefined) {
    updates.push("targetAgentId = ?");
    params.push(data.targetAgentId);
  }
  if (data.enabled !== undefined) {
    updates.push("enabled = ?");
    params.push(data.enabled ? 1 : 0);
  }
  if (data.lastRunAt !== undefined) {
    updates.push("lastRunAt = ?");
    params.push(data.lastRunAt);
  }
  if (data.nextRunAt !== undefined) {
    updates.push("nextRunAt = ?");
    params.push(data.nextRunAt);
  }
  if (data.timezone !== undefined) {
    updates.push("timezone = ?");
    params.push(data.timezone);
  }

  if (updates.length === 0) {
    return getScheduledTaskById(id);
  }

  updates.push("lastUpdatedAt = ?");
  params.push(data.lastUpdatedAt ?? new Date().toISOString());

  params.push(id);

  const row = getDb()
    .prepare<ScheduledTaskRow, (string | number | null)[]>(
      `UPDATE scheduled_tasks SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);

  return row ? rowToScheduledTask(row) : null;
}

export function deleteScheduledTask(id: string): boolean {
  const result = getDb().run("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Get all enabled scheduled tasks that are due for execution.
 * A task is due when its nextRunAt time is <= now.
 */
export function getDueScheduledTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare<ScheduledTaskRow, [string]>(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?
       ORDER BY nextRunAt ASC`,
    )
    .all(now)
    .map(rowToScheduledTask);
}

// ============================================================================
// Epic Functions
// ============================================================================

type EpicRow = {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  prd: string | null;
  plan: string | null;
  status: EpicStatus;
  priority: number;
  tags: string | null;
  createdByAgentId: string | null;
  leadAgentId: string | null;
  channelId: string | null;
  researchDocPath: string | null;
  planDocPath: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  githubRepo: string | null;
  githubMilestone: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progressNotifiedAt: string | null;
};

function rowToEpic(row: EpicRow): Epic {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    goal: row.goal,
    prd: row.prd ?? undefined,
    plan: row.plan ?? undefined,
    status: row.status,
    priority: row.priority,
    tags: row.tags ? JSON.parse(row.tags) : [],
    createdByAgentId: row.createdByAgentId ?? undefined,
    leadAgentId: row.leadAgentId ?? undefined,
    channelId: row.channelId ?? undefined,
    researchDocPath: row.researchDocPath ?? undefined,
    planDocPath: row.planDocPath ?? undefined,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    githubRepo: row.githubRepo ?? undefined,
    githubMilestone: row.githubMilestone ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

export interface EpicFilters {
  status?: EpicStatus;
  createdByAgentId?: string;
  leadAgentId?: string;
  search?: string;
  limit?: number;
}

export function getEpics(filters?: EpicFilters): Epic[] {
  let query = "SELECT * FROM epics WHERE 1=1";
  const params: (string | number)[] = [];

  if (filters?.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }
  if (filters?.createdByAgentId) {
    query += " AND createdByAgentId = ?";
    params.push(filters.createdByAgentId);
  }
  if (filters?.leadAgentId) {
    query += " AND leadAgentId = ?";
    params.push(filters.leadAgentId);
  }
  if (filters?.search) {
    query += " AND (name LIKE ? OR description LIKE ? OR goal LIKE ?)";
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  query += " ORDER BY priority DESC, createdAt DESC";

  if (filters?.limit) {
    query += " LIMIT ?";
    params.push(filters.limit);
  }

  return getDb()
    .prepare<EpicRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToEpic);
}

export function getEpicById(id: string): Epic | null {
  const row = getDb().prepare<EpicRow, [string]>("SELECT * FROM epics WHERE id = ?").get(id);
  return row ? rowToEpic(row) : null;
}

export function getEpicByName(name: string): Epic | null {
  const row = getDb().prepare<EpicRow, [string]>("SELECT * FROM epics WHERE name = ?").get(name);
  return row ? rowToEpic(row) : null;
}

export interface CreateEpicData {
  name: string;
  goal: string;
  description?: string;
  prd?: string;
  plan?: string;
  priority?: number;
  tags?: string[];
  createdByAgentId?: string;
  leadAgentId?: string;
  // channelId is auto-generated during epic creation
  researchDocPath?: string;
  planDocPath?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  githubRepo?: string;
  githubMilestone?: string;
}

export function createEpic(data: CreateEpicData): Epic {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Auto-create a channel for this epic to log progress, learnings, etc.
  const channelName = `epic-${data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")}`;
  const channel = createChannel(channelName, {
    description: `Channel for epic: ${data.name}`,
    type: "public",
    createdBy: data.createdByAgentId,
  });

  const row = getDb()
    .prepare<EpicRow, (string | number | null)[]>(
      `INSERT INTO epics (
        id, name, description, goal, prd, plan, status, priority, tags,
        createdByAgentId, leadAgentId, channelId, researchDocPath, planDocPath,
        slackChannelId, slackThreadTs, githubRepo, githubMilestone,
        createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.description ?? null,
      data.goal,
      data.prd ?? null,
      data.plan ?? null,
      data.priority ?? 50,
      JSON.stringify(data.tags ?? []),
      data.createdByAgentId ?? null,
      data.leadAgentId ?? null,
      channel.id,
      data.researchDocPath ?? null,
      data.planDocPath ?? null,
      data.slackChannelId ?? null,
      data.slackThreadTs ?? null,
      data.githubRepo ?? null,
      data.githubMilestone ?? null,
      now,
      now,
    );

  if (!row) {
    throw new Error("Failed to create epic");
  }

  // Create log entry
  try {
    createLogEntry({
      eventType: "task_created", // Reuse existing event type
      agentId: data.createdByAgentId,
      taskId: id,
      newValue: "draft",
      metadata: { type: "epic", name: data.name },
    });
  } catch {
    /* ignore log errors */
  }

  return rowToEpic(row);
}

export interface UpdateEpicData {
  name?: string;
  description?: string;
  goal?: string;
  prd?: string;
  plan?: string;
  status?: EpicStatus;
  priority?: number;
  tags?: string[];
  leadAgentId?: string | null;
  researchDocPath?: string;
  planDocPath?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  githubRepo?: string;
  githubMilestone?: string;
}

export function updateEpic(id: string, data: UpdateEpicData): Epic | null {
  const epic = getEpicById(id);
  if (!epic) return null;

  const now = new Date().toISOString();
  const updates: string[] = ["lastUpdatedAt = ?"];
  const params: (string | number | null)[] = [now];

  if (data.name !== undefined) {
    updates.push("name = ?");
    params.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description);
  }
  if (data.goal !== undefined) {
    updates.push("goal = ?");
    params.push(data.goal);
  }
  if (data.prd !== undefined) {
    updates.push("prd = ?");
    params.push(data.prd);
  }
  if (data.plan !== undefined) {
    updates.push("plan = ?");
    params.push(data.plan);
  }
  if (data.status !== undefined) {
    updates.push("status = ?");
    params.push(data.status);

    // Set startedAt when transitioning to active
    if (data.status === "active" && !epic.startedAt) {
      updates.push("startedAt = ?");
      params.push(now);
    }
    // Set completedAt when completing
    if (data.status === "completed" && !epic.completedAt) {
      updates.push("completedAt = ?");
      params.push(now);
    }
  }
  if (data.priority !== undefined) {
    updates.push("priority = ?");
    params.push(data.priority);
  }
  if (data.tags !== undefined) {
    updates.push("tags = ?");
    params.push(JSON.stringify(data.tags));
  }
  if (data.leadAgentId !== undefined) {
    updates.push("leadAgentId = ?");
    params.push(data.leadAgentId);
  }
  if (data.researchDocPath !== undefined) {
    updates.push("researchDocPath = ?");
    params.push(data.researchDocPath);
  }
  if (data.planDocPath !== undefined) {
    updates.push("planDocPath = ?");
    params.push(data.planDocPath);
  }
  if (data.slackChannelId !== undefined) {
    updates.push("slackChannelId = ?");
    params.push(data.slackChannelId);
  }
  if (data.slackThreadTs !== undefined) {
    updates.push("slackThreadTs = ?");
    params.push(data.slackThreadTs);
  }
  if (data.githubRepo !== undefined) {
    updates.push("githubRepo = ?");
    params.push(data.githubRepo);
  }
  if (data.githubMilestone !== undefined) {
    updates.push("githubMilestone = ?");
    params.push(data.githubMilestone);
  }

  params.push(id);

  const row = getDb()
    .prepare<EpicRow, (string | number | null)[]>(
      `UPDATE epics SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);

  return row ? rowToEpic(row) : null;
}

export function deleteEpic(id: string): boolean {
  // First unassign all tasks from this epic
  getDb().prepare("UPDATE agent_tasks SET epicId = NULL WHERE epicId = ?").run(id);

  const result = getDb().prepare("DELETE FROM epics WHERE id = ?").run(id);
  return result.changes > 0;
}

// Get task statistics for an epic
export function getEpicTaskStats(epicId: string): {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  pending: number;
  unassigned: number;
} {
  const row = getDb()
    .prepare<
      {
        total: number;
        completed: number;
        failed: number;
        in_progress: number;
        pending: number;
        unassigned: number;
      },
      [string]
    >(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END) as unassigned
      FROM agent_tasks WHERE epicId = ?`,
    )
    .get(epicId);

  return {
    total: row?.total ?? 0,
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    inProgress: row?.in_progress ?? 0,
    pending: row?.pending ?? 0,
    unassigned: row?.unassigned ?? 0,
  };
}

// Get epic with progress calculation
export function getEpicWithProgress(id: string): EpicWithProgress | null {
  const epic = getEpicById(id);
  if (!epic) return null;

  const stats = getEpicTaskStats(id);
  const progress = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  return {
    ...epic,
    taskStats: stats,
    progress,
  };
}

// Get tasks for an epic
export function getTasksByEpicId(epicId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE epicId = ? ORDER BY priority DESC, createdAt ASC",
    )
    .all(epicId)
    .map(rowToAgentTask);
}

// Assign task to epic
export function assignTaskToEpic(taskId: string, epicId: string): AgentTask | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      "UPDATE agent_tasks SET epicId = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(epicId, now, taskId);
  return row ? rowToAgentTask(row) : null;
}

// Unassign task from epic
export function unassignTaskFromEpic(taskId: string): AgentTask | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      "UPDATE agent_tasks SET epicId = NULL, lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(now, taskId);
  return row ? rowToAgentTask(row) : null;
}

// ============================================================================
// Epic Progress Trigger Functions (Lead-only iterative epic processing)
// ============================================================================

/**
 * Get active epics that have progress updates (task completions/failures)
 * since the last notification. Used to trigger lead to plan next steps.
 * Returns epics with their progress stats and recently finished tasks.
 */
export function getEpicsWithProgressUpdates(): Array<{
  epic: EpicWithProgress;
  finishedTasks: AgentTask[];
}> {
  // Find active epics that have tasks finished since last notification
  const rows = getDb()
    .prepare<EpicRow, []>(
      `SELECT e.* FROM epics e
       WHERE e.status = 'active'
       AND EXISTS (
         SELECT 1 FROM agent_tasks t
         WHERE t.epicId = e.id
         AND t.status IN ('completed', 'failed')
         AND t.finishedAt IS NOT NULL
         AND (e.progressNotifiedAt IS NULL OR t.finishedAt > e.progressNotifiedAt)
       )
       ORDER BY e.priority DESC, e.lastUpdatedAt DESC`,
    )
    .all();

  return rows
    .map((row) => {
      const epic = getEpicWithProgress(row.id);
      if (!epic) return null;

      // Get tasks that finished since last notification
      const progressNotifiedAt = row.progressNotifiedAt;
      const finishedTasks = getDb()
        .prepare<AgentTaskRow, [string] | [string, string]>(
          progressNotifiedAt
            ? `SELECT * FROM agent_tasks
               WHERE epicId = ?
               AND status IN ('completed', 'failed')
               AND finishedAt > ?
               ORDER BY finishedAt DESC`
            : `SELECT * FROM agent_tasks
               WHERE epicId = ?
               AND status IN ('completed', 'failed')
               ORDER BY finishedAt DESC`,
        )
        .all(...(progressNotifiedAt ? [row.id, progressNotifiedAt] : [row.id]))
        .map(rowToAgentTask);

      return { epic, finishedTasks };
    })
    .filter((result): result is NonNullable<typeof result> => result !== null);
}

/**
 * Mark an epic's progress as notified.
 * Prevents returning the same progress updates in future polls.
 */
export function markEpicProgressNotified(epicId: string): Epic | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<EpicRow, [string, string, string]>(
      `UPDATE epics SET progressNotifiedAt = ?, lastUpdatedAt = ?
       WHERE id = ? RETURNING *`,
    )
    .get(now, now, epicId);
  return row ? rowToEpic(row) : null;
}

/**
 * Mark multiple epics' progress as notified atomically.
 */
export function markEpicsProgressNotified(epicIds: string[]): number {
  if (epicIds.length === 0) return 0;

  const now = new Date().toISOString();
  const placeholders = epicIds.map(() => "?").join(",");

  const result = getDb().run(
    `UPDATE epics SET progressNotifiedAt = ?, lastUpdatedAt = ?
     WHERE id IN (${placeholders}) AND progressNotifiedAt IS NULL OR progressNotifiedAt < ?`,
    [now, now, ...epicIds, now],
  );

  return result.changes;
}

// ============================================================================
// Swarm Config Operations (Centralized Environment/Config Management)
// ============================================================================

type SwarmConfigRow = {
  id: string;
  scope: string;
  scopeId: string | null;
  key: string;
  value: string;
  isSecret: number; // SQLite boolean
  envPath: string | null;
  description: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToSwarmConfig(row: SwarmConfigRow): SwarmConfig {
  return {
    id: row.id,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    key: row.key,
    value: row.value,
    isSecret: row.isSecret === 1,
    envPath: row.envPath ?? null,
    description: row.description ?? null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

/**
 * Mask secret values in config entries for API responses.
 */
export function maskSecrets(configs: SwarmConfig[]): SwarmConfig[] {
  return configs.map((c) => (c.isSecret ? { ...c, value: "********" } : c));
}

/**
 * Write config values to .env files on disk when `envPath` is set.
 * Groups configs by envPath, reads existing file, updates/adds matching keys, writes back.
 */
function writeEnvFile(configs: SwarmConfig[]): void {
  const { readFileSync, writeFileSync } = require("node:fs");

  const byPath = new Map<string, SwarmConfig[]>();
  for (const config of configs) {
    if (!config.envPath) continue;
    const existing = byPath.get(config.envPath) ?? [];
    existing.push(config);
    byPath.set(config.envPath, existing);
  }

  for (const [envPath, entries] of byPath) {
    let lines: string[] = [];
    try {
      const content = readFileSync(envPath, "utf-8") as string;
      lines = content.split("\n");
    } catch {
      // File doesn't exist yet, start empty
    }

    for (const entry of entries) {
      const prefix = `${entry.key}=`;
      const lineIndex = lines.findIndex((l) => l.startsWith(prefix));
      const newLine = `${entry.key}=${entry.value}`;
      if (lineIndex >= 0) {
        lines[lineIndex] = newLine;
      } else {
        lines.push(newLine);
      }
    }

    const output = `${lines.filter((l) => l !== "").join("\n")}\n`;
    writeFileSync(envPath, output, "utf-8");
  }
}

/**
 * List config entries with optional filters.
 */
export function getSwarmConfigs(filters?: {
  scope?: string;
  scopeId?: string;
  key?: string;
}): SwarmConfig[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters?.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters?.scopeId) {
    conditions.push("scopeId = ?");
    params.push(filters.scopeId);
  }
  if (filters?.key) {
    conditions.push("key = ?");
    params.push(filters.key);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM swarm_config ${whereClause} ORDER BY key ASC`;

  return getDb()
    .prepare<SwarmConfigRow, string[]>(query)
    .all(...params)
    .map(rowToSwarmConfig);
}

/**
 * Get a single config entry by ID.
 */
export function getSwarmConfigById(id: string): SwarmConfig | null {
  const row = getDb()
    .prepare<SwarmConfigRow, [string]>("SELECT * FROM swarm_config WHERE id = ?")
    .get(id);
  return row ? rowToSwarmConfig(row) : null;
}

/**
 * Upsert a config entry. Inserts or updates by (scope, scopeId, key) unique constraint.
 */
export function upsertSwarmConfig(data: {
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  key: string;
  value: string;
  isSecret?: boolean;
  envPath?: string | null;
  description?: string | null;
}): SwarmConfig {
  const now = new Date().toISOString();
  const scopeId = data.scope === "global" ? null : (data.scopeId ?? null);
  const isSecret = data.isSecret ? 1 : 0;
  const envPath = data.envPath ?? null;
  const description = data.description ?? null;

  // Manual check for existing entry because SQLite's UNIQUE constraint
  // treats NULL != NULL, so ON CONFLICT never fires when scopeId is NULL (global scope).
  const existing =
    scopeId === null
      ? getDb()
          .prepare<{ id: string }, [string, string]>(
            "SELECT id FROM swarm_config WHERE scope = ? AND scopeId IS NULL AND key = ?",
          )
          .get(data.scope, data.key)
      : getDb()
          .prepare<{ id: string }, [string, string, string]>(
            "SELECT id FROM swarm_config WHERE scope = ? AND scopeId = ? AND key = ?",
          )
          .get(data.scope, scopeId, data.key);

  let row: SwarmConfigRow | null;

  if (existing) {
    row = getDb()
      .prepare<SwarmConfigRow, [string, number, string | null, string | null, string, string]>(
        `UPDATE swarm_config SET value = ?, isSecret = ?, envPath = ?, description = ?, lastUpdatedAt = ?
         WHERE id = ? RETURNING *`,
      )
      .get(data.value, isSecret, envPath, description, now, existing.id);
  } else {
    const id = crypto.randomUUID();
    row = getDb()
      .prepare<
        SwarmConfigRow,
        [
          string,
          string,
          string | null,
          string,
          string,
          number,
          string | null,
          string | null,
          string,
          string,
        ]
      >(
        `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(id, data.scope, scopeId, data.key, data.value, isSecret, envPath, description, now, now);
  }

  if (!row) throw new Error("Failed to upsert swarm config");

  const config = rowToSwarmConfig(row);

  // Write to envPath if set
  if (config.envPath) {
    try {
      writeEnvFile([config]);
    } catch (e) {
      console.error(`Failed to write env file ${config.envPath}:`, e);
    }
  }

  return config;
}

/**
 * Delete a config entry by ID.
 */
export function deleteSwarmConfig(id: string): boolean {
  const result = getDb().run("DELETE FROM swarm_config WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Get resolved (merged) config for a given agent and/or repo.
 * Scope resolution: repo > agent > global (most-specific wins).
 * Returns one entry per unique key with the most-specific scope winning.
 */
export function getResolvedConfig(agentId?: string, repoId?: string): SwarmConfig[] {
  // Start with global configs
  const configMap = new Map<string, SwarmConfig>();

  const globalConfigs = getSwarmConfigs({ scope: "global" });
  for (const config of globalConfigs) {
    configMap.set(config.key, config);
  }

  // Overlay agent configs (agent wins over global)
  if (agentId) {
    const agentConfigs = getSwarmConfigs({ scope: "agent", scopeId: agentId });
    for (const config of agentConfigs) {
      configMap.set(config.key, config);
    }
  }

  // Overlay repo configs (repo wins over agent and global)
  if (repoId) {
    const repoConfigs = getSwarmConfigs({ scope: "repo", scopeId: repoId });
    for (const config of repoConfigs) {
      configMap.set(config.key, config);
    }
  }

  return Array.from(configMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

// ============================================================================
// Swarm Repos Functions (Centralized Repository Management)
// ============================================================================

type SwarmRepoRow = {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: number; // SQLite boolean
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToSwarmRepo(row: SwarmRepoRow): SwarmRepo {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    clonePath: row.clonePath,
    defaultBranch: row.defaultBranch,
    autoClone: row.autoClone === 1,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export function getSwarmRepos(filters?: { autoClone?: boolean; name?: string }): SwarmRepo[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.autoClone !== undefined) {
    conditions.push("autoClone = ?");
    params.push(filters.autoClone ? 1 : 0);
  }
  if (filters?.name) {
    conditions.push("name = ?");
    params.push(filters.name);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM swarm_repos ${whereClause} ORDER BY name ASC`;

  return getDb()
    .prepare<SwarmRepoRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToSwarmRepo);
}

export function getSwarmRepoById(id: string): SwarmRepo | null {
  const row = getDb()
    .prepare<SwarmRepoRow, [string]>("SELECT * FROM swarm_repos WHERE id = ?")
    .get(id);
  return row ? rowToSwarmRepo(row) : null;
}

export function getSwarmRepoByName(name: string): SwarmRepo | null {
  const row = getDb()
    .prepare<SwarmRepoRow, [string]>("SELECT * FROM swarm_repos WHERE name = ?")
    .get(name);
  return row ? rowToSwarmRepo(row) : null;
}

export function getSwarmRepoByUrl(url: string): SwarmRepo | null {
  const row = getDb()
    .prepare<SwarmRepoRow, [string]>("SELECT * FROM swarm_repos WHERE url = ?")
    .get(url);
  return row ? rowToSwarmRepo(row) : null;
}

export function createSwarmRepo(data: {
  url: string;
  name: string;
  clonePath?: string;
  defaultBranch?: string;
  autoClone?: boolean;
}): SwarmRepo {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const clonePath = data.clonePath || `/workspace/repos/${data.name}`;

  const row = getDb()
    .prepare<SwarmRepoRow, [string, string, string, string, string, number, string, string]>(
      `INSERT INTO swarm_repos (id, url, name, clonePath, defaultBranch, autoClone, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.url,
      data.name,
      clonePath,
      data.defaultBranch ?? "main",
      data.autoClone !== false ? 1 : 0,
      now,
      now,
    );

  if (!row) throw new Error("Failed to create repo");
  return rowToSwarmRepo(row);
}

export function updateSwarmRepo(
  id: string,
  updates: Partial<{
    url: string;
    name: string;
    clonePath: string;
    defaultBranch: string;
    autoClone: boolean;
  }>,
): SwarmRepo | null {
  const setClauses: string[] = [];
  const params: (string | number)[] = [];

  const stringFields = ["url", "name", "clonePath", "defaultBranch"] as const;
  for (const field of stringFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      params.push(updates[field]);
    }
  }
  if (updates.autoClone !== undefined) {
    setClauses.push("autoClone = ?");
    params.push(updates.autoClone ? 1 : 0);
  }

  if (setClauses.length === 0) return getSwarmRepoById(id);

  setClauses.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const row = getDb()
    .prepare<SwarmRepoRow, (string | number)[]>(
      `UPDATE swarm_repos SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);

  return row ? rowToSwarmRepo(row) : null;
}

export function deleteSwarmRepo(id: string): boolean {
  const result = getDb().run("DELETE FROM swarm_repos WHERE id = ?", [id]);
  return result.changes > 0;
}

// ============================================================================
// Agent Memory Functions
// ============================================================================

type AgentMemoryRow = {
  id: string;
  agentId: string | null;
  scope: string;
  name: string;
  content: string;
  summary: string | null;
  embedding: Buffer | null;
  source: string;
  sourceTaskId: string | null;
  sourcePath: string | null;
  chunkIndex: number;
  totalChunks: number;
  tags: string;
  createdAt: string;
  accessedAt: string;
};

function rowToAgentMemory(row: AgentMemoryRow): AgentMemory {
  return {
    id: row.id,
    agentId: row.agentId,
    scope: row.scope as AgentMemoryScope,
    name: row.name,
    content: row.content,
    summary: row.summary,
    source: row.source as AgentMemorySource,
    sourceTaskId: row.sourceTaskId,
    sourcePath: row.sourcePath,
    chunkIndex: row.chunkIndex,
    totalChunks: row.totalChunks,
    tags: JSON.parse(row.tags || "[]"),
    createdAt: row.createdAt,
    accessedAt: row.accessedAt,
  };
}

export interface CreateMemoryOptions {
  agentId?: string | null;
  scope: AgentMemoryScope;
  name: string;
  content: string;
  summary?: string | null;
  embedding?: Buffer | null;
  source: AgentMemorySource;
  sourceTaskId?: string | null;
  sourcePath?: string | null;
  chunkIndex?: number;
  totalChunks?: number;
  tags?: string[];
}

export function createMemory(data: CreateMemoryOptions): AgentMemory {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<
      AgentMemoryRow,
      [
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        Buffer | null,
        string,
        string | null,
        string | null,
        number,
        number,
        string,
        string,
        string,
      ]
    >(
      `INSERT INTO agent_memory (id, agentId, scope, name, content, summary, embedding, source, sourceTaskId, sourcePath, chunkIndex, totalChunks, tags, createdAt, accessedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.agentId ?? null,
      data.scope,
      data.name,
      data.content,
      data.summary ?? null,
      data.embedding ?? null,
      data.source,
      data.sourceTaskId ?? null,
      data.sourcePath ?? null,
      data.chunkIndex ?? 0,
      data.totalChunks ?? 1,
      JSON.stringify(data.tags ?? []),
      now,
      now,
    );

  if (!row) throw new Error("Failed to create memory");
  return rowToAgentMemory(row);
}

export function getMemoryById(id: string): AgentMemory | null {
  const row = getDb()
    .prepare<AgentMemoryRow, [string]>("SELECT * FROM agent_memory WHERE id = ?")
    .get(id);
  if (!row) return null;

  // Update accessedAt
  getDb()
    .prepare("UPDATE agent_memory SET accessedAt = ? WHERE id = ?")
    .run(new Date().toISOString(), id);

  return rowToAgentMemory(row);
}

export function updateMemoryEmbedding(id: string, embedding: Buffer): void {
  getDb().prepare("UPDATE agent_memory SET embedding = ? WHERE id = ?").run(embedding, id);
}

export interface SearchMemoriesOptions {
  scope?: "agent" | "swarm" | "all";
  limit?: number;
  source?: AgentMemorySource;
  isLead?: boolean;
}

export function searchMemoriesByVector(
  queryEmbedding: Float32Array,
  agentId: string,
  options: SearchMemoriesOptions = {},
): (AgentMemory & { similarity: number })[] {
  const { scope = "all", limit = 10, source, isLead = false } = options;

  // Build WHERE clause
  const conditions: string[] = ["embedding IS NOT NULL"];
  const params: (string | null)[] = [];

  if (!isLead) {
    // Workers see their own agent-scoped + all swarm-scoped
    if (scope === "agent") {
      conditions.push("agentId = ? AND scope = 'agent'");
      params.push(agentId);
    } else if (scope === "swarm") {
      conditions.push("scope = 'swarm'");
    } else {
      // "all" - own agent + swarm
      conditions.push("(agentId = ? OR scope = 'swarm')");
      params.push(agentId);
    }
  } else {
    // Leads see everything
    if (scope === "agent") {
      conditions.push("scope = 'agent'");
    } else if (scope === "swarm") {
      conditions.push("scope = 'swarm'");
    }
    // "all" for lead = no scope filter needed
  }

  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = getDb()
    .prepare<AgentMemoryRow, (string | null)[]>(`SELECT * FROM agent_memory ${whereClause}`)
    .all(...params);

  // Import cosine similarity inline to avoid circular deps
  const { cosineSimilarity, deserializeEmbedding } = require("./embedding");

  // Compute similarities and sort
  const results: (AgentMemory & { similarity: number })[] = [];
  for (const row of rows) {
    if (!row.embedding) continue;
    const embedding = deserializeEmbedding(row.embedding);
    // Skip embeddings with mismatched dimensions (can happen if embedding model changes)
    if (embedding.length !== queryEmbedding.length) continue;
    const similarity = cosineSimilarity(queryEmbedding, embedding) as number;
    results.push({ ...rowToAgentMemory(row), similarity });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

export interface ListMemoriesOptions {
  scope?: "agent" | "swarm" | "all";
  limit?: number;
  offset?: number;
  isLead?: boolean;
}

export function listMemoriesByAgent(
  agentId: string,
  options: ListMemoriesOptions = {},
): AgentMemory[] {
  const { scope = "all", limit = 20, offset = 0, isLead = false } = options;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (!isLead) {
    if (scope === "agent") {
      conditions.push("agentId = ? AND scope = 'agent'");
      params.push(agentId);
    } else if (scope === "swarm") {
      conditions.push("scope = 'swarm'");
    } else {
      conditions.push("(agentId = ? OR scope = 'swarm')");
      params.push(agentId);
    }
  } else {
    if (scope === "agent") {
      conditions.push("scope = 'agent'");
    } else if (scope === "swarm") {
      conditions.push("scope = 'swarm'");
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit, offset);

  const rows = getDb()
    .prepare<AgentMemoryRow, (string | number)[]>(
      `SELECT * FROM agent_memory ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    )
    .all(...params);

  return rows.map(rowToAgentMemory);
}

export function deleteMemoriesBySourcePath(sourcePath: string, agentId: string): number {
  const result = getDb()
    .prepare("DELETE FROM agent_memory WHERE sourcePath = ? AND agentId = ?")
    .run(sourcePath, agentId);
  return result.changes;
}

export function deleteMemory(id: string): boolean {
  const result = getDb().prepare("DELETE FROM agent_memory WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getMemoryStats(agentId: string): {
  total: number;
  bySource: Record<string, number>;
  byScope: Record<string, number>;
} {
  const total = getDb()
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_memory WHERE agentId = ?",
    )
    .get(agentId);

  const bySourceRows = getDb()
    .prepare<{ source: string; count: number }, [string]>(
      "SELECT source, COUNT(*) as count FROM agent_memory WHERE agentId = ? GROUP BY source",
    )
    .all(agentId);

  const byScopeRows = getDb()
    .prepare<{ scope: string; count: number }, [string]>(
      "SELECT scope, COUNT(*) as count FROM agent_memory WHERE agentId = ? GROUP BY scope",
    )
    .all(agentId);

  const bySource: Record<string, number> = {};
  for (const row of bySourceRows) {
    bySource[row.source] = row.count;
  }

  const byScope: Record<string, number> = {};
  for (const row of byScopeRows) {
    byScope[row.scope] = row.count;
  }

  return { total: total?.count ?? 0, bySource, byScope };
}

// ============================================================================
// AgentMail Inbox Mapping Queries
// ============================================================================

export interface AgentMailInboxMapping {
  id: string;
  inboxId: string;
  agentId: string;
  inboxEmail: string | null;
  createdAt: string;
}

export function getAgentMailInboxMapping(inboxId: string): AgentMailInboxMapping | null {
  return (
    getDb()
      .prepare<AgentMailInboxMapping, [string]>(
        "SELECT * FROM agentmail_inbox_mappings WHERE inboxId = ?",
      )
      .get(inboxId) ?? null
  );
}

export function getAgentMailInboxMappingsByAgent(agentId: string): AgentMailInboxMapping[] {
  return getDb()
    .prepare<AgentMailInboxMapping, [string]>(
      "SELECT * FROM agentmail_inbox_mappings WHERE agentId = ? ORDER BY createdAt DESC",
    )
    .all(agentId);
}

export function getAllAgentMailInboxMappings(): AgentMailInboxMapping[] {
  return getDb()
    .prepare<AgentMailInboxMapping, []>(
      "SELECT * FROM agentmail_inbox_mappings ORDER BY createdAt DESC",
    )
    .all();
}

export function createAgentMailInboxMapping(
  inboxId: string,
  agentId: string,
  inboxEmail?: string,
): AgentMailInboxMapping {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<AgentMailInboxMapping, [string, string, string, string | null, string]>(
      `INSERT INTO agentmail_inbox_mappings (id, inboxId, agentId, inboxEmail, createdAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(inboxId) DO UPDATE SET agentId = excluded.agentId, inboxEmail = excluded.inboxEmail
       RETURNING *`,
    )
    .get(id, inboxId, agentId, inboxEmail ?? null, now);

  if (!row) throw new Error("Failed to create AgentMail inbox mapping");
  return row;
}

export function deleteAgentMailInboxMapping(inboxId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM agentmail_inbox_mappings WHERE inboxId = ?")
    .run(inboxId);
  return result.changes > 0;
}

/**
 * Find the most recent task by AgentMail thread ID
 * Includes completed/failed tasks to maintain thread continuity via parentTaskId
 */
export function findTaskByAgentMailThread(agentmailThreadId: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE agentmailThreadId = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(agentmailThreadId);
  return row ? rowToAgentTask(row) : null;
}

// ============================================================================
// Active Sessions (runner session tracking for concurrency awareness)
// ============================================================================

export function insertActiveSession(session: {
  agentId: string;
  taskId?: string;
  triggerType: string;
  inboxMessageId?: string;
  taskDescription?: string;
}): ActiveSession {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<
      ActiveSession,
      [string, string, string | null, string, string | null, string | null, string, string]
    >(
      `INSERT INTO active_sessions (id, agentId, taskId, triggerType, inboxMessageId, taskDescription, startedAt, lastHeartbeatAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      id,
      session.agentId,
      session.taskId ?? null,
      session.triggerType,
      session.inboxMessageId ?? null,
      session.taskDescription ?? null,
      now,
      now,
    );

  if (!row) throw new Error("Failed to insert active session");
  return row;
}

export function deleteActiveSession(taskId: string): boolean {
  const result = getDb().prepare("DELETE FROM active_sessions WHERE taskId = ?").run(taskId);
  return result.changes > 0;
}

export function deleteActiveSessionById(id: string): boolean {
  const result = getDb().prepare("DELETE FROM active_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getActiveSessions(agentId?: string): ActiveSession[] {
  if (agentId) {
    return getDb()
      .prepare<ActiveSession, [string]>(
        "SELECT * FROM active_sessions WHERE agentId = ? ORDER BY startedAt DESC",
      )
      .all(agentId);
  }
  return getDb()
    .prepare<ActiveSession, []>("SELECT * FROM active_sessions ORDER BY startedAt DESC")
    .all();
}

export function heartbeatActiveSession(taskId: string): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?")
    .run(now, taskId);
  return result.changes > 0;
}

export function cleanupStaleSessions(maxAgeMinutes = 30): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const result = getDb()
    .prepare("DELETE FROM active_sessions WHERE lastHeartbeatAt < ?")
    .run(cutoff);
  return result.changes;
}

export function cleanupAgentSessions(agentId: string): number {
  const result = getDb().prepare("DELETE FROM active_sessions WHERE agentId = ?").run(agentId);
  return result.changes;
}
