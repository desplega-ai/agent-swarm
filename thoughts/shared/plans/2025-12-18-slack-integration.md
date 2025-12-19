# Slack Multi-Agent Bot Integration Implementation Plan

## Overview

Integrate Slack as a communication interface for the Agent Swarm MCP, allowing users to interact with agents via Slack messages. Agents will respond with custom personas, and tasks can be created directly from Slack conversations.

## Current State Analysis

The Agent Swarm MCP currently provides:
- HTTP server with REST API and MCP transport (`src/http.ts`)
- SQLite database with `agents`, `agent_tasks`, and `agent_log` tables (`src/be/db.ts`)
- 8 MCP tools for agent coordination (`src/tools/*.ts`)
- CLI runners for lead/worker agents (`src/commands/*.ts`)
- React dashboard UI (`ui/src/`)

**What's Missing:**
- No Slack integration code exists
- No task source tracking (can't distinguish MCP vs Slack-created tasks)
- No mechanism for external systems to create tasks directly

### Key Discoveries:
- Socket Mode enabled in `slack-manifest.json:61` - no webhook endpoints needed
- Task creation flows through `send-task` tool only (`src/tools/send-task.ts`)
- Database uses `CREATE TABLE IF NOT EXISTS` for idempotent schema updates (`src/be/db.ts:23-65`)
- Zod v4 used for schema validation (`src/types.ts`)

## Desired End State

After implementation:
1. Slack bot connects via Socket Mode on server startup
2. Users can mention agents by name in Slack messages to create tasks
3. Agents respond in Slack with custom personas matching their swarm identity
4. Task progress/completion updates appear in the original Slack thread
5. `/agent-swarm-status` slash command shows current swarm state

### Verification:
- Bot appears online in Slack workspace
- Mentioning an agent name creates a task visible in the dashboard
- Agent completion messages appear in Slack with correct persona
- Slash command returns agent list with statuses

## What We're NOT Doing

- **Multi-workspace OAuth flow** - Single workspace only (env vars for tokens)
- **Interactive components** - No buttons, modals, or block kit interactions
- **App Home tab** - Disabled in manifest, not implementing
- **Message threading for sub-tasks** - Each mention = one task, no hierarchy
- **Slack-side task management** - No editing/canceling tasks from Slack
- **Rate limiting** - Rely on Slack's built-in rate limits
- **Message history sync** - Only process new messages, not historical

## Implementation Approach

Use Slack's Bolt SDK with Socket Mode for real-time event delivery. This avoids exposing public endpoints and simplifies deployment. The integration will:

1. Run alongside the existing HTTP server (not replace it)
2. Create tasks directly in the database (bypassing MCP tools)
3. Poll for task completion to send Slack responses
4. Use the agent's name as the Slack display name via `chat:write.customize`

## Phase 1: Database Schema Updates

### Overview
Add task source tracking and prepare schema for Slack token storage.

### Changes Required:

#### 1. Types (`src/types.ts`)

Add task source enum and extend task schema:

```typescript
// After line 3 (AgentTaskStatusSchema)
export const AgentTaskSourceSchema = z.enum(["mcp", "slack", "api"]);
export type AgentTaskSource = z.infer<typeof AgentTaskSourceSchema>;
```

Update `AgentTaskSchema` to include source:

```typescript
// Modify lines 5-19
export const AgentTaskSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  task: z.string().min(1),
  status: AgentTaskStatusSchema,
  source: AgentTaskSourceSchema.default("mcp"),  // NEW

  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  lastUpdatedAt: z.iso.datetime().default(() => new Date().toISOString()),

  finishedAt: z.iso.datetime().optional(),

  failureReason: z.string().optional(),
  output: z.string().optional(),
  progress: z.string().optional(),

  // Slack-specific metadata (optional)
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),
});
```

#### 2. Database Schema (`src/be/db.ts`)

Add `source` column and Slack metadata to `agent_tasks` table. Update the CREATE TABLE statement:

```sql
-- Modify lines 33-45
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
  source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api')),
  slackChannelId TEXT,
  slackThreadTs TEXT,
  slackUserId TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  finishedAt TEXT,
  failureReason TEXT,
  output TEXT,
  progress TEXT,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
```

Add migration for existing databases (add after table creation, before indexes):

```sql
-- Add column if it doesn't exist (SQLite doesn't support IF NOT EXISTS for columns)
-- We'll handle this in code with a try/catch
```

#### 3. Database Functions (`src/be/db.ts`)

Update `AgentTaskRow` type:

```typescript
// Modify lines 178-189
type AgentTaskRow = {
  id: string;
  agentId: string;
  task: string;
  status: AgentTaskStatus;
  source: AgentTaskSource;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
  failureReason: string | null;
  output: string | null;
  progress: string | null;
};
```

Update `rowToAgentTask` converter:

```typescript
// Modify lines 191-204
function rowToAgentTask(row: AgentTaskRow): AgentTask {
  return {
    id: row.id,
    agentId: row.agentId,
    task: row.task,
    status: row.status,
    source: row.source,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    slackUserId: row.slackUserId ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
    failureReason: row.failureReason ?? undefined,
    output: row.output ?? undefined,
    progress: row.progress ?? undefined,
  };
}
```

Update `createTask` function signature and query:

```typescript
// Modify lines 249-257
export function createTask(
  agentId: string,
  task: string,
  options?: {
    source?: AgentTaskSource;
    slackChannelId?: string;
    slackThreadTs?: string;
    slackUserId?: string;
  }
): AgentTask {
  const id = crypto.randomUUID();
  const source = options?.source ?? "mcp";
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string, AgentTaskStatus, AgentTaskSource, string | null, string | null, string | null]>(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, slackChannelId, slackThreadTs, slackUserId, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`
    )
    .get(id, agentId, task, "pending", source, options?.slackChannelId ?? null, options?.slackThreadTs ?? null, options?.slackUserId ?? null);
  if (!row) throw new Error("Failed to create task");
  try {
    createLogEntry({ eventType: "task_created", agentId, taskId: id, newValue: "pending", metadata: { source } });
  } catch { }
  return rowToAgentTask(row);
}
```

Add function to get Slack tasks awaiting response:

```typescript
// Add after getAllTasks function (around line 335)
export function getCompletedSlackTasks(): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId IS NOT NULL
       AND status IN ('completed', 'failed')
       ORDER BY lastUpdatedAt DESC`
    )
    .all()
    .map(rowToAgentTask);
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Server starts without errors: `bun run dev:http`
- [x] Existing tasks still work (backward compatible)

#### Manual Verification:
- [x] New task created via MCP has `source: "mcp"`
- [x] Database schema updated correctly (check with sqlite3 CLI)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the database changes work correctly before proceeding to the next phase.

---

## Phase 2: Slack Dependencies and Configuration

### Overview
Add Slack Bolt SDK and configure environment variables.

### Changes Required:

#### 1. Install Dependencies

```bash
bun add @slack/bolt
```

#### 2. Environment Variables

Create `.env.example` update (document required vars):

```bash
# Slack Bot Configuration (Socket Mode)
SLACK_BOT_TOKEN=xoxb-...      # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...      # App-Level Token (for Socket Mode)
SLACK_SIGNING_SECRET=...      # Signing Secret (optional for Socket Mode)
```

#### 3. Slack Types (`src/slack/types.ts`)

**File**: `src/slack/types.ts` (NEW)

```typescript
import type { Agent } from "../types";

export interface SlackMessageContext {
  channelId: string;
  threadTs?: string;
  userId: string;
  text: string;
  botUserId: string;
}

export interface AgentMatch {
  agent: Agent;
  matchedText: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Dependencies install: `bun install`
- [x] TypeScript compiles: `bun run tsc:check`
- [x] No runtime errors on import

#### Manual Verification:
- [x] `.env` file has required Slack tokens configured
- [ ] Tokens are valid (can be verified in Phase 3)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 3: Slack Bot Core Implementation

### Overview
Initialize Bolt app with Socket Mode and implement basic message handling.

### Changes Required:

#### 1. Slack App Initialization (`src/slack/app.ts`)

**File**: `src/slack/app.ts` (NEW)

```typescript
import { App, LogLevel } from "@slack/bolt";

let app: App | null = null;

export function getSlackApp(): App | null {
  return app;
}

export async function initSlackApp(): Promise<App | null> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    console.log("[Slack] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN, Slack integration disabled");
    return null;
  }

  app = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
    logLevel: process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Register handlers
  const { registerMessageHandler } = await import("./handlers");
  const { registerCommandHandler } = await import("./commands");

  registerMessageHandler(app);
  registerCommandHandler(app);

  return app;
}

export async function startSlackApp(): Promise<void> {
  if (!app) {
    await initSlackApp();
  }

  if (app) {
    await app.start();
    console.log("[Slack] Bot connected via Socket Mode");
  }
}

export async function stopSlackApp(): Promise<void> {
  if (app) {
    await app.stop();
    app = null;
    console.log("[Slack] Bot disconnected");
  }
}
```

#### 2. Agent Router (`src/slack/router.ts`)

**File**: `src/slack/router.ts` (NEW)

```typescript
import type { Agent } from "../types";
import { getAllAgents, getAgentById } from "../be/db";
import type { AgentMatch } from "./types";

/**
 * Routes a Slack message to the appropriate agent(s) based on mentions.
 *
 * Routing rules:
 * - `swarm#<uuid>` → exact agent by ID
 * - `swarm#all` → all non-lead agents
 * - Partial name match (words >3 chars) → agent by name
 * - Bot @mention only → lead agent
 */
export function routeMessage(
  text: string,
  botUserId: string,
  botMentioned: boolean
): AgentMatch[] {
  const matches: AgentMatch[] = [];
  const agents = getAllAgents().filter(a => a.status !== "offline");

  // Check for explicit swarm#<id> syntax
  const idMatches = text.matchAll(/swarm#([a-f0-9-]{36})/gi);
  for (const match of idMatches) {
    const agent = getAgentById(match[1]);
    if (agent && agent.status !== "offline") {
      matches.push({ agent, matchedText: match[0] });
    }
  }

  // Check for swarm#all broadcast
  if (/swarm#all/i.test(text)) {
    const nonLeadAgents = agents.filter(a => !a.isLead);
    for (const agent of nonLeadAgents) {
      if (!matches.some(m => m.agent.id === agent.id)) {
        matches.push({ agent, matchedText: "swarm#all" });
      }
    }
  }

  // Check for partial name matches (words > 3 chars)
  if (matches.length === 0) {
    for (const agent of agents) {
      const nameWords = agent.name.split(/\s+/).filter(w => w.length > 3);
      for (const word of nameWords) {
        const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
        if (regex.test(text)) {
          if (!matches.some(m => m.agent.id === agent.id)) {
            matches.push({ agent, matchedText: word });
          }
          break;
        }
      }
    }
  }

  // If only bot was mentioned and no agents matched, route to lead
  if (matches.length === 0 && botMentioned) {
    const lead = agents.find(a => a.isLead);
    if (lead) {
      matches.push({ agent: lead, matchedText: "@bot" });
    }
  }

  return matches;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extracts the task description from a message, removing bot mentions and agent references.
 */
export function extractTaskFromMessage(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")  // Remove bot mentions
    .replace(/swarm#[a-f0-9-]{36}/gi, "")             // Remove swarm#<id>
    .replace(/swarm#all/gi, "")                       // Remove swarm#all
    .trim();
}
```

#### 3. Message Handlers (`src/slack/handlers.ts`)

**File**: `src/slack/handlers.ts` (NEW)

```typescript
import type { App, GenericMessageEvent } from "@slack/bolt";
import { createTask, getAgentById } from "../be/db";
import { routeMessage, extractTaskFromMessage } from "./router";

export function registerMessageHandler(app: App): void {
  // Handle all message events
  app.event("message", async ({ event, client, say }) => {
    // Ignore bot messages and message_changed events
    if (event.subtype === "bot_message" || event.subtype === "message_changed") {
      return;
    }

    const msg = event as GenericMessageEvent;
    if (!msg.text || !msg.user) return;

    // Get bot's user ID
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id as string;

    // Check if bot was mentioned
    const botMentioned = msg.text.includes(`<@${botUserId}>`);

    // Route message to agents
    const matches = routeMessage(msg.text, botUserId, botMentioned);

    if (matches.length === 0) {
      // No agents matched - ignore message unless bot was directly mentioned
      if (botMentioned) {
        await say({
          text: "No agents are currently available. Use `/agent-swarm-status` to check the swarm.",
          thread_ts: msg.thread_ts || msg.ts,
        });
      }
      return;
    }

    // Extract task description
    const taskDescription = extractTaskFromMessage(msg.text, botUserId);
    if (!taskDescription) {
      await say({
        text: "Please provide a task description after mentioning an agent.",
        thread_ts: msg.thread_ts || msg.ts,
      });
      return;
    }

    // Create tasks for each matched agent
    const createdTasks: string[] = [];
    for (const match of matches) {
      // Check agent is still idle
      const agent = getAgentById(match.agent.id);
      if (!agent || agent.status !== "idle") {
        await say({
          text: `Agent "${match.agent.name}" is currently ${agent?.status || "unavailable"} and cannot accept tasks.`,
          thread_ts: msg.thread_ts || msg.ts,
        });
        continue;
      }

      const task = createTask(match.agent.id, taskDescription, {
        source: "slack",
        slackChannelId: msg.channel,
        slackThreadTs: msg.thread_ts || msg.ts,
        slackUserId: msg.user,
      });

      createdTasks.push(`${match.agent.name} (${task.id.slice(0, 8)})`);
    }

    if (createdTasks.length > 0) {
      await say({
        text: `Task created for: ${createdTasks.join(", ")}`,
        thread_ts: msg.thread_ts || msg.ts,
      });
    }
  });

  // Handle app_mention events specifically
  app.event("app_mention", async ({ event, client, say }) => {
    // app_mention is already handled by the message event above
    // but we can add specific behavior here if needed
    console.log(`[Slack] App mentioned in channel ${event.channel}`);
  });
}
```

#### 4. Slash Commands (`src/slack/commands.ts`)

**File**: `src/slack/commands.ts` (NEW)

```typescript
import type { App } from "@slack/bolt";
import { getAllAgents, getAllTasks } from "../be/db";

export function registerCommandHandler(app: App): void {
  app.command("/agent-swarm-status", async ({ command, ack, respond }) => {
    await ack();

    const agents = getAllAgents();
    const tasks = getAllTasks({ status: "in_progress" });

    const statusEmoji: Record<string, string> = {
      idle: ":white_circle:",
      busy: ":large_blue_circle:",
      offline: ":black_circle:",
    };

    const agentLines = agents.map(agent => {
      const emoji = statusEmoji[agent.status] || ":question:";
      const role = agent.isLead ? " (Lead)" : "";
      const activeTask = tasks.find(t => t.agentId === agent.id);
      const taskInfo = activeTask ? ` - Working on: ${activeTask.task.slice(0, 50)}...` : "";
      return `${emoji} *${agent.name}*${role}: ${agent.status}${taskInfo}`;
    });

    const summary = {
      total: agents.length,
      idle: agents.filter(a => a.status === "idle").length,
      busy: agents.filter(a => a.status === "busy").length,
      offline: agents.filter(a => a.status === "offline").length,
    };

    await respond({
      response_type: "ephemeral",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Agent Swarm Status" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Summary:* ${summary.total} agents (${summary.idle} idle, ${summary.busy} busy, ${summary.offline} offline)`,
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: agentLines.join("\n") || "_No agents registered_",
          },
        },
      ],
    });
  });
}
```

#### 5. Export Module (`src/slack/index.ts`)

**File**: `src/slack/index.ts` (NEW)

```typescript
export { initSlackApp, startSlackApp, stopSlackApp, getSlackApp } from "./app";
export { routeMessage, extractTaskFromMessage } from "./router";
export type { SlackMessageContext, AgentMatch, SlackConfig } from "./types";
```

#### 6. Integrate with HTTP Server (`src/http.ts`)

Add Slack startup/shutdown to the HTTP server lifecycle:

```typescript
// Add import at top (after line 24)
import { startSlackApp, stopSlackApp } from "./slack";

// Modify shutdown function (around line 391)
async function shutdown() {
  console.log("Shutting down...");

  // Stop Slack bot
  await stopSlackApp();

  // Close all active transports (SSE connections, etc.)
  for (const [id, transport] of Object.entries(transports)) {
    console.log(`[HTTP] Closing transport ${id}`);
    transport.close();
    delete transports[id];
  }

  // Close all active connections forcefully
  httpServer.closeAllConnections();
  httpServer.close(() => {
    closeDb();
    console.log("MCP HTTP server closed, and database connection closed");
    process.exit(0);
  });
}

// Add Slack startup after HTTP server starts (after line 418)
httpServer
  .listen(port, async () => {
    console.log(`MCP HTTP server running on http://localhost:${port}/mcp`);

    // Start Slack bot (if configured)
    await startSlackApp();
  })
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Server starts: `bun run dev:http`
- [ ] Console shows "[Slack] Bot connected via Socket Mode" (with valid tokens)

#### Manual Verification:
- [ ] Bot appears online in Slack workspace
- [ ] `/agent-swarm-status` command works
- [ ] Mentioning an agent name creates a task in the database
- [ ] Task shows `source: "slack"` in database/dashboard

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the Slack bot connects and basic commands work before proceeding to the next phase.

---

## Phase 4: Task Completion Responses

### Overview
Send task completion/failure messages back to Slack with custom agent personas.

### Changes Required:

#### 1. Response Sender (`src/slack/responses.ts`)

**File**: `src/slack/responses.ts` (NEW)

```typescript
import type { WebClient } from "@slack/web-api";
import type { AgentTask, Agent } from "../types";
import { getAgentById } from "../be/db";
import { getSlackApp } from "./app";

/**
 * Send a task completion message to Slack with the agent's persona.
 */
export async function sendTaskResponse(task: AgentTask): Promise<boolean> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs) {
    return false;
  }

  const agent = getAgentById(task.agentId);
  if (!agent) {
    console.error(`[Slack] Agent not found for task ${task.id}`);
    return false;
  }

  const client = app.client;

  try {
    if (task.status === "completed") {
      await sendWithPersona(client, {
        channel: task.slackChannelId,
        thread_ts: task.slackThreadTs,
        text: task.output || "Task completed.",
        username: agent.name,
        icon_emoji: getAgentEmoji(agent),
      });
    } else if (task.status === "failed") {
      await sendWithPersona(client, {
        channel: task.slackChannelId,
        thread_ts: task.slackThreadTs,
        text: `:x: Task failed: ${task.failureReason || "Unknown error"}`,
        username: agent.name,
        icon_emoji: getAgentEmoji(agent),
      });
    }

    return true;
  } catch (error) {
    console.error(`[Slack] Failed to send response for task ${task.id}:`, error);
    return false;
  }
}

/**
 * Send a progress update to Slack.
 */
export async function sendProgressUpdate(task: AgentTask, progress: string): Promise<boolean> {
  const app = getSlackApp();
  if (!app || !task.slackChannelId || !task.slackThreadTs) {
    return false;
  }

  const agent = getAgentById(task.agentId);
  if (!agent) return false;

  try {
    await sendWithPersona(app.client, {
      channel: task.slackChannelId,
      thread_ts: task.slackThreadTs,
      text: `:hourglass_flowing_sand: ${progress}`,
      username: agent.name,
      icon_emoji: getAgentEmoji(agent),
    });
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to send progress update:`, error);
    return false;
  }
}

async function sendWithPersona(
  client: WebClient,
  options: {
    channel: string;
    thread_ts: string;
    text: string;
    username: string;
    icon_emoji: string;
  }
): Promise<void> {
  await client.chat.postMessage({
    channel: options.channel,
    thread_ts: options.thread_ts,
    text: options.text,
    username: options.username,
    icon_emoji: options.icon_emoji,
  });
}

function getAgentEmoji(agent: Agent): string {
  if (agent.isLead) return ":crown:";

  // Generate consistent emoji based on agent name hash
  const emojis = [":robot_face:", ":gear:", ":zap:", ":rocket:", ":star:", ":crystal_ball:", ":bulb:", ":wrench:"];
  const hash = agent.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return emojis[hash % emojis.length];
}
```

#### 2. Completion Watcher (`src/slack/watcher.ts`)

**File**: `src/slack/watcher.ts` (NEW)

```typescript
import { getCompletedSlackTasks, updateTaskSlackNotified } from "../be/db";
import { sendTaskResponse } from "./responses";
import { getSlackApp } from "./app";

let watcherInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start watching for completed Slack tasks and sending responses.
 */
export function startTaskWatcher(intervalMs = 5000): void {
  if (watcherInterval) {
    console.log("[Slack] Task watcher already running");
    return;
  }

  watcherInterval = setInterval(async () => {
    if (!getSlackApp()) return;

    const tasks = getCompletedSlackTasks();

    for (const task of tasks) {
      const sent = await sendTaskResponse(task);
      if (sent) {
        // Mark task as Slack-notified to prevent re-sending
        markTaskNotified(task.id);
      }
    }
  }, intervalMs);

  console.log(`[Slack] Task watcher started (interval: ${intervalMs}ms)`);
}

export function stopTaskWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    console.log("[Slack] Task watcher stopped");
  }
}

// Track notified tasks in memory (persists across watcher cycles)
const notifiedTasks = new Set<string>();

function markTaskNotified(taskId: string): void {
  notifiedTasks.add(taskId);
}

// Override getCompletedSlackTasks to filter already-notified
export function getUnnotifiedCompletedSlackTasks() {
  const { getCompletedSlackTasks } = require("../be/db");
  return getCompletedSlackTasks().filter((t: { id: string }) => !notifiedTasks.has(t.id));
}
```

**Note:** We use an in-memory set for tracking notified tasks. For production, consider adding a `slackNotifiedAt` column to the database.

#### 3. Update Slack App to Start Watcher (`src/slack/app.ts`)

Add watcher startup:

```typescript
// Add import at top
import { startTaskWatcher, stopTaskWatcher } from "./watcher";

// Update startSlackApp function
export async function startSlackApp(): Promise<void> {
  if (!app) {
    await initSlackApp();
  }

  if (app) {
    await app.start();
    console.log("[Slack] Bot connected via Socket Mode");

    // Start watching for task completions
    startTaskWatcher();
  }
}

// Update stopSlackApp function
export async function stopSlackApp(): Promise<void> {
  stopTaskWatcher();

  if (app) {
    await app.stop();
    app = null;
    console.log("[Slack] Bot disconnected");
  }
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Server starts without errors: `bun run dev:http`

#### Manual Verification:
- [ ] Create a task from Slack message
- [ ] Complete the task via MCP (or manually update DB)
- [ ] Verify completion message appears in Slack thread
- [ ] Message shows agent's name as the sender
- [ ] Failed tasks show error message in Slack

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that task responses appear correctly in Slack before proceeding to the next phase.

---

## Phase 5: Polish and Edge Cases

### Overview
Handle multi-agent mentions, broadcasts, and improve error handling.

### Changes Required:

#### 1. Update Handlers for Better UX (`src/slack/handlers.ts`)

Update message handler with better feedback:

```typescript
// Replace the task creation loop in registerMessageHandler

// Create tasks for each matched agent
const results: { success: string[]; failed: string[] } = { success: [], failed: [] };

for (const match of matches) {
  const agent = getAgentById(match.agent.id);

  if (!agent) {
    results.failed.push(`${match.agent.name} (not found)`);
    continue;
  }

  if (agent.status !== "idle") {
    results.failed.push(`${agent.name} (${agent.status})`);
    continue;
  }

  try {
    const task = createTask(agent.id, taskDescription, {
      source: "slack",
      slackChannelId: msg.channel,
      slackThreadTs: msg.thread_ts || msg.ts,
      slackUserId: msg.user,
    });
    results.success.push(`${agent.name}`);
  } catch (error) {
    results.failed.push(`${agent.name} (error)`);
  }
}

// Send summary
const parts: string[] = [];
if (results.success.length > 0) {
  parts.push(`:white_check_mark: Task assigned to: ${results.success.join(", ")}`);
}
if (results.failed.length > 0) {
  parts.push(`:warning: Could not assign to: ${results.failed.join(", ")}`);
}

if (parts.length > 0) {
  await say({
    text: parts.join("\n"),
    thread_ts: msg.thread_ts || msg.ts,
  });
}
```

#### 2. Add Help Command

Add to `src/slack/commands.ts`:

```typescript
app.command("/agent-swarm-help", async ({ command, ack, respond }) => {
  await ack();

  await respond({
    response_type: "ephemeral",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Agent Swarm Help" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*How to assign tasks:*
• Mention an agent by name: \`Hey Alpha, can you review this code?\`
• Use explicit ID: \`swarm#<uuid> please analyze the logs\`
• Broadcast to all: \`swarm#all status report please\`
• Mention the bot: \`@agent-swarm help me\` (routes to lead agent)

*Commands:*
• \`/agent-swarm-status\` - Show all agents and their current status
• \`/agent-swarm-help\` - Show this help message`,
        },
      },
    ],
  });
});
```

Update manifest if needed for the new command.

#### 3. Rate Limiting Protection

Add simple rate limiting to prevent spam:

```typescript
// Add to src/slack/handlers.ts

const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userRequests = rateLimitMap.get(userId) || 0;

  // Simple sliding window (resets after window)
  if (userRequests >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  rateLimitMap.set(userId, userRequests + 1);

  // Clean up after window
  setTimeout(() => {
    const current = rateLimitMap.get(userId) || 0;
    if (current > 0) {
      rateLimitMap.set(userId, current - 1);
    }
  }, RATE_LIMIT_WINDOW);

  return true;
}

// Use in message handler:
if (!checkRateLimit(msg.user)) {
  await say({
    text: "You're sending too many requests. Please slow down.",
    thread_ts: msg.thread_ts || msg.ts,
  });
  return;
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Linting passes: `bun run lint`

#### Manual Verification:
- [ ] Multi-agent mention creates separate tasks
- [ ] `swarm#all` creates tasks for all non-lead agents
- [ ] Rate limiting prevents spam
- [ ] Help command shows usage instructions

**Implementation Note**: After completing this phase and all automated verification passes, the Slack integration should be fully functional for manual testing.

---

## Testing Strategy

### Unit Tests

Create `src/slack/router.test.ts`:

```typescript
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { routeMessage, extractTaskFromMessage } from "./router";

// Mock the database
mock.module("../be/db", () => ({
  getAllAgents: () => [
    { id: "1", name: "Alpha Worker", isLead: false, status: "idle" },
    { id: "2", name: "Beta Tester", isLead: false, status: "idle" },
    { id: "3", name: "Lead Agent", isLead: true, status: "idle" },
  ],
  getAgentById: (id: string) => {
    const agents: Record<string, any> = {
      "1": { id: "1", name: "Alpha Worker", isLead: false, status: "idle" },
      "2": { id: "2", name: "Beta Tester", isLead: false, status: "idle" },
      "3": { id: "3", name: "Lead Agent", isLead: true, status: "idle" },
    };
    return agents[id] || null;
  },
}));

describe("routeMessage", () => {
  test("matches agent by partial name", () => {
    const matches = routeMessage("Hey Alpha, can you help?", "BOT123", false);
    expect(matches).toHaveLength(1);
    expect(matches[0].agent.name).toBe("Alpha Worker");
  });

  test("routes to lead when only bot mentioned", () => {
    const matches = routeMessage("<@BOT123> help", "BOT123", true);
    expect(matches).toHaveLength(1);
    expect(matches[0].agent.isLead).toBe(true);
  });

  test("handles swarm#all broadcast", () => {
    const matches = routeMessage("swarm#all status check", "BOT123", false);
    expect(matches).toHaveLength(2); // All non-lead agents
  });
});

describe("extractTaskFromMessage", () => {
  test("removes bot mention", () => {
    const task = extractTaskFromMessage("<@BOT123> please review this", "BOT123");
    expect(task).toBe("please review this");
  });
});
```

### Integration Tests

Manual testing checklist:

1. **Bot Connection**
   - Start server with valid Slack tokens
   - Verify bot shows as online in Slack

2. **Task Creation**
   - Send message: "Alpha, please check the logs"
   - Verify task appears in dashboard with source: "slack"
   - Verify confirmation message in Slack

3. **Task Completion**
   - Complete task via MCP/dashboard
   - Verify completion message appears in Slack thread
   - Verify message shows agent's name

4. **Error Handling**
   - Message busy agent - verify error response
   - Invalid agent name - verify no task created
   - Missing task description - verify error response

5. **Commands**
   - `/agent-swarm-status` - verify agent list
   - `/agent-swarm-help` - verify help text

## Performance Considerations

1. **Task Watcher Interval**: Default 5 seconds. Increase for high-volume deployments.
2. **Rate Limiting**: 10 requests/minute per user. Adjust based on team size.
3. **Memory**: Notified task tracking uses in-memory Set. For long-running instances, consider periodic cleanup or DB column.

## Migration Notes

### Database Migration

The schema changes add new columns with defaults, so existing data is preserved:
- `source` defaults to `"mcp"` for existing tasks
- `slackChannelId`, `slackThreadTs`, `slackUserId` default to NULL

No manual migration needed - SQLite `ALTER TABLE` is handled by the schema update.

### Environment Variables

Add to deployment configuration:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Bot will gracefully disable if tokens are missing.

## References

- Research document: `thoughts/shared/research/2025-12-18-slack-integration.md`
- Slack manifest: `slack-manifest.json`
- HTTP server: `src/http.ts`
- Database layer: `src/be/db.ts`
- Types: `src/types.ts`
- Task creation: `src/tools/send-task.ts`
- Slack Bolt docs: https://slack.dev/bolt-js/
