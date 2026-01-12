# Lead Agent Inbox Model Implementation Plan

## Overview

Modify the agent swarm so that the lead agent focuses exclusively on **delegation and answering questions**, rather than performing tasks. When Slack messages are routed to the lead, they become **inbox messages** (not tasks), which the lead can respond to directly or delegate to workers.

## Current State Analysis

### Current Behavior (Problems)
1. **Slack messages to lead create tasks** - In `src/slack/handlers.ts:231`, `createTask()` is called for ALL matched agents including leads
2. **Lead prompt mentions `poll-task`** - In `src/prompts/base-prompt.ts:29`, the lead is told it can use poll-task to claim work
3. **Lead receives `task_assigned` triggers** - In `src/http.ts:314-322`, leads can get task assignment triggers like workers
4. **No inbox concept exists** - There's no separate mechanism for lead to receive messages without them becoming tasks

### Key Discoveries
- `send-task` already blocks direct task assignment to leads (`src/tools/send-task.ts:112-117`)
- Slack responses already work with agent personas (`src/slack/responses.ts`)
- The tool pattern uses `createToolRegistrar()` from `src/tools/utils.ts`
- Leads get triggers via polling in `src/http.ts:325-349`

## Desired End State

After this plan is complete:
1. Slack messages routed to the lead create **inbox messages** (not tasks)
2. Lead polling returns `slack_inbox_message` trigger for unread inbox items
3. Lead can use `slack-reply` tool to respond directly to Slack threads
4. Lead can use `inbox-delegate` tool to create tasks for workers from inbox items
5. Lead prompt no longer mentions `poll-task` and emphasizes delegation/answering
6. Workers continue to receive Slack-originated tasks normally (no change)

### Verification
- Send `@agent-swarm help me with X` in Slack
- Verify no task is created in `agent_tasks` table
- Verify inbox message is created in new `inbox_messages` table
- Poll as lead, verify `slack_inbox_message` trigger
- Use `slack-reply` tool, verify message appears in Slack thread
- Use `inbox-delegate` tool, verify task created for worker with Slack context

## What We're NOT Doing

- Changing worker behavior (workers still get tasks from Slack)
- Adding interactive Slack components (buttons, modals)
- OAuth flow for multi-workspace support
- Changing the internal swarm chat/channel messaging system

## Implementation Approach

We'll add a new `inbox_messages` table and two new tools (`slack-reply`, `inbox-delegate`), modify the Slack handler to route lead messages to inbox, and update lead polling/prompts.

---

## Phase 1: Database Schema and Types

### Overview
Add the `inbox_messages` table and TypeScript types for the lead's inbox.

### Changes Required

#### 1. Add InboxMessage Type
**File**: `src/types.ts`
**Changes**: Add new schema and type for inbox messages

```typescript
// After line 54 (after AgentTaskSchema)

export const InboxMessageStatusSchema = z.enum([
  "unread",
  "read",
  "responded",
  "delegated",
]);

export const InboxMessageSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),                           // Lead agent who received this
  content: z.string().min(1),                  // The message content
  source: z.enum(["slack"]).default("slack"),
  status: InboxMessageStatusSchema.default("unread"),

  // Slack context (for replying)
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),

  // Routing info
  matchedText: z.string().optional(),          // Why it was routed here

  // Delegation tracking
  delegatedToTaskId: z.uuid().optional(),      // If delegated, which task
  responseText: z.string().optional(),         // If responded directly

  // Timestamps
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
});

export type InboxMessageStatus = z.infer<typeof InboxMessageStatusSchema>;
export type InboxMessage = z.infer<typeof InboxMessageSchema>;
```

#### 2. Add Database Table and Functions
**File**: `src/be/db.ts`
**Changes**: Add table creation in `initDb()` and CRUD functions

Add table in schema initialization (inside the `initSchema` transaction, after `session_logs`):

```typescript
database.run(`
  CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'slack',
    status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'read', 'responded', 'delegated')),
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

// Add index
database.run(`CREATE INDEX IF NOT EXISTS idx_inbox_messages_agentId ON inbox_messages(agentId)`);
database.run(`CREATE INDEX IF NOT EXISTS idx_inbox_messages_status ON inbox_messages(status)`);
```

Add CRUD functions after the session log section:

```typescript
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
  source?: "slack";
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
      "UPDATE inbox_messages SET status = 'responded', responseText = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(responseText, now, id);
  return row ? rowToInboxMessage(row) : null;
}

export function markInboxMessageDelegated(id: string, taskId: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string, string]>(
      "UPDATE inbox_messages SET status = 'delegated', delegatedToTaskId = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(taskId, now, id);
  return row ? rowToInboxMessage(row) : null;
}
```

### Success Criteria

#### Automated Verification
- [x] `bun test` passes (no regressions)
- [x] Server starts without errors: `bun run src/http.ts`
- [x] Table is created in SQLite database

#### Manual Verification
- [x] Can manually insert/query inbox_messages via SQLite CLI

---

## Phase 2: Slack Handler for Lead Routing

### Overview
Modify the Slack message handler to create inbox messages instead of tasks when routing to the lead.

### Changes Required

#### 1. Update Slack Handler
**File**: `src/slack/handlers.ts`
**Changes**: Import inbox functions and modify the task creation loop

Add import at top:
```typescript
import { createTask, getAgentById, getTasksByAgentId, createInboxMessage } from "../be/db";
```

Modify the loop starting at line 222:

```typescript
for (const match of matches) {
  const agent = getAgentById(match.agent.id);

  if (!agent) {
    results.failed.push(`\`${match.agent.name}\` (not found)`);
    continue;
  }

  try {
    // NEW: Check if this is a lead agent
    if (agent.isLead) {
      // Create inbox message instead of task
      const inboxMsg = createInboxMessage(agent.id, fullTaskDescription, {
        source: "slack",
        slackChannelId: msg.channel,
        slackThreadTs: threadTs,
        slackUserId: msg.user,
        matchedText: match.matchedText,
      });
      results.assigned.push(`*${agent.name}* (inbox)`);
      continue;
    }

    // Existing task creation for workers (unchanged)
    const task = createTask(agent.id, fullTaskDescription, {
      source: "slack",
      slackChannelId: msg.channel,
      slackThreadTs: threadTs,
      slackUserId: msg.user,
    });

    // ... rest of existing logic
  } catch {
    results.failed.push(`\`${agent.name}\` (error)`);
  }
}
```

### Success Criteria

#### Automated Verification
- [x] `bun test` passes
- [x] TypeScript compiles without errors

#### Manual Verification
- [ ] Send `@agent-swarm help` in Slack (routes to lead)
- [ ] Verify NO task appears in `agent_tasks` table
- [ ] Verify inbox message appears in `inbox_messages` table

---

## Phase 3: Lead Polling Trigger

### Overview
Add the `slack_inbox_message` trigger type to lead polling so the lead wakes up when inbox messages arrive.

### Changes Required

#### 1. Update HTTP Polling
**File**: `src/http.ts`
**Changes**: Add inbox check in lead-specific triggers section

Add import:
```typescript
import {
  // ... existing imports ...
  getUnreadInboxMessages,
} from "./be/db";
```

Modify the lead triggers section (around line 325):

```typescript
if (agent.isLead) {
  // === LEAD-SPECIFIC TRIGGERS ===

  // NEW: Check for unread inbox messages (highest priority for lead)
  const unreadInbox = getUnreadInboxMessages(myAgentId);
  if (unreadInbox.length > 0) {
    return {
      trigger: {
        type: "slack_inbox_message",
        count: unreadInbox.length,
        messages: unreadInbox.slice(0, 5), // Return up to 5 most recent
      },
    };
  }

  // Existing: Check for unread mentions (internal chat)
  const inbox = getInboxSummary(myAgentId);
  // ... rest of existing code
}
```

#### 2. Update Runner Trigger Prompt
**File**: `src/commands/runner.ts`
**Changes**: Add case for `slack_inbox_message` in `buildPromptForTrigger()`

Add new case in the switch statement (around line 280):

```typescript
case "slack_inbox_message":
  // Format inbox message summaries
  const inboxSummaries = trigger.messages
    .map((m: { id: string; content: string }) => {
      const preview = m.content.length > 100 ? `${m.content.slice(0, 100)}...` : m.content;
      return `- "${preview}" (ID: ${m.id.slice(0, 8)})`;
    })
    .join("\n");

  return `You have ${trigger.count} inbox message(s) from Slack:\n${inboxSummaries}\n\nFor each message, you can either:
- Use \`slack-reply\` with the inboxMessageId to respond directly to the user
- Use \`inbox-delegate\` to assign the request to a worker agent

Review each message and decide the appropriate action.`;
```

### Success Criteria

#### Automated Verification
- [x] `bun test` passes
- [x] TypeScript compiles without errors

#### Manual Verification
- [ ] Poll as lead agent via HTTP API
- [ ] Verify `slack_inbox_message` trigger is returned when inbox has unread items

---

## Phase 4: Slack Reply Tool

### Overview
Create a new tool that allows agents (primarily lead) to reply directly to Slack threads.

### Changes Required

#### 1. Create slack-reply Tool
**File**: `src/tools/slack-reply.ts` (NEW FILE)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getAgentById,
  getInboxMessageById,
  getTaskById,
  markInboxMessageResponded,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { getSlackApp } from "@/slack/app";

export const registerSlackReplyTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-reply",
    {
      title: "Reply to Slack thread",
      description:
        "Send a reply to a Slack thread. Use inboxMessageId for inbox messages, or taskId for task-related threads.",
      inputSchema: z.object({
        inboxMessageId: z
          .uuid()
          .optional()
          .describe("The inbox message ID to reply to (for leads responding to inbox)."),
        taskId: z
          .uuid()
          .optional()
          .describe("The task ID with Slack context (for task-related threads)."),
        message: z
          .string()
          .min(1)
          .max(4000)
          .describe("The message to send to the Slack thread."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ inboxMessageId, taskId, message }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: { success: false, message: "Agent not found." },
        };
      }

      let slackChannelId: string | undefined;
      let slackThreadTs: string | undefined;

      // Determine Slack context from inbox message or task
      if (inboxMessageId) {
        const inboxMsg = getInboxMessageById(inboxMessageId);
        if (!inboxMsg) {
          return {
            content: [{ type: "text", text: "Inbox message not found." }],
            structuredContent: { success: false, message: "Inbox message not found." },
          };
        }
        if (inboxMsg.agentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "This inbox message is not yours." }],
            structuredContent: { success: false, message: "This inbox message is not yours." },
          };
        }
        slackChannelId = inboxMsg.slackChannelId;
        slackThreadTs = inboxMsg.slackThreadTs;

        // Mark as responded
        markInboxMessageResponded(inboxMessageId, message);
      } else if (taskId) {
        const task = getTaskById(taskId);
        if (!task) {
          return {
            content: [{ type: "text", text: "Task not found." }],
            structuredContent: { success: false, message: "Task not found." },
          };
        }
        // Verify agent has context for this task
        if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "You don't have context for this task." }],
            structuredContent: { success: false, message: "You don't have context for this task." },
          };
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = task.slackThreadTs;
      } else {
        return {
          content: [{ type: "text", text: "Must provide inboxMessageId or taskId." }],
          structuredContent: { success: false, message: "Must provide inboxMessageId or taskId." },
        };
      }

      if (!slackChannelId || !slackThreadTs) {
        return {
          content: [{ type: "text", text: "No Slack context available." }],
          structuredContent: { success: false, message: "No Slack context available." },
        };
      }

      // Send the reply
      const app = getSlackApp();
      if (!app) {
        return {
          content: [{ type: "text", text: "Slack not configured." }],
          structuredContent: { success: false, message: "Slack not configured." },
        };
      }

      try {
        await app.client.chat.postMessage({
          channel: slackChannelId,
          thread_ts: slackThreadTs,
          text: message,
          username: agent.name,
          icon_emoji: agent.isLead ? ":crown:" : ":robot_face:",
        });

        return {
          content: [{ type: "text", text: "Reply sent successfully." }],
          structuredContent: { success: true, message: "Reply sent successfully." },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to send reply: ${error}` }],
          structuredContent: { success: false, message: `Failed to send reply: ${error}` },
        };
      }
    },
  );
};
```

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles without errors
- [x] `bun test` passes

#### Manual Verification
- [ ] Lead can use `slack-reply` with inboxMessageId
- [ ] Message appears in Slack thread with lead's persona

---

## Phase 5: Inbox Delegate Tool

### Overview
Create a tool for leads to delegate inbox messages to workers by creating tasks.

### Changes Required

#### 1. Create inbox-delegate Tool
**File**: `src/tools/inbox-delegate.ts` (NEW FILE)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getAgentById,
  getInboxMessageById,
  markInboxMessageDelegated,
  createTaskExtended,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

export const registerInboxDelegateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "inbox-delegate",
    {
      title: "Delegate inbox message to worker",
      description:
        "Delegate an inbox message to a worker agent by creating a task. The task inherits Slack context for replies.",
      inputSchema: z.object({
        inboxMessageId: z.uuid().describe("The inbox message ID to delegate."),
        agentId: z.uuid().describe("The worker agent to delegate to."),
        taskDescription: z
          .string()
          .min(1)
          .optional()
          .describe("Custom task description. If omitted, uses the original message."),
        offerMode: z
          .boolean()
          .default(false)
          .describe("If true, offer the task instead of direct assign."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async ({ inboxMessageId, agentId, taskDescription, offerMode }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      const leadAgent = getAgentById(requestInfo.agentId);
      if (!leadAgent || !leadAgent.isLead) {
        return {
          content: [{ type: "text", text: "Only leads can delegate inbox messages." }],
          structuredContent: { success: false, message: "Only leads can delegate inbox messages." },
        };
      }

      const inboxMsg = getInboxMessageById(inboxMessageId);
      if (!inboxMsg) {
        return {
          content: [{ type: "text", text: "Inbox message not found." }],
          structuredContent: { success: false, message: "Inbox message not found." },
        };
      }

      if (inboxMsg.agentId !== requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "This inbox message is not yours." }],
          structuredContent: { success: false, message: "This inbox message is not yours." },
        };
      }

      const targetAgent = getAgentById(agentId);
      if (!targetAgent) {
        return {
          content: [{ type: "text", text: "Target agent not found." }],
          structuredContent: { success: false, message: "Target agent not found." },
        };
      }

      if (targetAgent.isLead) {
        return {
          content: [{ type: "text", text: "Cannot delegate to another lead." }],
          structuredContent: { success: false, message: "Cannot delegate to another lead." },
        };
      }

      // Create task for the worker
      const task = createTaskExtended(taskDescription || inboxMsg.content, {
        agentId: offerMode ? undefined : agentId,
        offeredTo: offerMode ? agentId : undefined,
        creatorAgentId: requestInfo.agentId,
        source: "slack",
        slackChannelId: inboxMsg.slackChannelId,
        slackThreadTs: inboxMsg.slackThreadTs,
        slackUserId: inboxMsg.slackUserId,
      });

      // Mark inbox as delegated
      markInboxMessageDelegated(inboxMessageId, task.id);

      return {
        content: [
          {
            type: "text",
            text: `Delegated to ${targetAgent.name}. Task ID: ${task.id.slice(0, 8)}`,
          },
        ],
        structuredContent: {
          success: true,
          message: `Task created and ${offerMode ? "offered to" : "assigned to"} ${targetAgent.name}.`,
          task,
        },
      };
    },
  );
};
```

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles without errors
- [x] `bun test` passes

#### Manual Verification
- [ ] Lead can use `inbox-delegate` to create task for worker
- [ ] Task has Slack context preserved
- [ ] Worker completion sends response to original Slack thread

---

## Phase 6: Tool Registration and Prompts

### Overview
Register the new tools and update the lead prompt to emphasize delegation and answering.

### Changes Required

#### 1. Register New Tools
**File**: `src/server.ts`
**Changes**: Import and register slack-reply and inbox-delegate

Add imports:
```typescript
import { registerSlackReplyTool } from "./tools/slack-reply";
import { registerInboxDelegateTool } from "./tools/inbox-delegate";
```

Add registration after line 68 (after registerMyAgentInfoTool):
```typescript
// Slack integration tools (always registered, will no-op if Slack not configured)
registerSlackReplyTool(server);
registerInboxDelegateTool(server);
```

#### 2. Update Lead Prompt
**File**: `src/prompts/base-prompt.ts`
**Changes**: Replace `BASE_PROMPT_LEAD` constant

```typescript
const BASE_PROMPT_LEAD = `
As the lead agent, you are responsible for coordinating the activities of all worker agents in the swarm.

**IMPORTANT:** You do NOT perform worker tasks yourself. Your role is to:
1. Answer questions directly when you have the knowledge
2. Delegate tasks to appropriate workers
3. Monitor progress and ensure the swarm operates efficiently
4. Resolve conflicts and provide guidance

#### Slack Inbox
When Slack messages are routed to you, they appear as "inbox messages" - NOT tasks.
- Use \`slack-reply\` with the inboxMessageId to respond directly to the user
- Use \`inbox-delegate\` with the inboxMessageId and agentId to create a task for a worker

#### General monitor and control tools

- get-swarm: To get the list of all workers in the swarm along with their status.
- get-tasks: To get the list of all tasks assigned to workers.
- get-task-details: To get detailed information about a specific task.

#### Task delegation tools

- send-task: Assign a new task to a specific worker, or to the general pool.
- inbox-delegate: Delegate an inbox message to a worker (creates task with Slack context).
- slack-reply: Respond directly to a Slack thread.
- task-action: Manage tasks (accept, reject, etc.) - note: you should rarely need this.
- store-progress: Useful to track your own coordination notes or fix task issues.
`;
```

### Success Criteria

#### Automated Verification
- [x] `bun test` passes
- [x] TypeScript compiles without errors
- [x] Server starts: `bun run src/http.ts`

#### Manual Verification
- [ ] Lead agent receives updated prompt with inbox instructions

---

## Phase 7: Block Lead from poll-task (Optional Enhancement)

### Overview
Optionally restrict the `poll-task` tool to prevent leads from claiming tasks.

### Changes Required

#### 1. Add Lead Check to poll-task
**File**: `src/tools/poll-task.ts`
**Changes**: Add early return if agent is lead

Add at the start of the handler (after getting requestInfo):

```typescript
// Check if lead is trying to poll
const agent = getAgentById(requestInfo.agentId);
if (agent?.isLead) {
  return {
    content: [
      {
        type: "text",
        text: "Lead agents should not poll for tasks. Use inbox tools to respond to Slack messages, or get-tasks to monitor workers.",
      },
    ],
    structuredContent: {
      success: false,
      message: "Lead agents use inbox and delegation tools instead of polling for tasks.",
      offeredTasks: [],
      availableCount: 0,
      waitedForSeconds: 0,
    },
  };
}
```

### Success Criteria

#### Automated Verification
- [x] `bun test` passes

#### Manual Verification
- [ ] Lead calling `poll-task` gets helpful error message

---

## Testing Strategy

### Unit Tests
- Test `createInboxMessage`, `getUnreadInboxMessages`, etc.
- Test `slack-reply` tool validation
- Test `inbox-delegate` tool validation

### Integration Tests
- End-to-end: Slack message → inbox → slack-reply → Slack response
- End-to-end: Slack message → inbox → inbox-delegate → worker task → completion → Slack response

### Manual Testing Steps
1. Start MCP server: `bun run src/http.ts`
2. Connect Slack (ensure bot tokens configured)
3. Send `@agent-swarm help me with X` in Slack
4. Verify inbox message created (not task)
5. Poll as lead, verify `slack_inbox_message` trigger
6. Use `slack-reply` tool, verify Slack response
7. Use `inbox-delegate` tool, verify task created
8. Worker completes task, verify Slack thread gets response

## Performance Considerations

- Inbox messages are queried frequently (on every lead poll)
- Added indexes on `agentId` and `status` for efficient lookups
- Limited to 5 messages per poll to avoid large payloads

## Migration Notes

- No data migration needed - new table starts empty
- Existing tasks and Slack flows continue working for workers
- Lead behavior changes immediately on deployment

## References

- Existing Slack integration: `src/slack/handlers.ts`, `src/slack/responses.ts`
- Tool pattern: `src/tools/utils.ts`, `src/tools/send-task.ts`
- Polling logic: `src/http.ts:282-379`
- Lead prompt: `src/prompts/base-prompt.ts:11-30`
