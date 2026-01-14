---
date: 2026-01-14
author: Claude
status: draft
tags: [slack, lead-agent, thread-context, inbox-messages, mcp-tools]
related_research: thoughts/shared/research/2026-01-14-lead-slack-thread-context.md
---

# Fix Slack Thread Context for Lead Agent

## Overview

The lead agent cannot properly follow up on Slack messages because:
1. The prompt only shows a 100-character truncated preview, which cuts off the actual message when thread context is prepended
2. There is no MCP tool for the agent to read full inbox message content
3. The message format doesn't clearly distinguish thread history from the new message

This plan implements three changes:
1. Remove the 100-character truncation in prompt formatting
2. Create a new `get-inbox-message` MCP tool
3. Restructure message storage to clearly separate thread context from new message

## Current State Analysis

### How Messages Are Currently Stored

When a Slack message arrives, `handlers.ts` concatenates thread context with the new message:

```typescript
// src/slack/handlers.ts:221
const fullTaskDescription = threadContext + taskDescription;
```

Where `threadContext` is formatted as:
```
<thread_context>
John Doe: Can you help me with this bug?
[Agent]: I'll look into that...
</thread_context>

```

And `taskDescription` is the new message content (e.g., "Any update?").

The resulting `content` stored in `inbox_messages` is:
```
<thread_context>
John Doe: Can you help me with this bug?
[Agent]: I'll look into that...
</thread_context>

Any update?
```

### How Messages Are Currently Presented

In `runner.ts:372`, the content is truncated to 100 characters:
```typescript
const preview = m.content.length > 100 ? `${m.content.slice(0, 100)}...` : m.content;
```

This means the agent sees:
```
- "<thread_context>
John Doe: Can you help me with this bug?
[Agent]: I'll..." (inboxMessageId: abc-123)
```

The actual new message ("Any update?") is never shown.

### Key Discoveries

- `src/commands/runner.ts:372` - 100-char truncation
- `src/slack/handlers.ts:221` - Thread context prepended to message
- `src/slack/handlers.ts:85` - Thread context wrapped in `<thread_context>` tags
- `src/be/db.ts:2610` - `getInboxMessageById()` retrieves full message
- `src/types.ts:26-48` - `InboxMessage` schema with all Slack fields
- `src/server.ts:73-75` - Where Slack tools are registered

## Desired End State

After implementation:
1. The lead agent receives a clear prompt showing:
   - The new message content (what they need to respond to)
   - Thread context separately labeled
2. A `get-inbox-message` tool allows reading full message details
3. The agent can easily understand what message triggered the inbox entry

**Verification**:
- Send a Slack message in a thread to the lead agent
- Verify the prompt shows the new message prominently with thread context below
- Verify the `get-inbox-message` tool returns full message details

## What We're NOT Doing

- NOT changing how messages are stored in the database
- NOT modifying the Slack webhook handlers
- NOT changing how thread context is fetched from Slack
- NOT adding new database columns
- NOT modifying the `slack-reply` or `inbox-delegate` tools

## Implementation Approach

We'll make changes in three phases:
1. **Phase 1**: Restructure how inbox messages store content (separate new message from context)
2. **Phase 2**: Update runner prompt formatting to show full content clearly
3. **Phase 3**: Create `get-inbox-message` MCP tool

---

## Phase 1: Restructure Inbox Message Content Storage

### Overview

Change how `handlers.ts` stores inbox messages to clearly separate the new message from thread context, so we can present them differently in the prompt.

### Changes Required

#### 1. Update Slack Handlers to Store Structured Content

**File**: `src/slack/handlers.ts`

**Current code** (lines 213-245):
```typescript
const threadContext = await getThreadContext(
  client,
  msg.channel,
  msg.thread_ts,
  msg.ts,
  botUserId,
);
const fullTaskDescription = threadContext + taskDescription;
// ...
createInboxMessage(agent.id, fullTaskDescription, {
  source: "slack",
  slackChannelId: msg.channel,
  slackThreadTs: threadTs,
  slackUserId: msg.user,
  matchedText: match.matchedText,
});
```

**New approach**: Store the new message as `content` and thread context separately in a new format:

```typescript
const threadContext = await getThreadContext(
  client,
  msg.channel,
  msg.thread_ts,
  msg.ts,
  botUserId,
);

// Structure the content with clear separation
const structuredContent = threadContext
  ? `<new_message>\n${taskDescription}\n</new_message>\n\n<thread_history>\n${threadContext}\n</thread_history>`
  : taskDescription;

createInboxMessage(agent.id, structuredContent, {
  source: "slack",
  slackChannelId: msg.channel,
  slackThreadTs: threadTs,
  slackUserId: msg.user,
  matchedText: match.matchedText,
});
```

#### 2. Update getThreadContext to Return Raw Content

**File**: `src/slack/handlers.ts`

Change `getThreadContext` to return just the formatted messages without the `<thread_context>` wrapper (we'll wrap differently):

**Current** (line 85):
```typescript
return `<thread_context>\n${formattedMessages.join("\n")}\n</thread_context>\n\n`;
```

**New**:
```typescript
return formattedMessages.join("\n");
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Tests pass: `bun test`
- [x] Linting passes: `bun run lint`

#### Manual Verification:
- [ ] Send a Slack message in a thread to the lead agent
- [ ] Check database to verify `content` field has structured format with `<new_message>` and `<thread_history>` tags

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the database storage looks correct before proceeding to Phase 2.

---

## Phase 2: Update Runner Prompt Formatting

### Overview

Modify `buildPromptForTrigger` to show full message content with clear structure instead of truncated preview.

### Changes Required

#### 1. Update Trigger Prompt Formatting

**File**: `src/commands/runner.ts`

**Current code** (lines 368-382):
```typescript
case "slack_inbox_message": {
  // Lead: Slack inbox messages from users
  const inboxSummaries = (trigger.messages || [])
    .map((m: { id: string; content: string }) => {
      const preview = m.content.length > 100 ? `${m.content.slice(0, 100)}...` : m.content;
      return `- "${preview}" (inboxMessageId: ${m.id})`;
    })
    .join("\n");

  return `You have ${trigger.count} inbox message(s) from Slack:\n${inboxSummaries}\n\nFor each message, you can either:
- Use \`slack-reply\` with the inboxMessageId to respond directly to the user
- Use \`inbox-delegate\` to assign the request to a worker agent

Review each message and decide the appropriate action.`;
}
```

**New code**:
```typescript
case "slack_inbox_message": {
  // Lead: Slack inbox messages from users
  const inboxDetails = (trigger.messages || [])
    .map((m: { id: string; content: string }, index: number) => {
      // Parse structured content if present
      const newMessageMatch = m.content.match(/<new_message>\n([\s\S]*?)\n<\/new_message>/);
      const threadHistoryMatch = m.content.match(/<thread_history>\n([\s\S]*?)\n<\/thread_history>/);

      const newMessage = newMessageMatch ? newMessageMatch[1] : m.content;
      const threadHistory = threadHistoryMatch ? threadHistoryMatch[1] : null;

      let formatted = `### Message ${index + 1} (inboxMessageId: ${m.id})\n`;
      formatted += `**New Message:**\n${newMessage}\n`;

      if (threadHistory) {
        formatted += `\n**Thread History:**\n${threadHistory}\n`;
      }

      return formatted;
    })
    .join("\n---\n\n");

  return `You have ${trigger.count} inbox message(s) from Slack:\n\n${inboxDetails}\n\nFor each message, you can either:
- Use \`slack-reply\` with the inboxMessageId to respond directly to the user
- Use \`inbox-delegate\` to assign the request to a worker agent

Review each message and decide the appropriate action.`;
}
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Tests pass: `bun test`
- [x] Linting passes: `bun run lint`

#### Manual Verification:
- [ ] Send a Slack message in a thread to the lead agent
- [ ] Verify the prompt shows the new message clearly labeled
- [ ] Verify thread history is shown separately below
- [ ] Verify no truncation occurs

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the prompt format is clear and usable before proceeding to Phase 3.

---

## Phase 3: Create get-inbox-message MCP Tool

### Overview

Create a new MCP tool that allows lead agents to read full details of inbox messages.

### Changes Required

#### 1. Create the Tool File

**File**: `src/tools/get-inbox-message.ts` (new file)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getInboxMessageById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { InboxMessageSchema } from "@/types";

export const registerGetInboxMessageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-inbox-message",
    {
      title: "Get inbox message details",
      description:
        "Returns detailed information about a specific inbox message, including full content and Slack context. Only accessible to the lead agent who owns the message.",
      inputSchema: z.object({
        inboxMessageId: z.uuid().describe("The ID of the inbox message to retrieve."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        inboxMessage: InboxMessageSchema.optional(),
      }),
    },
    async ({ inboxMessageId }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Agent ID not found.",
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: "Agent not found in swarm." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Agent not found in swarm.",
          },
        };
      }

      const inboxMsg = getInboxMessageById(inboxMessageId);

      if (!inboxMsg) {
        return {
          content: [{ type: "text", text: `Inbox message with ID "${inboxMessageId}" not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Inbox message with ID "${inboxMessageId}" not found.`,
          },
        };
      }

      // Verify ownership - only the assigned lead can read their inbox
      if (inboxMsg.agentId !== requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "This inbox message belongs to another agent." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "This inbox message belongs to another agent.",
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Inbox message "${inboxMessageId}" retrieved.\n\nContent:\n${inboxMsg.content}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Inbox message "${inboxMessageId}" retrieved.`,
          inboxMessage: inboxMsg,
        },
      };
    },
  );
};
```

#### 2. Register the Tool in Server

**File**: `src/server.ts`

Add import at line 9 (with other lead inbox tools):
```typescript
import { registerGetInboxMessageTool } from "./tools/get-inbox-message";
```

Register after `registerInboxDelegateTool` at line 75:
```typescript
registerGetInboxMessageTool(server);
```

#### 3. Update Base Prompt with Tool Documentation

**File**: `src/prompts/base-prompt.ts`

Update the Slack Inbox section (around line 20-24):
```typescript
#### Slack Inbox
When Slack messages are routed to you, they appear as "inbox messages" - NOT tasks.
Each inbox message shows the new message to respond to, with any thread history for context.

Available tools:
- \`get-inbox-message\`: Read full details of an inbox message (content, Slack context, status)
- \`slack-reply\`: Reply directly to the user in the Slack thread
- \`inbox-delegate\`: Create a task for a worker agent (preserves Slack context for replies)
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Tests pass: `bun test`
- [x] Linting passes: `bun run lint`
- [x] Tool appears in MCP tool list (registered in server.ts:77)

#### Manual Verification:
- [ ] Lead agent can call `get-inbox-message` with a valid ID
- [ ] Tool returns full message content and Slack context
- [ ] Tool rejects requests from agents who don't own the message
- [ ] Tool returns appropriate error for non-existent message IDs

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the tool works correctly.

---

## Testing Strategy

### Unit Tests

Add tests for the new `get-inbox-message` tool:

**File**: `src/tests/get-inbox-message.test.ts`

```typescript
import { describe, test, expect, beforeAll } from "bun:test";
import { initDb, createInboxMessage, getInboxMessageById } from "@/be/db";

describe("get-inbox-message tool", () => {
  beforeAll(() => {
    initDb(":memory:");
  });

  test("creates inbox message with structured content", () => {
    const agentId = crypto.randomUUID();
    const content = `<new_message>\nAny update?\n</new_message>\n\n<thread_history>\nJohn: Help with bug\n</thread_history>`;

    const msg = createInboxMessage(agentId, content, {
      source: "slack",
      slackChannelId: "C123",
      slackThreadTs: "1234.5678",
    });

    expect(msg.content).toBe(content);
    expect(msg.slackChannelId).toBe("C123");
  });

  test("retrieves inbox message by ID", () => {
    const agentId = crypto.randomUUID();
    const msg = createInboxMessage(agentId, "Test message", { source: "slack" });

    const retrieved = getInboxMessageById(msg.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.content).toBe("Test message");
  });
});
```

### Integration Tests

1. Send Slack message in new thread → verify no thread history
2. Send Slack message in existing thread → verify thread history present
3. Call `get-inbox-message` → verify full content returned
4. Call `slack-reply` → verify reply appears in Slack thread

### Manual Testing Steps

1. Start a lead agent
2. Send a Slack message mentioning the swarm bot in a channel
3. Verify the lead receives the message with clear "New Message" section
4. Reply in the thread
5. Send another message in the same thread
6. Verify the lead receives it with both new message and thread history clearly separated
7. Use `get-inbox-message` tool to retrieve full details
8. Use `slack-reply` to respond

## Performance Considerations

- No performance impact expected - changes are to formatting only
- The `get-inbox-message` tool is a simple database lookup (indexed by UUID)
- Thread history is already fetched at message receive time (no additional Slack API calls)

## Migration Notes

- No database migration needed - using existing columns
- Backward compatibility: The new structured format includes the full content, so existing logic that reads `content` will still work
- Messages created before this change will display without the structured format (just raw content)

## References

- Related research: `thoughts/shared/research/2026-01-14-lead-slack-thread-context.md`
- Similar tool: `src/tools/get-task-details.ts:1-52`
- Message creation: `src/slack/handlers.ts:238-247`
- Prompt formatting: `src/commands/runner.ts:368-382`
