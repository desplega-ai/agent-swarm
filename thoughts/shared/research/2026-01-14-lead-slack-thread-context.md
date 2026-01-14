---
date: 2026-01-14T12:00:00-08:00
researcher: Claude
git_commit: 7ffa4d18b53c5422d59fdf53b00a8bab6f7a12fd
branch: main
repository: agent-swarm
topic: "Lead Agent Slack Thread Context Handling"
tags: [research, slack, lead-agent, thread-context, inbox-messages]
status: complete
last_updated: 2026-01-14
last_updated_by: Claude
---

# Research: Lead Agent Slack Thread Context Handling

**Date**: 2026-01-14T12:00:00-08:00
**Researcher**: Claude
**Git Commit**: 7ffa4d18b53c5422d59fdf53b00a8bab6f7a12fd
**Branch**: main
**Repository**: agent-swarm

## Research Question

Why is the lead agent not properly following up on Slack messages? Specifically:
- Not getting the thread context
- Not able to follow up to previous messages
- Needing to reference all context again and again for it to work

## Summary

The lead agent's difficulty with Slack thread context stems from **how inbox messages are presented to the agent, not how they are stored**. While the system correctly retrieves thread context from Slack (up to 20 messages) and stores it in inbox messages, the agent only sees a 100-character truncated preview in the trigger prompt. Additionally, there is no MCP tool for the agent to read the full inbox message content, and the base prompt does not explain the thread context format.

## Detailed Findings

### Component 1: Thread Context Retrieval (Working Correctly)

**Location**: `src/slack/handlers.ts:45-90`

The `getThreadContext()` function correctly fetches thread history from Slack:

```typescript
const result = await client.conversations.replies({
  channel,
  ts: threadTs,
  limit: 20, // Last 20 messages max
});
```

Thread messages are formatted with user display names or `[Agent]:` prefix for bot messages, and wrapped in XML-style tags:

```
<thread_context>
John Doe: Can you help me with this bug?
[Agent]: I'll look into that. The issue appears to be in the authentication module...
John Doe: Thanks! Any update?
</thread_context>

<actual new message content here>
```

**Key Pattern**: Bot messages are truncated to 500 chars to keep context manageable (`handlers.ts:77`).

---

### Component 2: Inbox Message Storage (Working Correctly)

**Location**: `src/slack/handlers.ts:213-247`

When creating inbox messages for the lead agent, the full task description includes thread context:

```typescript
const fullTaskDescription = threadContext + taskDescription;

createInboxMessage(agent.id, fullTaskDescription, {
  source: "slack",
  slackChannelId: msg.channel,
  slackThreadTs: threadTs,
  slackUserId: msg.user,
  matchedText: match.matchedText,
});
```

The `InboxMessage` record in the database contains:
- `content`: Full message including thread context (unlimited length)
- `slackChannelId`: Channel ID for replies
- `slackThreadTs`: Thread timestamp for replies
- `slackUserId`: User who sent the message

---

### Component 3: Prompt Formatting (Content Truncation)

**Location**: `src/commands/runner.ts:368-382`

When the lead agent receives a `slack_inbox_message` trigger, the content is **truncated to 100 characters**:

```typescript
case "slack_inbox_message": {
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

**Example of what the agent sees**:
```
You have 1 inbox message(s) from Slack:
- "<thread_context>
John Doe: Can you help me with this bug?
[Agent]: I'll..." (inboxMessageId: abc-123)

For each message, you can either:
- Use `slack-reply` with the inboxMessageId to respond directly to the user
- Use `inbox-delegate` to assign the request to a worker agent
```

**Impact**: The 100-character limit means the agent may only see the thread context header and some history, **but not the actual new message** that needs a response.

---

### Component 4: No Tool to Read Full Inbox Content

**Location**: `src/tools/` directory

There is NO MCP tool that allows agents to read the full content of inbox messages. The existing tools:

| Tool | Purpose | Can Read Full Inbox? |
|------|---------|---------------------|
| `slack-reply` | Reply to Slack threads | No - uses inbox internally but doesn't expose content |
| `inbox-delegate` | Delegate to workers | No - uses inbox internally but doesn't expose content |
| `read-messages` | Read internal channel messages | No - different message type |

The full inbox message content is:
- Available internally to `slack-reply` and `inbox-delegate` tools
- Stored in the database (`getInboxMessageById()` at `db.ts:2610`)
- **Not exposed to agents via any MCP tool**

---

### Component 5: Base Prompt Guidance (Minimal)

**Location**: `src/prompts/base-prompt.ts:20-24`

The base prompt provides minimal guidance about Slack:

```
#### Slack Inbox
When Slack messages are routed to you, they appear as "inbox messages" - NOT tasks.
- Use `slack-reply` with the inboxMessageId to respond directly to the user
- Use `inbox-delegate` with the inboxMessageId and agentId to create a task for a worker
```

**What's NOT explained**:
- That thread context is included in messages
- How to interpret `<thread_context>` tags
- That the preview shown might be truncated
- How to access the full message content

---

### Component 6: Thread Follow-Up Routing (Working Correctly)

**Location**: `src/slack/router.ts:139-144`

When a message arrives in a thread, the router checks if an agent is already working on it:

```typescript
if (matches.length === 0 && threadContext) {
  const workingAgent = getAgentWorkingOnThread(threadContext.channelId, threadContext.threadTs);
  if (workingAgent && workingAgent.status !== "offline") {
    matches.push({ agent: workingAgent, matchedText: "thread follow-up" });
  }
}
```

**Location**: `src/be/db.ts:1052-1083`

The `getAgentWorkingOnThread()` function checks:
1. `agent_tasks` table for workers with active tasks in that thread
2. `inbox_messages` table for leads with messages in that thread

---

### Component 7: Hook System Context (Limited)

**Location**: `src/hooks/hook.ts:141-200`

The hook system's "system tray" shows:
- Unread message count
- Mention count
- Task counts

It does NOT show:
- Slack message content
- Thread context
- Message previews

---

## Code References

- `src/slack/handlers.ts:45-90` - Thread context retrieval (`getThreadContext()`)
- `src/slack/handlers.ts:213-247` - Inbox message creation with context
- `src/commands/runner.ts:368-382` - Prompt formatting with 100-char truncation
- `src/tools/slack-reply.ts` - Reply tool (internal inbox access)
- `src/tools/inbox-delegate.ts` - Delegate tool (internal inbox access)
- `src/be/db.ts:2610` - `getInboxMessageById()` database function
- `src/prompts/base-prompt.ts:20-24` - Lead agent Slack instructions
- `src/slack/router.ts:139-144` - Thread follow-up routing

## Architecture Documentation

### Data Flow: Slack Message to Lead Agent

```
1. Slack message arrives
   └─> handlers.ts:147 (message event handler)

2. Thread context fetched
   └─> handlers.ts:213-221 (getThreadContext())
   └─> Returns: "<thread_context>\n...\n</thread_context>\n\n"

3. Full description assembled
   └─> handlers.ts:221: fullTaskDescription = threadContext + taskDescription

4. Inbox message created (lead agents)
   └─> handlers.ts:239-245 (createInboxMessage())
   └─> Stores FULL content in database

5. Agent polls for triggers
   └─> http.ts:400-412 (GET /poll)
   └─> Returns claimed inbox messages with FULL content

6. Runner formats prompt
   └─> runner.ts:368-382 (buildPromptForTrigger)
   └─> TRUNCATES content to 100 chars
   └─> Agent sees partial preview only

7. Agent tries to respond
   └─> Cannot read full message
   └─> No tool available for reading inbox
   └─> Must guess context from truncated preview
```

### Key Observations

1. **Thread context is correctly captured** - The system fetches up to 20 messages with user names
2. **Thread context is correctly stored** - Full content saved in `inbox_messages` table
3. **Thread context is NOT correctly presented** - 100-char truncation cuts off most context
4. **No mechanism to retrieve full content** - Agent has no tool to read the full message
5. **Agent is not told about thread context** - Base prompt doesn't explain the format

## Historical Context (from thoughts/)

- `thoughts/shared/research/2025-12-18-slack-integration.md` - Original Slack integration research
- `thoughts/shared/plans/2026-01-12-lead-inbox-model.md` - Lead inbox model design

## Related Research

- `thoughts/shared/research/2026-01-13-lead-duplicate-trigger-processing.md` - Related trigger handling research

## Open Questions

1. Should the 100-character truncation limit be increased or removed?
2. Should a dedicated `read-inbox-message` MCP tool be created?
3. Should the base prompt explain the `<thread_context>` format?
4. Should follow-up messages in a thread show the previous response instead of full history?
5. Should the thread context be presented differently (e.g., separate from main message)?
