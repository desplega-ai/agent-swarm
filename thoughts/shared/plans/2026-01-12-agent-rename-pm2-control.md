# Agent Renaming & PM2 Control from Frontend Implementation Plan

## Overview

Implement two features to enhance frontend management capabilities:
1. **Agent name editing** - Allow changing agent names directly from the UI
2. **PM2 process control** - Stop/Start/Restart/Rename PM2 processes and view logs from the frontend

Since agents run on separate machines (distributed architecture), PM2 control requires a **command queue system** where the backend queues commands and agents poll for them, execute locally, and report results.

## Current State Analysis

### Key Discoveries:

- Agent names are stored in SQLite `agents` table but can only be set at registration time via `POST /api/agents` (`src/http.ts:227-279`)
- `updateAgentProfile()` function exists at `src/be/db.ts:1256-1286` but only updates `description`, `role`, `capabilities` - NOT `name`
- No PATCH endpoint exists for agents
- Services are tracked in `services` table with status (starting, healthy, unhealthy, stopped) at `src/be/db.ts:134-155`
- MCP tools exist for agents to register/unregister/update their own services at `src/tools/services.ts`
- Agents poll for triggers via `GET /api/poll` at `src/http.ts:282-379` with runner implementation at `src/commands/runner.ts:237-277`
- Frontend uses React Query hooks at `ui/src/hooks/queries.ts` and API client at `ui/src/lib/api.ts`
- ServicesPanel at `ui/src/components/ServicesPanel.tsx` is currently read-only display

## Desired End State

1. **Agent name editing**: Users can click an edit button next to agent name in AgentDetailPanel, modify the name inline, and save. The change persists to the database and UI updates immediately.

2. **PM2 control**: ServicesPanel displays action buttons (Stop, Start, Restart, Logs) for each service. Clicking a button:
   - Creates a command in the database
   - Agent polls and receives the command
   - Agent executes PM2 command locally
   - Agent reports result back to backend
   - Frontend shows command status and result

3. **Log viewing**: A modal displays PM2 logs for a service with stdout/stderr filtering and auto-refresh.

## What We're NOT Doing

- WebSocket-based real-time updates (using polling for simplicity)
- Agent-to-agent direct communication for PM2 control
- PM2 process configuration editing (only lifecycle control)
- Bulk operations on multiple services at once
- Historical command audit UI (just current command status)

## Implementation Approach

The implementation follows a layered approach:
1. Backend database and API changes first
2. Agent-side command execution
3. Frontend UI components

For PM2 control, we use a command queue pattern since agents are distributed. This reuses the existing polling mechanism, extending the `Trigger` type to include `command_pending`.

---

## Phase 1: Agent Name Editing - Backend

### Overview
Add database function and API endpoint to update agent names.

### Changes Required:

#### 1. Database function for name update
**File**: `src/be/db.ts`
**Changes**: Add `updateAgentName()` function after `updateAgentProfile()` (around line 1286)

```typescript
export function updateAgentName(id: string, newName: string): Agent | null {
  const agent = getAgentById(id);
  if (!agent) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentRow, [string, string, string]>(
      `UPDATE agents SET name = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *`,
    )
    .get(newName, now, id);

  if (row) {
    try {
      createLogEntry({
        eventType: "agent_profile_update",
        agentId: id,
        oldValue: agent.name,
        newValue: newName,
        metadata: { field: "name" },
      });
    } catch {}
  }

  return row ? rowToAgent(row) : null;
}
```

#### 2. PATCH endpoint for agents
**File**: `src/http.ts`
**Changes**: Add PATCH handler after GET `/api/agents/:id` endpoint (around line 527)

```typescript
// PATCH /api/agents/:id - Update agent properties
if (
  req.method === "PATCH" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "agents" &&
  pathSegments[2]
) {
  const agentId = pathSegments[2];

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const agent = getAgentById(agentId);
  if (!agent) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Agent not found" }));
    return;
  }

  let updated = agent;

  // Update name if provided
  if (body.name && typeof body.name === "string") {
    const result = updateAgentName(agentId, body.name);
    if (result) updated = result;
  }

  // Update profile fields if provided
  if (body.description || body.role || body.capabilities) {
    const result = updateAgentProfile(agentId, {
      description: body.description,
      role: body.role,
      capabilities: body.capabilities,
    });
    if (result) updated = result;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(updated));
  return;
}
```

#### 3. Update imports in http.ts
**File**: `src/http.ts`
**Changes**: Add `updateAgentName` to imports from `./be/db`

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run build` or `bunx tsc --noEmit`
- [ ] Server starts without errors: `bun run src/http.ts`
- [ ] API test: `curl -X PATCH http://localhost:3013/api/agents/<id> -H "Content-Type: application/json" -d '{"name":"new-name"}'`

#### Manual Verification:
- [ ] Agent name is updated in database after PATCH request
- [ ] Agent log entry is created with `agent_profile_update` event

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Agent Name Editing - Frontend

### Overview
Add API method, React Query mutation, and inline edit UI for agent names.

### Changes Required:

#### 1. API method for updating agents
**File**: `ui/src/lib/api.ts`
**Changes**: Add `updateAgent` method to `ApiClient` class

```typescript
async updateAgent(
  id: string,
  updates: { name?: string; description?: string; role?: string; capabilities?: string[] },
): Promise<Agent> {
  const res = await this.request(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update agent");
  return res.json();
}
```

#### 2. React Query mutation hook
**File**: `ui/src/hooks/queries.ts`
**Changes**: Add `useUpdateAgent` hook

```typescript
export function useUpdateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: { name?: string; description?: string; role?: string };
    }) => api.updateAgent(id, updates),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent", variables.id] });
    },
  });
}
```

#### 3. Add edit UI to AgentDetailPanel
**File**: `ui/src/components/AgentDetailPanel.tsx`
**Changes**: Add inline edit capability for agent name

- Add `useState` for edit mode and name value
- Add edit icon button next to agent name
- When editing, show input field with save/cancel buttons
- Call `useUpdateAgent` mutation on save

### Success Criteria:

#### Automated Verification:
- [ ] Frontend builds: `cd ui && bun run build`
- [ ] TypeScript compiles: `cd ui && bunx tsc --noEmit`

#### Manual Verification:
- [ ] Edit button appears next to agent name in detail panel
- [ ] Clicking edit shows input field with current name
- [ ] Saving updates the name and closes edit mode
- [ ] Cancel discards changes
- [ ] Agent list refreshes with new name

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Command Queue System - Database & Types

### Overview
Add database table and types for the command queue system.

### Changes Required:

#### 1. Add command types
**File**: `src/types.ts`
**Changes**: Add command-related types

```typescript
// Command types for PM2 control
export type CommandType = "pm2_start" | "pm2_stop" | "pm2_restart" | "pm2_rename" | "pm2_logs";
export type CommandStatus = "pending" | "in_progress" | "completed" | "failed" | "expired";

export interface AgentCommand {
  id: string;
  agentId: string;
  serviceId?: string;
  commandType: CommandType;
  payload?: Record<string, unknown>;
  status: CommandStatus;
  result?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: string;
  createdBy: string;
}
```

#### 2. Add agent_commands table
**File**: `src/be/db.ts`
**Changes**: Add table creation in schema initialization (after services table)

```typescript
database.run(`
  CREATE TABLE IF NOT EXISTS agent_commands (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    serviceId TEXT,
    commandType TEXT NOT NULL CHECK(commandType IN ('pm2_start', 'pm2_stop', 'pm2_restart', 'pm2_rename', 'pm2_logs')),
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'expired')),
    result TEXT,
    createdAt TEXT NOT NULL,
    startedAt TEXT,
    completedAt TEXT,
    expiresAt TEXT NOT NULL,
    createdBy TEXT,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (serviceId) REFERENCES services(id) ON DELETE SET NULL
  )
`);
```

Add indexes:
```typescript
database.run(`CREATE INDEX IF NOT EXISTS idx_agent_commands_agentId ON agent_commands(agentId)`);
database.run(`CREATE INDEX IF NOT EXISTS idx_agent_commands_status ON agent_commands(status)`);
database.run(`CREATE INDEX IF NOT EXISTS idx_agent_commands_createdAt ON agent_commands(createdAt)`);
```

#### 3. Add CRUD functions for commands
**File**: `src/be/db.ts`
**Changes**: Add command management functions

```typescript
// Command row type
type CommandRow = {
  id: string;
  agentId: string;
  serviceId: string | null;
  commandType: CommandType;
  payload: string | null;
  status: CommandStatus;
  result: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  createdBy: string | null;
};

function rowToCommand(row: CommandRow): AgentCommand {
  return {
    id: row.id,
    agentId: row.agentId,
    serviceId: row.serviceId ?? undefined,
    commandType: row.commandType,
    payload: row.payload ? JSON.parse(row.payload) : undefined,
    status: row.status,
    result: row.result ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy ?? undefined,
  };
}

export interface CreateCommandOptions {
  serviceId?: string;
  payload?: Record<string, unknown>;
  createdBy?: string;
  expiresInMs?: number; // Default 5 minutes
}

export function createCommand(
  agentId: string,
  commandType: CommandType,
  options?: CreateCommandOptions,
): AgentCommand {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (options?.expiresInMs ?? 5 * 60 * 1000)).toISOString();

  const row = getDb()
    .prepare<CommandRow, (string | null)[]>(
      `INSERT INTO agent_commands (id, agentId, serviceId, commandType, payload, status, createdAt, expiresAt, createdBy)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      agentId,
      options?.serviceId ?? null,
      commandType,
      options?.payload ? JSON.stringify(options.payload) : null,
      now,
      expiresAt,
      options?.createdBy ?? null,
    );

  if (!row) throw new Error("Failed to create command");
  return rowToCommand(row);
}

export function getCommandById(id: string): AgentCommand | null {
  const row = getDb()
    .prepare<CommandRow, [string]>("SELECT * FROM agent_commands WHERE id = ?")
    .get(id);
  return row ? rowToCommand(row) : null;
}

export function getPendingCommandsForAgent(agentId: string): AgentCommand[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare<CommandRow, [string, string]>(
      `SELECT * FROM agent_commands
       WHERE agentId = ? AND status = 'pending' AND expiresAt > ?
       ORDER BY createdAt ASC`,
    )
    .all(agentId, now)
    .map(rowToCommand);
}

export function updateCommandStatus(
  id: string,
  status: CommandStatus,
  result?: string,
): AgentCommand | null {
  const now = new Date().toISOString();
  const timestampField = status === "in_progress" ? "startedAt" : "completedAt";

  const row = getDb()
    .prepare<CommandRow, [CommandStatus, string | null, string, string]>(
      `UPDATE agent_commands
       SET status = ?, result = ?, ${timestampField} = ?
       WHERE id = ? RETURNING *`,
    )
    .get(status, result ?? null, now, id);

  return row ? rowToCommand(row) : null;
}

export interface CommandFilters {
  agentId?: string;
  status?: CommandStatus;
  serviceId?: string;
}

export function getAllCommands(filters?: CommandFilters): AgentCommand[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.serviceId) {
    conditions.push("serviceId = ?");
    params.push(filters.serviceId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM agent_commands ${whereClause} ORDER BY createdAt DESC LIMIT 100`;

  return getDb()
    .prepare<CommandRow, string[]>(query)
    .all(...params)
    .map(rowToCommand);
}

export function deleteCommand(id: string): boolean {
  const result = getDb().run("DELETE FROM agent_commands WHERE id = ?", [id]);
  return result.changes > 0;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bunx tsc --noEmit`
- [ ] Server starts and initializes database: `bun run src/http.ts`
- [ ] Database has new table: `sqlite3 agent-swarm-db.sqlite ".schema agent_commands"`

#### Manual Verification:
- [ ] Table created with correct schema
- [ ] Indexes created

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 4.

---

## Phase 4: Command Queue System - API Endpoints

### Overview
Add REST endpoints for command management.

### Changes Required:

#### 1. Add command endpoints
**File**: `src/http.ts`
**Changes**: Add command CRUD endpoints

```typescript
// POST /api/commands - Create a new command
if (
  req.method === "POST" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "commands" &&
  !pathSegments[2]
) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  if (!body.agentId || !body.commandType) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing agentId or commandType" }));
    return;
  }

  // Verify agent exists
  const agent = getAgentById(body.agentId);
  if (!agent) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Agent not found" }));
    return;
  }

  const command = createCommand(body.agentId, body.commandType, {
    serviceId: body.serviceId,
    payload: body.payload,
    createdBy: myAgentId || "frontend",
  });

  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify(command));
  return;
}

// GET /api/commands - List commands
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "commands" &&
  !pathSegments[2]
) {
  const agentId = queryParams.get("agentId") || undefined;
  const status = queryParams.get("status") as CommandStatus | undefined;
  const serviceId = queryParams.get("serviceId") || undefined;

  const commands = getAllCommands({ agentId, status, serviceId });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ commands }));
  return;
}

// GET /api/commands/:id - Get single command
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "commands" &&
  pathSegments[2] &&
  !pathSegments[3]
) {
  const command = getCommandById(pathSegments[2]);
  if (!command) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Command not found" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(command));
  return;
}

// POST /api/commands/:id/result - Agent reports command result
if (
  req.method === "POST" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "commands" &&
  pathSegments[2] &&
  pathSegments[3] === "result"
) {
  const commandId = pathSegments[2];
  const command = getCommandById(commandId);

  if (!command) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Command not found" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const status = body.success ? "completed" : "failed";
  const updated = updateCommandStatus(commandId, status, JSON.stringify(body.result || body.error));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(updated));
  return;
}

// DELETE /api/commands/:id - Cancel pending command
if (
  req.method === "DELETE" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "commands" &&
  pathSegments[2]
) {
  const command = getCommandById(pathSegments[2]);

  if (!command) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Command not found" }));
    return;
  }

  if (command.status !== "pending") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Can only cancel pending commands" }));
    return;
  }

  deleteCommand(pathSegments[2]);
  res.writeHead(204);
  res.end();
  return;
}
```

#### 2. Extend poll endpoint for commands
**File**: `src/http.ts`
**Changes**: Add command trigger to poll response (in the transaction, after other trigger checks)

```typescript
// Check for pending commands (before returning null trigger)
const pendingCommands = getPendingCommandsForAgent(myAgentId);
if (pendingCommands.length > 0) {
  const cmd = pendingCommands[0];
  // Mark as in_progress
  updateCommandStatus(cmd.id, "in_progress");
  return {
    trigger: {
      type: "command_pending",
      commandId: cmd.id,
      command: cmd,
    },
  };
}
```

#### 3. Update imports
**File**: `src/http.ts`
**Changes**: Add new imports from `./be/db`

```typescript
import {
  // ... existing imports
  createCommand,
  getCommandById,
  getPendingCommandsForAgent,
  updateCommandStatus,
  getAllCommands,
  deleteCommand,
} from "./be/db";
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bunx tsc --noEmit`
- [ ] Create command: `curl -X POST http://localhost:3013/api/commands -H "Content-Type: application/json" -d '{"agentId":"<id>","commandType":"pm2_stop","payload":{"processName":"test"}}'`
- [ ] List commands: `curl http://localhost:3013/api/commands`

#### Manual Verification:
- [ ] Command appears in database after creation
- [ ] Poll endpoint returns command_pending trigger
- [ ] Command status updates to in_progress after poll

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 5.

---

## Phase 5: Agent-Side Command Execution

### Overview
Add PM2 command execution on the agent side.

### Changes Required:

#### 1. Create PM2 executor module
**File**: `src/commands/pm2-executor.ts` (new file)
**Changes**: Create new module

```typescript
export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

export async function executePm2Command(
  commandType: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  const processName = payload.processName as string;

  if (!processName) {
    return { success: false, error: "Missing processName in payload" };
  }

  try {
    switch (commandType) {
      case "pm2_stop":
        await Bun.$`pm2 stop ${processName}`.quiet();
        return { success: true, message: `Stopped ${processName}` };

      case "pm2_start":
        await Bun.$`pm2 start ${processName}`.quiet();
        return { success: true, message: `Started ${processName}` };

      case "pm2_restart":
        await Bun.$`pm2 restart ${processName}`.quiet();
        return { success: true, message: `Restarted ${processName}` };

      case "pm2_rename": {
        const newName = payload.newName as string;
        if (!newName) {
          return { success: false, error: "Missing newName for rename" };
        }
        // PM2 doesn't have rename, so we delete and restart with new name
        const jlist = await Bun.$`pm2 jlist`.json();
        const proc = (jlist as Array<{ name: string; pm2_env: { pm_exec_path: string } }>).find(
          (p) => p.name === processName,
        );
        if (!proc) {
          return { success: false, error: `Process ${processName} not found` };
        }
        await Bun.$`pm2 delete ${processName}`.quiet();
        await Bun.$`pm2 start ${proc.pm2_env.pm_exec_path} --name ${newName}`.quiet();
        return { success: true, message: `Renamed ${processName} to ${newName}` };
      }

      case "pm2_logs": {
        const lines = (payload.lines as number) || 100;
        const output = await Bun.$`pm2 logs ${processName} --lines ${lines} --nostream`.text();
        return { success: true, data: { logs: output } };
      }

      default:
        return { success: false, error: `Unknown command type: ${commandType}` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function reportCommandResult(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  commandId: string,
  result: CommandResult,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": agentId,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    await fetch(`${apiUrl}/api/commands/${commandId}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify(result),
    });
  } catch (error) {
    console.warn(`[pm2-executor] Failed to report result: ${error}`);
  }
}
```

#### 2. Extend trigger types in runner
**File**: `src/commands/runner.ts`
**Changes**: Add command_pending to Trigger interface (around line 174)

```typescript
interface Trigger {
  type:
    | "task_assigned"
    | "task_offered"
    | "unread_mentions"
    | "pool_tasks_available"
    | "tasks_finished"
    | "command_pending"; // Add this
  taskId?: string;
  task?: unknown;
  mentionsCount?: number;
  count?: number;
  tasks?: Array<{
    id: string;
    agentId?: string;
    task: string;
    status: string;
  }>;
  // Add command fields
  commandId?: string;
  command?: {
    id: string;
    commandType: string;
    serviceId?: string;
    payload?: Record<string, unknown>;
  };
}
```

#### 3. Handle command execution in poll loop
**File**: `src/commands/runner.ts`
**Changes**: Add command handling in the poll loop (after trigger check, before building prompt)

Add import at top:
```typescript
import { executePm2Command, reportCommandResult } from "./pm2-executor";
```

Add in poll loop (around line 570, after `console.log(`[${role}] Trigger received: ${trigger.type}`);`):
```typescript
// Handle command triggers directly (no Claude needed)
if (trigger.type === "command_pending" && trigger.command && trigger.commandId) {
  console.log(`[${role}] Executing command: ${trigger.command.commandType}`);
  const result = await executePm2Command(
    trigger.command.commandType,
    trigger.command.payload || {},
  );
  console.log(`[${role}] Command result: ${result.success ? "success" : "failed"}`);
  await reportCommandResult(apiUrl, apiKey, agentId, trigger.commandId, result);
  console.log(`[${role}] Command result reported, polling for next trigger...`);
  continue; // Skip Claude iteration for commands
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bunx tsc --noEmit`
- [ ] PM2 executor module can be imported: `bun -e "import './src/commands/pm2-executor'"`

#### Manual Verification:
- [ ] Start a test PM2 process: `pm2 start --name test-process "sleep 3600"`
- [ ] Create stop command via API
- [ ] Agent polls and executes command
- [ ] PM2 process is stopped
- [ ] Command status updated to completed

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 6.

---

## Phase 6: Frontend PM2 Controls

### Overview
Add command API methods, React Query hooks, and action buttons to ServicesPanel.

### Changes Required:

#### 1. Add frontend types
**File**: `ui/src/types/api.ts`
**Changes**: Add command types

```typescript
export type CommandType = "pm2_start" | "pm2_stop" | "pm2_restart" | "pm2_rename" | "pm2_logs";
export type CommandStatus = "pending" | "in_progress" | "completed" | "failed" | "expired";

export interface AgentCommand {
  id: string;
  agentId: string;
  serviceId?: string;
  commandType: CommandType;
  payload?: Record<string, unknown>;
  status: CommandStatus;
  result?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: string;
  createdBy?: string;
}
```

#### 2. Add command API methods
**File**: `ui/src/lib/api.ts`
**Changes**: Add command methods to ApiClient

```typescript
async createCommand(params: {
  agentId: string;
  commandType: CommandType;
  serviceId?: string;
  payload?: Record<string, unknown>;
}): Promise<AgentCommand> {
  const res = await this.request("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error("Failed to create command");
  return res.json();
}

async getCommand(id: string): Promise<AgentCommand> {
  const res = await this.request(`/api/commands/${id}`);
  if (!res.ok) throw new Error("Failed to get command");
  return res.json();
}

async getCommands(filters?: {
  agentId?: string;
  status?: string;
  serviceId?: string;
}): Promise<{ commands: AgentCommand[] }> {
  const params = new URLSearchParams();
  if (filters?.agentId) params.set("agentId", filters.agentId);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.serviceId) params.set("serviceId", filters.serviceId);
  const query = params.toString();
  const res = await this.request(`/api/commands${query ? `?${query}` : ""}`);
  if (!res.ok) throw new Error("Failed to get commands");
  return res.json();
}

async cancelCommand(id: string): Promise<void> {
  const res = await this.request(`/api/commands/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to cancel command");
}
```

#### 3. Add React Query hooks for commands
**File**: `ui/src/hooks/queries.ts`
**Changes**: Add command hooks

```typescript
export function useCreateCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      agentId: string;
      commandType: CommandType;
      serviceId?: string;
      payload?: Record<string, unknown>;
    }) => api.createCommand(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commands"] });
    },
  });
}

export function useCommand(id: string | undefined) {
  return useQuery({
    queryKey: ["command", id],
    queryFn: () => (id ? api.getCommand(id) : null),
    enabled: !!id,
    refetchInterval: 2000, // Poll for status updates
  });
}

export function useCommands(filters?: { agentId?: string; status?: string; serviceId?: string }) {
  return useQuery({
    queryKey: ["commands", filters],
    queryFn: () => api.getCommands(filters),
    select: (data) => data.commands,
    refetchInterval: 5000,
  });
}
```

#### 4. Add action buttons to ServicesPanel
**File**: `ui/src/components/ServicesPanel.tsx`
**Changes**: Add actions column with Stop/Start/Restart buttons

Add imports:
```typescript
import IconButton from "@mui/joy/IconButton";
import Tooltip from "@mui/joy/Tooltip";
import { useCreateCommand } from "../hooks/queries";
// Icons (use MUI Joy icons or simple text for now)
```

Add action column to table header:
```typescript
<th style={{ width: "12%" }}>ACTIONS</th>
```

Add action buttons to each row:
```typescript
const createCommand = useCreateCommand();

// In table row
<td>
  <Box sx={{ display: "flex", gap: 0.5 }}>
    <Tooltip title="Stop">
      <IconButton
        size="sm"
        variant="soft"
        color="danger"
        onClick={() => createCommand.mutate({
          agentId: service.agentId,
          commandType: "pm2_stop",
          serviceId: service.id,
          payload: { processName: service.name },
        })}
        disabled={service.status === "stopped"}
      >
        ■
      </IconButton>
    </Tooltip>
    <Tooltip title="Start">
      <IconButton
        size="sm"
        variant="soft"
        color="success"
        onClick={() => createCommand.mutate({
          agentId: service.agentId,
          commandType: "pm2_start",
          serviceId: service.id,
          payload: { processName: service.name },
        })}
        disabled={service.status === "healthy"}
      >
        ▶
      </IconButton>
    </Tooltip>
    <Tooltip title="Restart">
      <IconButton
        size="sm"
        variant="soft"
        color="warning"
        onClick={() => createCommand.mutate({
          agentId: service.agentId,
          commandType: "pm2_restart",
          serviceId: service.id,
          payload: { processName: service.name },
        })}
      >
        ↻
      </IconButton>
    </Tooltip>
  </Box>
</td>
```

### Success Criteria:

#### Automated Verification:
- [ ] Frontend builds: `cd ui && bun run build`
- [ ] TypeScript compiles: `cd ui && bunx tsc --noEmit`

#### Manual Verification:
- [ ] Action buttons appear in services table
- [ ] Clicking Stop creates a command
- [ ] Command appears in database
- [ ] Agent executes command
- [ ] Service status updates

**Implementation Note**: After completing this phase and all automated verification passes, the core functionality is complete. Phase 7 (Log Viewer) is optional but recommended.

---

## Phase 7: Log Viewer Modal (Optional Enhancement)

### Overview
Add a modal to view PM2 logs for a service.

### Changes Required:

#### 1. Create LogViewerModal component
**File**: `ui/src/components/LogViewerModal.tsx` (new file)

Modal that:
- Opens when clicking Logs button on a service
- Creates a pm2_logs command to fetch logs
- Displays logs in a scrollable, monospace view
- Has stdout/stderr filter tabs
- Auto-refreshes while open

#### 2. Add logs button to ServicesPanel
**File**: `ui/src/components/ServicesPanel.tsx`
**Changes**: Add logs button and modal state

### Success Criteria:

#### Manual Verification:
- [ ] Logs button opens modal
- [ ] Logs are displayed
- [ ] Filter tabs work
- [ ] Modal closes properly

---

## Testing Strategy

### Unit Tests:
- Database CRUD functions for commands
- PM2 executor command handling
- API endpoint request/response validation

### Integration Tests:
- Full command flow: create → poll → execute → report
- Frontend command creation → backend → agent → result

### Manual Testing Steps:
1. Create an agent and a service via API
2. Start a PM2 process manually: `pm2 start --name test "sleep 3600"`
3. Click Stop in UI → verify process stops
4. Click Start → verify process starts
5. Click Restart → verify restart
6. Edit agent name → verify update

## Performance Considerations

- Commands expire after 5 minutes to prevent stale commands
- Poll interval is 2 seconds to balance responsiveness and load
- Log fetching is on-demand, not streamed continuously
- Frontend polls command status every 2 seconds while a command is pending

## References

- Existing polling mechanism: `src/commands/runner.ts:237-277`
- Service table schema: `src/be/db.ts:134-155`
- Agent profile update pattern: `src/be/db.ts:1256-1286`
- Frontend React Query patterns: `ui/src/hooks/queries.ts`

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/types.ts` | Modify | Add command types |
| `src/be/db.ts` | Modify | Add table, CRUD functions |
| `src/http.ts` | Modify | Add PATCH agent, command endpoints |
| `src/commands/pm2-executor.ts` | Create | PM2 command execution |
| `src/commands/runner.ts` | Modify | Handle command triggers |
| `ui/src/types/api.ts` | Modify | Add command types |
| `ui/src/lib/api.ts` | Modify | Add command API methods |
| `ui/src/hooks/queries.ts` | Modify | Add command hooks |
| `ui/src/components/ServicesPanel.tsx` | Modify | Add action buttons |
| `ui/src/components/AgentDetailPanel.tsx` | Modify | Add name editing |
| `ui/src/components/LogViewerModal.tsx` | Create | Optional log viewer |
