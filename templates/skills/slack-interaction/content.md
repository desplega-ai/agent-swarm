# Slack interaction

## What the engine posts

For every task that came from Slack, the engine owns the thread tree and the top-level outcome card. It posts the start, the completion, and the failure. You do not.

## Your one message

- At most one message per task, and only when the outcome card will not carry it: a question, a decision the requester must make, a link to a page or file with one line of context, or a table, chart or key figures. Send the last as a `slack-reply` `card` and keep the task `output` to one line pointing at it: the outcome card posts `output` too.
- Progress, receipts, acknowledgments, and relayed worker output stay out of Slack.
- Concrete content. The length matches what the requester asked for.
- The "How you write" rules of your system prompt apply. Slack renders mrkdwn: `*bold*`, `_italic_`, `` `code` ``, `<url|text>` for links. Markdown headings and tables do not render. For a table or chart, send a `card`.

## Where to post

The task carries `slackChannelId` and `slackThreadTs` in its metadata. A follow-up task with `parentTaskId` inherits them.

- Reply in the task's thread: `slack-reply` with `taskId` and `message`.
- Reply to an inbox message: `slack-reply` with `inboxMessageId`.
- New top-level message in a channel (lead): `slack-start-thread` with `channelId`, then `slack-post` with the returned `ts` as `threadTs` for replies under it.
- Fix your own message: `slack-update` (text) or `slack-delete` (lead). Both work only on messages this bot authored.

## Tools

| Tool | Use |
|---|---|
| `slack-reply` | reply in a thread by `taskId` or `inboxMessageId` |
| `slack-post` | post to a channel, optional `threadTs` (lead) |
| `slack-start-thread` | post a top-level message and get its `ts` (lead) |
| `slack-read` | read a thread by `taskId` or `inboxMessageId`, or a channel by `channelId` (lead) |
| `slack-list-channels` | channels the bot is a member of |
| `slack-upload-file` | upload a file to a thread or channel, up to 1 GB |
| `slack-download-file` | attach a Slack file (by ID or URL) to your task; run the `fetchCommand` it returns to get the bytes |
| `slack-update` | edit your own message |
| `slack-delete` | delete your own message (lead) |
| `slack-create-channel`, `slack-invite-to-channel`, `slack-archive-channel` | channel lifecycle (lead) |

Files attached to your task already come with download commands in the task message. Use those before `slack-download-file`. `slack-read` on your task also attaches the files in the thread and gives each one a `fetchCommand`. Don't look for Slack files under `/app/shared` or `/workspace/shared/downloads`: those paths are the API server's disk.

## Message limits

- Text sent without `blocks` is split into sections under Slack's 3,000-character section limit for you. With explicit `blocks`, keep each section's text at or under 3,000 characters yourself.
- Truncate user text by code point (`Array.from(s).slice(0, n).join("")`), never with `s.slice(0, n)`: cutting an emoji in half leaves a lone UTF-16 surrogate, and Slack rejects the blocks with `invalid_blocks_format`.

## Unknown user

A task without `requestedByUserId` came from a Slack user the swarm does not know. Register them with `manage-user`, using the Slack user ID and display name from the task metadata, then continue. When you learn a requester's stable preferences (language, tone, verbosity), the lead stores them in the user's `comms` field with `manage-user`.

## Use-case thread (lead)

A use case (a schedule and its runs under one key, see the `scheduling` skill) can post a summary of each run to one Slack thread.

1. When you handle the follow-up of the first run (the planning session has usually ended by then), read `kv-get { namespace: "usecase:<key>", key: "thread" }`. A stored value means that you offered before: do not offer again.
2. Offer once: "Do you want a summary of each run in a Slack channel? Tell me the channel."
3. On no: `kv-set { namespace: "usecase:<key>", key: "thread", value: { declined: true } }`.
4. On yes: `slack-start-thread { channelId, message }` with a one-line title, for example "Competitor watch: one summary per run". Then `kv-set { namespace: "usecase:<key>", key: "thread", value: { adapter: "slack", channelId, threadTs: "<ts from slack-start-thread>" } }`.
5. When you finish or review a run of the use case (the run itself, or the follow-up of a worker's run): `kv-get` the thread. When it has a `threadTs`, `slack-post { channelId, threadTs, message }` with the run summary and the link to its result file.

## Lead standing orders

When your heartbeat runbook says so, check for unaddressed requests older than one hour: `slack-list-channels`, then `slack-read` per channel, then create a task for each open request.

## Scripts-only mode

The named Slack tools are not registered. Use `script-run` with inline source: `ctx.swarm.slack_reply({ taskId, message })`. The task ID carries the thread context.

## Status and blocker questions

Answer for the scope of the place the question was asked. In a customer or project channel or thread, "current blockers" or "what's the status" means that customer's or project's work: its tracker, its PRs, its open asks. Answer swarm-wide only in a DM or an ops channel, or when the person asks for it. Name the scope you used in the first line.
