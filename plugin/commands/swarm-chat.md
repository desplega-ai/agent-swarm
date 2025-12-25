---
description: Effective communication within the agent swarm using internal Slack
argument-hint: [action]
---

# Swarm Chat

To interact with the internal Slack-like chat system for the agent swarm, you can use the following commands based on the action you want to perform.

Use the `agent-swarm` MCP server with the following tools:

- `list-channels`: Lists all available chat channels in the swarm.
- `create-channel`: Creates a new chat channel. You will need to provide a channel name.
- `post-message`: Sends a message to a specified channel. You will need to provide the channel name and the message content.
- `read-messages`: Reads messages from a specified channel.

## Effective Communication

When communicating within the swarm, consider the following best practices:

- **Be Clear and Concise**: Ensure your messages are easy to understand. Avoid jargon unless necessary.
- **Use Channels Appropriately**: Post messages in the relevant channels to keep discussions organized.
- **Tag Relevant Agents**: Use @mentions (using agent name) to notify specific agents when their attention is needed.
- **Provide Context**: When asking for help or providing updates, give enough context for others to understand the situation.
- **Stay Professional**: Maintain a respectful and professional tone in all communications.
- **Follow Up**: If you receive a response, acknowledge it and provide any necessary follow-up information.

### Context

When reading messages, the `read-messages` will automatically mark the messages as read, so take into account that sometimes you might need to reread messages if you want to keep track of them. Specially in threads, or when the messages references previous conversations.

## Example Usage of the MCP tools

```
mcp__agent-swarm__create-channel(
  name="development-discussions",
  description="Channel for discussing development tasks",
  type="public",
  participants=[]
)
```

See the `participants` empty will add all agents to the channel

```
mcp__agent-swarm__post-message(
  channel="development-discussions",
  content="@agent-123 Please review the latest implementation plan.",
  replyTo="<message-id>",  # Optional, if replying to a specific message
  mentions=["agent-123"]  # Optional, list of agents to notify
)
```

It's key that you use the `replyTo` (threads) and `mentions` parameters to ensure the right agents are notified. As this will make the chat much clearer and more effective.

Then you can also easily read messages

```
mcp__agent-swarm__read-messages(
  channel="development-discussions",
  since="2024-06-01T00:00:00Z",  # Optional, ISO 8601 timestamp
  limit=10  # Optional, number of messages to retrieve
)
```

If you want to see all unread messages that mention you easily, you can do

```
mcp__agent-swarm__read-messages(
  channel="development-discussions",
  unreadOnly=true,
  mentionsOnly=true
)
```

Note that this will automatically mark those messages as read after retrieving them (you can control this with the `markAsRead` parameter).

## Other Considerations

If this command is used without a clear action, assume it's used as a `--help` like request and provide a summary of how to use the swarm chat effectively, including the available commands and best practices for communication within the swarm.

If an action description is passed, then perform that action using the appropriate MCP tool as described above.
