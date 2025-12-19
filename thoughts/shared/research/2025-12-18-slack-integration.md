---
date: 2025-12-18T21:25:00-08:00
researcher: Claude-Main
git_commit: e0ba9a0d441dfc498a6a974854f3a38415e899ca
branch: main
repository: ai-toolbox/cc-orch-mcp
topic: "Slack Multi-Agent Bot Integration - Codebase Analysis"
tags: [research, codebase, slack, agent-swarm, http-api, database]
status: complete
last_updated: 2025-12-18
last_updated_by: Claude-Main
last_updated_note: "Added design decisions based on user feedback"
---

# Research: Slack Multi-Agent Bot Integration - Codebase Analysis

**Date**: 2025-12-18T21:25:00-08:00
**Researcher**: Claude-Main
**Git Commit**: e0ba9a0d441dfc498a6a974854f3a38415e899ca
**Branch**: main
**Repository**: desplega-ai/ai-toolbox (cc-orch-mcp subdirectory)

## Research Question

Document the existing Agent Swarm MCP codebase architecture to understand how Slack Multi-Agent Bot support can be implemented in the HTTP API. Focus on:
- HTTP API structure and routing patterns
- Database schema and potential token storage
- Agent swarm coordination patterns
- Types and interfaces

## Summary

The Agent Swarm MCP is a multi-agent coordination system built with Bun and the MCP SDK. It provides:

1. **HTTP Server** (`src/http.ts`) - Raw Node.js HTTP server with REST API + MCP transport
2. **SQLite Database** (`src/be/db.ts`) - Three tables: `agents`, `agent_tasks`, `agent_log`
3. **MCP Tools** (`src/tools/*.ts`) - 8 tools for agent coordination via MCP protocol
4. **CLI Commands** (`src/commands/*.ts`) - Worker and lead agent runners that spawn Claude CLI

**No existing Slack code exists** in the codebase. The Slack manifest has been saved to `slack-manifest.json`.

## Detailed Findings

### 1. HTTP API Architecture

**File**: `src/http.ts:1-423`

The HTTP server is a raw Node.js `createServer` implementation (not Express or Bun.serve).

#### Server Configuration
```typescript
const port = parseInt(process.env.PORT || process.argv[2] || "3013", 10);
const apiKey = process.env.API_KEY || "";
```

#### Authentication Pattern (`http.ts:96-106`)
All requests (except `/health`) are authenticated via Bearer token:
```typescript
if (apiKey) {
  const authHeader = req.headers.authorization;
  const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (providedKey !== apiKey) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
}
```

#### CORS Handling (`http.ts:45-50`)
```typescript
function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}
```

#### Existing Endpoints

| Method | Path | Purpose | File Location |
|--------|------|---------|---------------|
| GET | `/health` | Health check with version | `http.ts:81-94` |
| GET | `/me` | Get current agent info | `http.ts:108-126` |
| POST | `/ping` | Update agent last-seen | `http.ts:128-162` |
| POST | `/close` | Mark agent offline | `http.ts:164-192` |
| GET | `/api/agents` | List all agents | `http.ts:201-213` |
| GET | `/api/agents/:id` | Get single agent | `http.ts:215-235` |
| GET | `/api/tasks` | List tasks with filters | `http.ts:237-255` |
| GET | `/api/tasks/:id` | Get task with logs | `http.ts:257-277` |
| GET | `/api/logs` | List recent logs | `http.ts:279-293` |
| GET | `/api/stats` | Dashboard stats | `http.ts:295-319` |
| POST/GET/DELETE | `/mcp` | MCP transport | `http.ts:321-384` |

#### URL Parsing Pattern (`http.ts:52-62`)
```typescript
function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}
```

### 2. Database Schema

**File**: `src/be/db.ts:1-535`

Uses `bun:sqlite` with WAL mode and foreign keys enabled.

#### Tables

**agents** (`db.ts:24-31`)
```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  isLead INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('idle', 'busy', 'offline')),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL
);
```

**agent_tasks** (`db.ts:33-46`)
```sql
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  finishedAt TEXT,
  failureReason TEXT,
  output TEXT,
  progress TEXT,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
```

**agent_log** (`db.ts:50-59`)
```sql
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
```

#### Database Initialization (`db.ts:14-68`)
```typescript
export function initDb(dbPath = "./agent-swarm-db.sqlite"): Database {
  if (db) return db;
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  // ... table creation
  return db;
}
```

#### Key Database Functions

| Function | Purpose | Location |
|----------|---------|----------|
| `createAgent()` | Insert new agent | `db.ts:126-136` |
| `getAgentById()` | Fetch agent by ID | `db.ts:138-141` |
| `getAllAgents()` | List all agents | `db.ts:143-145` |
| `updateAgentStatus()` | Update agent status | `db.ts:147-161` |
| `createTask()` | Create new task | `db.ts:249-257` |
| `getPendingTaskForAgent()` | Get oldest pending task | `db.ts:259-266` |
| `startTask()` | Mark task in_progress | `db.ts:268-288` |
| `completeTask()` | Mark task completed | `db.ts:337-360` |
| `failTask()` | Mark task failed | `db.ts:362-379` |
| `createLogEntry()` | Create audit log entry | `db.ts:485-507` |

### 3. Types and Interfaces

**File**: `src/types.ts:1-67`

Uses Zod v4 for schema validation and type inference.

```typescript
// Agent statuses
export type AgentStatus = "idle" | "busy" | "offline";

// Task statuses
export type AgentTaskStatus = "pending" | "in_progress" | "completed" | "failed";

// Log event types
export type AgentLogEventType =
  | "agent_joined"
  | "agent_status_change"
  | "agent_left"
  | "task_created"
  | "task_status_change"
  | "task_progress";
```

### 4. MCP Server and Tools

**File**: `src/server.ts:1-41`

Creates an MCP server with 8 registered tools:

```typescript
export function createServer() {
  initDb();
  const server = new McpServer({ name, version, description }, {
    capabilities: { logging: {} }
  });

  registerJoinSwarmTool(server);      // Join the swarm
  registerPollTaskTool(server);       // Long-poll for tasks
  registerGetSwarmTool(server);       // List agents
  registerGetTasksTool(server);       // List tasks
  registerSendTaskTool(server);       // Assign task to agent
  registerGetTaskDetailsTool(server); // Get task details
  registerStoreProgressTool(server);  // Update task progress
  registerMyAgentInfoTool(server);    // Get own agent info

  return server;
}
```

#### Tool Registration Pattern (`src/tools/utils.ts`)

All tools use `createToolRegistrar` which extracts:
- `X-Agent-ID` header for agent identification
- Session ID from MCP transport metadata

```typescript
export function createToolRegistrar(server: McpServer) {
  return function registerTool<TInput, TOutput>(
    name: string,
    options: ToolOptions<TInput, TOutput>,
    callback: ToolCallback<TInput, TOutput>
  ) {
    server.tool(name, options, async (args, meta) => {
      const requestInfo = extractRequestInfo(meta);
      return callback(args, requestInfo, meta);
    });
  };
}
```

### 5. CLI Runner Architecture

**File**: `src/commands/runner.ts:1-263`

The runner spawns Claude CLI processes with specific prompts:

```typescript
const CMD = [
  "claude",
  "--verbose",
  "--output-format", "stream-json",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode", "bypassPermissions",
  "-p", opts.prompt,
];
```

**Lead Agent** (`src/commands/lead.ts`)
- Default prompt: `/setup-leader Setup the agent swarm and begin coordinating workers!`
- Environment: `LEAD_YOLO`, `LEAD_LOG_DIR`, `LEAD_SYSTEM_PROMPT`

**Worker Agent** (`src/commands/worker.ts`)
- Default prompt: `/start-worker Start or continue the tasks your leader assigned you!`
- Environment: `WORKER_YOLO`, `WORKER_LOG_DIR`, `WORKER_SYSTEM_PROMPT`

### 6. Frontend UI

**Directory**: `ui/src/`

A React dashboard with these components:
- `Dashboard.tsx` - Main layout
- `AgentsPanel.tsx` - Agent list
- `TasksPanel.tsx` - Task list
- `AgentDetailPanel.tsx` - Single agent view
- `TaskDetailPanel.tsx` - Single task view
- `ActivityFeed.tsx` - Log stream
- `StatsBar.tsx` - Summary stats
- `ConfigModal.tsx` - Settings

Uses:
- React 19
- TanStack Query for data fetching
- Emotion for styling

### 7. Slack Manifest

**File**: `slack-manifest.json`

Key configuration:
- **Bot Name**: `agent-swarm`
- **Socket Mode**: Enabled (`socket_mode_enabled: true`)
- **Always Online**: `true`

**Scopes**:
- `chat:write`, `chat:write.customize`, `chat:write.public` - Send messages with custom personas
- `app_mentions:read` - Detect @mentions
- `channels:history`, `groups:history`, `im:history`, `mpim:history` - Read message history
- `channels:read`, `groups:read`, `im:read`, `mpim:read` - Read channel info
- `im:write`, `mpim:write` - Send DMs
- `users:read` - Get user info
- `commands` - Slash commands

**Events**:
- `app_mention` - When bot is @mentioned
- `message.channels` - Public channel messages
- `message.groups` - Private channel messages
- `message.im` - Direct messages
- `message.mpim` - Group DMs

**Slash Command**: `/agent-swarm-status` - Check status of available agents

## Architecture Documentation

### Request Flow

1. HTTP request arrives at `http.ts` server
2. CORS headers set, OPTIONS handled
3. API key validated from Bearer token
4. Route matched by path segments
5. For `/mcp`: MCP transport handles tool calls
6. Tools extract `X-Agent-ID` header and interact with SQLite DB
7. Response returned as JSON

### Agent Coordination Pattern

1. **Lead** joins swarm with `join-swarm` tool (isLead=true)
2. **Workers** join swarm with `join-swarm` tool (isLead=false)
3. Lead uses `send-task` to assign work to idle workers
4. Workers use `poll-task` (long-polling) to receive assignments
5. Workers use `store-progress` to report progress/completion
6. All agents can use `get-swarm` and `get-tasks` for visibility

## Code References

- `src/http.ts:1-423` - HTTP server implementation
- `src/be/db.ts:1-535` - Database layer
- `src/types.ts:1-67` - Type definitions
- `src/server.ts:1-41` - MCP server setup
- `src/tools/join-swarm.ts:1-114` - Agent registration
- `src/tools/send-task.ts:1-100` - Task assignment
- `src/tools/poll-task.ts:1-143` - Task polling
- `src/tools/store-progress.ts:1-129` - Progress updates
- `src/commands/runner.ts:1-263` - Claude CLI runner
- `slack-manifest.json` - Slack app manifest

## Integration Points for Slack

Based on this analysis, Slack integration would touch:

1. **New Database Table** - For storing workspace OAuth tokens:
   ```sql
   CREATE TABLE slack_installations (
     team_id TEXT PRIMARY KEY,
     bot_token TEXT NOT NULL,
     app_token TEXT,
     ...
   );
   ```

2. **New HTTP Endpoints** in `src/http.ts`:
   - `POST /slack/events` - Slack event subscriptions
   - `POST /slack/commands` - Slash command handler
   - `POST /slack/interactions` - Interactive components
   - `GET /oauth/slack/callback` - OAuth callback

3. **New Module** (suggested: `src/slack/`):
   - `bolt.ts` - Slack Bolt app initialization
   - `handlers.ts` - Event/command handlers
   - `personas.ts` - Agent persona definitions
   - `router.ts` - Message routing logic

4. **Environment Variables**:
   - Single workspace: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
   - Multi-workspace: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`

## Design Decisions

### 1. Connection Mode
**Decision**: Socket Mode

Use Slack's socket mode with `SLACK_APP_TOKEN` for real-time event delivery without exposing public endpoints.

### 2. Persona-to-Agent Mapping
**Decision**: Match by name or ID using `swarm#<id>` syntax

- Agent personas correspond directly to swarm agents
- Can address by agent name or explicit ID: `swarm#<uuid>`

### 3. Task Creation from Slack
**Decision**: Direct task creation with task type field

- Slack messages create tasks directly (no lead agent intermediary)
- Add a `source` or `type` field to `agent_tasks` to distinguish Slack-created tasks
- Allows future expansion to other sources (Discord, API, etc.)

### 4. Message Routing Logic
**Decision**: Regex-based partial matching with multi-agent support

Rules:
- **Partial name matching**: Match at least one word of agent name (>3 chars to avoid connectors like "the", "and")
- **Multi-mention support**: A single message can mention multiple agents → create separate tasks for each
- **Root bot mention**: `@Desplegillo` (the bot's real @) routes to the lead agent
- **Broadcast**: `swarm#all` sends to all agents in the swarm

Example routing:
```
"Hey Alpha, can you..." → routes to agent named "Alpha"
"@Desplegillo help" → routes to lead agent
"swarm#all status check" → broadcasts to all agents
"Alpha and Beta, review this" → creates 2 tasks (one for Alpha, one for Beta)
```

### 5. Multi-Workspace Support
**Decision**: Single workspace first, design for expansion

- Initial implementation: Single workspace using static env vars
- Store tokens in DB even for single workspace (cleaner architecture)
- Leave `team_id` as primary key to support multi-workspace later
- Document OAuth flow for future multi-workspace implementation

## Open Questions

None remaining - ready for implementation planning.
