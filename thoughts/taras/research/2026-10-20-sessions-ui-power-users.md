---
date: 2026-10-20T15:10:00+02:00
researcher: Claude
git_commit: 2412e97b3b2113e1a1e1e8d3275377547781e553
branch: main
repository: agent-swarm
topic: "Facts for the sessions UI power-user redesign (10 open questions)"
tags: [research, sessions, slack, chat-sdk, inbox-state, asset-keys]
status: complete
autonomy: critical
last_updated: 2026-10-20
last_updated_by: Claude
---

# Research: facts for the sessions UI power-user redesign

**Date**: 2026-10-20, 15:10 BCN
**Researcher**: Claude (7-agent Workflow fan-out, Sonnet, synthesized in the main session)
**Git Commit**: `2412e97b3`
**Branch**: `main`

## Research Question

Answer the 10 fact-shaped open questions in `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md` ("Open Questions (for /research)").

## Summary

**Slack.** The Slack app subscribes to every message event in the channels, private channels, DMs, and group DMs the bot is in (`slack-manifest.json:94-105`). The `message` handler acts only on addressed messages. But each human thread message reaches `app.event("message")` (`src/slack/handlers.ts:423`) with `ts`, `user`, `text`, and `thread_ts` before any routing filter drops it. `getThreadContext` calls `conversations.replies` with `limit: 20` and no cursor. Per the Slack docs, that returns the parent plus the **oldest** replies, not the newest. `chat:write.customize` is in the bot scopes. The code already posts persona overrides and context blocks. The relay triggers fire only for `source = 'slack'` (Slack) and `source = 'chat'` or system follow-ups (chat-sdk). A dashboard follow-up on a Slack session has `source = 'ui'`, so its result is never relayed as a direct outcome. It still appears as a child in the Slack thread tree.

**Read state and keys.** `/api/inbox-state` stores rows keyed by `(userId, itemType, itemId)`, and only clients write them. Nothing on the server creates a `to_read` item. In the my-swarm app, "Needs you" means an unread root whose latest status is `failed`. Approvals and HITL requests are not part of it. `agent_tasks.key` has one plain index. Prefix filters use `"key" LIKE ? ESCAPE '\'`, which does not use that index: it scans the whole table (verified with `EXPLAIN QUERY PLAN` on prod). A range predicate does use the index. `/api/sessions` has no `key` filter, and no query counts tasks per key or prefix. A task key move runs a full audit scan of 7 tables before each move, and any audit warning blocks the move with a 409. No bulk or prefix move exists.

**Chat SDK and ordering.** The Chat SDK `SerializedMessage` shape is documented below (chat 4.41.1). `ThreadHistoryCache` stores up to 100 messages with a 7-day TTL that refreshes on each append. Our own `chat_lists` prefix can store without trim or expiry. Telegram, Discord, and Slack each have an API that returns a readable title, but the repo stores none of them. WhatsApp through chat-sdk is not installed. Kapso uses `kapso:conversation:<id>`. The session timeline is a parent-to-child tree, not a time-ordered list. The customer most likely ran `v1.168.0` (tagged 2026-10-10). No commit since then explicitly fixes ordering. The Trace render of session turns (#2162) first shipped in `v2.0.0`.

## Detailed Findings

### Q1. `conversations.replies` with `limit: 20` returns the oldest messages

- Call: `src/slack/handlers.ts:338-342`, `{ channel, ts: threadTs, limit: 20 }`, comment `// Last 20 messages max`.
- Slack docs (`docs.slack.dev/reference/methods/conversations.replies`, via context7): "The earliest messages in the time range are returned first." `oldest` defaults to 0, `latest` to now. Paging uses `has_more` and `response_metadata.next_cursor`.
- On a 60-reply thread, the call returns the parent plus the 19 oldest replies. It does not page. This follows from the docs; no live call was made.
- `getThreadContextForBuffer` (`src/slack/thread-buffer.ts:120-124`) has the same `limit: 20` and no cursor. Only `render-v2.ts:589-616` pages with a cursor.

### Q2. `/api/inbox-state`

- Routes: `src/http/inbox-state.ts` (`GET` line 10, `PATCH` line 48, `PATCH /bulk` line 66, 1 to 200 items in one transaction). DB: `listInboxState` and `upsertInboxState` (`src/be/db.ts:12615-12690`). Table: `src/be/migrations/057_inbox_item_state.sql:12-27`, plus `readAt` (156) and `lastReadAt` (227).
- Key: `UNIQUE(userId, itemType, itemId)`. `itemType` is `approval`, `credential_missing`, `broken_task`, `to_read`, `to_start_template`, or `notification`. `status` is `open`, `snoozed`, `dismissed`, or `done`. `readAt` is sticky (the first value wins). `lastReadAt` is a client-controlled cursor.
- **Creation:** nothing on the server creates rows. The my-swarm app writes them on Done, Later, read, and unread, with `itemId` = root task id (`my-swarm/swarm-app/src/lib/api.ts:216-261`).
- **Dashboard today:** `useToReadInbox` (`apps/ui/src/api/hooks/use-inbox.ts:228-264`) derives `to_read` candidates on the client: `source: ["ui"]` sessions with `latestStatus === "completed"` and activity within 7 days. A state row hides a candidate. Slack-origin roots are excluded. `approval`, `credential_missing`, and `broken_task` are separate dashboard buckets (lines 100, 129, 190).
- **"Needs you" in the app:** `classify` (`swarm-app/src/lib/inbox-sections.ts:39-66`) puts a thread in `needs` only when it is unread and `latestStatus === 'failed'`. No approval or HITL input. The app's default sources are `ui` and `chat`; an "other" flag adds `slack` and the rest (`lib/inbox.ts:120-130`).

### Q3. Key index, prefix filter, sessions query, shares

- Index: one, `idx_agent_tasks_asset_key ON agent_tasks("key")` (`src/be/migrations/115_asset_namespace_keys.sql:21`). Keys are stored lowercase (enforced by triggers at 115:103-157).
- Prefix filter: `assetKeyPrefixPattern` (`src/be/db.ts:407-409`) escapes `\`, `%`, and `_`, and appends `%`. The predicate is `"key" LIKE ? ESCAPE '\'` (`src/be/db/tasks/read.ts:879-881`, `1045-1047`). No `case_sensitive_like` pragma is set. The planner does not use the index for this LIKE: `SCAN agent_tasks`. A range predicate uses it (see Open Questions, item 1).
- `GET /api/sessions` (`src/http/sessions.ts:174-225`, handler 395-444) calls `listRecentSessions` (`src/be/db.ts:12977`) and `countSessions` (`:13081`).
  - Roots: `r.parentTaskId IS NULL`. Filters: `source IN (…)`, `q` (substring on task and title), `requestedByUserId`, `contextKeyPrefix` (on `contextKey`, not `key`).
  - Aggregates: one recursive CTE (`:13016-13048`) computes `chainCount`, `MAX(lastUpdatedAt)`, and the latest status per root. Order: `lastActivityAt DESC, createdAt DESC, id DESC`. Default limit 25.
  - Visibility: `sessionViewerCondition` (`src/be/db/session-visibility.ts:10-29`). `mine` = requester is me. `shared` = an active `session_shares` row for me or for everyone. The default scope is ownerless, mine, or shared.
- Shares: `session_shares` (`src/be/migrations/230_session_shares.sql:8-18`): `rootTaskId`, `userId` (NULL = everyone), `access` (`read`/`write`), `revokedAt`. Rows are revoked and re-inserted, never deleted.
- Aggregates per key or prefix for tasks: not found. `listAssetSummaries` (`src/be/db.ts:1648-1683`) returns rows, not counts.

### Q4. Conversation identity and readable names per source

| Source | Thread id / context key | Readable name source | Stored? |
|---|---|---|---|
| Slack | `task:slack:<channelId>:<threadTs>` (`src/tasks/context-key.ts:108`) | `conversations.list` (`src/tools/slack-list-channels.ts:74-86`, `src/slack/channel-activity.ts:160-169`); `conversations.info` is used only for externality (`src/slack/external-channel.ts:101-120`, 10 min cache, name not read) | No |
| Telegram | `task:chat-sdk:telegram:<enc(chatId[:topicId])>` (`context-key.ts:121-132`); SDK ids `telegram:<chatId>[:<topicId>]` | SDK `fetchThread` / `fetchChannelInfo` call `getChat` and return the chat title or the person's name | No |
| Discord | SDK ids `discord:<guildId>:<channelId>[:<threadId>]`, DMs use guild `@me` | SDK `fetchThread` / `fetchChannelInfo` return the channel `name`; `fetchDiscordGuilds` (`src/integrations/chat-sdk/discord-api.ts:21-62`) lists guild names for the status card only (60 s cache) | No |
| WhatsApp (chat-sdk) | Not installed (`node_modules/@chat-adapter` has discord, shared, slack, teams, telegram) | n/a | n/a |
| Kapso (WhatsApp) | `kapso:conversation:<id>` (`src/integrations/kapso/inbound.ts:166`) | `contact_name` in the webhook (logged only, `:95`); identity table via `resolveKapsoIdentity` | No |

- Slack author names in `<thread_context>`: `<@U…>: text`, rewritten to `<@U|Name>` through `resolveIdentity("slack", id)` (`src/slack/enrich.ts:175-196`). No `users.info` call in that path.
- chat-sdk inbound tasks: `source: "chat"`, `taskType: "chat-inbound"`, tags `["chat-sdk", adapter]` (`src/integrations/chat-sdk/inbound.ts:260, 379-383`).

### Q5. Where human Slack thread messages are available

`conversations.replies` and `conversations.history` call sites (tests excluded):

| Location | Use |
|---|---|
| `src/slack/handlers.ts:285` | `wasThreadStartedBySwarm`, `limit: 1` |
| `src/slack/handlers.ts:338` | `getThreadContext`, `limit: 20` |
| `src/slack/thread-buffer.ts:120` | `getThreadContextForBuffer`, `limit: 20` |
| `src/slack/render-v2.ts:592` | `findReservedSlackMessage`, `limit: 100` with a cursor |
| `src/slack/channel-activity.ts:75`, `:86` | `history`, cursor seed and polling |
| `src/tools/slack-read.ts:211`, `:217` | agent tool for threads and channel history |
| `src/be/seed-scripts/catalog/slack-thread-flatten.ts:53` | seed script, `limit=1000` |

- Subscribed bot events (`slack-manifest.json:94-105`): `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`, `assistant_thread_started`, and others. Every message in the bot's conversations is delivered.
- Handler order in `app.event("message")` (`handlers.ts:423`): drop duplicate events, drop `message_changed`, drop bot messages, drop empty or user-less messages, drop duplicates, drop external channels and unauthorized users. Then `workflowEventBus.emit("slack.message", …)` (~`:495-503`) runs with structured `ts`, `user`, and `text`.
- Thread routing after that: with `ADDITIVE_SLACK=true` (default false, `:537`) a message in a swarm thread is buffered unless it mentions someone else. Otherwise a message that is not an `@mention` or an assistant-thread message is ignored as `not_addressed` (~`:692`). No code persists ignored messages.
- `slackInboundOutcomeMiddleware` (`src/slack/app.ts:113`) runs earlier. Not inspected (UNVERIFIED).

### Q6. Chat SDK `SerializedMessage` and `chat_lists`

- Version: `chat` 4.41.1; `@chat-adapter/*` pinned to 4.41.1.
- `SerializedMessage` (`node_modules/chat/dist/types-kdVm1MWj.d.ts:56-96`): `_type: "chat:Message"`, `id`, `threadId`, `text`, `formatted` (mdast Root), `raw`, `author { userId, userName, fullName, email?, isBot (boolean | "unknown"), isMe, isSystem? }`, `metadata { dateSent (ISO), edited, editedAt? }`, `attachments [{ type, url?, name?, mimeType?, size?, width?, height? }]`, `isMention?`, `links?`, `replyTo?`. `Message.toJSON()` / `fromJSON()` convert dates (`:152-165`).
- `ThreadHistoryCache` (`node_modules/chat/dist/index.js:509-545`): key `msg-history:<threadId>`, `maxMessages` 100, `ttlMs` 7 days, `raw` set to null on append. Used only by adapters with `persistThreadHistory` (Telegram here).
- `SqliteChatState.appendToList` (`src/integrations/chat-sdk/state.ts:129-156`), one transaction: delete the list if expired, insert with `seq = MAX(seq)+1`, trim to the newest `maxLength` when `maxLength > 0`, set `expires_at` on every row of the key (NULL when `ttlMs` is 0 or unset). `getList` returns unexpired rows `ORDER BY seq ASC` (`:158-166`).
- Readers merge persisted history with `thread.recentMessages`, dedupe by id, and sort by `metadata.dateSent` (`src/integrations/chat-sdk/inbound.ts:168-195`).

### Q7. Slack scopes, persona overrides, context blocks

- Bot scopes (`slack-manifest.json:66-88`) include `chat:write`, `chat:write.customize` (`:73`), `chat:write.public`, history and read scopes, `files:*`, `reactions:write`, and `users:read`. `channels:manage` and `commands` are likely at `:69-70` and `:75` (UNVERIFIED; `DEPLOYMENT.md:653` lists both).
- Persona `username` plus `icon_emoji` overrides (from `getAgentDisplayName` / `getAgentEmoji`): `src/slack/responses.ts:101-102` and six more sites, `watcher.ts:493-494`, `actions.ts:156`, `thread-buffer.ts:260, 361`, `render-v2.ts:678, 1317, 1382-1383`. `icon_url` is not used.
- Context blocks: `render-v2.ts:1266` (outcome footer, `{ type: "context", elements: [{ type: "mrkdwn", text: parts.join(" · ") }] }`), `src/slack/blocks.ts:129-140` (`contextBlock()` helper and limits), `render-v2.ts:551`, `handlers.ts:949, 980`.

### Q8. Relay triggers and a dashboard follow-up on a Slack session

- Slack triggers (`src/be/migrations/144_slack_relay_obligations.sql`): `enqueue_slack_relay_after_terminal_update` and `…_insert` insert into `slack_relay_obligations` when the status becomes `completed`, `failed`, or `cancelled` AND `source = 'slack'` AND `slackChannelId` and `slackThreadTs` are set. No later migration changes them.
- chat-sdk triggers (`217_chat_sdk_state.sql:69-103`): the same terminal conditions, plus `contextKey GLOB 'task:chat-sdk:*'` and one of `source = 'chat'`, `source = 'system' AND taskType = 'follow-up'`, or a lead `resume`.
- The composer is `apps/ui/src/components/shared/task-composer.tsx` (rendered at `sessions/session-conversation.tsx:168`). Follow-ups call `api.createTask` with `parentTaskId` and `source: "ui"` (`:127-135, 169`). `src/be/db.ts:2575-2588` copies the parent's Slack ids when the channel matches.
- What Slack code does with that `ui` task:

| Path | Effect |
|---|---|
| Relay obligation (144) | Not created (`source` must be `slack`) |
| `getSlackTasksInThread` / `buildRenderForest` (`render-v2.ts:412-421`) | Included as a child node in the thread tree |
| Child result card (`render-v2.ts:988-1000`, loop `1716-1752`) | Eligible, but only when `SLACK_RENDER_V2_DELEGATION` is on (default false) and the parent chain reaches a `source = 'slack'` ask |
| Direct outcome / ask conclusion (`:1001-1007`, `:970-980`) | Excluded, but the task joins the ask closure (`closure.ts:26`) |
| Status and ack (`session-status.ts`, `ack.ts:209-215`) | Filter on Slack ids only (follow-on behavior UNVERIFIED) |
| Legacy watcher (`watcher.ts:685-830`) | Runs only when `SLACK_RENDER_V2` is off (default on) |
| Worker prompt (`poll.ts:440, 606`, `runner.ts:7251-7262`) | The task runs with the parent's Slack context |

### Q9. Asset key move path

- Route: `PATCH /api/assets/{entityType}/{id}/key` (`src/http/assets.ts:170-185`), `rbac: ungated` with inline checks. Task branch (`:319-336`): load the task, targets = `cascade ? getRootTaskChain(id) : [task]`, `canMutateTaskNamespace` per target (403 on any failure), then `authorizeAssetKeyWrite` and `moveAssetKey` (`:359-368`). Errors: "blocked until" → 409, other → 400 (`:379-386`).
- Permission: `can()` is pure and synchronous (`src/rbac/can.ts:29-45`). `task.fs.mutate` allows operator, user, lead, assignee, or creator (`src/rbac/legacy-policy.ts:223-235`). `requestPrincipal` reads the DB only for agent principals (`src/http/request-principal.ts:13-25`). No batching.
- `moveAssetKey` (`src/be/db.ts:1736-1879`): before the transaction it runs `auditAssetKeys` over all keys. Inside one transaction, per task whose key differs: select its attachment mappings, `UPDATE agent_tasks SET key`, update each mapped file's key plus a `file` history row, then a `task` history row.
- `auditAssetKeys` (`src/be/asset-key-audit.ts:105-188`): full scan of `agent_tasks`, `workflows`, `scheduled_tasks`, `pages`, `apps`, `scripts`, and `asset_key_mappings`, plus two attachment joins. `ok` is false on any issue, including warnings (`unknown-personal-user`, `missing-provider-mapping`, `provider-mapping-drift`). `moveAssetKey` gates on `ok`, not on `structuralValid`.
- Bulk or prefix move: not found. `keyPrefix` exists only for listing.
- Tables: `asset_key_mappings` (`115_asset_namespace_keys.sql:30-48`), `asset_key_history` (rebuilt in `129_asset_keys_apps_scripts.sql:14-47`, index on `(entity_type, entity_id, changed_at DESC)`).

### Q10. Session timeline order and the reported bug

- Server: `getRootTaskChain` (`src/be/db.ts:12904-12918`) orders the chain by `createdAt, rowid`. The root is returned separately (`src/http/sessions.ts:473-491`).
- Client: `buildTimelineTree` (`apps/ui/src/components/sessions/session-timeline.tsx:135-207`) builds a parent-to-child tree and sorts siblings by `createdAt`. Rendering is depth-first. One child renders inline. Two or more siblings render as a `ParallelGroup` first, then each subtree (`:270-337`). A terminal parent whose `lastUpdatedAt` is later than all its children has its outcome moved below them under a "closed this fork" chip (`:45-114`). Auto-review follow-ups render as `ReviewAck` chips unless handoffs are shown (`:142-179`). Steering messages appear only inside each task's chain of thought, sorted by time (`chain-of-thought.tsx:225-245`).
- Auto-scroll: `useAutoScroll(scrollEl, [chainSignature])` (`session-conversation.tsx:89`) follows the bottom while the user is within 100 px of it (`use-auto-scroll.ts:29-79`).
- Git: tag `v1.68.0` exists. `557f47624` "feat: Sessions UI and more! (#455)" is in `v1.68.0..HEAD`, so the sessions view landed after v1.68.0. The customer most likely ran `v1.168.0`, not `v1.68.0` (see Open Questions, item 4). 36 commits since then touch the sessions UI, API, or the scroll hook. None explicitly fixes ordering. Closest: `cdfa1d9f9` (#1598, shows delegated progress and follow-up output) and `2b924cf11` (#1704, batches steering and citation lookups).

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/slack/handlers.ts` | 338-342 | `getThreadContext`, `limit: 20`, no cursor |
| `src/slack/handlers.ts` | 423, ~495-503 | `message` event entry; structured `slack.message` emit |
| `slack-manifest.json` | 66-88, 94-105 | Bot scopes; subscribed events |
| `src/http/inbox-state.ts` | 10, 48, 66 | Inbox-state routes |
| `apps/ui/src/api/hooks/use-inbox.ts` | 228-264 | Dashboard client-side `to_read` derivation |
| `src/be/migrations/115_asset_namespace_keys.sql` | 21 | The only index on `agent_tasks.key` |
| `src/be/db.ts` | 12977-13117 | `listRecentSessions` / `countSessions` |
| `src/be/db/session-visibility.ts` | 10-29 | Session visibility (mine, shared) |
| `src/integrations/chat-sdk/state.ts` | 129-166, 218-243 | `chat_lists` append and read; persisted history |
| `src/be/migrations/144_slack_relay_obligations.sql` | all | Slack relay triggers |
| `src/be/migrations/217_chat_sdk_state.sql` | 69-103 | chat-sdk relay triggers |
| `src/be/db.ts` | 1736-1879 | `moveAssetKey` |
| `src/be/asset-key-audit.ts` | 105-188 | `auditAssetKeys` full scan |
| `apps/ui/src/components/sessions/session-timeline.tsx` | 135-337 | Tree-ordered timeline |

## Open Questions (resolved 2026-10-20, after Taras's review)

1. **Does the key prefix filter use `idx_agent_tasks_asset_key`? No. It scans the whole table.**
   - Prod (read-only `sqlite3` 3.45.1 on `swarm`, 49,728 `agent_tasks` rows): `"key" LIKE 'shared/slack/%' ESCAPE '\'` → `SCAN agent_tasks`. The same prefix as a range, `"key" >= 'shared/slack/' AND "key" < 'shared/slack0'` → `SEARCH agent_tasks USING INDEX idx_agent_tasks_asset_key (key>? AND key<?)`.
   - `bun:sqlite` 3.51.0 with bound parameters (the shape the code uses): LIKE → `SCAN`, range → `SEARCH … USING INDEX`. Script: an in-memory table with the same index (run on 2026-10-20).
   - This matches SQLite's documented LIKE-optimization rule: with `case_sensitive_like` off, the column must use a `NOCASE` index, and `idx_agent_tasks_asset_key` uses the default `BINARY` collation.
2. **What does `slackInboundOutcomeMiddleware` read? Only delivery outcomes, not message content.**
   - It is defined at `src/slack/inbound-dispatch.ts:174-200`. It wraps `next()` in an `AsyncLocalStorage` delivery state, marks the delivery as dispatched, and records the outcome or error code per transport. It does not read `ts`, `user`, or `text`.
   - Related storage: `slack_inbound_receipts` (`src/be/migrations/204_slack_inbound_receipts.sql`) holds the raw payload encrypted (AES-256-GCM) only while a delivery is pending. It erases the payload when the delivery is processed or ignored, and keeps dedup keys for 48 hours. It is not a message history.
3. **What does `ack.ts` do for a `ui` task with Slack ids? Nothing.**
   - `finalizeTerminalSlackReactions` (`src/slack/ack.ts:203-240`) skips a task when `triggerMessageTs(task)` returns nothing.
   - `triggerMessageTs` (`:182-190`) returns `slackTriggerMessageTs`, or walks the parents of `deferred` tasks only.
   - Child tasks do not inherit `slackTriggerMessageTs`. The parent fill-in at `src/be/db.ts:2578-2586` copies `slackChannelId`, `slackThreadTs`, and `slackUserId` only.
   - So a dashboard follow-up never adds or finalizes a reaction on a Slack message.
4. **Which version did the customer run? Most likely v1.168.0.**
   - The transcript says "568", installed "hace una semana o semana y media". `v1.168.0` was tagged on 2026-10-10, 10 days before the call. `v1.68.0` is from 2026-04-22, before the Sessions UI (`557f47624`, 2026-05-10). The last 1.x is `v1.173.0` (2026-10-15), and `v2.0.0` followed on 2026-10-16. The customer said they have not upgraded to v2.
   - Sessions commits since `v1.168.0`: `f6ecdfbed` (#2162, the session turns and transcript render as a ported Trace; ChainOfThought merges tool calls, reasoning, the activity log, and steering), `b5fef28c9` (#2249, sharing and presence), and `6ff84e370` (#2277, JSON output tree). None of them names an ordering fix. #2162 is the only one that changes how a turn's activity is merged and rendered, and it first shipped in `v2.0.0`.
   - Whether the report reproduces on v2.4.x: not verified. It needs a live repro: send a follow-up in a session with a running lead task, and watch where the reply renders.

## Appendix

- **Corrections to the brainstorm:**
  - The brainstorm said "Needs you must cover approvals and HITL, as in the app". In the app, "Needs you" is unread plus `failed`. Including approvals and HITL is a new decision, not parity.
  - The brainstorm said `/api/inbox-state` gives read-state sync "with no new API". Sync works, but every item is client-written. Nothing creates `to_read` rows on the server, and the dashboard derives unread on the client today.
  - The brainstorm said the bot sees human messages only through `conversations.replies`. In fact every message in the bot's channels reaches `handlers.ts:423`. Capture can happen at the event, not only at task creation.
- **Historical context:** `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md` (decisions); `~/Documents/my-swarm/thoughts/taras/plans/2026-10-19-swarm-app-v2-m12-b3.md` (app groups); `2026-10-10-team-scoped-privacy.md` (privacy).
- **Raw agent output:** Workflow run `wf_980cf08b-e54` (journal under the session's `subagents/workflows/` directory).
