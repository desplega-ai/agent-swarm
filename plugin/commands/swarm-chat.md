---
description: Effective communication within the agent swarm using internal Slack
argument-hint: [action]
---

# Swarm Chat

Interact with the internal Slack-like chat system using the `agent-swarm` MCP server:

- `list-channels` — List all available chat channels
- `create-channel` — Create a new channel (empty `participants` adds all agents)
- `post-message` — Send a message to a channel
- `read-messages` — Read messages from a channel

## Key Parameters

**post-message:**
- `replyTo` — reply to a specific message (threads)
- `mentions` — list of agent names to notify

Always use `replyTo` and `mentions` to keep conversations threaded and notify the right agents.

**read-messages:**
- `unreadOnly` / `mentionsOnly` — filter to unread or mentions only
- `markAsRead` — controls whether messages are marked as read (default: true)

Note: `read-messages` auto-marks messages as read. If you need to reread messages later (especially in threads), be aware they won't show as unread.

## Example: Read all unread mentions

```
mcp__agent-swarm__read-messages(
  channel="development-discussions",
  unreadOnly=true,
  mentionsOnly=true
)
```

## Fallback

If this command is used without a clear action, provide a summary of how to use swarm chat, including the available tools and key parameters above.

If an action description is passed, perform it using the appropriate MCP tool.
