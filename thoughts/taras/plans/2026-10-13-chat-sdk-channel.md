---
date: 2026-10-13
author: Taras
topic: "Chat SDK (chat-sdk.dev) as a swarm input/output channel"
status: completed
last_updated: 2026-10-14
last_updated_by: Claude (phase 6 agent)
autonomy: verbose
commit_per_phase: true
brainstorm: thoughts/taras/brainstorms/2026-10-13-chat-sdk-channel.md
---

# Chat SDK Channel Implementation Plan

## Overview

Add Vercel's Chat SDK (`chat@4.41.1`) as an additive input/output channel for the swarm, next to the bespoke Slack, AgentMail and Kapso integrations. One `Chat` instance, four adapters in v1 (Telegram, Slack, Teams, Discord), SQLite-backed state, durable outcome relay, MCP tools, extension hooks, a seeded skill and a full Integrations card.

- **Motivation**: Taras wants a single abstraction to add chat platforms (Discord, Telegram, Teams) without one bespoke integration per platform.
- **Related**: `thoughts/taras/brainstorms/2026-10-13-chat-sdk-channel.md` (all decisions), `/tmp/chat-sdk-spike` (Bun + Telegram smoke test, installed 4.41.1 dist)

## Current State Analysis

Research ran on 2026-10-13 against main `0e1962094` and the installed Chat SDK 4.41.1 dist in `/tmp/chat-sdk-spike/node_modules`. Items marked **(corrects brainstorm)** change a brainstorm assumption.

### Channels today

- No generic channel interface. Slack (`src/slack/`), AgentMail and Kapso (`src/integrations/kapso/{client,config,inbound}.ts`) are bespoke. Kapso is the lightest and reads config per request through `getKapsoConfig()` (`src/integrations/kapso/config.ts:51-68`): swarm_config global scope first, `process.env` fallback, no cache.
- Capabilities: `ALL_CAPABILITIES` (`src/server.ts:211-234`), `DEFAULT_CAPABILITIES` (`:239-266`, kapso commented out = default off), `getEnabledCapabilities()` (`:283-290`) drops `slack` unless socket mode. Tools register under `if (hasCapability("kapso"))` (`:673-678`). Tool names also go in `src/tools/tool-config.ts:124-128`.
- Webhook routes (`src/http/webhooks.ts`): Kapso route at `:173-193` uses `auth: { apiKey: false }`, typed 200, 401, 503, and reads the raw body with `for await (const chunk of req)`. Kapso and AgentMail omit `rbac`. Azure DevOps (`:141-158`) carries the explicit `rbac: { ungated: "provider webhook: ..." }` posture. Copy the Azure form. `src/http/all-routes.ts:73` already imports `./webhooks`.
- Config guard: `VALIDATED_KEYS: Record<string, (value: unknown) => string | null>` (`src/be/swarm-config-guard.ts:67,229`). `SLACK_DISABLE` (`:382`) and `AGENTMAIL_DISABLE` (`:390`) are boolean validators. `RESERVED_KEYS` (`:27-32`). PUT `/api/config` on global scope calls `scheduleIntegrationsReload()` (`src/http/config.ts:484-492,521`), which runs `reloadGlobalConfigsAndIntegrations()` in `src/http/core.ts:~145-250`. Kapso is not reinitialized there because it holds no clients.
- Public URL: `getPublicMcpBaseUrl()` in `src/utils/constants.ts:71`. Kapso's webhook URL is `${getPublicMcpBaseUrl()}/api/integrations/kapso/webhook`.
- Boot: `src/http/index.ts` listen callback starts `startSlackApp()` in try/catch at `:760` ("one integration, not the boot path"), then GitHub, GitLab, Azure DevOps, AgentMail, Linear, Jira, workflows, script supervisor, scheduler, heartbeat. `shutdown()` (`:473-567`) stops the scheduler, heartbeat, supervisor, `drainApi()`, `stopSlackApp()`, then `httpServer.close`, `closeDb()`, `process.exit(0)`. Single process, no cluster.

### Task identity

- **(corrects brainstorm)** `agent_tasks.source` has no SQL CHECK constraint. `056_drop_agent_tasks_source_check.sql:1-12` dropped it and made `AgentTaskSourceSchema` (`src/types.ts:379-394`) the single source of truth. `comb` was added later with no migration. Adding `"chat"` needs no migration.
- Adding a source touches: `src/types.ts:393`, three hand-edited unions in `apps/ui/src/api/types.ts` (`:25-31`, `~1262`, `~3048`), the icon map in `apps/ui/src/components/shared/tasks-table.tsx:126`, `task-source-line.tsx`, `people/integration-icons.tsx`, plus regenerated `openapi.json` and `src/extensions/contract-types.generated.ts`.
- Context keys: `ContextKeyFamily = "slack"|"agentmail"|"trackers"|"schedule"|"workflow"` (`src/tasks/context-key.ts:41`). Adding a family touches the header comment (`:15-27`), `ParsedContextKey` (`:45`), a builder next to `slackContextKey` (`:92`), a `case` in `parseContextKey` (`:213`). **`assertSafePart` (`:78`) throws on `:`.** Chat SDK thread ids are `<adapterName>:<platform id>` and contain colons, so the thread id must be encoded inside the key.
- `createTaskExtended(task, options)` (`src/be/db.ts:2411`) accepts `source`, `taskType`, `tags`, `priority`, `dependsOn`, `contextKey`, `status: draft|backlog|unassigned`, `parentTaskId`, `requestedByUserId`. Follow-ups inherit `contextKey` from the parent (`db.ts:2593`). `promoteDraftTask(taskId)` (`db.ts:3240`) is idempotent.
- Slack-hardcoded thread lookups that need contextKey-based twins: `getAgentWorkingOnThread` (`src/be/db/tasks/read.ts:1271`), `getLatestActiveTaskInThread` (`:1294`), `getLatestLeadTaskInThread` (`:1317`). All filter on `source='slack' AND slackChannelId AND slackThreadTs`.
- Steering source enum `SteeringSourceSchema = ui|mcp|script|slack|api` (`src/types.ts:449`) needs `"chat"`.

### Outcome delivery (Slack relay)

- **(corrects brainstorm)** `slack_relay_obligations` rows are written by two SQL triggers in `144_slack_relay_obligations.sql:23-44`, not by app code. They fire AFTER UPDATE OF status (and AFTER INSERT) when the new status is terminal, `source='slack'`, and `slackChannelId`/`slackThreadTs` are non-null. `INSERT OR IGNORE`, same transaction as the status change.
- Drain: `startTaskWatcher(3000)` (`src/slack/watcher.ts:622`), `processPendingSlackRelays(now)` (`:517-620`), read `getPendingSlackRelayTasks` (`src/be/db/tasks/read.ts:980-993`, LIMIT 200, never-attempted first), claim `markSlackRelayAttempted` (`:995`) before send, ack `markSlackRelayDelivered` (`:1009`, idempotent via `WHERE delivered_at IS NULL`). No attempt cap. Posted text is `task.output || "Task completed."` (`src/slack/responses.ts:141`).
- Scrubbing is global for Slack: `installSlackEgressScrub()` patches `WebClient.prototype.apiCall` (`src/slack/egress-scrub.ts:75`). Chat SDK has no such hook, so `scrubSecrets` must be called at each send point.
- `workflowEventBus` (`src/workflows/event-bus.ts`) emits `task.completed|failed|cancelled` inside `afterCommit` (`src/be/db/tasks/write.ts:474,575,705`). In-process only. `src/jira/outbound.ts:58-80` is the precedent for subscribing from an integration. `runTaskTerminalEffects` (`src/tasks/task-terminal-effects.ts:27`) never sees cancellations and is fire-and-forget. Do not hook delivery there.

### Slack inbound mechanics to lift

- Generic buffer: `createAdditiveBuffer<T>({timeoutMs, onFlush(items, key, reason), label})` (`src/tasks/additive-buffer.ts:75`), returns `{enqueue, isBuffered, count, instantFlush, cancel, keys}`. The Slack wrapper `src/slack/thread-buffer.ts:49-98` keys on `channelId:threadTs` and splits on the first colon (unsafe for Chat SDK ids). `ADDITIVE_SLACK_BUFFER_MS` is read at `:37` (`|| 10_000`). `!now` handler at `src/slack/handlers.ts:517-553`. Flush sets `dependsOn = [latestActiveTask.id]` (`:286`) and `parentTaskId` (`:297-312`).
- Router: `routeMessage(text, botUserId, botMentioned, threadContext?) -> AgentMatch[]` (`src/slack/router.ts:38`), `isAgentReachable` filter (`:48-49`), `swarm#<uuid>` (`:52-59`), `swarm#all` (`:24`), thread owner via `getAgentWorkingOnThread` (`:81`), lead fallback (`:94-105`).
- Steering: `requestSlackThreadSteering(...)` (`src/slack/steering.ts:38`) wraps `requestSteering` from `src/be/steering.ts:218`. Rule: steering enabled, `SLACK_THREAD_STEERING=lead|all`, target `in_progress`, mode `steer` only when `SLACK_THREAD_STEERING_MODE=steer`, `onUnsupported: "degrade"`, `createdByKind: "user"`. Null result means create a task.
- Extension hook: `dispatchPre("pre.slack.route", payload, {validateModify})` at `src/slack/handlers.ts:606-626`; block returns `ignoreSlackInbound("extension_blocked")` (`:629`); modify with extension-identity agents rejected (`:636-665`). Task creation goes through `createSlackTaskWithFiles` (`src/slack/inbound-files.ts:286`) then `createTaskWithSiblingAwareness(description, options, {origin: "slack"})` (`src/tasks/sibling-awareness.ts:169`).
- Files: draft task with `refreshDraftTaskLease` every 60 s (`inbound-files.ts:52`), `attachSlackFilesToTask` (`:341`) dedups by sha256, uploads via `getFileStorageProvider().upload(scope, Bun.file(path), {...})` (`src/fs/provider.ts:88`), records with `recordTaskAttachmentUpload` (`src/be/task-attachment-store.ts:30`), `promoteDraftTask` in `finally`. `buildAttachmentText` (`:101`) takes `SlackFile[]`.
- Templates: `registerTemplate(...)` (`src/prompts/registry.ts:33`), `resolveTemplate("slack.message.thread_context", {thread_messages})` (`handlers.ts:711`, defined `src/slack/templates.ts:56-69`). Template names are enumerated in `src/be/seed-scripts/catalog/ops-catalog-audit.ts:41` and `.inline.ts:41`.
- `src/slack/inbound-dispatch.ts` is a Bolt-coupled durable receipt layer. Not needed: Chat SDK dedups itself.

### Extensions, skills, UI, docs

- Contract: `SlackRouteEvent` (`src/extensions/contract.ts:171-178`), `SlackRouteModify` (`:180-182`), `SlackMessageEvent` (`:231-237`), `KapsoMessageEvent` (`:283-292`), map entries at `:350,371,375`. New event steps: contract, `bun run build:extension-types` (regenerates `contract-types.generated.ts` and `src/scripts-runtime/types/swarm-extension.d.ts`), a `case` in `src/extensions/dispatcher.ts:~156-175` (subject must not carry message text), `dispatchPre`/`dispatchPost` call, fixture under `src/tests/fixtures/extensions/<name>/{manifest.json,hooks.ts}` (model: `route-channel-to-agent`), a row in `docs-site/content/docs/(documentation)/guides/extensions.mdx:204-223`, a line in `runbooks/extensions.md:305`.
- **(corrects brainstorm)** `kapso-whatsapp` is not in `BUILT_IN_SKILL_SOURCES` (`src/be/seed-skills/index.ts:319+`). It installs from GitHub through the catalog's `recommendedSkills` (`source: "template"`). CLAUDE.md prefers seeding, so the Chat SDK skill will be seeded.
- Integrations catalog field kinds are `text|password|textarea|select|boolean` (`apps/ui/src/lib/integrations-catalog.ts:14`). No json, action or read-only kind. Custom sections go through `SPECIAL_FLOWS` in `apps/ui/src/components/integrations/special-flows.tsx` (typed record, model: `jira-oauth-section.tsx` with `useJiraTrackerStatus`). `deriveIntegrationStatus` (`apps/ui/src/lib/integrations-status.ts:~65`) has a Slack mode special case at `:80-92`. The card page is `apps/ui/src/pages/integrations/[id]/page.tsx`, saving through `PUT /api/config?includeSecrets=true`. The setup wizard has its own list in `apps/ui/src/pages/setup/steps/integrations/catalog.ts`. No integration health endpoint exists; `src/http/status.ts:~460-520` `slackMilestone` is the nearest precedent.
- Docs: `docs-site/content/docs/(documentation)/integrations/kapso.mdx` (sections: What it does, Setup, How it works, Outbound updates, Reference), `integrations/index.mdx:31`, `integrations/meta.json:13`, `guides/extensions.mdx`, `ui/configuration.mdx`, `MCP.md:20` capability list and `:2206` Kapso tool section.

### Packaging

- The API image compiles `src/http.ts` with `bun build --compile` (`Dockerfile:87-88`) on `oven/bun:1.4.0` and ships only the binary on `debian:bookworm-slim`. No `node_modules` in the final image. Packages must be root `package.json` deps with `bun.lock` committed. Literal-path `await import("chat")` and static imports both get bundled. No `--external`.
- `.dependency-cruiser.cjs` enforces worker/DB boundaries only. Chat code under `src/integrations/chat-sdk/` and `src/tools/` is API-side and allowed.
- Unverified: `chat`, `discord.js`, `@slack/socket-mode`, `@microsoft/teams.apps` under `bun build --compile`. A trial compile is a Phase 1 gate.

### Chat SDK 4.41.1 facts that shape the design

- `new Chat({adapters: Record<name, Adapter>, state, userName, concurrency?, dedupeTtlMs?, history?, lockScope?, logger?})`. Record keys must equal adapter names (`slack`, `telegram`, `discord`, `teams`) because thread ids are prefixed with the adapter name. `concurrency` default is `"drop"`; `ConcurrencyConfig` has `strategy`, `debounceMs`, `maxQueueSize`, `queueEntryTtlMs`, `maxLockLifetimeMs`.
- `propagateHandlerErrors` and `waitUntil` are per-request `WebhookOptions`, not constructor options.
- **(corrects brainstorm)** `chat.thread(threadId)` takes one argument and splits on `:` to find the adapter. `thread.post(string)` sends raw text; use `thread.post({markdown})`. It returns `SentMessage` with `.id`.
- Handlers: `onNewMention(thread, message, ctx?)`, `onDirectMessage(thread, message, channel, ctx?)`, `onSubscribedMessage(thread, message, ctx?)`, `onNewMessage(regex, h)`, `onSlashCommand`, `onReaction`. Routing order: DM, subscribed, mention, regex. `onNewMention` fires only on unsubscribed threads. `author.isMe` messages are dropped. `Message = {id, threadId, text, author: {userId, userName, fullName, isBot, isMe}, attachments: {type, url?, name?, mimeType?, size?, data?, fetchData?}[], isMention?, raw}`. `thread.id`, `thread.channelId`, `thread.adapter.name`, `thread.isDM`, `thread.subscribe()`.
- `StateAdapter` import: `import type { StateAdapter, Lock, QueueEntry } from "chat"`. 17 methods. **The core filters `QueueEntry.expiresAt` on dequeue itself**, so the SQL adapter does not. `enqueue`/`dequeue` run only for `queue|debounce|burst` strategies. Dedupe key `dedupe:<adapter>:<message.id>` with `setIfNotExists`.
- Lifecycle: `chat.initialize()`, `chat.shutdown()` (calls each adapter's `disconnect?.()` then `state.disconnect()`). **`doInitialize` uses `Promise.all`; one adapter failure poisons `initPromise` permanently and every later webhook rethrows it.** Adapter health must be tracked outside `Chat`.
- Telegram: `apiUrl` overrides the Bot API base (mockable in tests). Constructor throws on missing token, or `mode: "webhook"` without `secretToken`/`allowUnverifiedWebhooks`. `getMe` runs in `initialize()` and failure is only a warn. `startPolling`, `stopPolling`, `disconnect()`, `resetWebhook()`. **(corrects brainstorm)** No `persistMessageHistory`; it sets `persistThreadHistory = true`.
- Discord: constructor requires `botToken`, `applicationId`, and `publicKey` or `webhookVerifier`. `startGatewayListener(options, durationMs = 180000, abortSignal?, webhookUrl?)` returns a 200 Response immediately and hands the real promise to `options.waitUntil`. The inner promise resolves on `durationMs` or abort, never rejects, and `client.destroy()` runs in `finally`. **Discord has no `disconnect()`**, so `chat.shutdown()` does not stop the gateway. `discord.js` is a top-level import; `@discordjs/ws` imports `worker_threads` at top level.
- Slack: `mode: "webhook"|"socket"`, socket mode starts in `initialize()`, `handleWebhook` returns 405 in socket mode. Constructor throws for webhook mode without `signingSecret`. Has `disconnect()`. Teams: `appId`, `appPassword`, `appType`, `appTenantId`, `webhookVerifier`; `initialize()` rethrows.
- Adapters read `process.env` fallbacks (`TELEGRAM_*`, `DISCORD_*`, `SLACK_BOT_TOKEN`, ...) and default to `ConsoleLogger`. Pass explicit config and a scrubbing logger to `Chat` and every adapter.

### Testing precedents

- Kapso: `src/tests/kapso-inbound.test.ts` runs in process with `initDb("./test-kapso-inbound.sqlite")`, a fake req/res into `handleWebhooks(req, res, path)`, and a swapped `globalThis.fetch`. `kapso-client.test.ts` swaps `fetch` per test.
- Tool presence per capability: `src/tests/enabled-tools.test.ts:30-50` (`toolNames(opts)` reads `_registeredTools`). `selectTaskTools`: `src/tests/task-tool-manifest.test.ts`.
- Migrations: `migration-208-task-runtime-dispatch.test.ts` (in-memory `Database(":memory:")` + the `.sql` file), `migration-runner-regressions.test.ts` (`initDb` fresh and incomplete).
- Extensions: `extensions-example-route-slack-channel.test.ts` with `loadBundleFixture`.
- Black-box E2E: `scripts/e2e/scenarios/*.ts` with unique `order`; no scenario posts to a webhook yet. `scripts/e2e/http.ts` has the HTTP helpers.
- Migration ordinals: main tail is 208; open PRs take 209 (#2082), 210 (#2082), 211 (#2098), 212 (#2099). First free ordinal is **213**. Re-check at implementation time with `bash scripts/check-migration-conflicts.sh`.
- New tables without `created_by`/`updated_by` need one line each in `.non-audit-tables` (`scripts/check-audit-columns.ts:60-71`).

## Desired End State

An operator sets `CHAT_SDK_ENABLED=true` and `CHAT_SDK_ADAPTERS` (env or dashboard, secrets by `{"$config": "KEY"}` reference). The API boots one `Chat` instance per configured adapter over a SQLite `StateAdapter`, exposes `POST /api/integrations/chat/{adapter}/webhook`, and registers the `chat-*` MCP tools under the `chat-sdk` capability. A mention or DM on Telegram, Slack, Teams or Discord creates a Lead task with `source: "chat"` and `contextKey: task:chat-sdk:{adapter}:{encodedThreadId}` after a 10 s buffer window. Thread replies steer or follow up the live task. Inbound attachments land as task attachments. A terminal task state posts the output back to the originating thread through a durable `chat_relay_obligations` row. Agents reply mid-task with `chat-reply`. Operators intercept routing with `pre.chat.route` and observe traffic with `post.chat.message`. Agents get the seeded `chat-sdk` skill. The Integrations card shows per-adapter fields, webhook URLs, adapter health, a Telegram "Register webhook" action and the Slack clash error. Boot refuses `slack` in `CHAT_SDK_ADAPTERS` unless `SLACK_DISABLE=true`.

Verification: each phase ends with a webhook-driven test against a mock platform API (`apiUrl`), plus the CI gate commands in Quick Verification Reference. The Manual E2E at the end runs all four adapters against real bots.

## What We're NOT Doing

- Rich rendering: cards, modals, blocks, streaming edits, progress message edits (`render-v2.ts`, `blocks.ts`, `session-status.ts`, `work-objects.ts` are not ported).
- Multi-workspace OAuth installs (`clientId`/`installationProvider` on Slack, Teams multi-tenant install flows).
- Replacing or touching `src/slack`. The bespoke Slack integration stays as is.
- Porting `src/slack/inbound-dispatch.ts` (Bolt receipt layer). Chat SDK dedups by message id, Slack retry header and Telegram update id itself.
- Hot reload of `CHAT_SDK_ADAPTERS`. Both keys are `restartRequired: true`; `reloadGlobalConfigsAndIntegrations` is not extended.
- Slash commands, reactions, `onNewMessage(regex)` handlers.
- Outbound files from agents to chat threads.
- Shrinking the Teams dependency footprint (`@microsoft/teams.graph-endpoints`, about 45 MB of `.d.ts`). Measured and noted in Phase 4, acted on only if the image size gate fails.

## Implementation Approach

- **Additive, Slack-shaped, Kapso-placed.** Code lives in `src/integrations/chat-sdk/` plus `src/tools/chat-*.ts`. Mechanics copy `src/slack` (buffer, router, steer, draft-task files, relay obligations). Config, capability and webhook posture copy Kapso.
- **One `Chat` per adapter.** `Map<adapterName, Chat>` sharing one SQLite `StateAdapter` and one handler-registration function. A failing adapter never poisons the others. Health is the per-instance `initialize()` outcome plus logger warnings.
- **State in dedicated tables, one statement per method.** `chat_state_kv`, `chat_subscriptions`, `chat_locks`, `chat_lists`, `chat_queue` through `getDbClient()`. No KV reuse for SDK state. The channel-to-agent mapping stays in KV under a reserved `integrations:chat` namespace.
- **Identity by `contextKey` only.** `source: "chat"` (zod + UI, no migration), `contextKey = task:chat-sdk:{adapter}:{encodeURIComponent(threadIdWithoutAdapterPrefix)}`. Follow-ups inherit `contextKey` already. Thread lookups get contextKey-based twins of the Slack SQL helpers.
- **Outbound is a durable obligation.** Migration adds `chat_relay_obligations` with triggers mirroring migration 144, gated on `source='chat' AND contextKey LIKE 'task:chat-sdk:%'`. A watcher tick drains it. `task.completed` on the event bus triggers an early tick. `scrubSecrets` at every send.
- **`waitUntil` always passed.** A small in-process tracker catches and scrub-logs rejections, counts in-flight work, and drains with a bounded timeout in `shutdown()` before `closeDb()`.
- **Secrets by reference.** `{"$config": "KEY"}` resolved at boot by a generic `resolveConfigRefs` in `src/be/config-refs.ts`. Resolver-capable fields get a function, plain-string fields get the value. Adapters get explicit config plus a scrubbing logger. No env fallbacks are relied on.
- **Telegram first.** Telegram is webhook-in, HTTP-out, has `apiUrl` for a mock server, and ships only `chat` + `shared`. It is the Phase 1 vertical slice. Slack and Teams follow the same shape. Discord's gateway loop is its own phase.
- **Compile gate early.** `bun build --compile` with all four adapters runs in Phase 1 before any other work, because the API image ships a single binary.
- **Sequencing.** Foundation + Telegram slice → inbound pipeline + extensions → outbound relay + tools + skill → Slack + Teams + clash guard → Discord gateway → Integrations card + docs. Each phase leaves main deployable with the feature off by default.

## Quick Verification Reference

Copied from CLAUDE.md and LOCAL_TESTING.md. Run from the repo root.

```bash
bun run check                                   # frozen install, Biome on changed files, tsgo, affected tests
bun run test:root -- src/tests/<file>.test.ts   # one test file
bun run test:root -- --parallel=4               # full root suite as CI runs it
bun run tsc:check:tsc                           # tsc 5, the CI authority
bun run lint:slop
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bash scripts/check-migration-conflicts.sh
bash scripts/check-audit-columns.sh
bun run check:rbac-coverage
bun run check:openapi-response-coverage
bun run docs:openapi                            # after any route change; commit openapi.json + docs-site api-reference
bun run build:extension-types                   # after contract.ts changes; commit both generated files
bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files
bun run e2e                                     # black-box contract suite
DESPLEGA_TELEMETRY_ENV=test bun run start:http  # local API on :3013
```

`bun run lint` aborts on this Mac (memory note). Use `bun run check` plus the sandbox-lint recipe from the memory file for whole-scope lint.

---

## Phase 1: Foundation + Telegram vertical slice

### Overview

When this phase is done, the API boots with `CHAT_SDK_ENABLED=true` and a Telegram entry in `CHAT_SDK_ADAPTERS`, a Telegram update POSTed to `/api/integrations/chat/telegram/webhook` creates a Lead task with `source: "chat"` and a `task:chat-sdk:telegram:...` contextKey, and the compiled API binary bundles all four adapters. No buffer, router, relay or tools yet.

### Changes Required:

#### 1. Dependencies and compile gate
**File**: `package.json`, `bun.lock`
**Changes**: Add exact pins `"chat": "4.41.1"`, `"@chat-adapter/telegram": "4.41.1"`, `"@chat-adapter/slack": "4.41.1"`, `"@chat-adapter/discord": "4.41.1"`, `"@chat-adapter/teams": "4.41.1"`. Run `bun install` (Bun 1.4.0 lockstep, see `check:bun-version`). Do this FIRST and run the compile gate (Automated Verification below) before any other change. If an adapter fails under `bun build --compile`, stop and report to Taras with the error. Options then are on-disk staging like `vec0.so` or dropping that adapter from v1.

#### 2. Adapter loader
**File**: `src/integrations/chat-sdk/adapters.ts` (new)
**Changes**: `loadAdapter(name: "telegram"|"slack"|"discord"|"teams", config, logger)` with four literal-path `await import("@chat-adapter/<name>")` branches (literal paths get bundled by `bun build`; a computed specifier does not). Each branch constructs the adapter with explicit config plus `logger`. `apiUrl` is injected only from `CHAT_SDK_API_URL_OVERRIDES` (JSON by adapter name, a RESERVED_KEYS env-only variable, see item 6), never from operator config: an operator-writable base URL plus a `$config` ref would send secrets to an arbitrary host. Teams and Discord branches exist now so the compile gate covers them; they are only exercised in Phases 4 and 5.

#### 3. Migration
**File**: `src/be/migrations/213_chat_sdk_state.sql` (new; re-check the ordinal with `bash scripts/check-migration-conflicts.sh` and `gh pr list` first; 209-212 are taken by open PRs as of 2026-10-13)
**Changes**:
- `chat_state_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`.
- `chat_subscriptions(thread_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (strftime(...)))`.
- `chat_locks(thread_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)`.
- `chat_lists(key TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (key, seq))`.
- `chat_queue(id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, entry TEXT NOT NULL)` plus `idx_chat_queue_thread(thread_id, id)`.
- `chat_relay_obligations` copied column-for-column from `144_slack_relay_obligations.sql` (audit columns included) plus `given_up_at TEXT` and `last_error TEXT` (Slack has no attempt cap and retries a poison row forever; Phase 3 caps attempts and records why), the partial pending index extended with `AND given_up_at IS NULL`, and two triggers `enqueue_chat_relay_after_terminal_update` / `_insert` with the WHEN clause `NEW.contextKey GLOB 'task:chat-sdk:*' AND (NEW.source = 'chat' OR (NEW.source = 'system' AND NEW.taskType = 'follow-up'))` (the column is camelCase `contextKey`, see `042_task_context_key.sql:4`; `GLOB` because `LIKE` is case-insensitive in SQLite). The `system` + `follow-up` arm covers lead follow-ups, which `src/tasks/worker-follow-up.ts:402-403` creates with `source: "system", taskType: "follow-up"` and which inherit the chat contextKey (`db.ts:2593`); without it only the lead's first output ("delegated to X") would reach the user. `resume` and `reroute-decision` follow-ups are excluded on purpose. Same OLD/NEW status conditions as 144.
- No adapter column: Chat SDK thread ids and SDK-written keys already carry the adapter prefix.
**File**: `.non-audit-tables`
**Changes**: Add `chat_state_kv`, `chat_subscriptions`, `chat_locks`, `chat_lists`, `chat_queue`, each with a `# Chat SDK StateAdapter rows, no user attribution (213)` comment.

#### 4. SQLite StateAdapter
**File**: `src/integrations/chat-sdk/state.ts` (new)
**Changes**: `class SqliteChatState implements StateAdapter` (`import type { StateAdapter, Lock, QueueEntry } from "chat"`). Every method is one statement or one short `getDbClient().transaction`, never raw `getDb()`:
- `connect()` idempotent no-op; `disconnect()` is a no-op (the memory adapter clears subscriptions on disconnect because it is memory; a durable store must keep "we own this thread" across restarts; locks expire by TTL).
- `subscribe`/`unsubscribe`/`isSubscribed` on `chat_subscriptions`.
- `acquireLock(threadId, ttlMs)`: `INSERT ... ON CONFLICT(thread_id) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at WHERE chat_locks.expires_at <= ?now`, return the lock when `changes > 0`, else `null` (same shape as `claimKv`, `src/be/db.ts:13715-13731`). `extendLock`: `UPDATE ... WHERE thread_id=? AND token=? AND expires_at > ?now`, returns `changes > 0`. `releaseLock`: `DELETE WHERE thread_id=? AND token=?`. `forceReleaseLock`: `DELETE WHERE thread_id=?`.
- `get`/`set(ttlMs)`/`setIfNotExists(ttlMs)`/`delete` on `chat_state_kv`; `ttlMs` of 0 or undefined means no expiry; expired rows are deleted on read.
- `appendToList(key, value, {maxLength, ttlMs})` in a transaction: insert with `seq = COALESCE(MAX(seq), 0) + 1`, delete rows outside the newest `maxLength`, reset `expires_at` on every row of the key. `getList` returns unexpired rows by `seq`.
- `enqueue(threadId, entry, maxSize)`: insert, delete oldest beyond `maxSize`, return the count. `dequeue`: transaction select-oldest-then-delete. `queueDepth`: count. No `expiresAt` filtering (the core does it on dequeue, `chat/dist/index.js:2521,2587`).
- `sweepExpired(now)` deletes expired `chat_state_kv`, `chat_lists`, `chat_locks` rows. Called from the Phase 3 watcher tick; exported now for tests.

#### 5. Config reference resolver
**File**: `src/be/config-refs.ts` (new)
**Changes**: `resolveConfigRefs<T>(value: unknown, lookup: (key: string) => string | undefined): T`. Walks arrays and objects, replaces every `{ "$config": "KEY" }` leaf with `lookup(KEY)`, collects missing keys and throws one error listing them. Pure, no DB import. `isConfigRef(x)` guard exported.

#### 6. Chat SDK config
**File**: `src/integrations/chat-sdk/config.ts` (new)
**Changes**:
- `ChatSdkAdaptersSchema`: `z.object({ telegram, slack, discord, teams }).partial()`, each adapter a `z.looseObject` with the fields from the brainstorm type sketch where `Str = z.union([z.string(), ConfigRefSchema])`. Unknown keys pass through, except `apiUrl`, `apiBaseUrl` and `webhookVerifier`, which the schema rejects (operator-supplied base URLs exfiltrate `$config` secrets; a verifier bypasses signature checks). Every adapter accepts an optional `userName` (default `"swarm"`): `ChatConfig.userName` is required by the SDK and drives mention detection.
- `readChatSdkEnv()` reads `CHAT_SDK_ENABLED` and `CHAT_SDK_ADAPTERS` from `process.env` AFTER `loadGlobalConfigsIntoEnv(true)` has run (`src/http/core.ts:81`), which is how `SLACK_DISABLE` is read today. Stored swarm_config wins over the deployment env by that mechanism. Verify during implementation that secret rows are injected too (`getInjectableGlobalConfigs`); if not, fall back to `getSwarmConfigs` like `src/integrations/kapso/config.ts:51-58`.
- `getChatSdkConfig(): { enabled: boolean; adapters: Record<AdapterName, ResolvedAdapterConfig>; error?: string }`. Parses the JSON, validates with the schema, resolves refs with `resolveConfigRefs(json, lookupSwarmConfig)`, where `lookupSwarmConfig` reads decrypted global `swarm_config` rows through `getSwarmConfigs` (the `src/integrations/kapso/config.ts:51-58` path) and never `process.env`, and throws on any key in `RESERVED_KEYS` (`src/be/swarm-config-guard.ts:27-32`). Reason: leads can write ordinary global config, and an env-backed lookup would let `{"$config":"API_KEY"}` leave the host. Env-only deployments put raw values in `CHAT_SDK_ADAPTERS` (decided 2026-10-14). Resolver-capable fields (`botToken`, `appId`, `applicationId`) become `async () => value` functions; plain-string fields get the value.
- `assertNoSlackClash(config)`: throws `ChatSdkConfigError("CHAT_SDK_ADAPTERS.slack conflicts with the built-in Slack integration; set SLACK_DISABLE=true to use the Chat SDK Slack adapter")` when `adapters.slack` exists and `SLACK_DISABLE` does not resolve to true. Evaluated on resolved values. Boot calls it before constructing anything and logs + skips the whole Chat SDK start on error (does not crash the API, matching `startSlackApp` isolation at `src/http/index.ts:760`).
**File**: `src/be/swarm-config-guard.ts`
**Changes**: `CHAT_SDK_ENABLED` joins the boolean validator list next to `SLACK_DISABLE` (`:382`). `CHAT_SDK_API_URL_OVERRIDES` joins `RESERVED_KEYS` (`:27-32`) so it is env-only and never injected from a swarm_config row; `loadAdapter` reads it to point Telegram and Slack at a mock in tests and local QA. `CHAT_SDK_ADAPTERS` gets a validator that `JSON.parse`s and runs `ChatSdkAdaptersSchema.safeParse` (no ref resolution), returning the first issue path as the error string.
**File**: `apps/ui/src/lib/configuration-catalog.ts`
**Changes**: Add `CHAT_SDK_ENABLED` (group Integrations, kind boolean, default `false`, `restartRequired: true`, `docsUrl: ${DOCS}integrations/chat-sdk`). `CHAT_SDK_ADAPTERS` is JSON and belongs to the Phase 6 Integrations card, not this catalog.

#### 7. Runtime: one Chat per adapter, logger, waitUntil tracker
**File**: `src/integrations/chat-sdk/logger.ts` (new)
**Changes**: `createScrubbingLogger(prefix)` implementing the SDK `Logger` interface (`debug/info/warn/error/child`), passing every argument through `scrubSecrets` (`src/utils/secret-scrubber.ts`) before `console.*`. Records `warn`/`error` entries per adapter into the health map (item 7c).
**File**: `src/integrations/chat-sdk/background.ts` (new)
**Changes**: `trackBackground(promise)` (the `waitUntil` implementation): counts in-flight, catches rejections, logs them scrubbed. `drainBackground(timeoutMs)` awaits in-flight work with a bound.
**File**: `src/integrations/chat-sdk/runtime.ts` (new)
**Changes**:
- `startChatSdk()`: `getChatSdkConfig()`, bail with a log line when disabled or on config error, `assertNoSlackClash`, construct `SqliteChatState` once, then for each configured adapter: `loadAdapter`, `new Chat({ adapters: { [name]: adapter }, state, userName: cfg.userName, logger, concurrency: "concurrent" })` (record key equals adapter name because thread ids are prefixed with it; `concurrent` because the swarm's own 10 s buffer coalesces bursts, while the SDK's `queue` strategy processes only the latest queued message and hands the rest to `ctx.skipped`, `chat/dist/types-kdVm1MWj.d.ts:616-618`), `registerChatHandlers(chat)` (item 9), `await chat.initialize()` in try/catch. Store in `Map<AdapterName, Chat>` plus `health: Map<AdapterName, { status: "ok"|"error"; error?: string; since: string }>`.
- `getChatInstance(adapter)`, `getChatSdkHealth()`, `isChatSdkEnabled()`.
- `stopChatSdk()`: `await chat.shutdown()` per instance (Discord gateway abort is added in Phase 5), then `drainBackground(10_000)`.
- `apiUrl` for Telegram and Slack comes only from `CHAT_SDK_API_URL_OVERRIDES` (env-only), never from operator config.
**File**: `src/http/index.ts`
**Changes**: In the listen callback, `try { await startChatSdk() } catch (e) { console.error(scrub...) }` right after `startSlackApp()` (`:760`). In `shutdown()` (`:473-567`), `await stopChatSdk()` next to `stopSlackApp()`, before `httpServer.close` and `closeDb()`.

#### 8. Capability and webhook route
**File**: `src/server.ts`
**Changes**: Add `"chat-sdk"` to `ALL_CAPABILITIES` (`:211-234`) and as a commented default-off line in `DEFAULT_CAPABILITIES` (`:239-266`). In `getEnabledCapabilities()` (`:283-290`) add `chat-sdk` when `isChatSdkEnabled()` and remove it otherwise (inverse of the `slack` socket-mode drop). Tool registration under `hasCapability("chat-sdk")` comes in Phase 3; in this phase only the capability exists.
**File**: `src/http/webhooks.ts`
**Changes**: `chatSdkWebhook = route({ method: "post", path: "/api/integrations/chat/{adapter}/webhook", pattern: ["api", "integrations", "chat", ":adapter", "webhook"], tags: ["Webhooks"], auth: { apiKey: false }, rbac: { ungated: "provider webhook: the Chat SDK adapter verifies the platform signature (Telegram secret token, Slack signing secret, Discord Ed25519, Teams JWT)" }, responses: { 200: unstructured("adapter response proxied as-is"), 401, 404, 503 } })`. Handler: 404 when Chat SDK is disabled or the adapter is not configured; read the raw body (`for await (const chunk of req)`, as the Kapso handler does at `:710-797`); build `new Request(getPublicMcpBaseUrl() + req.url, { method, headers, body: rawBody })` where `headers` is a `Headers` built from `req.rawHeaders` pairs (Bun's `Headers` init from `IncomingMessage.headers` comma-joins array values, which breaks signature checks that read a specific header); `const response = await chat.webhooks[adapter](request, { waitUntil: trackBackground, propagateHandlerErrors: true })`; copy status, headers and body onto `res`. Then `bun run docs:openapi`.

#### 9. Types and minimal handlers
**File**: `src/types.ts`
**Changes**: `"chat"` appended to `AgentTaskSourceSchema` (`:393`) and to `SteeringSourceSchema` (`:449`).
**File**: `src/tasks/context-key.ts`
**Changes**: New family `chat-sdk`: header comment (`:15-27`), `ParsedContextKey` variant `{ family: "chat-sdk"; parts: { adapter: string; threadId: string } }` (`:45-74`, the existing variants all use `parts`), `chatSdkContextKey(threadId)` next to `slackContextKey` (`:92`) that splits `threadId` on the first `:` into adapter and rest and returns `task:chat-sdk:${adapter}:${encodeURIComponent(rest)}`, `parseContextKey` case (`:213`) that decodes and rebuilds `${adapter}:${rest}`. Round-trip unit test with a Telegram id containing colons.
**Files**: `apps/ui/src/api/types.ts` (`:25-31`, `~1262`, `~3048`), `apps/ui/src/components/shared/tasks-table.tsx:126`, `apps/ui/src/pages/tasks/[id]/task-source-line.tsx`, `apps/ui/src/pages/people/integration-icons.tsx`
**Changes**: Add `"chat"` to the three source unions and a `MessageSquare` icon entry, so chat tasks created from this phase on render in the task table (moved here from Phase 6 on review).
**Generated**: `bun run build:extension-types` (both generated files enumerate `source`) and commit `src/extensions/contract-types.generated.ts` and `src/scripts-runtime/types/swarm-extension.d.ts`.
**File**: `src/integrations/chat-sdk/handlers.ts` (new)
**Changes**: `registerChatHandlers(chat)` registers `onNewMention` and `onDirectMessage`. Both: `await thread.subscribe()`, resolve the lead with the same helper `src/slack/router.ts:105` uses, then `createTaskWithSiblingAwareness(message.text, { agentId: lead.id, source: "chat", taskType: "chat-inbound", tags: ["chat-sdk", thread.adapter.name], priority: 70, contextKey: chatSdkContextKey(thread.id) }, { origin: "webhook" })` (the Kapso call shape, `src/integrations/kapso/inbound.ts:154-170`). Phase 2 replaces this body with the buffered, routed pipeline; the registration point stays.

#### 10. Docs stub
**File**: `docs-site/content/docs/(documentation)/integrations/chat-sdk.mdx` (new), `integrations/index.mdx`, `integrations/meta.json`
**Changes**: Page with frontmatter, "What it does", "Configuration" (`CHAT_SDK_ENABLED`, `CHAT_SDK_ADAPTERS` JSON example with `$config` refs, Telegram fields, webhook URL, `mode: "polling"` for local dev), "Status: Telegram only in this phase". Index bullet and meta entry. Expanded in Phase 6.

#### 11. Tests
**Files** (new under `src/tests/`):
- `chat-sdk-state.test.ts`: contract test of `SqliteChatState` against the `state-memory` semantics listed in Current State (lock acquire/extend/release/force, TTL expiry, setIfNotExists, list maxLength + TTL reset, queue FIFO + maxSize, subscriptions survive `disconnect()`), on `./test-chat-sdk-state.sqlite` via `initDb`, cleaning `-wal`/`-shm` in `afterAll`.
- `config-refs.test.ts`: nested refs, arrays, missing keys aggregated in one error, non-ref objects untouched.
- `chat-sdk-config.test.ts`: schema accepts the brainstorm example, rejects a non-object adapter, resolves refs into functions for `botToken` and strings for `secretToken`, `assertNoSlackClash` throws unless `SLACK_DISABLE=true`, the `VALIDATED_KEYS` validator returns an error string for bad JSON and for an `apiUrl` key, `{"$config":"API_KEY"}` and `{"$config":"SECRETS_ENCRYPTION_KEY"}` are rejected as reserved, a `$config` ref to an env-only value (not a swarm_config row) is reported missing.
- `chat-sdk-webhook-telegram.test.ts`: in-process like `kapso-inbound.test.ts:86,248`. Boot `initDb("./test-chat-sdk-telegram.sqlite")`, a `Bun.serve({ port: 0 })` fake Bot API answering `getMe`, `getWebhookInfo`, `sendMessage`, set `CHAT_SDK_ENABLED=true`, `CHAT_SDK_ADAPTERS` with `{ telegram: { botToken: "t", secretToken: "s", mode: "webhook" } }` and `CHAT_SDK_API_URL_OVERRIDES` with `{ telegram: server.url }`, `await startChatSdk()`, then drive `handleWebhooks(req, res, "/api/integrations/chat/telegram/webhook")`: wrong `X-Telegram-Bot-Api-Secret-Token` gives 401, unknown adapter gives 404, a private-chat text update creates one task with `source: "chat"`, `contextKey` starting `task:chat-sdk:telegram:`, the lead as `agentId`, and `chat_subscriptions` contains the thread. `await stopChatSdk()` in `afterAll`.
- `migration-213-chat-sdk-state.test.ts`: in-memory `Database(":memory:")` on the hand-built base + the `.sql` file like `migration-208-task-runtime-dispatch.test.ts`; asserts tables, the partial index, and that updating a `source='chat'` task with a `task:chat-sdk:` contextKey to `completed` inserts one obligation row while a `source='slack'` task does not.
- `context-key.test.ts` (extend if it exists): chat-sdk round trip.
- `enabled-tools.test.ts` style check: `getEnabledCapabilities()` contains `chat-sdk` only when enabled.

### Success Criteria:

#### Automated Verification:
- [x] Compile gate passes (the binary has no `--help`; it boots the API, so ALWAYS give it a throwaway `DATABASE_PATH`, otherwise it migrates `./agent-swarm-db.sqlite`): `bun build ./src/http.ts ./src/scripts-runtime/executors/quickjs-worker.ts --compile --compile-exec-argv='--expose-gc' --outfile /tmp/agent-swarm-api-trial && d=$(mktemp -d) && port=$(bun -e 'const s=Bun.serve({port:0,fetch(){return new Response("")}});console.log(s.port);s.stop()') && (PORT=$port DATABASE_PATH=$d/db.sqlite DESPLEGA_TELEMETRY_ENV=test SLACK_DISABLE=true HEARTBEAT_DISABLE=true /tmp/agent-swarm-api-trial & echo $! > $d/pid) && for i in $(seq 1 40); do curl -sf http://127.0.0.1:$port/health >/dev/null && break; sleep 1; done; curl -sf http://127.0.0.1:$port/health; echo health=$?; kill $(cat $d/pid)` (`health=0` required; a build error or a non-zero health stops the phase)
- [x] Docker API image builds: `docker build -f Dockerfile -t agent-swarm-api:chat-sdk .`
- [x] Bun pin lockstep: `bun run check:bun-version`
- [x] Phase tests: `bun run test:root -- src/tests/chat-sdk-state.test.ts src/tests/config-refs.test.ts src/tests/chat-sdk-config.test.ts src/tests/chat-sdk-webhook-telegram.test.ts src/tests/migration-213-chat-sdk-state.test.ts`
- [x] Migration runner regressions still pass: `bun run test:root -- src/tests/migration-runner-regressions.test.ts`
- [x] Migration ordinal and immutability: `bash scripts/check-migration-conflicts.sh`
- [x] Audit columns: `bash scripts/check-audit-columns.sh`
- [x] Boundaries: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bun run check:dep-graph`
- [x] Async seam hygiene: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] Route contracts: `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run docs:openapi && git diff --exit-code openapi.json`
- [x] Inner loop: `bun run check` and `bun run tsc:check:tsc` and `bun run lint:slop`
- [x] Fresh DB boots and applies 213 (no GNU `timeout` on macOS, so background + kill): `d=$(mktemp -d) && port=$(bun -e 'const s=Bun.serve({port:0,fetch(){return new Response("")}});console.log(s.port);s.stop()') && (PORT=$port DATABASE_PATH=$d/db.sqlite DESPLEGA_TELEMETRY_ENV=test SLACK_DISABLE=true HEARTBEAT_DISABLE=true bun run start:http & echo $! > $d/pid) && for i in $(seq 1 40); do curl -sf http://127.0.0.1:$port/health >/dev/null && break; sleep 1; done; kill $(cat $d/pid); sqlite3 $d/db.sqlite "select name from _migrations order by name desc limit 1"`
- [x] Generated extension types committed: `bun run build:extension-types && git diff --exit-code src/extensions/contract-types.generated.ts src/scripts-runtime/types/swarm-extension.d.ts`

#### Automated QA:
- [x] Start the fake Bot API (`bun scripts/dev/telegram-bot-api-mock.ts`, new tiny `Bun.serve` script shared with the test above, prints its port), boot the API with `CHAT_SDK_ENABLED=true CHAT_SDK_ADAPTERS='{"telegram":{"botToken":"fake","secretToken":"s","mode":"webhook"}}' CHAT_SDK_API_URL_OVERRIDES='{"telegram":"http://127.0.0.1:<port>"}' SLACK_DISABLE=true HEARTBEAT_DISABLE=true DESPLEGA_TELEMETRY_ENV=test bun run start:http`, confirm the boot log shows `[chat-sdk] telegram ready` and no secret in the log.
- [x] `$config` path: `curl -X PUT http://localhost:3013/api/config -H "Authorization: Bearer 123123" -H 'content-type: application/json' -d '[{"key":"TG_TOKEN","value":"fake","isSecret":true,"scope":"global"},{"key":"CHAT_SDK_ADAPTERS","value":"{\\"telegram\\":{\\"botToken\\":{\\"$config\\":\\"TG_TOKEN\\"},\\"secretToken\\":\\"s\\",\\"mode\\":\\"webhook\\"}}","scope":"global"}]'`, restart, confirm `telegram ready`; then PUT the same JSON with `{"$config":"API_KEY"}`, restart, confirm the boot log shows the reserved-key rejection and `GET /health` still answers.
- [x] `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3013/api/integrations/chat/telegram/webhook -H 'X-Telegram-Bot-Api-Secret-Token: wrong' -d '{}'` prints `401`; `.../chat/discord/webhook` prints `404`.
- [x] `curl -s -X POST http://localhost:3013/api/integrations/chat/telegram/webhook -H 'X-Telegram-Bot-Api-Secret-Token: s' -H 'content-type: application/json' -d @src/tests/fixtures/chat-sdk/telegram-private-text.json` returns 200, then `curl -s -H "Authorization: Bearer 123123" 'http://localhost:3013/api/tasks?source=chat' | jq '.[0] | {source, contextKey, agentId, status}'` shows the new task.
- [x] Boot with `CHAT_SDK_ADAPTERS='{"slack":{...}}'` and no `SLACK_DISABLE`: the log shows the clash error and the API still serves `GET /health`.
- [x] Boot with `CHAT_SDK_ADAPTERS='{"telegram":{"botToken":"x"}}'` (the schema defaults `mode` to `webhook`, never the SDK's `auto`, which would start long polling against the real Bot API; webhook mode without a secret makes the constructor throw): the Telegram adapter is marked `error` in `getChatSdkHealth()` (log line) and the API still serves `GET /health`.

#### Manual Verification:
- [ ] Optional real-bot check: with a BotFather token and `mode: "polling"`, DM the bot and confirm a `source: "chat"` task appears in the dashboard task list.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] chat-sdk foundation + telegram slice` after verification passes.

## Phase 2: Inbound pipeline + extension hooks

### Overview

When this phase is done, every inbound Chat SDK message goes through a 10 s per-thread buffer, the `pre.chat.route` extension hook, a router (explicit agent, broadcast, KV channel mapping incl. workflow, thread owner, Lead), the steer-vs-follow-up rule for live tasks, and attachment download into task attachments. `post.chat.message` fires for every inbound message. The Phase 1 minimal handler body is replaced; its registration point stays.

### Changes Required:

#### 1. Extension contract
**File**: `src/extensions/contract.ts`
**Changes**: Next to `SlackRouteEvent` (`:171-182`) add `ChatRouteEvent { adapter; channelId; threadId; userId; userName?; text; botMentioned: boolean; isDirectMessage: boolean; threadContext?: { adapter; threadId } }`, `ChatRouteModify { target: {kind:"agent", agentId} | {kind:"lead"} | {kind:"broadcast"} | {kind:"workflow", workflowId} }` with a `ChatRouteModifySchema` zod next to `SlackRouteModifySchema`. Next to `SlackMessageEvent` (`:231-237`) add `ChatMessageEvent { adapter; channelId; threadId; userId?; text; direction: "inbound" | "outbound"; taskId?; messageId? }`. Map entries `pre.chat.route` (modify: `ChatRouteModify`) and `post.chat.message` (`modify: never; result: void`) at `:350,371`.
**File**: `src/extensions/dispatcher.ts`
**Changes**: `case` for both events in the run-record `subject` switch (`~:156-175`): ids only (`adapter`, `threadId`, `taskId`), never `text`.
**File**: `src/extensions/post-bridge.ts`
**Changes**: Subscribe to a new bus event `chat.message.received` and `chat.message.sent` (emitted by the inbound pipeline and by Phase 3 outbound) and `dispatchPost("post.chat.message", compact(...))`, mirroring the Kapso bridge at `:249`. Add both event names to the `workflowEventBus` event map (`src/workflows/event-bus.ts`).
**Generated**: `bun run build:extension-types`; commit `src/extensions/contract-types.generated.ts` and `src/scripts-runtime/types/swarm-extension.d.ts`.
**File**: `src/tests/fixtures/extensions/route-chat-channel-to-agent/{manifest.json,hooks.ts}` (new)
**Changes**: Copy of `route-channel-to-agent`: config `{ adapter, channelId, agentId }`, `pre.chat.route` returns `modify({ target: { kind: "agent", agentId } })` when adapter+channel match, `post.chat.message` appends to `ctx.state`.
**Docs**: Two rows in `docs-site/content/docs/(documentation)/guides/extensions.mdx:204-223` (Event, Boundary, payload, modify shape, block effect) and one line in `runbooks/extensions.md` near `:305` describing when `pre.chat.route` runs (after buffer flush, before task creation, outside any transaction).

#### 2. ContextKey-based thread lookups
**File**: `src/be/db/tasks/read.ts`
**Changes**: Next to the Slack helpers (`:1271-1340`) add generic `getAgentWorkingOnContextKey(contextKey)`, `getLatestActiveTaskByContextKey(contextKey)`, `getLatestLeadTaskByContextKey(contextKey)`, same status filters as their Slack twins but `WHERE contextKey = ?` (indexed by `idx_agent_tasks_context_key_status`). Re-export through `src/be/db.ts`. All through `getDbClient()`.

#### 3. Thread buffer
**File**: `src/integrations/chat-sdk/thread-buffer.ts` (new)
**Changes**: One `createAdditiveBuffer<ChatBufferedMessage>({ timeoutMs: CHAT_SDK_BUFFER_MS (env, default 10_000), onFlush, label: "chat" })` from `src/tasks/additive-buffer.ts:75`, keyed by the SDK `thread.id` (no split; ids contain colons). `ChatBufferedMessage = { messageId, text, userId, userName, botMentioned, isDirectMessage, attachments: Attachment[] }`. Exports `bufferChatMessage(thread, message, flags)`, `instantFlushChat(threadId)`, `isChatThreadBuffered`. `!now` prefix in a message forces `instantFlush` (same as `src/slack/handlers.ts:517-553`). `onFlush(items, threadId, reason)` calls `flushChatThread(threadId, items, reason === "manual")`.

#### 4. Router, steering, templates
**File**: `src/integrations/chat-sdk/router.ts` (new)
**Changes**: Port of `src/slack/router.ts:38-110`: `routeChatMessage(text, { adapter, channelId, threadId, botMentioned, isDirectMessage }) -> ChatRouteTarget`. Order: `swarm#<uuid>` (reachable agent), `swarm#all` (broadcast to non-leads), KV channel mapping `integrations:chat:channels` key `${adapter}:${channelId}` (value `{ agentId?, workflowId? }`, read with `getKv`; the register tools come in Phase 3), thread owner via `getAgentWorkingOnContextKey` with Lead fallback when offline, Lead when mentioned or DM, else `null` (ignore). `isAgentReachable` filter kept. Mention stripping uses `message.isMention` plus a generic `@botName` strip rather than Slack's `<@U…>` regex.
**File**: `src/integrations/chat-sdk/steering.ts` (new)
**Changes**: Port of `src/slack/steering.ts:38-69` with `requestSteering` from `src/be/steering.ts:218`, `source: "chat"`, `createdByKind: "user"`, `onUnsupported: "degrade"`. No new env knobs (brainstorm: reuse the existing rule; six knobs fail the deletion test): the Slack defaults are constants here, steer only when the target task's agent is the lead and `mode: "queue"`; `isSteeringEnabled()` is the only switch. Conditions: steering enabled, target task from `getLatestActiveTaskByContextKey` is `in_progress`, no attachments. Returns `null` when a follow-up task should be created instead. Ack text is a constant one-liner posted with `thread.post({ markdown })`.
**File**: `src/integrations/chat-sdk/templates.ts` (new)
**Changes**: `registerTemplate({ eventType: "chat.message.thread_context", ... variables: [thread_messages] })` copied from `src/slack/templates.ts:56-69`. Add the name wherever `slack.message.thread_context` is enumerated (`src/be/seed-scripts/catalog/ops-catalog-audit.ts:41`, `.inline.ts:41`) if the audit test requires it.
**File**: `src/be/swarm-config-guard.ts`, `apps/ui/src/lib/configuration-catalog.ts`, `docs-site/content/docs/(documentation)/ui/configuration.mdx`
**Changes**: Register `CHAT_SDK_BUFFER_MS` (bounded integer, mirrors `ADDITIVE_SLACK_BUFFER_MS`) in the guard, the catalog (group Integrations) and the docs page in the same PR. No other operator env var is added by this plan beyond `CHAT_SDK_ENABLED`, `CHAT_SDK_ADAPTERS` and the env-only `CHAT_SDK_API_URL_OVERRIDES`.

#### 5. Inbound pipeline and attachments
**File**: `src/integrations/chat-sdk/inbound.ts` (new)
**Changes**:
- `handleChatInbound(thread, message, kind: "mention" | "dm" | "subscribed")`: emit `chat.message.received` on the bus (ids + text, scrubbed by `emit`); if an active task exists for `chatSdkContextKey(thread.id)` try `requestChatThreadSteering`, whatever the handler kind (the SDK routes a DM to `onDirectMessage` even when the thread is subscribed, `chat/dist/index.js:2788-2798`, so Telegram private chats, Slack DMs and Teams 1:1 would otherwise never steer); otherwise `bufferChatMessage`. Under `concurrent` the `ctx.skipped` list is always empty; the test asserts it.
- `flushChatThread(threadId, items, immediate)`: rebuild `thread` via `getChatInstance(adapter).thread(threadId)`; combine texts as `[Thread follow-up: N message(s) buffered]\n\n...` when N > 1 (colon, not the Slack marker's dash); prepend `resolveTemplate("chat.message.thread_context", { thread_messages })` when the thread has prior swarm tasks; `dispatchPre("pre.chat.route", event, { validateModify: ChatRouteModifySchema })` outside any transaction; `block` → log and return; `modify` → use the target (reject extension-identity agents as `src/slack/handlers.ts:636-665` does); else `routeChatMessage`. Target `workflow` → start the run the way the Kapso webhook handler treats `{ kind: "workflow" }` (`src/http/webhooks.ts:710-797`). Target agent/lead/broadcast → `createChatTaskWithFiles` per target with `dependsOn = !immediate && latestActive ? [latestActive.id] : undefined`, `parentTaskId = mostRecentTask?.id`, `inheritParentOutputSchema: false`, `source: "chat"`, `taskType: "chat-inbound"`, `tags: ["chat-sdk", adapter]`, `contextKey`, `routingReason`/`routingSource` as Slack sets them. `await thread.subscribe()` when not subscribed. Threads stay subscribed after terminal tasks (the subscription set has no expiry; plain replies must still reach the swarm as follow-ups).
**File**: `src/integrations/chat-sdk/attachments.ts` (new)
**Changes**: Copy, not extract, of the `src/slack/inbound-files.ts:286-420` flow (the plan does not touch `src/slack`; extraction is a derail note). `createChatTaskWithFiles(description, options, attachments)`: no attachments → `createTaskWithSiblingAwareness(description, options, { origin: "webhook" })`; with attachments → create as `status: "draft"`, `refreshDraftTaskLease` every 60 s, `attachChatFilesToTask(taskId, attachments)`, `promoteDraftTask` in `finally`. `attachChatFilesToTask`: for each `attachment.fetchData()` (SDK guard: 25 MiB, SSRF blocklist) write to `mkdtemp("chat-files-")` with `await using` disposal, sha256 dedup against `getTaskAttachments`, `getFileStorageProvider().upload(...)` (`src/fs/provider.ts:88`), `recordTaskAttachmentUpload({ intent: "user-upload", description: "Shared on <adapter> (message <id>)" })` (`src/be/task-attachment-store.ts:30`). `buildChatAttachmentText(attachments, failed)` emits `[File: <name> (<mime>, <size>) id=<id>]` lines appended to the description.
**File**: `src/integrations/chat-sdk/handlers.ts`
**Changes**: `onNewMention` → `handleChatInbound(thread, message, "mention")`, `onDirectMessage` → `"dm"`, add `onSubscribedMessage` → `"subscribed"`. Skip `message.author.isBot === true`.

#### 6. Tests
**Files** (new under `src/tests/`):
- `chat-sdk-inbound.test.ts`: `CHAT_SDK_BUFFER_MS=50`; two Telegram updates in one thread within 50 ms produce one task whose description carries `[Thread follow-up: 2 message(s) buffered]`; `!now` flushes immediately; `swarm#<uuid>` routes to that agent; KV mapping `integrations:chat:channels` routes to a pinned agent; a second message after the first (lead-owned) task is `in_progress` calls `requestSteering` (spy) and creates no task, both for a group-thread message and for a Telegram private-chat DM; with the task `pending` it creates a follow-up with `dependsOn`; a message with an attachment whose `fetchData` returns bytes yields one `task_attachments` row and a `[File: ...]` line; `pre.chat.route` block from the fixture creates no task; modify from the fixture routes to the configured agent.
- `extensions-example-route-chat-channel.test.ts`: `loadBundleFixture("route-chat-channel-to-agent")` like `extensions-example-route-slack-channel.test.ts`.
- `extensions-post-bridge.test.ts`: add a case that `chat.message.received` reaches `post.chat.message`.

### Success Criteria:

#### Automated Verification:
- [x] Phase tests: `bun run test:root -- src/tests/chat-sdk-inbound.test.ts src/tests/extensions-example-route-chat-channel.test.ts src/tests/extensions-post-bridge.test.ts src/tests/chat-sdk-webhook-telegram.test.ts`
- [x] Extension suite: `bun run test:root -- src/tests/extensions-*.test.ts`
- [x] Generated types committed: `bun run build:extension-types && git diff --exit-code src/extensions/contract-types.generated.ts src/scripts-runtime/types/swarm-extension.d.ts`
- [x] Template enumeration guard: `grep -rn "slack.message.thread_context" src/be/seed-scripts/catalog src/tests` and add `chat.message.thread_context` next to every hit; the full suite in Phase 5 catches any audit test
- [x] Hygiene: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-db-boundary.sh`
- [x] Inner loop: `bun run check && bun run tsc:check:tsc && bun run lint:slop`

#### Automated QA:
- [x] With the Phase 1 local boot (fake Bot API) and `CHAT_SDK_BUFFER_MS=2000`: POST two updates for the same chat 500 ms apart, wait 3 s, `GET /api/tasks?source=chat` shows exactly one new task whose description contains `2 message(s) buffered`.
- [x] Mark that task `in_progress` through the API (claim it with a test agent registered as `AGENT_ID=$(uuidgen)`, never a slug), POST a third update in the same chat, confirm no new task and a steering entry for the task (`GET /api/tasks/<id>` steering list or the DB `task_steering` table).
- [x] Load the `route-chat-channel-to-agent` fixture as an extension (`POST /api/extensions` per `runbooks/extensions.md`), POST an update in the configured channel, confirm the task's `agentId` is the fixture's agent.
- [x] POST an update with a `document` attachment pointing at a file served by the fake Bot API (`getFile` + download path), confirm `GET /api/tasks/<id>/attachments` lists it.

#### Manual Verification:
- [ ] None required.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] chat-sdk inbound pipeline + extension hooks` after verification passes.

---

## Phase 3: Outbound relay, MCP tools, seeded skill

### Overview

When this phase is done, a terminal chat task posts its output back to the originating thread through the `chat_relay_obligations` watcher, agents have six `chat-*` MCP tools under the `chat-sdk` capability (also mapped into the script SDK), `chat-reply` is gated to chat-context tasks, and the seeded `chat-sdk` skill exists.

### Changes Required:

#### 1. Relay queries and watcher
**File**: `src/be/db/tasks/read.ts`
**Changes**: Next to `getPendingSlackRelayTasks` (`:980-1020`) add `getPendingChatRelayTasks(limit = 200)` (`delivered_at IS NULL AND given_up_at IS NULL AND status IN terminal`, same ordering), `markChatRelayAttempted(taskId, now, error?)` (bumps `attempt_count`, sets `last_attempt_at`, `last_error`), `markChatRelayDelivered(taskId)` (idempotent), `markChatRelayGivenUp(taskId, error)`. Re-export via `src/be/db.ts`.
**File**: `src/integrations/chat-sdk/relay.ts` (new)
**Changes**: `processPendingChatRelays(now = Date.now())`: for each row, `parseContextKey(task.contextKey)` → `${adapter}:${threadId}`; claim with `markChatRelayAttempted`; text = `scrubSecrets(task.output || task.failureReason || "Task completed.")` prefixed by status for failed/cancelled; split into chunks per adapter limit (`telegram 4096`, `discord 2000`, `slack 4000`, `teams 20000`, map in `limits.ts`); `await getChatInstance(adapter).thread(threadId).post({ markdown: chunk })`; on success `markChatRelayDelivered` and emit `chat.message.sent` (bus → `post.chat.message` outbound); on error record `last_error` and leave pending; a row is eligible again only after `last_attempt_at + min(3 s × 2^attempt_count, 10 min)` (the pending query filters on `last_attempt_at`, same partial index); `markChatRelayGivenUp` only when `created_at` is older than `RELAY_GIVE_UP_AFTER_MS` (module constant, 24 h; Slack never gives up, 20 attempts at 3 s would have been one minute of outage). A missing or unhealthy adapter instance skips the row without counting an attempt. `startChatRelayWatcher(intervalMs = 3000)` with an `isProcessing` guard and `sweepExpired` every 20th tick; `workflowEventBus.on("task.completed" | "task.failed" | "task.cancelled")` schedules one immediate tick (debounced 250 ms). `stopChatRelayWatcher()`. Started/stopped from `startChatSdk` / `stopChatSdk`.

#### 2. MCP tools
**Files** (new): `src/tools/chat-reply.ts`, `src/tools/chat-post.ts`, `src/tools/chat-open-dm.ts`, `src/tools/chat-read-thread.ts`, `src/tools/register-chat-channel.ts` (register + unregister)
**Changes**: Each returns `toolOk`/`toolErr` with `swarmToolOutputSchema(z.looseObject({...}))`, all output fields optional, no format pins. `chat-reply { text }`: resolves the calling task from `requestInfo` (`x-source-task-id`, as the Slack tools do), requires `parseContextKey(task.contextKey)?.family === "chat-sdk"`, posts `{ markdown: scrubSecrets(text) }` to that thread, returns `{ messageId, adapter, threadId }`, emits `chat.message.sent`. `chat-post { adapter, threadId? , channelId?, text }`: out-of-band post via `chat.thread(...)` or `chat.channel(channelId).post`. `chat-open-dm { adapter, userId }` → `chat.openDM` → `{ threadId }`. `chat-read-thread { threadId, limit? }` → `chat.history.thread.list(threadId).collect()` trimmed to `limit`; description states Telegram returns only messages seen since boot and Teams needs `Chat.Read.*`. `register-chat-channel { adapter, channelId, agentId? | workflowId?, name? }` / `unregister-chat-channel`: lead-only via `can({ verb: "integration.chat.manage" })`; KV `integrations:chat:channels` key `${adapter}:${channelId}`.
**File**: `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`
**Changes**: Add verb `integration.chat.manage` next to `integration.kapso.manage` (`:123` / `:288`, `leadOnly`).
**File**: `src/tools/tool-config.ts`, `src/server.ts`
**Changes**: Tool names in the config list (next to Kapso, `:124-128`); registration block `if (hasCapability("chat-sdk")) { ... }` next to the Kapso block (`:673-678`).
**File**: `src/utils/task-tool-manifest.ts`, `src/http/mcp.ts`
**Changes**: Widen the `task` param type (`:19-33`) with `contextKey?: string | null`; filter out `chat-reply` unless the contextKey family is `chat-sdk`. The `mcp.ts:~232` call site already passes the full task row.
**File**: `src/scripts-runtime/sdk-allowlist.ts`
**Changes**: `SDK_TOOL_NAME_MAP` entries `chat_reply`, `chat_post`, `chat_openDm`, `chat_readThread`, `chat_registerChannel`, `chat_unregisterChannel`. Then `bun run build:script-types` and commit `src/scripts-runtime/types/*.d.ts`.
**File**: `MCP.md`
**Changes**: `chat-sdk` added to the default-off capability list (`:20`) and a `## Chat SDK Tools` section in the Kapso format (`:2206`). Check `package.json` for an MCP.md generator first; if one exists run it instead of hand-editing.

#### 3. Seeded skill
**Files** (new): `templates/skills/chat-sdk/config.json`, `templates/skills/chat-sdk/content.md`
**Changes**: `config.json` in the `templates/skills/apps/config.json` shape (name `chat-sdk`, description trigger-oriented: "task carries a chat-sdk contextKey, user asked via Telegram/Slack/Discord/Teams"), `runAllSeedersCandidate: true`, `systemDefault: false`. `content.md` (no frontmatter) sections: How you know you are on a chat task; Reply with `chat-reply` (when, how often, questions vs progress); The final summary is posted automatically (do not duplicate it); Markdown per platform (what Telegram, Discord, Slack, Teams render; no tables on Telegram/Discord; length limits); Attachments arrive as task attachments; `chat-read-thread` limits per platform; Leads: `register-chat-channel`; Etiquette (short, no secrets, mention the user when asking).
**File**: `src/be/seed-skills/index.ts`
**Changes**: Static `import chatSdkConfig from "../../../templates/skills/chat-sdk/config.json"` and `content.md` text import; alphabetical entry in `BUILT_IN_SKILL_SOURCES` (`:319+`). Then `bun run build:skill-md` if a `SKILL.md` convention applies to the directory.

#### 4. Tests
**Files** (new under `src/tests/`):
- `chat-sdk-relay.test.ts`: create a `source: "chat"` task with a Telegram contextKey, complete it through the DB write path, assert one obligation row; one `processPendingChatRelays()` tick posts `sendMessage` to the fake Bot API with the task output and sets `delivered_at`; a 500 from the fake API leaves the row pending with `attempt_count = 1` and `last_error`, and a tick 1 s later is a no-op (backoff); a row whose `created_at` is 25 h old (clock injected through `now`) gets `given_up_at`; with the adapter unhealthy the row is skipped and `attempt_count` stays 0; delegation: a lead task completes, then its `follow-up` task (`source: "system"`, inherited contextKey) completes, and two posts reach the fake API (mirror of `scripts/e2e/scenarios/slack-delegation-child-result.ts`); a 9000-char output arrives as three Telegram chunks; `post.chat.message` outbound reaches a fixture extension.
- `chat-sdk-tools.test.ts`: `toolNames({ capabilities: [...] })` from `enabled-tools.test.ts:30-50` lists the six tools only with `chat-sdk`; `chat-reply` returns `toolErr` for a task without a chat contextKey and posts for one with it; `register-chat-channel` is refused for a non-lead (pattern `rbac-charact-slack.test.ts`).
- `task-tool-manifest.test.ts`: case "chat-reply only preloads for a task carrying a chat-sdk contextKey".

### Success Criteria:

#### Automated Verification:
- [x] Phase tests: `bun run test:root -- src/tests/chat-sdk-relay.test.ts src/tests/chat-sdk-tools.test.ts src/tests/task-tool-manifest.test.ts src/tests/enabled-tools.test.ts`
- [x] SDK registration: `bun scripts/check-sdk-tool-registration.ts && bun run build:script-types && git diff --exit-code src/scripts-runtime/types/`
- [x] Skill gates: `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`
- [x] RBAC: `bun run check:rbac-coverage` and `bun run test:root -- src/tests/rbac-charact-slack.test.ts`
- [x] Hygiene: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-db-boundary.sh`
- [x] Inner loop: `bun run check && bun run tsc:check:tsc && bun run lint:slop`

#### Automated QA:
- [x] Local boot with the fake Bot API: POST a Telegram update, claim the task as a test agent (`AGENT_ID=$(uuidgen)`) through MCP, call `store-progress` with `status: completed` and an output, confirm within 5 s the fake Bot API log shows one `sendMessage` to the originating chat with that output, and `sqlite3 <db> "select delivered_at from chat_relay_obligations"` is non-null.
- [x] From the same task context call `chat-reply` through MCP, confirm a second `sendMessage` and a `post.chat.message` extension run row (`GET /api/extensions/runs`).
- [x] From a task without a chat contextKey, `get-tasks`-style tool listing (`tools/list` over MCP with `x-source-task-id`) does not include `chat-reply`.
- [ ] `GET /api/skills` lists `chat-sdk` after boot; a worker container's `~/.claude/skills/chat-sdk/SKILL.md` exists after `bun run docker:build:worker && bun run pm2-restart` (or the skill-sync log line).

#### Manual Verification:
- [ ] Read `templates/skills/chat-sdk/content.md` once for tone and accuracy against the four platforms.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] chat-sdk relay, tools, seeded skill` after verification passes.

---

## Phase 4: Slack and Teams adapters

### Overview

Telegram is not here because it is already complete: Phase 1 wires it as the vertical slice (webhook route, config, handlers), Phases 2 and 3 run the full inbound pipeline and relay against it, and Phase 6 adds its "Register webhook" dashboard action. Discord needs a gateway loop and gets Phase 5.

When this phase is done, the Chat SDK Slack adapter works in socket and webhook mode against `@desplega.ai/slack-mock` with the bespoke Slack disabled, the Teams adapter accepts activities through the webhook route, and the Slack clash guard is covered end to end. Adapter coverage after this phase: Telegram (1), Slack (4), Teams (4), Discord (5).

### Changes Required:

#### 1. Slack adapter
**File**: `src/integrations/chat-sdk/adapters.ts`, `config.ts`
**Changes**: Slack branch passes `botToken`, `signingSecret`, `appToken`, `mode` (default `webhook`), `userName`, `apiUrl`. Socket mode: the adapter starts the socket inside `initialize()`; the webhook route returns the adapter's 405 in that mode (documented). `url_verification` is answered by the adapter. Health captures socket connect errors from the logger.
**File**: `src/integrations/chat-sdk/limits.ts`
**Changes**: Slack chunk limit and a note that Slack renders mrkdwn (the SDK converts markdown).

#### 2. Teams adapter
**File**: `src/integrations/chat-sdk/adapters.ts`, `config.ts`
**Changes**: Teams branch passes `appId`, `appPassword`, `appTenantId`, `appType` (default `MultiTenant`), optional `webhookVerifier` (tests only, never from operator config), `apiUrl`. `initialize()` rethrows, so the health map records the error and the other adapters keep running (one Chat per adapter).

#### 3. Clash guard end to end
**File**: `src/server.ts`
**Changes**: Verify `getEnabledCapabilities()` drops the bespoke `slack` capability when `SLACK_DISABLE=true` and adds `chat-sdk`; nothing new expected, covered by test.

#### 4. Tests
**Files** (new under `src/tests/`):
- `chat-sdk-slack.test.ts`: `const slack = await SlackMock.start({ port: 0, manifest: "slack-manifest.json" })` (the repo manifest); env `SLACK_DISABLE=true`, `CHAT_SDK_ADAPTERS` with `{ slack: { mode: "socket", apiUrl: slack.env.SLACK_API_URL, botToken: slack.env.SLACK_BOT_TOKEN, appToken: slack.env.SLACK_APP_TOKEN, signingSecret: "mock-signing-secret" } }`; `await startChatSdk(); await slack.waitForConnection()`; `const ask = await slack.postMessage({ channel: "general", user: "alice", text: `<@${slack.bot.userId}> hi` })` → one `source: "chat"` task with a `task:chat-sdk:slack:` contextKey; complete it → `await slack.waitForMessage({ channel: "general", thread_ts: ask.ts, from: "bot" })` contains the output; a human reply in the thread while the task is `pending` creates a follow-up with `dependsOn`. Webhook-mode case: `mode: "webhook"`, POST to `handleWebhooks` a `url_verification` body signed with `v0=` HMAC-SHA256 over `v0:<ts>:<body>` and `X-Slack-Request-Timestamp` → 200 with the challenge; an unsigned `event_callback` → 401; a signed `app_mention` → task.
- `chat-sdk-teams.test.ts`: `webhookVerifier: () => true` injected through a test-only hook on `loadAdapter`; POST a minimal Bot Framework `message` Activity (conversation id, from, text with the bot mention entity) → task with `task:chat-sdk:teams:` contextKey; without the verifier an unsigned POST → 401. Teams `initialize()` against an unreachable `apiUrl` → health `error` while a Telegram adapter in the same boot stays `ok`. Before writing this file, check whether Teams `initialize()` calls Microsoft beyond `apiUrl` (MSAL token, JWKS; `@chat-adapter/teams/dist/index.js:35-45` pins only Bot Framework calls); if it does, stub `globalThis.fetch` as `kapso-client.test.ts:14-25` does so CI never reaches the network.
- `chat-sdk-config.test.ts`: add "slack entry + SLACK_DISABLE=true boots; without it `assertNoSlackClash` throws and `startChatSdk` returns without instances".

### Success Criteria:

#### Automated Verification:
- [x] Phase tests: `bun run test:root -- src/tests/chat-sdk-slack.test.ts src/tests/chat-sdk-teams.test.ts src/tests/chat-sdk-config.test.ts`
- [x] Bespoke Slack regression guard: `bun run e2e --only slack-mention` (the black-box suite boots the bespoke Slack app against slack-mock)
- [x] Hygiene: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-test-spawn-sync.sh`
- [x] Inner loop: `bun run check && bun run tsc:check:tsc && bun run lint:slop`

#### Automated QA:
- [x] Run `slack-mock serve --port 4040` (from `node_modules/.bin`), boot the API with `SLACK_DISABLE=true` and the socket-mode Chat SDK Slack config above (`apiUrl: http://127.0.0.1:4040/api/`), `curl -X POST http://127.0.0.1:4040/mock/messages -d '{"channel":"general","user":"alice","text":"<@U0BOT00000> hello"}'`, confirm a task; complete it; `agent-browser open http://127.0.0.1:4040/c/general` and `agent-browser screenshot /tmp/chat-sdk-slack-thread.png` shows the bot reply in the thread. Attach the screenshot to the PR (`github-attach` skill).
- [x] Boot without `SLACK_DISABLE` and with the slack entry: the log shows the clash error, `GET /health` is 200, and the boot log shows no Chat SDK instances.
- [x] Record a slack-mock journal (`--data-file`) during the socket-mode run and render `slack-mock frames --journal <file> --channel general --thread <ts> --out /tmp/chat-sdk-frames` as PR evidence.

#### Manual Verification:
- [ ] Teams: against a real Azure Bot registration (public HTTPS `PUBLIC_MCP_BASE_URL`), send a message to the bot in a Teams chat and confirm the task plus the posted reply. No mock exists for the Bot Framework JWT flow.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] chat-sdk slack + teams adapters` after verification passes.

---

## Phase 5: Discord gateway loop

### Overview

Why Discord is special: Discord does not push messages to a webhook. Its interactions endpoint only carries slash commands and component clicks. Plain channel messages and @mentions arrive only over the Gateway WebSocket. The Chat SDK Discord adapter exposes that as `startGatewayListener(options, durationMs = 180000, abortSignal)`, built for serverless re-invocation: it logs in with `discord.js`, listens for one window, then destroys the client. A long-lived API process has to re-arm it in a loop, pick a window long enough to stay inside Discord's 1000 identifies per day, and abort it on shutdown because the adapter has no `disconnect()` (facts in Current State, "Chat SDK 4.41.1 facts"). The other three adapters are webhook-in, HTTP-out and need none of this.

When this phase is done, a configured Discord adapter runs a supervised Gateway listener loop inside the API process (mentions and channel messages arrive), the interactions webhook answers PING and slash commands, and shutdown aborts the loop cleanly.

### Changes Required:

#### 1. Gateway supervisor
**File**: `src/integrations/chat-sdk/discord-gateway.ts` (new)
**Changes**: `startDiscordGateway(chat, adapter)` runs after `chat.initialize()` succeeded (the listener returns 500 otherwise). Loop: `while (!signal.aborted) { const started = Date.now(); let inner: Promise<unknown> | undefined; await adapter.startGatewayListener({ waitUntil: p => { inner = p; trackBackground(p) }, propagateHandlerErrors: true }, DISCORD_GATEWAY_WINDOW_MS, signal); await inner; if (Date.now() - started < 10_000) await sleep(30_000, signal) }`. `DISCORD_GATEWAY_WINDOW_MS` is a module constant (6 h), not an operator knob. The cost of a window boundary is not the identify budget (1000 per day; even 180 s windows use about 480) but lost events: the Gateway does not replay `MESSAGE_CREATE`, so messages sent during a re-arm gap or a 30 s backoff are dropped. A long window keeps gaps rare; the docs page states the limitation; a follow-up can hold one `discord.js` client across windows through the forwarding path (`webhookUrl` + `x-discord-gateway-token`). Health: `gateway: { state: "running" | "backoff" | "stopped", since, restarts }` plus logger-captured `error` lines. `stopDiscordGateway()` aborts the controller and awaits the current inner promise (bounded by `drainBackground`). Called from `startChatSdk`/`stopChatSdk`; Discord has no `disconnect()`, so this is the only stop path.

#### 2. Discord config and route
**File**: `src/integrations/chat-sdk/adapters.ts`, `config.ts`
**Changes**: Discord branch passes `botToken`, `publicKey`, `applicationId`, `respondToChannelIds`, `respondToGlobalMentions`, `mentionRoleIds`. The Phase 1 webhook route already serves `/api/integrations/chat/discord/webhook` (Ed25519 PING, slash commands, components).
**File**: `src/integrations/chat-sdk/limits.ts`
**Changes**: Discord 2000-char chunks.

#### 3. Tests
**Files** (new under `src/tests/`):
- `chat-sdk-discord-gateway.test.ts`: a stub adapter whose `startGatewayListener` resolves the inner promise after 20 ms; assert the loop re-arms (3 iterations observed), enters backoff when the window resolves too fast (fake `sleep` captures the 30 s), stops on abort within one iteration, and reports `restarts` in health.
- `chat-sdk-discord-webhook.test.ts`: generate an Ed25519 key pair with `crypto.subtle`, configure `publicKey` from it, POST an unsigned body → 401; POST a signed PING (`X-Signature-Ed25519`, `X-Signature-Timestamp`) → 200 `{ "type": 1 }`.
- Compiled-binary runtime check (script, not a test): boot `/tmp/agent-swarm-api-trial` with a Discord entry and a bogus token; expect a scrubbed login error in the log, health `error`, and `GET /health` 200. Covers `discord.js` and `@discordjs/ws` (`worker_threads`) inside the compiled binary at runtime.

### Success Criteria:

#### Automated Verification:
- [x] Phase tests: `bun run test:root -- src/tests/chat-sdk-discord-gateway.test.ts src/tests/chat-sdk-discord-webhook.test.ts`
- [x] Full root suite as CI runs it: `bun run test:root -- --parallel=4`
- [x] Compile and runtime: `bun build ./src/http.ts ./src/scripts-runtime/executors/quickjs-worker.ts --compile --compile-exec-argv='--expose-gc' --outfile /tmp/agent-swarm-api-trial` then the bogus-token boot above using the Phase 1 compile-gate pattern (temp `DATABASE_PATH`, free `PORT`, `/health` poll, `kill`)
- [x] Image size recorded: `docker build -f Dockerfile -t agent-swarm-api:chat-sdk . && docker images agent-swarm-api:chat-sdk --format '{{.Size}}'` (baseline 381 MB; `.d.ts` files are not bundled by `bun build`, so the Teams typings do not reach the image)
- [x] Inner loop: `bun run check && bun run tsc:check:tsc && bun run lint:slop`

#### Automated QA:
- [x] Boot locally with a Discord entry using a bogus token: log shows `[chat-sdk] discord gateway backoff` after the login failure, no crash, `SIGTERM` exits within 15 s with `[chat-sdk] discord gateway stopped` in the log.

#### Manual Verification:
- [ ] Real Discord bot (Message Content intent enabled, interactions endpoint set to `${PUBLIC_MCP_BASE_URL}/api/integrations/chat/discord/webhook`): mention the bot in a channel → task; completion reply arrives in the thread; a `/ping`-style slash command, if registered, reaches the webhook (200). Record the login count in the Discord developer portal stays flat over an hour.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] chat-sdk discord gateway loop` after verification passes.

---

## Phase 6: Integrations card, status API, docs

### Overview

When this phase is done, the dashboard has a Chat SDK integration card (per-adapter forms with secret fields saved as `$config` refs, advanced JSON editor, webhook URL per adapter, adapter health, Telegram "Register webhook", Slack clash error), tasks with `source: "chat"` render in the UI, and the docs cover setup for all four platforms.

### Changes Required:

#### 1. Status and register-webhook routes
**File**: `src/http/integrations.ts`
**Changes**: `GET /api/integrations/chat/status` via `route()` with `schema`: `{ enabled, slackClash: boolean, adapters: [{ name, configured, health: "ok" | "error" | "disabled", error?, webhookUrl, mode?, gateway? }] }` from `getChatSdkConfig()` + `getChatSdkHealth()`. `POST /api/integrations/chat/telegram/register-webhook` with `rbac: { permission: "integration.chat.manage" }`: calls Bot API `setWebhook` with `${getPublicMcpBaseUrl()}/api/integrations/chat/telegram/webhook` and the configured `secretToken`, returns `getWebhookInfo` under a `schema`. Then `bun run docs:openapi`.

#### 2. UI
**File**: `apps/ui/src/lib/integrations-catalog.ts`
**Changes**: Entry `chat-sdk` (category `comm`, docsUrl, `specialFlow: "chat-sdk"`, `restartRequired: true`, fields `CHAT_SDK_ENABLED` (boolean) and `CHAT_SDK_ADAPTERS` (textarea, advanced, helpText with the JSON example), and a line in the card copy pointing at the seeded `chat-sdk` skill: `SkillSource` is only `"swarm-registry" | "template"` (`integrations-catalog.ts:74`), and a seeded skill needs no install, so either leave `recommendedSkills` out or extend `SkillSource` with a no-op `"seeded"` value in a small separate commit).
**File**: `apps/ui/src/lib/chat-sdk-fields.ts` (new) and `src/tests/chat-sdk-fields-sync.test.ts` (new)
**Changes**: The UI cannot import the API-side zod schema. Keep a plain field-list JSON in the UI and a backend test that compares it with the keys exported by `src/integrations/chat-sdk/config.ts` (`CHAT_SDK_ADAPTER_FIELDS`), so the two cannot drift silently (brainstorm asked for one schema source; this is the enforceable substitute).
**File**: `apps/ui/src/components/integrations/chat-sdk-section.tsx` (new), `special-flows.tsx`
**Changes**: Register `"chat-sdk"` in `SPECIAL_FLOWS` with `genericFields: "advanced"`. The section renders four adapter panels (Telegram, Slack, Discord, Teams), each with the fields from the schema; secret fields use the existing secret input and save as their own `swarm_config` secret rows named `CHAT_SDK_<ADAPTER>_<FIELD>`, while the JSON written to `CHAT_SDK_ADAPTERS` carries `{ "$config": "CHAT_SDK_<ADAPTER>_<FIELD>" }`. Per adapter: webhook URL (read-only, copy button), health line from `useChatSdkStatus` (new hook over `GET /api/integrations/chat/status`), Telegram "Register webhook" button (mutation, shows `getWebhookInfo` result), Slack clash banner when `slackClash`. Restart-required notice after save. Follow `apps/ui/DESIGN.md` and the `dashboard-ui` skill.
**File**: `apps/ui/src/lib/integrations-status.ts`
**Changes**: `chat-sdk` special case: `configured` when `CHAT_SDK_ENABLED` is true and `CHAT_SDK_ADAPTERS` parses to a non-empty object, `partial` when only one of them is set.
**File**: `apps/ui/src/pages/setup/steps/integrations/catalog.ts`
**Changes**: Add the `chat-sdk` entry if the wizard lists comm integrations.
**Files**: `apps/ui/src/api/types.ts` (`:25-31`, `~1262`, `~3048`), `apps/ui/src/components/shared/tasks-table.tsx:126`, `apps/ui/src/pages/tasks/[id]/task-source-line.tsx`, `apps/ui/src/pages/people/integration-icons.tsx`
**Changes**: Done in Phase 1; verify nothing regressed.

#### 3. Docs
**File**: `docs-site/content/docs/(documentation)/integrations/chat-sdk.mdx`
**Changes**: Full page: What it does; Configuration (`CHAT_SDK_ENABLED`, `CHAT_SDK_ADAPTERS`, `$config` refs resolve swarm_config rows only and never reserved keys, `CHAT_SDK_BUFFER_MS`, the env-only `CHAT_SDK_API_URL_OVERRIDES` for dev and test); per-platform setup (Telegram: BotFather, secret token, Register webhook, `mode: "polling"` for local; Slack: app manifest for the Chat SDK adapter, scopes, webhook vs socket, `SLACK_DISABLE=true`; Discord: bot token, public key, application id, Message Content intent, interactions URL, gateway loop note; Teams: Azure Bot registration, app id/password, tenant); How it works (buffer, routing, steer vs follow-up, relay, attachments); Tools; Extensions (`pre.chat.route`, `post.chat.message`); Limits per platform; Troubleshooting (health errors, clash, 405 in socket mode).
**Files**: `docs-site/content/docs/(documentation)/ui/configuration.mdx` (all catalog keys), `guides/extensions.mdx` (verify Phase 2 rows), `MCP.md` (verify Phase 3 section), `DEPLOYMENT.md` or `runbooks/local-development.md` (one paragraph: Chat SDK needs outbound network at boot and a public URL for webhooks).

#### 4. Tests
- `src/tests/chat-sdk-status-route.test.ts`: status shape with one ok and one error adapter; `register-webhook` posts `setWebhook` to the fake Bot API with the public URL and secret, 403 for a non-lead principal.
- UI: no unit-test infra by convention (memory note); verification is `tsc -b`, lint, the Playwright smoke, and agent-browser evidence.

### Success Criteria:

#### Automated Verification:
- [x] Backend: `bun run test:root -- src/tests/chat-sdk-status-route.test.ts && bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run docs:openapi && git diff --exit-code openapi.json`
- [x] UI: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [x] UI E2E smoke: `bun run e2e:ui -- --grep @smoke`
- [x] Full gate: `bun run check && bun run tsc:check:tsc && bun run lint:slop && bun run test:root -- --parallel=4 && bun run e2e`
- [ ] Docs build: `cd docs-site && bun install --frozen-lockfile && bun run build`

#### Automated QA:
- [ ] `agent-browser open http://localhost:5274/integrations/chat-sdk` (API with the fake Bot API Telegram config): screenshot the card empty, after saving a Telegram token (the JSON preview shows `{"$config":"CHAT_SDK_TELEGRAM_BOT_TOKEN"}` and no plaintext), with the health line `ok`, and with a Slack entry while `SLACK_DISABLE` is unset (clash banner). Recording of "Register webhook" click → `getWebhookInfo` result. Upload via the `github-attach` skill into the PR `## Before / after` section.
- [x] Task list filter `source=chat` shows the Telegram tasks with the chat icon; task detail shows the source line.
- [ ] `GET /api/integrations/chat/status` with a bogus Discord token returns `health: "error"` for discord and `ok` for telegram.

#### Manual Verification:
- [ ] Visual pass of the card against `apps/ui/DESIGN.md` on desktop and a narrow viewport.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 6] chat-sdk integrations card + docs` after verification passes.

---

## Manual E2E

Run after Phase 6 against a deployed or tunneled API (`PUBLIC_MCP_BASE_URL` must be public HTTPS for webhook-mode adapters; Telegram polling needs none). Replace `<...>` placeholders.

```bash
# 0. Secrets by reference (dashboard Secrets page or API)
curl -X PUT "$API/api/config" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '[{"key":"CHAT_SDK_TELEGRAM_BOT_TOKEN","value":"<botfather-token>","isSecret":true,"scope":"global"},
       {"key":"CHAT_SDK_TELEGRAM_SECRET","value":"<random-32>","isSecret":true,"scope":"global"},
       {"key":"CHAT_SDK_ENABLED","value":"true","scope":"global"},
       {"key":"CHAT_SDK_ADAPTERS","value":"{\"telegram\":{\"botToken\":{\"$config\":\"CHAT_SDK_TELEGRAM_BOT_TOKEN\"},\"secretToken\":{\"$config\":\"CHAT_SDK_TELEGRAM_SECRET\"},\"mode\":\"webhook\"}}","scope":"global"}]'
# restart the API (restartRequired), then
curl -s "$API/api/integrations/chat/status" -H "Authorization: Bearer $KEY" | jq
curl -s -X POST "$API/api/integrations/chat/telegram/register-webhook" -H "Authorization: Bearer $KEY" | jq   # expect url = $API/api/integrations/chat/telegram/webhook

# 1. Telegram: DM the bot "summarize today's open tasks". Expect a source=chat task for the Lead within ~10 s,
#    a reply in the DM when it completes, and a follow-up task when you answer in the same chat.
curl -s "$API/api/tasks?source=chat&limit=3" -H "Authorization: Bearer $KEY" | jq '.[] | {id,status,contextKey,agentId}'

# 2. Slack via Chat SDK (SLACK_DISABLE=true on this deployment, bespoke app stopped):
#    install a second Slack app from docs-site/.../integrations/chat-sdk.mdx manifest, set Event URL to
#    $API/api/integrations/chat/slack/webhook, mention the bot in a channel. Expect task + threaded reply.
#    Then set CHAT_SDK_ADAPTERS with slack while SLACK_DISABLE is unset, restart: expect the clash error in logs
#    and on the Integrations card, API still healthy.

# 3. Discord: bot with Message Content intent, interactions URL $API/api/integrations/chat/discord/webhook.
#    Mention the bot in a channel -> task; completion reply in a thread. Leave it 1 h, check
#    status.gateway.restarts stays 0 and the developer portal login count is flat.

# 4. Teams: Azure Bot with messaging endpoint $API/api/integrations/chat/teams/webhook, appId/appPassword
#    via $config refs. Message the bot in a 1:1 chat -> task; completion reply.

# 5. Extensions: install the route-chat-channel-to-agent fixture pointed at a worker, mention the bot in that
#    channel -> task assigned to that worker; GET /api/extensions/runs shows pre.chat.route modify + post.chat.message.

# 6. Attachments: send a PDF to the Telegram bot with a caption -> task with one attachment listed in the task detail.

# 7. Shutdown: `docker compose stop api` (or pm2 stop) completes within 15 s with
#    "[chat-sdk] stopped" and no DB-after-close errors.
```

---

## Appendix

- **Follow-up plans**:
  - Rich rendering (cards, streaming edits) and multi-workspace OAuth installs, after v1 lands.
  - A `--chat-sdk` leg for the black-box E2E runner (`scripts/e2e/run.ts` boots the bespoke Slack app, so a Chat SDK Slack scenario needs its own boot profile with `SLACK_DISABLE=true`).
- **Derail notes**:
  - `src/slack/inbound-files.ts:286-420` and the new `attachments.ts` are near-copies. Extract a generic `createTaskWithAttachments` once both are stable (two-adapters rule satisfied then); not done now because the plan does not touch `src/slack`.
  - `requestedByUserId` for chat authors is unset in v1. Kapso links by phone number (`resolveKapsoRequestedByUserId`); a people-link by `adapter:userId` is a small follow-up.
  - `integrations:*` KV namespaces are not reserved (`src/kv-reserved-namespaces.ts` reserves top-level families only). Kapso has the same exposure. Reserving `integrations` would need a family-prefix rule; out of scope.
  - Hot reload of `CHAT_SDK_ADAPTERS` through `reloadGlobalConfigsAndIntegrations` (`src/http/core.ts`) is possible later: `stopChatSdk()` then `startChatSdk()`. v1 is restart-only.
  - Chat SDK is beta with fast 4.x minors. Pin exact and add it to the daily docker/deps bump cadence (`chore(docker): bump ...` PRs) so adapter drift is caught by `chat-sdk-*.test.ts`.
  - `MIN_SEND_INTERVAL` and the in-memory `notifiedCompletions` sets from `src/slack/watcher.ts` are deliberately not copied; the obligation row is the only dedupe.
  - Steering ack text and the `[Thread follow-up: N message(s) buffered]` marker are constants, not prompt templates; only the thread-context prompt goes through the registry.
- **Decisions taken during planning** (2026-10-13, Taras):
  - Thread id inside contextKey: `encodeURIComponent` of the id after the adapter prefix.
  - `chat_relay_obligations` rows are written by SQL triggers mirroring migration 144.
  - One `Chat` instance per adapter for health isolation.
  - `source: "chat"` through zod and UI unions only; no migration (CHECK dropped in 056).
  - `disconnect()` on the SQLite state adapter is a no-op; `concurrency: "concurrent"` (review 2026-10-14: `queue` processes only the latest message and drops the rest into `ctx.skipped`).
  - Six state tables kept as decided in the brainstorm review (atomic single statements, inspectable rows). Under `concurrent`, `chat_queue` sees no traffic and `chat_locks` little; they stay because the `StateAdapter` contract requires the methods.
  - Changes to brainstorm decisions, recorded on review (2026-10-14, Taras): (a) threads stay subscribed after a terminal task (brainstorm: unsubscribe); plain replies must still reach the swarm. (b) A Slack clash logs and skips Chat SDK instead of failing boot. (c) `$config` resolves swarm_config rows only, rejects `RESERVED_KEYS`, and operator config cannot carry `apiUrl`; env-only `CHAT_SDK_API_URL_OVERRIDES` is the dev/test seam. (d) Lead `follow-up` tasks on a chat contextKey are relayed too, so delegated results reach the user. (e) The Integrations card writes secrets as `CHAT_SDK_<ADAPTER>_<FIELD>` rows; the advanced JSON editor still accepts any `$config` key (brainstorm: key picker). (f) No `CHAT_THREAD_STEERING*`, relay-cap or Discord-window env vars; constants instead.
  - Six phases; commit per phase after manual confirmation; Workflow fan-out used for research.
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-10-13-chat-sdk-channel.md`
  - Research spike outputs (session-local): `/tmp/chat-sdk-research/r0..r7.md`
  - Chat SDK docs: https://chat-sdk.dev
  - Chat SDK repo: https://github.com/vercel/chat
  - slack-mock: https://github.com/desplega-ai/slack-mock (`@desplega.ai/slack-mock@0.4.0`, Web API + Socket Mode, no Events API push)
  - Spike install: `/tmp/chat-sdk-spike/node_modules` (4.41.1 dist)

---

## Review Errata

_Reviewed: 2026-10-14 by Claude (independent Opus critique, 30 file:line refs spot-checked, all `bun run` scripts and `scripts/*` paths verified to exist). Output mode: auto-apply. Decisions on the four judgment calls taken by Taras._

### Applied
- [x] Critical: `$config` resolved against `process.env`, so a lead-written `{"$config":"API_KEY"}` plus an operator `apiUrl` could exfiltrate the swarm key. Now resolves swarm_config rows only, rejects `RESERVED_KEYS`, schema rejects `apiUrl`/`apiBaseUrl`/`webhookVerifier`; env-only `CHAT_SDK_API_URL_OVERRIDES` (added to `RESERVED_KEYS`) is the test seam. Tests and QA steps updated.
- [x] Critical: compile gate ran the binary with `--help`, which boots the API on :3013 and migrates the dev DB. Replaced with temp `DATABASE_PATH`, free `PORT`, `/health` poll, `kill`; same pattern replaces GNU `timeout` in the fresh-DB check and the Phase 5 runtime check.
- [x] Critical: steering only on `kind === "subscribed"`, but the SDK routes DMs to `onDirectMessage` even when subscribed, so DMs never steered. Steering now keys on "active task on this contextKey"; DM steering test added.
- [x] Critical: `concurrency: "queue"` processes only the latest queued message. Switched to `"concurrent"` (our buffer coalesces); `ctx.skipped` asserted empty.
- [x] Critical: relay gave up after 20 attempts at 3 s. Now exponential backoff on `last_attempt_at` (cap 10 min) and a 24 h time-based give-up constant; unhealthy adapter skips without counting.
- [x] Important: lead follow-ups are `source: "system", taskType: "follow-up"` and inherit the contextKey, so delegated results never relayed. Trigger now also fires for that arm; delegation test added.
- [x] Important: `source: "chat"` changes two generated type files; `build:extension-types` + diff check added to Phase 1.
- [x] Important: UI source unions and icon moved from Phase 6 to Phase 1 so chat tasks render from the first phase.
- [x] Important: brainstorm decisions changed without a record (unsubscribe policy, clash behavior, `$config` picker, single schema source). Appendix "Decisions taken" now lists each; schema sharing gets a UI field list + sync test in Phase 6.
- [x] Important: trigger used `LIKE` (case-insensitive in SQLite); now `GLOB`.
- [x] Important: Discord window env var dropped for a constant; the real risk (Gateway does not replay `MESSAGE_CREATE` during re-arm gaps) is now named and documented.
- [x] Important: `CHAT_THREAD_STEERING*` and relay-cap env vars dropped; constants reuse the Slack rule defaults.
- [x] Important: Teams test may reach Microsoft for MSAL/JWKS; pre-check and `fetch` stub added.
- [x] Important: Telegram SDK default mode is `auto` (starts polling against the real Bot API); schema defaults to `webhook`; QA examples made explicit.
- [x] Minor: `ParsedContextKey` variant now uses `parts`; `SkillSource` has no `"seeded"`; forward reference to the Phase 6 status route removed from Phase 4 QA; `AGENT_ID=$(uuidgen)` spelled out; `Headers` built from `rawHeaders`; `userName` source named; non-existent `ops-catalog-audit.test.ts` replaced.

### Remaining
- [ ] None. The reviewer's suggestion to shrink the six state tables to two was not applied: Taras chose dedicated tables in the brainstorm review; recorded in the Appendix with the traffic note.

---

## Implementation Errata

_Recorded by the orchestrator during autopilot implementation (2026-10-14). Each entry changes or clarifies plan text; the code is the reference._

### Phase 1
- Boot does not await `startChatSdk()`; adapters initialize in parallel. Reason: the Slack adapter's `auth.test` retry can block for minutes and would stall the scheduler, heartbeat and supervisor. Cost: the webhook answers 404 while an adapter is still initializing, 503 when it failed to start.
- `userName` is passed to an adapter only when the operator sets it. Passing `"swarm"` to Telegram sets `hasExplicitUserName` and blocks the `getMe` username, which breaks mention detection. `Chat` itself gets `userName ?? "swarm"`.
- Every adapter gets an explicit default `apiUrl` (Telegram `https://api.telegram.org`, Slack `https://slack.com/api/`, Discord `https://discord.com/api/v10`, Teams unset) and Telegram gets `allowUnverifiedWebhooks: false`. Reason: adapters fall back to `process.env.*_API_URL`, and global swarm_config rows are injected into env. The schema also rejects `allowUnverifiedWebhooks`.
- `@slack/web-api` is pinned to `7.13.0` as a direct dependency. `@chat-adapter/slack` needs `^7.18`; without the pin bun hoists 7.19 and `src/slack` (which gets web-api through bolt) fails tsc with two `WebClient` declarations. The adapter keeps a nested 7.19.0.
- UI: only the `AgentTaskSource` union, two icon maps and a "Chat" label changed. The unions near `apps/ui/src/api/types.ts:1262` and `:3048` are `AutomationIntegrationId` and `MilestoneId`, and `people/integration-icons.tsx` maps identity kinds. None are task sources.
- `CHAT_SDK_API_URL_OVERRIDES` is also in the SQL denylist inside `getInjectableGlobalConfigs` (defense in depth with `RESERVED_KEYS`).
- The compile-gate command needs `MIGRATIONS_DIR=$PWD/src/be/migrations` for the compiled binary (the Dockerfile sets it). `PUT /api/config` takes one object, not an array; the QA examples send one PUT per key.
- Deferred to Phase 3 on purpose (review 2026-10-14): `sweepExpired` is exported but not yet scheduled, so `chat_state_kv` dedupe rows accumulate until the Phase 3 watcher runs it. The relay-obligation triggers likewise fill `chat_relay_obligations` ahead of the Phase 3 consumer. Both are fine because all phases ship in one PR.
- **Phase 3 must gate tool registration on `getEnabledCapabilities()` / `isChatSdkEnabled()`, not `hasCapability("chat-sdk")`**: `hasCapability` reads only `CAPABILITIES`, so tools gated on it never register when the operator enables Chat SDK via `CHAT_SDK_ENABLED` alone.

### Phase 2
- `ChatRouteModifySchema` lives in `src/integrations/chat-sdk/inbound.ts` next to its use. `contract.ts` imports zod as a type only, and a runtime schema there could break the type bundler.
- `src/workflows/event-bus.ts` has no event map; names are plain strings. The `chat.message.received` row was added to the built-in events table in `runbooks/workflows.md`. `chat.message.sent` is subscribed by the post-bridge and first emitted in Phase 3.
- The contextKey lookups (`getAgentWorkingOnContextKey`, `getLatestActiveTaskByContextKey`, `getLatestLeadTaskByContextKey`) take an optional `source`; chat passes `"chat"` so delegated worker tasks and follow-ups that inherit the contextKey cannot become the thread owner or the steering target.
- Steering: target is the latest lead task on the contextKey in `in_progress`. Skipped for `!now`, attachments, and threads that already have buffered messages (order kept). A `SteeringRequestError` falls back to buffering. The ack is a constant markdown line; since Phase 3 it also emits `chat.message.sent`.
- KV channel-mapping key is `chatChannelKey(adapter, channelId)` in `router.ts`; SDK channel ids already carry the adapter prefix, so the key is the channel id itself. Phase 3 register tools must use the same helper.
- Attachments are fetched once per flush and shared across matched tasks. File ids are `<messageId>-<n>` with characters outside `[\w.-]` replaced by `_`. Missing MIME becomes `application/octet-stream`.
- `CHAT_SDK_BUFFER_MS` is read lazily (buffer rebuilt when the value changes and no thread is waiting), so it is not `restartRequired`. Guard bounds 1..600000. Timer flushes are registered with `trackBackground`; `stopChatSdk` flushes waiting threads before adapters shut down.
- Workflow target uses `handleWebhookTrigger(..., { alreadyAuthenticated: true })` like Kapso.
- No reachable lead: the task goes to `getLeadAgent()` and waits (or is created unassigned), like Slack's queued path.
- QA adaptations: `GET /api/tasks` needs `fields=full` to return `contextKey`; attachments are read from `GET /api/tasks/<id>` and `/api/fs/tasks/<id>/files` (there is no `/attachments` route); a local boot needs `MULTI_RUNTIME_ENABLED=false` or agent registration requires `runtimeInstanceId`.
- Deferred: `templates/skills/swarm-extensions/content.md` lists extension events but not the chat ones (Phase 6 docs, needs `build:skill-md`).
- Known limitation (review 2026-10-14): `subscribe()` runs when the flush creates the first task, as planned. In an unsubscribed group thread, a reply without a mention inside the first buffer window reaches no SDK handler and is dropped. Extension `broadcast` targets every non-lead agent with no reachability filter, matching Slack.

### Phase 3
- Tool gate: the local `hasCapability` in `createServer` resolves `chat-sdk` through `isChatSdkEnabled()`, so the registration block stays `if (hasCapability("chat-sdk"))` and the MCP.md generator still finds it. `CAPABILITIES=core,chat-sdk` alone registers nothing. The full-surface script bridge always has the tools.
- `chat-reply` hiding: `selectTaskTools` only controls preloading, so `tools/list` needed a session-level filter. `createServer({ excludedTools })` is set by `src/http/mcp.ts` when the `x-source-task-id` task is not chat-family. Without the header the tool stays and falls back to the agent's current task (as `request-human-input` does). It refuses tasks the caller neither owns nor created.
- Relay DB API: `getPendingChatRelayTasks(now, limit)` returns `{task, attemptCount, createdAt, lastError}` and applies the backoff filter in SQL; `markChatRelayAttempted(taskId, now)` is conditional on the same predicate so two concurrent ticks cannot both send; failures go through a separate `recordChatRelayError`; both writers scrub `last_error` in the DB layer (`.text-columns.json` now `scrubbed`).
- Backoff is `min(3 s × 2^attempt_count, 10 min)` on the bumped count, so the first retry is after 6 s. The 24 h give-up check runs before the adapter-health check so rows for a permanently removed adapter still close. An unparseable contextKey is given up at once.
- `chat.message.sent` fires once per logical message (full text, last chunk id), not per chunk. A later chunk failure re-posts earlier chunks on retry (no per-chunk progress column).
- Watcher starts before adapters initialize and stops first in `stopChatSdk`. `sweepExpired` runs every 20th tick. Bus terminal events schedule one tick after 250 ms.
- The steering ack is posted and emitted in `inbound.ts`, not `steering.ts`.
- `chat-open-dm` calls `chat.getAdapter(name).openDM(userId)` directly (`Chat.openDM` guesses the adapter; numeric ids are ambiguous). `chat-read-thread` uses `history.thread.list(threadId, { limit, direction: "backward" })`. `register-chat-channel` requires exactly one of `agentId` / `workflowId` and checks existence.
- RBAC: the four non-register tools stay open to all agents as planned, with reasons in `scripts/check-rbac-coverage.ts`. `slack-post` is lead-only; whether `chat-post` / `chat-open-dm` should be too is an open decision for Taras.
- Script SDK types are hand-written in `src/be/scripts/typecheck.ts`; the six signatures were added there before regeneration. `MCP.md` is generated (`bun run docs:mcp`) with a "Chat SDK Tools" title override and an enable hint; the regeneration also picked up a stale `script-upsert` description from main.
- `templates/skills/chat-sdk` has no `SKILL.md`, matching `apps`.
- QA: the Docker worker skill-file check was not run; the skill was verified through `GET /api/skills` and the seed log line.
- Known: the header comment of migration 213 still mentions an attempt cap (migrations are checksummed, so it is left as is).
- Review fixes (2026-10-14): the pending relay query is filtered to running adapters and a separate `giveUpStaleChatRelays` UPDATE closes 24 h old rows for every adapter, so a down adapter cannot starve the 200-row window. Delivery is at-least-once (chunk failure re-posts earlier chunks; a crash between send and `markChatRelayDelivered` re-sends). Telegram thread history is persisted in our SQLite state (100 messages, 7 days), not "since restart".
- **Open decision for Taras:** `chat-post`, `chat-read-thread`, `chat-open-dm` are open to all agents per the plan, while Slack's `slack-post` / `slack-read` are lead-gated. Parity would mean a new `integration.chat.post` verb or reusing `integration.chat.manage`.

### Phase 4
- slack-mock 0.4.0 (latest) answers `no_text` to the Chat SDK Slack adapter's `markdown_text` posts, which real Slack accepts. Tests and QA run a proxy shim `scripts/dev/slack-markdown-text-shim.ts` in front of slack-mock that copies `markdown_text` into `text`. Production outbound is unchanged. Follow-up: add `markdown_text` support to desplega-ai/slack-mock, then delete the shim.
- Teams `initialize()` in `@microsoft/teams.apps` 2.1.0 makes no network call, so an unreachable `apiUrl` cannot fail it. The health-isolation test uses a blank `appId` (the adapter's appId resolver throws inside `initialize()`): Teams `error`, Telegram `ok`, Teams webhook 503. The Teams SDK uses axios/MSAL, not `fetch`, so no fetch stub; a first message without `aadObjectId` triggers no member/Graph/history call and `apiUrl` points at a closed local port.
- `@chat-adapter/teams` always passes the deprecated `skipAuth` to `App` and does not forward `logger`; Teams SDK logs bypass `scrubSecrets`. Teams keeps the `SERVICE_URL` env fallback when `apiUrl` is unset (an explicit default would pin every call and break per-thread service URLs).
- Schema: Slack `mode` defaults to `webhook`; `signingSecret` is required in webhook mode and `appToken` in socket mode. Teams `appType` defaults to `MultiTenant`; `SingleTenant` requires `appTenantId`. These rules make the adapters' env fallbacks unreachable. The Slack branch passes `socketForwardingSecret: ""` and `encryptionKey: ""` to block `SLACK_*` env fallbacks.
- `getEnabledCapabilities()` now also drops the bespoke `slack` capability when `SLACK_DISABLE=true` (plan item 3 assumed this already held). **Taras to confirm:** this changes `serverCapabilities` prompt gating for workers on deployments with `SLACK_DISABLE=true`.
- Handler work is wrapped in `trackBackground` so socket-mode events (which arrive without `waitUntil`) are drained on shutdown. Handler errors are logged by the tracker instead of rethrown to the SDK.
- `watchSocketConnection` surfaces `@slack/socket-mode` reconnects as scrubbed warnings in health; the socket client's own logs bypass our logger.
- QA artifacts (local only, no PR yet): `/tmp/chat-sdk-slack-thread.png`, `/tmp/chat-sdk-frames/`, journal `/tmp/chat-sdk-qa/slack-socket.jsonl`. New test files are outside `tsc:check`; they were type-checked with a temporary tsconfig.
- Review fixes (2026-10-14): the Teams SDK reads `SERVICE_URL`, `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `MANAGED_IDENTITY_CLIENT_ID` and `CLOUD` from `process.env`; a `SERVICE_URL` config row could redirect the bot token. Those six keys now join the env-injection denylist in `getInjectableGlobalConfigs` (not `RESERVED_KEYS`: operators may still store them; they never reach env). Deployment env can still set them on purpose. `propagateHandlerErrors` was removed from the webhook call (moot once handlers catch their own errors; Telegram and Slack ack before processing, so no retry semantics changed). Socket reconnects log at info; only `unable_to_socket_mode_start` and `error` reach health. Harness renamed to `src/tests/chat-sdk-harness.ts`.
- Known: `slack-*` MCP tools still register from raw `CAPABILITIES` even when `SLACK_DISABLE=true` drops the prompt capability (pre-existing mismatch for HTTP mode too).

### Phase 5
- `startDiscordGateway(adapter, options?)` takes no `chat` argument (`startGatewayListener` already checks `this.chat`). Tests inject `windowMs`, `sleep` and `now`.
- A bad bot token does not set the adapter `status` to `error`. Status stays `ok`, `gateway.state` becomes `backoff`, and `lastWarning` holds the scrubbed listener error. Reason: the interactions webhook still works without the Gateway, and `status: error` would make the webhook answer 503.
- A non-200 from `startGatewayListener` (for example 500 "not initialized") logs and backs off instead of looping.
- New test hook `disableDiscordGateway` in `test-hooks.ts`: `discord.js` login ignores `apiUrl` and would reach real Discord. Production never sets it.
- `respondToChannelIds` and `mentionRoleIds` default to `[]` so the `DISCORD_RESPOND_TO_CHANNEL_IDS` / `DISCORD_MENTION_ROLE_IDS` env fallbacks cannot apply. `mentionRoleIds` was added to the schema.
- `stopChatSdk` order: stopping flag, relay watcher stop, `stopDiscordGateway()`, drain, flush, drain, adapter shutdown. Shutdown resets gateway health.
- Verified: compiled binary with a bogus token logs `TokenInvalid` (token appears 0 times), `discord gateway backoff`, `/health` 200, SIGTERM exits in about 1 s with `discord gateway stopped`. Image 378 MB (baseline 381 MB). Parallel suite 14295 pass, 0 fail.
- Follow-ups: the adapter's own info logs print `publicKey` and signature prefixes (noisy, not secret); a single `discord.js` client across windows via the forwarding path would remove the message loss at window gaps; Phase 6 docs must state that gap.
- Review fixes (2026-10-14): `stopChatSdk` uses one 10 s shutdown budget shared by both drains; `stopDiscordGateway()` only aborts and does not wait on its own, so SIGTERM stays inside the budget even when `discord.js` login hangs. Each Gateway window gets its own `AbortController` linked to the outer signal (the adapter never removes its abort listener, so a shared signal leaked one listener per 6 h window). The Discord adapter logger filters the per-message `Discord Gateway message received` info line (it carried user text for every guild message) and the per-interaction `publicKey`/signature-prefix noise; warn/error untouched. `publicKey` must be 64 hex chars. Health `lastWarning` now carries the scrubbed error cause. `propagateHandlerErrors` is not passed to the Gateway listener (consistent with Phase 4).
- Known: the `stopped` gateway state is reset by `stopChatSdk` and is visible only to direct `getDiscordGatewayHealth()` callers.

### Phase 6
- Status response (`GET /api/integrations/chat/status`) carries an optional top-level `error` (config resolution error, shown as a banner). `configured` and `slackClash` derive from the raw `CHAT_SDK_ADAPTERS` keys so the card shows them even when `$config` refs do not resolve; `mode` comes only from the non-secret field. A configured adapter that is not running reports `health: "disabled"` with a restart hint.
- Register-webhook: 400 when Telegram is not configured, is in polling mode, or has no `secretToken`; 502 when the Bot API fails; the token is redacted from error text. The Bot API base comes from `resolveAdapterApiUrl()` shared with the adapters. RBAC: operators and dashboard users may call it (same as `ensureConfigAdmin`); agents need `integration.chat.manage` (lead-only).
- The card has an explicit Save, not autosave, because it writes one combined JSON. Order: secret rows (`CHAT_SDK_<ADAPTER>_<FIELD>`), then `CHAT_SDK_ADAPTERS`, then `CHAT_SDK_ENABLED`; no `/api/config/reload`. Unknown keys and existing inline or other `$config` refs are preserved. An info callout appears when config comes from the environment only.
- No `recommendedSkills` (no seeded `SkillSource`); the card copy says the built-in `chat-sdk` skill needs no install. The setup wizard is unchanged: its integrations list comes from API onboarding signals, and Kapso is not in it either.
- Docs state the webhook answers 404 while an adapter is still starting and 503 after a failure or during shutdown (what the code does). Discord Interactions Endpoint URL is documented as optional per the adapter README; Slack scopes follow the adapter README manifest plus `im:write` and `files:read`, unverified against a real app.
- QA: the bogus-Discord item expected `health: "error"`; the Phase 5 design yields `ok` + `gateway.state: "backoff"` with the scrubbed `TokenInvalid` cause in `error`. The item wording is superseded. `cd docs-site && bun install --frozen-lockfile` fails on unmodified HEAD too (local Bun 1.4.2 vs pinned 1.4.0); the unfrozen build passes. Screenshots and the register-webhook recording are under `/tmp/chat-sdk-p6/` (nothing uploaded; no PR yet).
- Open: whether `?source=chat` filters the tasks page with more than one source (only one task existed in QA); `chat-post` / `chat-read-thread` / `chat-open-dm` lead-only decision (Phase 3).
- Review fixes (2026-10-14): `$config` objects on text fields are preserved unless edited (they rendered as `[object Object]` and were saved back); secret rows are written as a first batch and `CHAT_SDK_ADAPTERS` / `CHAT_SDK_ENABLED` only after every secret row succeeded (a failed row left a dangling ref that blocked boot); `ensureChatManage` reuses a parameterized `ensureConfigAdmin`; the status `error` no longer embeds the JSON parser message (it could echo an inline token) and is bounded; register-webhook has a 10 s Bot API timeout; env-only state renders effective, disabled switches; `secretToken` is validated client-side (`[A-Za-z0-9_-]{1,256}`); the card Save row is visible without scrolling; secret plaintext is masked in the JSON preview; pure form helpers moved to `apps/ui/src/lib/chat-sdk-form.ts` with tests; docs gained an unverified Slack app manifest block.
- RBAC note: `ensureChatManage` resolves operator (shared API key) and dashboard users as allowed, like `ensureConfigAdmin`; the lead-only `integration.chat.manage` verb applies to per-agent tokens or a bare `X-Agent-ID`. Kapso registers numbers through an MCP tool, so there is no HTTP precedent.
- Review round 2 (superagent-security + desplega-bot, 2026-10-14): the Phase 3 "open to all agents" decision is reversed. `chat-post` and `chat-open-dm` are lead only (`integration.chat.post`, `integration.chat.dm`). `chat-read-thread` lets any agent read the thread of its own task (X-Source-Task-ID or current task, owner or creator) and needs `integration.chat.read` for any other thread, like `slack-read`. Helper: `src/tools/chat-access.ts`.
- Review round 3 (desplega-bot, 2026-10-14, P1): task lineage could mint chat access (send-task with a foreign parentTaskId inherited its contextKey). New verb `task.parent.attach` (assignee, creator, lead, operator, user) gates `send-task` and POST /api/tasks before the child exists; a non-lead agent cannot bind a new task to a `task:chat-sdk:` contextKey over HTTP. The creator shortcut in chat-access/chat-reply stays, now safe by construction.
- QA follow-up (2026-10-14): the v1 "restart only" decision for `CHAT_SDK_ENABLED` / `CHAT_SDK_ADAPTERS` is reversed. `reloadGlobalConfigsAndIntegrations` calls `restartChatSdkIfConfigChanged()`, which compares a sha256 of the resolved config (plus `SLACK_DISABLE`) against the fingerprint `startChatSdk` applied, so a card save or a `$config` secret rotation restarts the adapters within seconds; the start wait is bounded to 15 s.
- QA follow-ups (2026-10-14): typing keepalive (`typing.ts`, every 4 s from the first DM or mention until the relay, 15 min cap, per thread not per task); card setup steps per adapter (`chat-sdk-setup.tsx`), webhook URL row with copy and a tunnel hint for loopback hosts, mode option hints; docs gained a tunnel subsection.
- QA follow-ups (2026-10-15, ee1a1b578): slash commands `/help`, `/status`, `/cancel`, `/reset` in `commands.ts`, one catch-all `chat.onSlashCommand` per Chat (unknown commands get the help text; Telegram would otherwise drop `/x` messages silently). Telegram registers the menu with `setMyCommands` at adapter start (`telegram-api.ts` shared with register-webhook). Slack and Discord need a one-time registration (manifest `slash_commands`, `PUT /applications/{id}/commands`), documented on the card and in the docs; Discord commands arrive only through the Interactions Endpoint URL; Teams has none. `/reset` stores `swarm:reset:<threadId>` (30 d TTL) in `chat_state_kv`: the next task gets no `parentTaskId` and no `<thread_context>` older than the reset. Routing still picks the previous owner ("thread follow-up" continuity), by design. Sibling awareness still sets a parent from a task that is still running after `/reset`; the reply says so and points to `/cancel`.
- Root cause of empty context after restarts: `Thread.refresh()`, `allMessages` and `history.thread.*` in chat 4.41.1 use the persisted `msg-history:` list only when the adapter returns zero messages, and the Telegram adapter's `fetchMessages` reads an in-memory cache, so any adapter restart (API restart, card save hot reload) lost the history. `getChatThreadContext` now merges `readPersistedThreadHistory(threadId)` with `thread.recentMessages` (dedup by id, sorted by `dateSent`, last 20). Upstream issue not filed yet.
- Live Telegram check 2026-10-15: `/start` → unknown-command help, `/status`, `/reset`, then a message created a task with no parent and no context, relayed. 25 consecutive `getUpdates` network errors appeared on the old API process before the restart (laptop network, not code).
- Merge of main 2026-10-15: main took ordinal 213 (`213_script_connections_sql`), so the Chat SDK migration is now `214_chat_sdk_state.sql` (test file renamed to `migration-214-chat-sdk-state.test.ts`). A local DB that applied the old 213 needs `UPDATE _migrations SET version=214, name='214_chat_sdk_state' WHERE name='213_chat_sdk_state'` before the next boot. Slack and Teams are marked experimental (card BETA tag + first setup step, docs callouts), tracked in issue #2149.
- Second merge of main 2026-10-15 (v1.173.0, PM2/services removal): `src/server.ts` capability filter now keeps only `ALL_CAPABILITIES` names (main) and still adds `chat-sdk` from `CHAT_SDK_ENABLED`; OpenAPI footprint is 425 operations; `MCP.md` regenerated with `bun run docs:mcp`. Review round 4 (superagent-security, P2): a workflow channel mapping fired for unaddressed replies in the subscribed thread, so each reply started another run. `routeChatMessage` now returns the workflow target only for a bot mention or a DM; a plain reply falls through to the thread owner, else it is ignored. Agent mappings are unchanged (the mapped agent is the channel's owner and gets follow-ups).
- Feedback round 2026-10-15 (Taras, after the Discord save): (1) partial saves: `ChatSdkAdaptersDraftSchema` (every field optional, forbidden keys and formats still enforced) guards the config write; `getChatSdkConfig` validates each adapter against its full schema and resolves its refs on its own, so an adapter with a missing field or an unresolvable `$config` lands in `config.incomplete[name]` ("<path>: required") and the others start; status health `incomplete`; the card lists the missing fields as a warning and keeps Save enabled; the fingerprint ignores `incomplete`, so a partial save does not restart the running adapters. (2) The Setup accordion remounts on the adapter switch: open while off, collapsed once on. (3) Discord invite link on the card and in the docs: `discordInviteUrl(applicationId)` with scopes `bot applications.commands` and permissions `326417632320`. (4) "Installed the app but nothing happens": the status now calls `GET /users/@me/guilds` (60 s cache, only while the Gateway runs) and the card says "Running, in no server" with the invite hint, or lists the servers. Taras's bot was in 0 servers. The save that added Discord had also dropped Telegram from `CHAT_SDK_ADAPTERS` (cause not reproduced: a second adapter saved from the browser kept the first); Telegram was restored by hand (`botToken` ref + `mode: polling`).
- Feedback round 2 (2026-10-15): the Telegram "drop" was the panel switch: off removed the entry. Now off writes `enabled: false` into the entry (schema `COMMON_SHAPE`, config `disabled[]`, status `enabled`, card "Off, configuration kept" + "Remove configuration"); on omits the flag. Secret rows of a switched-off or removed adapter are reused through `effectiveSecretValue` (`{ $config: CHAT_SDK_<ADAPTER>_<FIELD> }` when the row exists). Saves merge over the row as stored at save time (`mergeAdaptersForSave`: only touched adapters take the form's version). Setup accordion: open when the switch is on, collapsed when off (first version was inverted). "Copy for your agent" in the Setup header copies the rendered steps as plain text with links, the webhook URL and the field list (tooltip: send it to Exty or an agent with computer use). Discord live: mention in #general created a task and the reply landed in a thread (Taras, 13:27); status lists the SheetSQL server.
- Third merge of main 2026-10-15: main took 215 (`swarm_config` `exportToEnv`) and 216 (task resolved effort), so the Chat SDK migration is now `217_chat_sdk_state.sql` (local DB row renamed by UPDATE). `CHAT_SDK_*` rows default to `exportToEnv: false` (`ENV_EXPORT_DEFAULT_OFF_PREFIXES` in `config-env-export.ts`) and the card sends the flag explicitly; the API-side env injection ignores the flag, so the channel still boots from the rows.
- Review round 5 (superagent-security, 2026-10-15, P2): the public webhook buffered the body unbounded before the signature check. `src/http/webhooks.ts` now caps it at 1 MiB (`CHAT_SDK_WEBHOOK_MAX_BODY_BYTES`): a declared `Content-Length` above the cap answers 413 before any read, a stream that crosses it answers 413 at once and drains without buffering. Per-client rate limiting declined: the platforms call from their own hosts and the signature check is cheap. Covered in `chat-sdk-webhook-telegram.test.ts`.
- slack-mock 0.4.1 (2026-10-15, desplega-ai/slack-mock#6) accepts `markdown_text` on chat.postMessage, postEphemeral and update, so the proxy shim `scripts/dev/slack-markdown-text-shim.ts` is deleted and `chat-sdk-slack.test.ts` points the adapter at the mock directly.
