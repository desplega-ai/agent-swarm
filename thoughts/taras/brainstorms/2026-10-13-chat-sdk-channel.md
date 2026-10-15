---
date: 2026-10-13T00:00:00+02:00
author: Taras
topic: "Chat SDK (chat-sdk.dev) as a swarm input/output channel"
tags: [brainstorm, integrations, channels, chat-sdk, slack, agentmail, kapso]
status: ready-for-planning
exploration_type: idea
last_updated: 2026-10-13
last_updated_by: Claude
---

# Chat SDK as a swarm input/output channel — Brainstorm

## Context

Taras wants to evaluate how easy it would be to use Vercel's Chat SDK (https://chat-sdk.dev) as an input/output channel for the swarm, next to the bespoke Slack, AgentMail and Kapso integrations that exist today.

Initial sketch from Taras:

- `CHAT_SDK_ENABLED=true` switches the integration on.
- `CHAT_SDK_ADAPTERS` is a stringified JSON object. Each key is an enabled adapter. Each value is the config object passed to that adapter.
- Adapter configs can reference swarm secrets (swarm_config / secrets store) instead of raw values.

Chat SDK is a multi-platform chat bot abstraction. One `Chat` instance, N adapters (Slack, Teams, Discord, Telegram, WhatsApp, GitHub, ...). It gives a uniform thread model, subscriptions, message posting and streaming.

The question is a feasibility and shape question: what is the minimal footprint, where does it sit next to the existing channels, and what do we not touch.

## Exploration

### Q: What kind of exploration is this?
Idea to develop. Shape the Chat SDK channel: minimal footprint, placement next to Slack/AgentMail/Kapso, config model.

### Q: What role should the Chat SDK channel play relative to the bespoke Slack integration?
Additive. Technically it could replace Slack if someone wants to, but there are no plans to replace Slack. The bespoke Slack adapter is good and stays.

**Insights:** Design for "could replace Slack" but do not build parity. The Chat SDK channel gets its own task source, context-key family and columns. It must not share or touch `src/slack`. If a Chat SDK Slack adapter is enabled next to the bespoke one, both would react to the same events. That is an operator footgun to document or guard.

### Note from Taras (mid-session): state adapter
Chat SDK needs a state backend (threads, subscriptions, locks). Taras proposes a small SQLite state adapter custom to us, as a repo package.

**Insights:** Pending the Chat SDK state-interface facts. Two candidates inside the API process: (a) a thin adapter over the existing swarm KV store (namespaced, TTL, already in the API DB, already behind the async DB seam), or (b) a new table plus adapter. (a) needs no migration. The API server is the sole DB owner, so the adapter must live in API-side code or a package only the API imports.

### Facts: existing channels (sub-agent map, 2026-10-13)
- No generic channel or notifier interface exists. Slack, AgentMail and Kapso are each bespoke.
- `AgentTaskSourceSchema` (src/types.ts:379-394) has no `kapso` value. Kapso tasks use `source: "system"`, `taskType: "kapso-inbound"`, tags, and `contextKey: kapso:conversation:{id}`.
- Context keys: `src/tasks/context-key.ts`, `task:{family}:...`, families slack | agentmail | trackers | schedule | workflow. The same vocabulary is the KV namespace.
- Origin metadata is flat task columns (`slackChannelId`, `slackThreadTs`, `agentmailThreadId`, ...), copied onto follow-ups by `src/tasks/worker-follow-up.ts`.
- Kapso (the lightest channel): 22 files, +1750 lines, no migration, no `src/types.ts` change. Pieces: webhook route in `src/http/webhooks.ts`, `src/integrations/kapso/{client,config,inbound}.ts`, capability flag in `src/server.ts`, outbound MCP tools, integrations-catalog card, docs page, seeded skill, tests.
- Kapso config: `getKapsoConfig()` reads swarm_config first, env fallback. Secrets decrypted inside `getSwarmConfigs`.
- Tool gating: `ALL_CAPABILITIES` / `DEFAULT_CAPABILITIES` in `src/server.ts`; tools register under `hasCapability(...)`.
- No precedent for a stringified-JSON env var config anywhere in src or apps/ui.
- Slack inbound runs in socket mode by default (dev-blocked), HTTP mode optional. AgentMail and Kapso are signed webhooks under `/api/...`, auth-bypassed, 200-first.

### Facts: Chat SDK (verified against vercel/chat main, 2026-10-13)
- Package `chat` 4.41.1, MIT, Vercel, public beta, fast 4.x minor churn. `engines.node >= 20`. Bun is not documented anywhere. Peer deps `ai`, `workflow`, `zod` (v3 or v4) are all optional.
- Adapters: `@chat-adapter/{slack,discord,telegram,teams,gchat,github,linear,whatsapp,resend,...}`. Each adapter owns webhook parsing and signature verification. Slack adapter supports webhook (default) or socket mode.
- Inbound wiring: `chat.webhooks.<adapter>(request: Request, options?) => Promise<Response>`. Framework-agnostic Web fetch handler, drops into `Bun.serve` / the existing `route()` factory. `WebhookOptions`: `waitUntil`, `deduplicate`, `propagateHandlerErrors`.
- State is required. `StateAdapter` interface (18 methods): `connect/disconnect`, `subscribe/unsubscribe/isSubscribed(threadId)`, `acquireLock/releaseLock/forceReleaseLock/extendLock`, `get/set(ttl)/setIfNotExists(ttl)/delete`, `appendToList/getList`, `enqueue/dequeue/queueDepth`. Official: memory, redis, ioredis, postgres. No SQLite. Docs: implement the interface, use `state-memory` as reference.
- Event model: `onNewMention`, `onSubscribedMessage`, `onDirectMessage`, `onNewMessage(regex)`, slash commands, reactions. `thread.subscribe()`, `thread.post()`, `thread.state` (30 day TTL default).
- Out-of-band posting works: `chat.thread(adapterName, threadId).post(...)`, `openDM(user)`. Good for completion notifications without an inbound trigger.
- Concurrency: per-thread lock, `onLockConflict: drop | force | fn`, default drop. Multi-instance needs shared state.
- Gotcha (#941): handler errors were swallowed via `waitUntil`; 4.41 added `propagateHandlerErrors`.
- Config: adapter factories auto-read env (`SLACK_BOT_TOKEN`, ...) or take explicit options. Resolver functions allowed for lazy secrets. No JSON-blob precedent.

**Insights:** The `StateAdapter` surface maps one-to-one onto the swarm KV primitives (namespaced key, value, TTL, set-if-not-exists). Locks are `setIfNotExists` with TTL. Lists and queues are JSON arrays under a key, or a small dedicated table if contention matters. A KV-backed adapter needs no migration.

### Q: How should we back the Chat SDK StateAdapter?
KV-backed adapter in `src` (recommended, accepted). Implement `StateAdapter` over the existing swarm KV store. Locks are `setIfNotExists` + TTL. No migration, no new package. Lives in `src/integrations/chat-sdk/state.ts`.

**Insights:** Uses a reserved KV namespace (see `src/kv-reserved-namespaces.ts`) such as `integrations:chat-sdk:*`, like Kapso's `integrations:kapso:*`. Lists and queues are JSON arrays under one key. Append is read-modify-write, so wrap it in a `transaction` to keep it atomic across API workers. Per-thread lock contention is low (one thread, one inbound at a time), so this is fine for v1. Revisit with a dedicated table only if queue strategies (`queue`, `debounce`) see real load.

### Q: How should CHAT_SDK_ENABLED / CHAT_SDK_ADAPTERS be stored and read?
swarm_config keys with env fallback and secret references (recommended, accepted). `CHAT_SDK_ENABLED` (boolean) and `CHAT_SDK_ADAPTERS` (JSON object keyed by adapter name). JSON values may reference swarm secrets by name, for example `"botToken": {"$config": "DISCORD_BOT_TOKEN"}` (syntax settled in the review round). Resolution happens at boot through the adapter factories' resolver functions. One JSON editor on the Integrations card. A zod schema per supported adapter validates the blob in `VALIDATED_KEYS` (`src/be/swarm-config-guard.ts`).

**Insights:** Same precedence as Kapso: stored swarm_config wins over the deployment env. `$secret` refs keep the JSON non-secret, so the UI can show it in clear and the scrubber has nothing to catch. Rotating a secret does not require editing the JSON. The `CHAT_SDK_ENABLED` flag goes next to `SLACK_DISABLE` / `AGENTMAIL_DISABLE` in the guard's reserved list, and the Configuration catalog gets it with `restartRequired: true` (adapters are constructed at boot). Example:

```json
{
  "discord": { "botToken": {"$config": "DISCORD_BOT_TOKEN"}, "publicKey": {"$config": "DISCORD_PUBLIC_KEY"} },
  "telegram": { "botToken": {"$config": "TELEGRAM_BOT_TOKEN"} }
}
```

### Q: How does a Chat SDK message become swarm work, and who gets it?
Mention creates a task for the Lead, thread replies become follow-ups (recommended, accepted). `onNewMention` / `onDirectMessage` create a task, subscribe the thread, and set `contextKey = task:chat-sdk:{adapter}:{threadId}`. `onSubscribedMessage` on a thread with a live task becomes a follow-up or steer on that task. An optional KV mapping `{adapter}:{channelId}` to an agent or workflow overrides the Lead default, Kapso-style.

**Insights:** This adds a `chat-sdk` family to `ContextKeyFamily` in `src/tasks/context-key.ts`. Follow-up vs steer should reuse whatever `src/tasks/worker-follow-up.ts` and the Slack steering path already decide for live tasks, not a new rule. The thread subscription is the Chat SDK-side memory of "we own this thread"; the task lookup by contextKey is the swarm-side memory. Both must agree: unsubscribe when the task reaches a terminal state without a follow-up.

### Q: What does Chat SDK get for outbound?
Auto outcome post plus one reply tool (option 1, Taras: "probably aligned w 1"). On a terminal task state, `task-terminal-effects` posts the store-progress summary to the originating thread via `chat.thread(adapter, threadId).post()`. One MCP tool, `chat-sdk-reply`, scoped to the task's thread, covers mid-task messages and questions. Streaming and message edits are deferred.

**Insights:** `chat.thread(adapter, threadId)` works without an inbound trigger, so the terminal post needs only `contextKey` to find adapter + thread. No extra origin columns are strictly required for v1 (see the open decision on task columns below).

### Note from Taras (mid-session): capability, skill, extensions, Slack as the template
Four additions:
1. Expose Chat SDK as a server capability, so its MCP tools register only when enabled.
2. Ship a seeded skill for the swarm (how to reply, thread etiquette, what the adapters can and cannot render).
3. Plug extensions in from the start, so operators can customize routing and outbound.
4. Model the mechanics on the Slack integration, not Kapso.

**Insights (facts checked):**
- Capability: `ALL_CAPABILITIES` / `DEFAULT_CAPABILITIES` in `src/server.ts` already gate `slack`, `agentmail`, `kapso`. Add `chat-sdk`, off by default, auto-enabled when `CHAT_SDK_ENABLED` resolves true, the same way `slack` is dropped when socket mode is off.
- Skill: `templates/skills/chat-sdk/` (`config.json` + `content.md`), registered in `BUILT_IN_SKILL_SOURCES`, toggled per agent. Kapso has `templates/skills/kapso-whatsapp/` as the precedent.
- Extensions: `src/extensions/contract.ts` today has `pre.slack.route`, `post.slack.message`, `post.kapso.message`, `post.email.received`, plus the generic `pre.task.create` / `post.task.*`. Mirror the Slack pair: `pre.chat.route` (modify target agent/workflow, or drop) and `post.chat.message` (observe inbound and outbound). `dispatchPre` at the route entry point outside transactions, as `src/slack/handlers.ts:606` does. Each new event needs a fixture under `src/tests/fixtures/extensions/`, a row in the operator guide, and `bun run build:extension-types`.
- Slack mechanics to copy, in order of value: `event-dedup.ts` (receipts, idempotency), `inbound-dispatch.ts` + `thread-buffer.ts` (coalesce bursts before creating a task), `router.ts` (target selection + the `pre.slack.route` hook), `steering.ts` (follow-up vs steer on a live task), `egress-scrub.ts` (secret scrubbing at egress). Skip for v1: `render-v2.ts`, `blocks.ts`, `session-status.ts`, `work-objects.ts`, `files.ts`.
- Chat SDK already does dedup and per-thread locking in its state layer, so `event-dedup.ts` may be redundant. Verify before copying it.

### Q: What should Chat SDK tasks carry as identity?
New source `"chat"` plus `contextKey` only (recommended, accepted). One migration widens the CHECK constraint on `source`. No new origin columns. Adapter and threadId live in `contextKey = task:chat-sdk:{adapter}:{threadId}` and in Chat SDK thread state.

**Insights:** Keep `AgentTaskSourceSchema` in `src/types.ts` in sync with the SQL. Check the migration ordinal against main's tail and open PRs (`scripts/check-migration-conflicts.sh`). Follow-ups inherit `contextKey` already, so the terminal post finds the thread without Slack-style column copying. The `chat-sdk-reply` tool resolves its target from the calling task's contextKey, which mirrors how the Slack tools are "task-context gated".

### Q: Which adapters must work at merge time?
Discord, Telegram, Slack and Teams (Taras, overriding the two-adapter recommendation).

**Insights:** Four adapters means four E2E legs and four app registrations for QA. Teams is the heaviest to set up locally. Slack via Chat SDK is explicitly in scope, so the double-handling question (bespoke `src/slack` and the Chat SDK Slack adapter both on) must be decided, not assumed. The Slack adapter supports both webhook and socket mode. The bespoke integration defaults to socket mode. Two socket-mode clients on the same app token is a Slack-side conflict.

### Q: What happens when both the bespoke Slack integration and the Chat SDK Slack adapter are configured?
Refuse at boot unless `SLACK_DISABLE=true` (recommended, accepted). Startup fails with a clear message when `CHAT_SDK_ADAPTERS` contains `slack` and the bespoke integration is enabled. One Slack path per deployment.

**Insights:** The check lives next to the capability resolution in `src/server.ts`. The Integrations page should show the same conflict as a card-level error, so the operator sees it before a restart. Because stored swarm_config wins over env, the guard must evaluate the resolved values, not raw `process.env`.

### Q: Which of these are explicitly OUT of v1?
Out: rich rendering (cards, modals, streaming edits) and multi-workspace OAuth installs. In: inbound file attachments and the full dashboard card (Taras unchecked both).

**Insights:** Attachments mean porting the intent of `src/slack/inbound-files.ts` + `task-attachments.ts` onto Chat SDK's lazy `fetchData()` (25 MB cap, SSRF-guarded by the SDK). The full dashboard card means per-adapter form fields with `isSecret`, not only a JSON editor. That pulls the adapter zod schemas into `apps/ui/src/lib/integrations-catalog.ts` so the UI can render fields and the API can validate the same shape. Keep one schema source and generate the catalog entry from it, or the two drift.

### Facts: Bun spike (2026-10-13, /tmp/chat-sdk-spike)
- `chat@4.41.1` plus `@chat-adapter/{slack,discord,telegram,teams,state-memory}@4.41.1` install and run under Bun 1.4. `bot.webhooks.telegram(req)` served from `Bun.serve` returns real responses: 401 on a wrong `x-telegram-bot-api-secret-token`, 503 "Service unavailable" when the bot identity cannot be resolved (fake token). Bun compatibility is no longer an open question for the core path.
- At `new Chat(...)` the SDK calls the platform APIs (Telegram `getMe`, `getWebhookInfo`) and logs errors instead of throwing. Boot needs outbound network and valid tokens; otherwise webhooks answer 503. Telegram has an "auto" mode that inspects webhook status, plus an explicit `longPolling` config.
- Adapter config interfaces (from the installed `.d.ts`), the fields that matter for us:
  - Slack: `botToken`, `signingSecret`, `appToken`, `mode` (webhook | socket), `clientId`/`clientSecret`/`installationProvider` (OAuth, out of v1), `fileTransport`, `nativeStreaming`, `userName`.
  - Discord: `botToken`, `publicKey`, `applicationId`, `respondToChannelIds`, `respondToGlobalMentions`, `mentionRoleIds`.
  - Telegram: `botToken`, `secretToken`, `mode`, `longPolling`, `allowedUserIds`, `allowUnverifiedWebhooks`, `businessMode`.
  - Teams: `appId`, `appPassword`, `appTenantId`, `appType` (MultiTenant | SingleTenant), `certificate` / `federated` (alt auth).
  - `botToken` / `appId` / `applicationId` accept `string | () => Promise<string>` resolvers on Discord, Telegram and Teams. Slack `botToken` is `SlackBotToken` (also resolver-capable per docs). `signingSecret`, `publicKey`, `secretToken`, `appPassword` are plain strings.

### Facts: codebase hooks (sub-agent, 2026-10-13)
- `src/tasks/task-terminal-effects.ts` does not post to any channel. It runs memory writes, raters and the lead follow-up, and is called after the completion transaction commits (`store-progress.ts:620`, `defer-task.ts:435`). Slack delivery happens in the Slack-specific watcher (`src/slack/watcher.ts`). The Chat SDK terminal post needs its own plug point after terminal effects, or a small watcher of its own.
- Slack tool gating is `selectTaskTools` in `src/utils/task-tool-manifest.ts:18-33`: `!name.startsWith("slack-") || Boolean(task.slackChannelId)`. It does not read `contextKey`. Adding `contextKey` to its input type and the `src/http/mcp.ts:232` call site lets `chat-*` tools gate on the `chat-sdk` family.
- KV API in `src/be/db.ts`: `getKv`, `upsertKv({expiresAt})`, `claimKv` (set-if-absent-or-expired), `deleteKv`, `incrKv`, `listKv({prefix})`, `countKv`. No atomic append. Reserved families in `src/kv-reserved-namespaces.ts` are `apps`, `comb`, `worker`; Kapso's `integrations:kapso:*` is not reserved.
- Secret references: the only existing convention is the credential broker's `[REDACTED:<configKey>]` placeholder (`src/scripts-runtime/credential-broker/types.ts:5,70`), substituted at fetch egress for script connections. There is no generic `$secret` / `secretRef` resolver.
- Attachments: `src/slack/inbound-files.ts` downloads with the bot token to a temp file, stores through the active file provider (agent-fs or shared-fs), and records a `task_attachments` row via `recordTaskAttachmentUpload` (`src/be/task-attachment-store.ts:30`, 50 MiB cap). Pointer-only, no blobs in the DB.
- Script SDK naming: `SDK_TOOL_NAME_MAP` maps `slack_reply: "slack-reply"`, `slack_post: "slack-post"`, `slack_startThread: "slack-start-thread"`. Kapso tools are not mapped.
- Webhook routes (`src/http/webhooks.ts`): Kapso and AgentMail use `auth: { apiKey: false }`, declare 401 and 503 responses, read the raw body by iterating `req`, and verify the signature themselves. Azure DevOps shows the `rbac: { ungated: "provider webhook: ..." }` posture.
- Capabilities: `getEnabledCapabilities()` in `src/server.ts:283-290` drops `slack` unless socket mode. Same place for the `chat-sdk` enable and the Slack-clash refusal.

### Review round 1 (file-review, 5 comments)
1. Config type: dumped as a TS sketch under Key Decisions.
2. Tools in scripts: tool table with `ctx.swarm` names added under Key Decisions.
3. Custom state tables: asked. Decision: dedicated tables for all Chat SDK state (atomic single-statement methods, inspectable rows). KV keeps only the channel mapping.
4. Webhook route: moved from Deferred to a v1 Key Decision with the full `route()` posture.
5. Open questions: resolved the codebase and SDK facts in-session (Bun spike, adapter config fields, hooks). What remains is fact-shaped research, not decisions.

### Q: Secret reference syntax inside CHAT_SDK_ADAPTERS?
`{"$config": "KEY"}` object (recommended, accepted). Resolves any swarm_config key at boot. Not the credential broker's `[REDACTED:KEY]` marker, which means "redacted output" at fetch egress.

**Insights:** The resolver is generic (`resolveConfigRefs(json)`), so later JSON-shaped configs reuse it. The Integrations card renders a `$config` value as a key picker over existing swarm_config keys, so secrets never pass through the JSON editor in clear.

### Facts: Slack mechanics to mirror (background research, 2026-10-13)
- **Outcome delivery is a durable-obligation poller, not an event subscriber.** `startTaskWatcher(3000ms)` (`src/slack/watcher.ts:622`) each tick runs `processPendingSlackRelays`, which selects `slack_relay_obligations` joined to `agent_tasks` where `delivered_at IS NULL AND status IN ('completed','failed','cancelled')` (`src/be/db/tasks/read.ts:980-992`), posts via `updateToFinal` / `sendTaskResponse`, then `markSlackRelayDelivered`. Retry comes for free: an undelivered row is retried next tick.
- A generic post-commit bus exists: `workflowEventBus` (`src/workflows/event-bus.ts`) emits `task.created`, `task.completed` (payload `{taskId, output, agentId, workflowRunId, ...}`), `task.failed`, `task.cancelled`, `task.superseded`, `task.progress` from `src/be/db/tasks/write.ts` inside `afterCommit`. `src/extensions/post-bridge.ts` bridges them to `post.task.*`. Subscribing here is in-process and not durable across a restart.
- **Burst coalescing**: `src/slack/thread-buffer.ts` is a 10 s debounce (`ADDITIVE_SLACK_BUFFER_MS`) keyed `channelId:threadTs`, built on `createAdditiveBuffer`. `!now` flushes immediately. Flushed description: `[Thread follow-up — N message(s) buffered]\n\n<combined>`, prefixed by the `slack.message.thread_context` template (`src/slack/templates.ts:54-67`). Files download at flush time only. `dependsOn = [latestActiveTask.id]`.
- **Steer vs follow-up** (`src/slack/steering.ts`): steer only when the agent is lead, the message is in a thread, there are no files, and the target task is `in_progress` (`SLACK_THREAD_STEERING=lead|all`, mode `queue` unless `..._MODE=steer`). Otherwise a follow-up task is created. Steering goes through `requestSteering({source, onUnsupported: "degrade"})`.
- **Router** (`src/slack/router.ts:30`): `swarm#<uuid>` to that agent, `swarm#all` broadcast, thread follow-up to `getAgentWorkingOnThread` with lead fallback, else lead if the bot is mentioned. Only reachable agents. No KV mapping exists in Slack (that is Kapso-only). `pre.slack.route` is dispatched in `src/slack/handlers.ts:607-625` with `SlackRouteModify = { target: {kind:"agent", agentId} | {kind:"lead"} | {kind:"broadcast"} }`; extension-identity agents are rejected as targets.
- **Inbound files** (`src/slack/inbound-files.ts`): download to `mkdtemp("slack-files-")`, `await using` disposal. With files, the task is created as `status: "draft"` with a renewed lease, then `attachSlackFilesToTask` uploads via `getFileStorageProvider().upload(...)` and `recordTaskAttachmentUpload({intent: "user-upload", description: "Shared on Slack (file <id>)"})`, deduped by sha256, then `promoteDraftTask`. Task text gets `[File: <name> (<mime>, <size>) id=<id>]` lines from `buildAttachmentText`.
- **UI precedent**: the Kapso catalog entry (`apps/ui/src/lib/integrations-catalog.ts:254-310`) is four flat fields with `isSecret` plus `recommendedSkills: [kapso-whatsapp]`. No integration displays a webhook URL today. `deriveIntegrationStatus` (`integrations-status.ts:67-127`) knows `configured | partial | disabled | none`; there is no health concept.

**Insights:**
- Terminal post should copy the Slack pattern, not the event bus: a `chat_relay_obligations` row written at task creation (`contextKey` family `chat-sdk`), drained by the Chat SDK watcher tick. That gives durable retry across restarts and reuses `src/be/db/tasks/read.ts` query shape. The event bus can trigger an immediate attempt, but the row is the source of truth.
- The debounce buffer, the thread-context template, `!now`, and the steer rule can be lifted almost verbatim with `channelId:threadTs` replaced by `adapter:threadId`. Keep `ADDITIVE_SLACK_BUFFER_MS` semantics under a `CHAT_SDK_BUFFER_MS` name.
- `ChatRouteModify` extends the Slack shape with `{kind: "workflow", workflowId}` to match the Kapso-style mapping that the brainstorm already includes.
- The dashboard card needs two things no integration has today: a generated webhook URL per adapter and an adapter health line (from SDK init errors). Both are new UI capabilities, small but new. The status derivation must handle a JSON field with nested `$config` refs, which `isFieldPresent` does not understand yet.
- The draft-task-with-lease pattern for file downloads applies unchanged to Chat SDK `fetchData()`.

### Facts: Chat SDK internals (background research on the installed 4.41.1 dist, 2026-10-13)
- **`waitUntil` is load-bearing.** Slack and Telegram `handleWebhook` return 200 before handlers run and call `processMessage` without awaiting. Without `waitUntil`, a throwing handler is an unhandled rejection; `propagateHandlerErrors` only changes which promise is handed to `waitUntil`. The Discord gateway listener and the Slack socket-mode listener return 500 "waitUntil not provided" when it is missing. Teams awaits DM processing inline. Conclusion: we must always pass our own `waitUntil` that tracks and catches the promise.
- **Dedup is built in.** `routeIncomingMessage` claims `dedupe:{adapter}:{message.id}` with `setIfNotExists` (10 min TTL, `dedupeTtlMs`). Slack additionally honors `X-Slack-Retry-Num` with a 24 h `slack:event-delivered:{event_id}` key; Telegram claims `telegram:webhook-update:{scope}:{update_id}` for 24 h. All four adapters give stable ids. No `event-dedup.ts` port is needed.
- **Telegram** never calls `setWebhook`; the operator (or we) must register the URL. Modes: `auto` (default: webhook if one is registered or a serverless env var is set, else polling), `webhook` (throws without `secretToken` unless `allowUnverifiedWebhooks`), `polling` (`getUpdates` loop, `deleteWebhook` first by default). Verification is a timing-safe compare on `X-Telegram-Bot-Api-Secret-Token`.
- **Discord is two transports.** The interactions webhook (Ed25519 via `discord-interactions`, PING answered automatically) carries only slash commands and components. Plain channel messages and @mentions require a Gateway WebSocket: `startGatewayListener(options, durationMs = 180000, abortSignal, webhookUrl?)` builds a `discord.js` client (intents Guilds, GuildMessages, MessageContent, DirectMessages, reactions) for a fixed duration and needs `waitUntil`. It is designed for serverless re-invocation; a long-lived server must loop it or hold the client open. `discord.js` is imported at the top level of the adapter.
- **Slack adapter** answers `url_verification` itself after signature verification. Socket mode starts inside `initialize()` (first webhook or explicit init), needs `appToken`, and makes `handleWebhook` return 405.
- **Teams** wraps `@microsoft/teams.apps` 2.1.0. Inbound JWT is validated against Bot Framework JWKS by the SDK; `webhookVerifier` replaces that. Public HTTPS URL is an Azure Bot registration requirement, not checked by the adapter.
- **`StateAdapter` contract** (17 methods; the `state-memory` reference): `connect` idempotent; subscriptions are a set with no expiry; `acquireLock` returns null while an unexpired lock exists, else creates `{threadId, token, expiresAt}`; `extendLock` requires token match and never creates or resurrects; `releaseLock` deletes only on token match, `forceReleaseLock` ignores the token; `set`/`setIfNotExists` treat `ttlMs` 0 or undefined as no expiry, expired entries are purged on read; `appendToList(key, value, {maxLength, ttlMs})` keeps the newest `maxLength` and resets TTL on every append; `enqueue` drops the oldest above `maxSize`, `dequeue` is FIFO and does not filter `expiresAt`; `disconnect` clears subscriptions, locks and queues but not the cache. SDK-written keys: `dedupe:*`, `slack:event-delivered:*`, `telegram:webhook-update:*`, `teams:aadObjectId:*`, `teams:userInfo:*`.
- **Attachments**: `Attachment = { type, data?, fetchData?: () => Promise<Buffer | ArrayBuffer>, url?, name?, mimeType?, size?, ... }`. All four adapters implement `fetchData`. Shared guard in `@chat-adapter/shared`: 25 MiB cap, 5 redirects, 30 s timeout, private-range `BlockList` on every hop, Content-Length and streaming enforcement. Slack accepts a custom `fileTransport`.
- **`history.thread`**: Slack (conversations.replies), Discord (REST messages), Teams (Graph; throws on 403 without `Chat.Read.*`), Telegram (in-process cache only, Bot API has no history endpoint).
- **Footprint**: 235 packages, 122 MB `node_modules`, no native `.node` binaries. Teams pulls `@microsoft/*` 57 MB plus `express`, `axios`, `jsonwebtoken`, `jwks-rsa`; Slack `@slack/web-api` + `@slack/socket-mode` + `ws`; Discord `discord.js` 14 + `undici`; Telegram only `chat` + `shared`.

**Insights:**
- `waitUntil` becomes a tiny in-process tracker (`trackBackground(promise)`): log + scrub on rejection, count in-flight for graceful shutdown. Pass it on every `chat.webhooks[adapter](req, {...})` call and to the listeners.
- Discord mentions need a supervised gateway loop in the API process (`startGatewayListener` re-armed on completion, or a persistent `discord.js` client via the forwarding path with `x-discord-gateway-token`). This is the one adapter that is not "webhook in, HTTP out". It is the heaviest runtime piece of v1 and deserves its own plan phase.
- Telegram in v1: the Integrations card gets a "Register webhook" action that calls Bot API `setWebhook` with our URL and the configured `secretToken`, and shows `getWebhookInfo`. Local dev uses `mode: "polling"`.
- The API Docker image grows by roughly 120 MB (today 381 MB). Import adapters dynamically only for configured entries, so unconfigured adapters cost disk but not boot time or memory. Teams is the bulk; acceptable for v1, revisit if image size becomes a gate.
- The SQL state tables map directly: `chat_state_kv(key PK, value JSON, expires_at)`, `chat_subscriptions(thread_id PK)`, `chat_locks(thread_id PK, token, expires_at)`, `chat_lists(key, seq, value, expires_at)` or JSON array in kv with the maxLength rule, `chat_queue(thread_id, seq, entry JSON)`. Each method is one statement under the async seam; `setIfNotExists` and `acquireLock` are `INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < now` returning changes.

## Synthesis

### Key Decisions
- Additive channel. Slack, AgentMail and Kapso stay untouched. Design so the Chat SDK Slack adapter could replace `src/slack` one day, but build no parity now.
- State: `StateAdapter` backed by dedicated SQLite tables (`chat_state_kv`, `chat_subscriptions`, `chat_locks`, `chat_queue`, lists), one migration, API-side only, through the async DB seam. Each method is one SQL statement, atomic by construction. (Revised from KV-backed after Taras's review comment: atomic append/dequeue, indexed depth, inspectable rows.) The channel-to-agent mapping stays in KV under `integrations:chat:channels`.
- Config: `CHAT_SDK_ENABLED` (boolean) + `CHAT_SDK_ADAPTERS` (JSON object keyed by adapter) as swarm_config keys with env fallback. Values may reference any swarm_config key as `{"$config": "KEY"}`, resolved at boot by a small reusable resolver (`src/be/config-refs.ts`). Resolved at boot; resolver-capable fields (`botToken`, `appId`, `applicationId`) get a function, plain-string fields (`signingSecret`, `publicKey`, `secretToken`, `appPassword`) get the resolved value. Per-adapter zod schemas validate in `VALIDATED_KEYS`. `restartRequired: true`. Type sketch:

```ts
type ConfigRef = { $config: string };             // resolves a swarm_config key (secret or plain) at boot
type Str = string | ConfigRef;

type ChatSdkAdapters = Partial<{
  slack:    { botToken: Str; signingSecret: Str; appToken?: Str; mode?: "webhook" | "socket"; userName?: string };
  discord:  { botToken: Str; publicKey: Str; applicationId: Str; respondToChannelIds?: string[]; respondToGlobalMentions?: boolean };
  telegram: { botToken: Str; secretToken: Str; mode?: "webhook" | "polling"; allowedUserIds?: string[] };
  teams:    { appId: Str; appPassword: Str; appTenantId?: Str; appType?: "MultiTenant" | "SingleTenant" };
}>;
// CHAT_SDK_ENABLED: boolean
// CHAT_SDK_ADAPTERS: ChatSdkAdapters  (stringified JSON in env; JSON column in swarm_config)
```
Unknown keys per adapter are passed through to the factory after validation, so SDK additions do not need a schema bump to be usable.
- Inbound: `onNewMention` / `onDirectMessage` create a task for the Lead, subscribe the thread, `contextKey = task:chat-sdk:{adapter}:{threadId}`. `onSubscribedMessage` on a live task becomes follow-up or steer via the existing paths. Optional KV mapping `{adapter}:{channelId}` to agent or workflow overrides the Lead.
- Outbound: terminal task state posts the store-progress summary to the originating thread. Delivery is a durable `chat_relay_obligations` row (written at task creation) drained by a Chat SDK watcher tick, mirroring `slack_relay_obligations`; the `task.completed` bus event may trigger an immediate attempt. One MCP tool `chat-reply`, scoped to the calling task's thread. Markdown text only.
- Task identity: new `source: "chat"` (one migration widening the CHECK). No new origin columns. Adapter and thread live in `contextKey`.
- Capability `chat-sdk` in `ALL_CAPABILITIES`, off by default, on when `CHAT_SDK_ENABLED` resolves true. MCP tools register only under it, and are mapped into the script SDK via `SDK_TOOL_NAME_MAP` (Taras's review comment). Proposed set:

| MCP tool | `ctx.swarm` | Purpose | Gate |
|---|---|---|---|
| `chat-reply` | `chat_reply` | Post markdown to the calling task's thread | task contextKey family `chat-sdk` |
| `chat-post` | `chat_post` | Post to an arbitrary `{adapter, threadId \| channelId}` (out-of-band) | capability only |
| `chat-open-dm` | `chat_openDm` | Open a DM with a user id, returns threadId | capability only |
| `chat-read-thread` | `chat_readThread` | Fetch recent messages of a thread (`history.thread`) | capability only |
| `register-chat-channel` / `unregister-chat-channel` | `chat_registerChannel` / `chat_unregisterChannel` | KV mapping `{adapter}:{channelId}` to agent or workflow | capability only, lead-equivalent |

Gating `chat-reply` needs `contextKey` added to `selectTaskTools` (`src/utils/task-tool-manifest.ts`) and its call site.
- Extensions from day one: `pre.chat.route` (modify target, or drop) and `post.chat.message` (observe inbound and outbound), mirroring the Slack pair.
- Seeded skill `templates/skills/chat-sdk/` for swarm agents.
- Mechanics modeled on `src/slack`: 10 s debounce thread buffer with `!now` and the thread-context template, router (`swarm#<uuid>`, `swarm#all`, thread owner, lead) plus the `pre.chat.route` hook, steer rule (lead, in-thread, no files, target `in_progress`) with follow-up fallback, draft-task-with-lease for file downloads, egress scrubbing, durable relay obligations. Not ported: render-v2, blocks, session-status, work-objects, progress message edits.
- Extension `pre.chat.route` modify shape: `{ target: {kind:"agent", agentId} | {kind:"lead"} | {kind:"broadcast"} | {kind:"workflow", workflowId} }`. Event carries `adapter, channelId, threadId, userId, text, botMentioned, isDirectMessage, threadContext?`.
- v1 adapters: Discord, Telegram, Slack, Teams. All four E2E-verified before merge.
- Slack clash: boot refuses `slack` in `CHAT_SDK_ADAPTERS` unless `SLACK_DISABLE=true`, evaluated on resolved config. The Integrations card shows the same conflict.
- In v1: inbound file attachments via Chat SDK `fetchData()`; full Integrations card (per-field form with `isSecret`, generated webhook URL per adapter, conflict error).
- Out of v1: rich rendering (cards, modals, streaming edits), multi-workspace OAuth installs.
- No `event-dedup.ts` port: the SDK's message-level dedup plus Slack retry handling and Telegram update_id claims cover redeliveries for all four adapters (verified in source).
- `waitUntil`: always passed. A small tracker catches and scrub-logs handler rejections and counts in-flight work for shutdown. `propagateHandlerErrors: true`.
- Discord: v1 runs a supervised Gateway listener loop in the API process (re-arm `startGatewayListener` on completion, abort on shutdown), since mentions and plain messages do not arrive over the interactions webhook. The interactions webhook route still exists for PING, slash commands and components. Own plan phase.
- Telegram: Integrations card action "Register webhook" calls Bot API `setWebhook` with our URL and `secretToken`, and displays `getWebhookInfo`. `mode: "polling"` for local dev, passed through.
- Adapters are imported dynamically only for configured entries; all four packages ship in the API image (about 120 MB, Teams is 57 MB of it). Of the Teams share, 45 MB is `@microsoft/teams.graph-endpoints`: a generated client for all of Microsoft Graph, 3755 files, one 24 MB `types.d.ts`. Only `history.thread` on Teams uses it. Teams-phase options: delete `**/*.d.ts` under `node_modules/@microsoft` in the image stage (about half), or stub the package via an override in `/opt/global-deps/package.json` at the cost of `chat-read-thread` on Teams. `@microsoft/teams.apps` also pulls `express` 5, `axios`, `@azure/msal-node`, `jsonwebtoken`, `jwks-rsa`.
- `chat-read-thread` documents per-adapter limits: Telegram returns only messages seen since boot; Teams needs `Chat.Read.*` Graph permission.
- Webhook route (v1 requirement, per Taras's review comment): `POST /api/integrations/chat/{adapter}/webhook` via `route()`, `auth: { apiKey: false }`, `rbac: { ungated: "provider webhook: adapter signature" }`, `unstructured` response. The handler passes the raw `Request` straight to `chat.webhooks[adapter](req, { propagateHandlerErrors: true, waitUntil })`; the adapter verifies the signature. 404 for adapters not in the config. The Integrations card shows the full URL per enabled adapter (built from `PUBLIC_MCP_BASE_URL`).
- Telegram may run in `mode: "polling"` (no public URL) by passing the SDK option through; webhook stays the default. Useful for local dev.
- Boot resilience: SDK init logs platform-API failures instead of throwing. We surface them on the Integrations card as adapter health, and never crash the API on a bad adapter token.

### Open Questions
Resolved in-session (see Facts sections): Bun compatibility, adapter config fields, terminal-effects plug point, tool gating mechanism, KV API, attachment store, secret-ref precedent, webhook route posture. Remaining, all fact-shaped for `/research`:
All earlier fact questions are resolved in the Facts sections above. Left for the planner to confirm while implementing:
- Whether `Chat` filters `QueueEntry.expiresAt` on dequeue itself (state-memory does not), to decide if the SQL `dequeue` should.
- Whether the Telegram adapter sets `persistMessageHistory` (adds the SDK-side history cache fallback for `chat-read-thread`).
- Exact `startGatewayListener` return/completion semantics for the re-arm loop (does it resolve on `durationMs`, on abort, on disconnect?).

### Constraints Identified
- API server is the sole DB owner. The state adapter and all Chat SDK code live in API-side `src/integrations/chat-sdk/`, never in worker dirs.
- All DB access through `getDbClient()`; post-commit side effects via `afterCommit`.
- New routes via `route()` with RBAC posture and response schema; then `bun run docs:openapi`.
- MCP tools return `SwarmToolResult` with `swarmToolOutputSchema`; register in `SDK_TOOL_NAME_MAP` or exclude with reason.
- New extension events need contract entries, `build:extension-types`, fixtures, operator guide rows.
- Seeded skill must not collide with any baked skill name; run the three `check:skill-*` gates.
- New operator env vars go into the Configuration catalog and the docs page in the same PR.
- Outbound text passes `scrubSecrets` at egress.
- Chat SDK is beta with fast 4.x churn. Pin exact versions and add a renovate-style bump cadence.
- Bun compatibility is unverified. Treat the spike as the first gate.

### Core Requirements
- Operator enables Chat SDK with one flag and one adapter config object, from env or the dashboard, with secrets by reference.
- Each enabled adapter has a signed webhook endpoint the dashboard displays.
- A mention or DM on any enabled adapter creates a Lead task within one buffer window; thread replies steer or follow up the live task.
- Task completion posts the summary back to the originating thread; agents can reply mid-task via `chat-sdk-reply`.
- Inbound attachments reach the task.
- Operators can intercept routing and observe messages via extensions.
- Agents receive a seeded skill describing the channel.
- Boot fails loudly on a Slack double-configuration.
- Tasks show `source: "chat"` in the UI and to extension consumers.

## Next Steps

- Background research done (2026-10-13). The brainstorm is planning-ready.
- Next: `/desplega:create-plan` with this file as input. Suggested phase cut: (1) migration + state tables + config refs + capability + webhook route with Telegram polling E2E, (2) inbound pipeline (buffer, router, steer, extensions, attachments) + relay obligations + tools + skill, (3) Slack and Teams adapters + clash guard, (4) Discord gateway loop, (5) Integrations card + docs.
- Spike artifacts: `/tmp/chat-sdk-spike` (Bun + Telegram webhook smoke test, installed 4.41.1 dist for reference).
