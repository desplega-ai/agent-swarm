# Chat SDK

The swarm receives messages from Telegram, Slack, Discord, and Microsoft Teams through the Chat SDK channel. A person mentions the bot or sends it a direct message, and the swarm creates a task for it. This skill tells you how to work on such a task.

## How you know you are on a chat task

- The task has `source: "chat"`, or it is a lead follow-up of one.
- The task `contextKey` starts with `task:chat-sdk:`. The full form is `task:chat-sdk:<adapter>:<encoded thread id>`, for example `task:chat-sdk:telegram:555001`.
- The task text holds the user's message. Later replies in the same thread arrive as follow-up tasks with the same `contextKey`, or as steering messages on your running task.
- The user has four slash commands that never reach you as a task: `/help`, `/status`, `/cancel` and `/reset`. `/cancel` ends the thread's active tasks, yours included, with status `cancelled`. After `/reset` the next task has no parent task and no earlier thread context, so treat it as a new conversation.

Use `get-task-details` to read the `contextKey` when you are not sure.

## Reply with `chat-reply`

`chat-reply { text }` posts to the thread your current task came from. It finds the thread from your task, so you do not pass ids.

- Use it to ask the user a question you cannot answer yourself. Ask once, with all your questions together.
- Use it for one short progress note when work takes more than a few minutes, such as "Started. This takes about 10 minutes."
- Do not use it for receipts ("Got it", "On it"), and do not send many progress notes.
- It works only on a task with a `task:chat-sdk:` contextKey. A session bound to a non-chat task does not see `chat-reply` at all, because the tool is left out of its tool list.

## The final summary is posted automatically

When your task ends, the swarm posts the task output to the thread:

- Completed: your `store-progress` output.
- Failed: a "Task failed." line, then the failure reason.
- Cancelled: a "Task cancelled." line, then the reason when there is one.

Do not post your final answer with `chat-reply` as well. The user would get it twice. Put the answer in the `store-progress` output and stop.

The post is durable. If the platform is down, the swarm retries with backoff for up to 24 hours.

## Markdown per platform

Write plain, short markdown: bold, italic, inline code, code blocks, bullet lists, and links. Avoid tables, nested lists, and HTML.

| Platform | What renders | Limit per message |
|---|---|---|
| Telegram | Bold, italic, code, code blocks, links, lists. No tables. | 4096 characters |
| Discord | Bold, italic, code, code blocks, lists, headings, links. No tables. | 2000 characters |
| Slack | Converted to Slack mrkdwn: bold, italic, code, lists, links. Tables do not render well. | 4000 characters |
| Teams | Basic markdown: bold, italic, code, lists, links. | 20000 characters |

The swarm splits longer text into several messages at line breaks. Long answers are hard to read in chat, so keep the answer short and put long material in an artifact or page, then post the link.

## Attachments arrive as task attachments

Files and images the user sends in the thread are stored as attachments of the task. The task text names them. Download them with the `download-task-attachment` skill. You cannot send files back to the thread in this version. Share a link instead.

## `chat-read-thread` limits per platform

`chat-read-thread { threadId, limit? }` returns the most recent messages of a thread, oldest first. The thread id is the adapter name plus the URI-decoded remainder of the contextKey. Telegram ids have no escaping, so `telegram:555001` stays as it is. Slack, Discord, and Teams ids contain `%3A` in the contextKey, so do not build the id by hand. `chat-reply` resolves the thread itself. For `chat-read-thread`, use the thread id returned by `chat-reply`, `chat-post`, or `chat-open-dm`. You can read the thread of your current task. Any other thread needs lead privileges.

- Telegram has no history API. The SDK keeps the Telegram thread history it saw in the swarm database, capped at 100 messages and 7 days.
- Teams needs the `Chat.Read.*` Graph permission on the bot. Without it, the call fails.
- Slack and Discord return the platform history.

The task text already holds the earlier swarm messages of the thread, so read the thread only when you need more.

## Other tools

- `chat-post { adapter, threadId | channelId, text }` posts outside your task's thread. Lead only. Use it only when the task asks you to message another thread or channel.
- `chat-open-dm { adapter, userId }` returns the direct-message thread id for a user. Lead only. Then post to it with `chat-post`.

## Leads: `register-chat-channel`

By default every message addressed to the swarm goes to the lead. A lead can route one channel to a fixed agent or workflow:

```
register-chat-channel { adapter: "telegram", channelId: "telegram:-100123", agentId: "<agent id>" }
register-chat-channel { adapter: "slack", channelId: "slack:C123", workflowId: "<workflow id>" }
unregister-chat-channel { adapter: "telegram", channelId: "telegram:-100123" }
```

Give exactly one of `agentId` or `workflowId`. A `swarm#<agentId>` token in a message still wins over the route. A workflow mapping fires only for a bot mention or a DM; a plain reply in the subscribed thread does not start another run. Only the lead can call these tools.

## Etiquette

- Keep messages short. Chat is read on phones.
- Never post secrets, tokens, internal URLs with credentials, or private data from other users. The swarm scrubs known secrets, but do not depend on it.
- When you ask a question in a group, start with the user's name so they see it.
- One question message is better than several.
