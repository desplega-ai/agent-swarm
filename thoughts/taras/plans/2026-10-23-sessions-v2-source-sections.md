---
date: 2026-10-23
author: taras
topic: "Sessions v2 slice 5: Slack and chat source sections, source keys, and backfill"
tags: [plan, ui, sessions, slack, chat-sdk, asset-keys, backfill]
status: completed
autonomy: critical
commit_per_phase: true
issue: https://github.com/desplega-ai/agent-swarm/issues/2338
---

# Sessions v2: Slack and Chat Source Sections Implementation Plan

## Overview

Sessions v2 slice 5 (#2338). Slack and chat sessions get source asset keys. A one-time job re-keys old sessions. The sidebar shows one collapsed, read-only section per source, with real channel names.

- **Motivation**: a Slack or chat session sits in No group today, with only a "From Slack" note in its timeline. Power users want to see and triage their external conversations by source.
- **Related**: issue #2338, `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md` (slice 5, A2, A3, A11, A17), `thoughts/taras/plans/2026-10-21-sessions-v2-power-users.md` (#2329), `thoughts/taras/plans-yolo/2026-10-23-sessions-filter-select-all.md` (#2367), #2379 (source filter allowlist and the Done rule, merged after the first draft), mockup spec on agent-fs `/mockups/agent-swarm/sessions-v2/SPEC.md`.

## Current State Analysis

### Key assignment (main dd1ac9f1d)

- `createTaskExtended` sets `normalizeAssetKey(options?.key ?? defaultAssetKey("task", id))` (`src/be/db.ts:2847`). A child copies `parent.key` when no key is passed (`db.ts:2656-2657`). `send-task` (`src/tools/send-task.ts:460-461`) and `POST /api/tasks` (`src/http/tasks.ts:1085-1088`) also resolve `key ?? parentTask.key`, and they pass that inherited key through `authorizeAssetKeyWrite`. The legacy `createTask` in `src/be/db/tasks/write.ts:92` always writes the default.
- `authorizeAssetKeyWrite` (`src/be/asset-key-auth.ts:21-47`) only normalizes `shared/*` keys and checks the owner of `personal/<uid>/`. No reserved-prefix policy exists.
- Slack roots (all `source: "slack"`, none sets `key`): a queued mention with no agent (`src/slack/handlers.ts:730-743`), a lead mention in a new thread (`handlers.ts:848-866`), a worker mention, which is always a new root (`handlers.ts:876-890`), assistant threads with no lead or a first message (`src/slack/assistant.ts:276-288`, `306-321`), and the rare root from a buffer flush (`src/slack/thread-buffer.ts:295-316`). Thread ts is `msg.thread_ts || msg.ts`. A DM is a channel id that starts with `D` (`src/slack/watcher.ts:433-434`).
- Agents also create roots inside Slack threads: on prod, 226 `source = 'mcp'` roots share channel and thread with a Slack root (a lead `send-task` with Slack fields and no parent).
- chat-sdk has one creation path, `flushChatThread` (`src/integrations/chat-sdk/inbound.ts:376`, task options at `540-563`, insert through `createChatTaskWithFiles` at `566`): `source: "chat"`, `tags: ["chat-sdk", <adapter>]`, `contextKey = task:chat-sdk:<adapter>:<encodeURIComponent(rest)>` (`src/tasks/context-key.ts:136-147`, parsed by `chatThreadOfContextKey` at `153-163`). Later messages in the thread become children (`parentTaskId: mostRecentTask?.id`), so a chat is one chain until `/reset`. chat-sdk never writes `slackChannelId`.
- Thread ids: Telegram `telegram:<chatId>[:<topicId>]`, Discord `discord:<guildId|@me>:<channelId>[:<threadId>]` (`node_modules/@chat-adapter/discord/dist/index.js:2273-2276`), Slack via chat-sdk `slack:<channel>:<ts>`, Teams `teams:<base64url>:<base64url>[...]` (`src/integrations/chat-sdk/teams-origin.ts:55`, too long for a 255-character key). Kapso uses `source: "system"` and is not chat-sdk.
- `normalizeAssetKey` lowercases and has no character rules (`src/assets/key.ts:45-73`). `shared/slack/c0ar967k0kz/thread:1729000000.123456/` and `shared/telegram/-1001234567890/thread:42/` both pass. Slack ids are uppercase, so a Slack call must use `toUpperCase()`.
- Moves: `POST /api/session-moves` (bulk, sets each root key to `groupKey`, or to the default for `null`, `src/http/sessions.ts:675-692`, `1045-1073`) and `POST /api/session-moves/prefix` (rename and delete, owner only, `sessions.ts:694-710`, `1075-1145`) check access per root in `checkSessionMove` (`sessions.ts:736-762`). `PATCH /api/assets/task/{id}/key` moves one task (`src/http/assets.ts:308-400`). None refuses a source prefix. The UI Undo restores the exact old key (`apps/ui/src/components/sessions-v2/sidebar/use-tree-moves.ts:129-143`).

### Session tree server (main dd1ac9f1d)

- `GET /api/session-tree` returns counts only: `groups[]` (`key`, `lastActivityAt`, `total`, `unread`, `running`, `needsYou`), the `inbox` / `later` / `done` / `noGroup` sections, and `sources[]` (`src/http/sessions.ts:604-620`, `1011-1025`, schema `154-163`). It takes `show`, `showSource`, and the older `hideSource`.
- `GET /api/sessions` pages every list (Inbox, Later, Done, No group, one group) with `groupKey`, `noGroup`, `keyPrefix`, `triage`, `showSource`, `hideSource`, and offset paging (`src/http/sessions.ts:523-602`, `943-1009`). Each row carries `groupKey: sessionGroupKey(row.key)` (`src/be/db.ts:13001`).
- `getSessionTree` runs one summary query and builds a flat group map in JS (`src/be/db/session-tree.ts:395-466`). The client nests groups by `/` (`apps/ui/src/api/types.ts:845`, `SessionTreeResponse` at `852-860`).
- Leaf rule: `sessionGroupKey` strips one final `task:` / `thread:` / `schedule:` / `workflow:` segment (`src/assets/key.ts:92-101`). So `shared/slack/c1/thread:1.2/` already maps to group `shared/slack/c1/`. No rule makes a thread with 2 or more roots a nested group. `groupCondition` (`src/be/db/session-tree.ts:77-96`) lists a group as the exact key plus its direct leaves.
- No group is a root whose group key is `shared/` or `personal/<me>/` (`src/be/db/session-tree.ts:443-444`, list side `144-151`). That covers the bare `shared/` key (the column default from migration 115) and the per-task default `shared/task:<id>/`.
- Ownerless roots leave the tree through `r.requestedByUserId IS NOT NULL` when `tree` is set for a user (`src/be/db/session-tree.ts:136`). The bypass actor (the API key) has no viewer, so its tree includes ownerless roots. Visibility is `sessionViewerCondition` (`src/be/db/session-visibility.ts:25-28`).
- Source filter (#2379, merged after this plan's first draft): an allowlist. `showSource` keeps only roots whose `r.source` is in the list, and an empty list keeps none. `hideSource` stays for older clients, and the generic `source` param restricts by raw `r.source` (`sessionRootFilter`, `src/be/db/session-tree.ts:98-160`: `source` at `106-108`, `hideSource` at `109-111`, `showSource` at `112-119`). The tree applies `hideSource` and `showSource` in JS, so `sources` still counts filtered-out sources (`440-441`).
- Done (#2379, #2381): a Done session comes back only for a pending approval, a human-attributed task, or a person's steering message created after the Done mark (`reopensDoneSql`, `session-tree.ts:189-199`). Agent activity and key moves leave it in Done. `moveSessionChains` does not touch `lastUpdatedAt` (`src/be/db/session-moves.ts:87-88`).
- Prefix and group lookups use key ranges on `idx_agent_tasks_asset_key` (migration 115), never `LIKE`. `sessions-tree.test.ts:157-180` asserts the query plan.

### Labels and backfill infrastructure

- Slack client: `getSlackApp()?.client` (`src/slack/app.ts:33`). It is null when Slack is disabled, unconfigured, or in HTTP mode. It exists only after `startSlackApp()` resolves in the listen callback (`src/http/index.ts:776`).
- No channel-name cache exists. `conversations.info` runs only in `getChannelExternality` (`src/slack/external-channel.ts:112`). DM partner names come from `users.info` in `src/tools/slack-list-channels.ts:108`, uncached.
- Cache precedent: the Slack user-enrichment cache in `kv_entries`, namespace `integration:user-enrichment:slack`, 24 h TTL (`src/slack/enrich.ts:35-36`, `91-101`), through `getKv` / `upsertKv` (`src/be/db.ts:13682`, `13734`). `chat_state_kv` belongs to the chat SDK `StateAdapter` (`src/integrations/chat-sdk/state.ts`), so it is the wrong home for labels.
- Rate limits: `callSlackWithRetry` (`src/slack/render-v2.ts:124-139`) retries `ratelimited` errors with `retry_after`.
- chat-sdk stores no titles. A Telegram chat title exists only in the inbound update (`src/integrations/chat-sdk/facts.ts:37`, `95`) and goes into the task header text. No `getChat` call and no Discord channel-name call exist.
- Move path: `moveSessionChains({ moves, changedBy })` (`src/be/db/session-moves.ts:122-134`) runs one transaction per root, re-keys the given descendants and their mapped attachment files, and writes `asset_key_history`. It skips the whole-DB `auditAssetKeys` scan that `moveAssetKey` runs on every call (`session-moves.ts:38-48`). The caller runs `assertAssetKeyMovesAllowed` once. `getRootTaskChain` is at `src/be/db.ts:12916`.
- Backfill precedent: `src/be/boot-scrub-sweep.ts`. It runs once per version with a `seed_state(kind='maintenance')` done marker, keeps an id cursor in `seed_state`, works in batches of 200 with a yield between batches, and starts fire-and-forget in the listen callback (`src/http/index.ts:896-900`).

### Sidebar UI (main dd1ac9f1d)

- `buildTreeRows` (`apps/ui/src/components/sessions-v2/sidebar/tree-rows.ts:235-386`) builds the boxes (Inbox, Later, Done, No group), My groups, and Shared with me. No source section exists.
- `buildSessionGroupTree` (`apps/ui/src/lib/session-groups.ts:235-316`) nests `groups` by `/`. Every `shared/...` key goes to My groups, so a `shared/slack/...` key would land there today.
- Folds: `useTreeFolds` keeps them in localStorage per API URL and user (`sidebar/use-tree-folds.ts:22-58`). `openByDefault` returns false for unknown ids (`tree-rows.ts:189-193`). `foldIds` must list a new id, or `prune` drops it (`tree-rows.ts:196-208`).
- Read-only pattern: Shared with me groups get no menu, no "+", and no drop target (`session-tree.tsx:316`, `601-603`). Move targets come from `groupTargets` over My groups only (`lib/session-groups.ts:177-192`). They feed the move dialog, Start in, and `targetKeys`.
- Source marks: `TaskSourceMark` and `taskSourceLabel` (`apps/ui/src/components/shared/task-source-mark.tsx`) have a Slack logo. `chat` maps to a generic icon. No Telegram or Discord SVG exists in `apps/ui/public/integration-logos/`. Sidebar rows show no source mark (`sidebar/session-row.tsx:226-398`).
- Filter menu: `sidebar/filter-menu.tsx` lists `sources` from the tree with `TaskSourceMark`, one checkbox per source. Since #2379 the ticked (shown) sources live in localStorage (`lib/sessions-show.ts`, `DEFAULT_SHOWN_SOURCES = ["ui"]`), so Slack and every other non-dashboard source start unticked. `sessionsFilterParams` (`sessions-show.ts:130-135`) sends `showSource` to the tree (`api/hooks/use-session-tree.ts:26`), every `scope: "tree"` list (`api/hooks/session-query-keys.ts:72-82`, which also covers Cmd+K and the group tab), and triage (`api/hooks/use-session-triage.ts:190`). No UI code sends `hideSource` now.
- Phone: the same `SessionTree` with `phone`, drawn by `mobile/mobile-tree-body.tsx`. Long-press opens the group sheet only for groups that are mine.
- Mockup spec: sidebar order is Inbox, Later, Done, No group, My groups, Shared with me, then the source sections (SPEC line 138). Rows show the source logo when external (137). Source groups are read-only and absent from Start in and the "+" (153-154, 187). Headers show only a title and a count (126). A thread with 2 or more roots is a nested group under its channel (167). Channels show as `#eng`, DMs as `DM · <name>` (156).

### Prod data (read-only, 2026-10-23)

- Slack roots with an owner: 2169. Their keys: 1179 bare `shared/`, 990 `shared/task:<id>/`, none elsewhere.
- 205 owned roots with `source = 'mcp'` carry Slack thread fields (226 of all such roots share a thread with a Slack root).
- 390 children of Slack roots have a key that differs from their root. The backfill must re-key whole chains.
- Slack channels: 1352 owned roots in 31 `C…` channels, 1022 in 2 `D…` DM channels. 185 Slack threads hold 2 or more owned roots.
- 44 ownerless Slack roots exist. 3 Slack roots have no thread ts.
- No key starts with `shared/slack/`, `shared/telegram/`, or `shared/discord/` today. No Telegram or Discord roots exist on this deployment. 466 Slack roots in the last 30 days.
- Main's migration tail is 242 (dd1ac9f1d). This plan adds no migration.

## Desired End State

- A new root with Slack thread fields gets `shared/slack/<channelId>/thread:<ts>/`, whatever its `source`. A new chat-sdk root gets `shared/telegram/<chatId>/thread:<topicId>/` or `shared/telegram/<chatId>/task:<rootId>/` (no topic). Discord uses `shared/discord/<channelId>/thread:<threadId>/` or `.../task:<rootId>/`. Slack through chat-sdk uses the Slack shape. Teams and other adapters keep the default key.
- After the first boot of the new version, old Slack and chat roots with an untouched key (`shared/` or `shared/task:<own id>/`) sit under their source key, with their whole chain and attachments. The job writes a done marker. A second boot changes nothing.
- The sidebar shows, after Shared with me, one section per source (Slack, Telegram, Discord) that is ticked in the filter menu and has sessions. Sources start unticked (the #2379 `ui`-only default), so a user ticks Slack to see the Slack section. Each section starts collapsed. Its groups show `#eng`, `DM · Lena`, or a Telegram chat title. A Slack thread with 2 or more sessions is a nested group under its channel.
- Source groups are read-only: no menu, no "+", no drop target, not in Start in or the move dialog. A move into a source group fails on the server, except a move back to the session's own source key (Undo). Moving a session out works.
- Every external row shows its source logo. The filter menu's Slack checkbox controls the Slack section and every session under `shared/slack/`, agent-started thread sessions included, in Inbox, Later, and Done too. Unticked (the default), they all stay out. Telegram and Discord work the same way.

Verify with the phase checks below and the Manual E2E section.

## What We're NOT Doing

- Ownerless roots stay out of the tree. The A17 setting (`SESSIONS_EXTERNAL_SOURCES`, DMs first) is a follow-up.
- Two-way Slack (stored human messages, interleaved timeline, dashboard replies posted to Slack) is a separate follow-up.
- No new filter chips, and no change to the #2379 `ui`-only default. The filter menu's Sources checkboxes show and hide the source sections.
- No key policing at task creation. An agent can still pass an explicit `shared/slack/...` key on `send-task`. Keys are labels, not visibility, and the read-only rule applies to moves only. (A creation-time check would also hit inherited keys, because `send-task` authorizes `key ?? parent.key`.)
- No Teams or Kapso source sections. Teams ids do not fit a 255-character key, and Kapso is not chat-sdk.
- No Discord channel names. Discord DMs get the sender name, and channel groups show their id.
- No per-viewer DM label. A DM shows `DM · <name of the person in the DM>`, also to that person.
- A nested thread counts every owned root in the thread, including roots the viewer cannot see. A viewer who sees 1 of 2 roots sees a nested group with 1 session. This keeps the tree and the list on one rule.
- No "N sessions in this thread" link in the session header, no first-run guide step for sources, and no removal of Legacy Sessions.
- The my-swarm app is not changed. It shows the new keys as raw groups until Taras ports the rules.

## Implementation Approach

- One pure helper module, `src/assets/source-key.ts`, owns the source key shapes: `sessionSourceKey(task)` derives a key, `sourceOfKey(key)` reads the source back. The task insert path, the backfill, the move guard, and the filter all use it.
- The derivation lives in the insert path (`createTaskExtended` and the legacy `createTask`) for roots with no explicit key. Every Slack, chat-sdk, and agent path gets the key with no handler change.
- The sessions v2 filter (`showSource`, and the older `hideSource`) reads an effective source: the source of the key prefix when the key sits under a source prefix, else `r.source`. One SQL `CASE` and one JS helper keep the tree and the lists in step. The generic `source` param keeps the raw `r.source`, so other callers see no change.
- Labels come from a `kv_entries` cache. The tree route reads cached labels in one query and never waits on Slack. A miss starts a background Slack lookup, and the next poll shows the name. chat-sdk writes its labels when a message comes in.
- The backfill follows `boot-scrub-sweep.ts`: done marker, id cursor, batches of 200, one audit check, `moveSessionChains`, fire-and-forget after boot.
- The UI splits source keys out of My groups in `buildSessionGroupTree`. That one change removes them from every move target list. A new `source` row draws the foldable section header.
- Nested threads come last, so the phase can be cut with no effect on the rest.
- One PR, one commit per phase. Risk: high (it re-keys about 2,400 prod root sessions, plus their chains, and writes key history).

## Quick Verification Reference

- `bun run check:local`
- `bun run test:root -- src/tests/sessions-tree.test.ts src/tests/sessions-move.test.ts`
- `bun run tsc:check:tsc && bun run lint && bun run lint:slop`
- `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- `cd apps/ui && bun run lint && bunx tsc -b`

---

## Phase 1: Source keys for new sessions

### Overview

`src/assets/source-key.ts` exists, and every new root with Slack thread fields or a Telegram, Discord, or chat-sdk Slack thread gets its source key at insert.

### Changes Required:

#### 1. Source key helper
**File**: `src/assets/source-key.ts` (new)
**Changes**:
- `SESSION_SOURCES = ["slack", "telegram", "discord"] as const` and `type SessionSource`.
- `sessionSourceKey({ id, slackChannelId, slackThreadTs, contextKey }): string | null`.
  - Slack fields (both set): `shared/slack/<channelId>/thread:<threadTs>/`.
  - `contextKey` from `chatThreadOfContextKey` (`src/tasks/context-key.ts:153`): `slack:<channel>:<ts>` gives the Slack shape. `telegram:<chatId>[:<topicId>]` gives `shared/telegram/<chatId>/thread:<topicId>/`, or `shared/telegram/<chatId>/task:<id>/` with no topic. `discord:<guild>:<channelId>[:<threadId>]` gives `shared/discord/<channelId>/thread:<threadId>/`, or `.../task:<id>/` with no thread. Any other adapter gives null.
  - The result goes through `normalizeAssetKey`. A throw (too long, bad segment) gives null.
- `sourceOfKey(key): SessionSource | null`, a prefix check on `shared/<source>/`.
- `src/tasks/context-key.ts` has no imports, so `source-key.ts` can import `chatThreadOfContextKey` from it directly.

#### 2. Insert path
**File**: `src/be/db.ts` (line 2847, one expression; the facade freeze allows editing an existing line)
**Changes**: `options?.key ?? (options?.parentTaskId ? null : sessionSourceKey({ id, ...slack fields, contextKey })) ?? defaultAssetKey("task", id)`. Children keep inheriting the parent key (`db.ts:2656-2657`).

**File**: `src/be/db/tasks/write.ts` (line 92)
**Changes**: the same derivation for the legacy `createTask`, which takes Slack fields.

#### 3. Tests
**File**: `src/tests/session-source-keys.test.ts` (new)
**Changes**:
- Unit cases for every shape: Slack channel, Slack DM, chat-sdk Slack, Telegram with and without topic, a negative Telegram chat id, Discord guild and `@me`, Teams (null), an over-long key (null), and uppercase Slack ids (lowercased).
- Insert cases on a fresh DB: a root with Slack fields gets the Slack key, an `mcp` root with Slack fields gets it too, a child inherits its parent key, an explicit key wins, and a chat-sdk Telegram root gets the Telegram key.
- Fix any existing test that asserts `shared/task:` for a task with Slack fields (find them with `grep -rln "slackChannelId" src/tests`).

**File**: `scripts/e2e/scenarios/slack-mention.ts`
**Changes**: the scenario already reads the task row through `ctx.db` (line 49). Select `key` too, and expect `shared/slack/c0general0/thread:<message.ts>/` (the mock channel `C0GENERAL0`, lowercased). This proves the key on a real Bolt mention through `@desplega.ai/slack-mock`.

### Success Criteria:

#### Automated Verification:
- [x] New tests pass: `bun run test:root -- src/tests/session-source-keys.test.ts`
- [x] Key and session tests pass: `bun run test:root -- src/tests/asset-key-normalization.test.ts src/tests/sessions-tree.test.ts src/tests/context-key.test.ts`
- [x] Slack and chat-sdk tests pass: `bun run test:root -- src/tests/slack-*.test.ts src/tests/chat-sdk-*.test.ts`
- [x] Black-box Slack scenarios pass (run from a clean checkout with no `.env`): `env -u ANTHROPIC_API_KEY bun run e2e --only slack-mention,slack-follow-up`
- [x] Type check passes: `bun run tsc:check:tsc`
- [x] Lint passes: `bun run lint && bun run lint:slop`
- [x] Boundary check passes: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] `POST /api/tasks` has no Slack fields (its body schema at `src/http/tasks.ts:282-313` drops them), so probe the insert path directly. Write `/tmp/sss-qa/p1-probe.ts`: it sets `DATABASE_PATH=/tmp/sss-qa/p1.sqlite`, boots the DB the way `src/tests/sessions-tree.test.ts` does, calls `createTaskExtended` for a Slack root, an `mcp` root with Slack fields, a child of the Slack root, and a Telegram chat-sdk root, then prints each `key`. Run `mkdir -p /tmp/sss-qa && rm -f /tmp/sss-qa/p1.sqlite && bun /tmp/sss-qa/p1-probe.ts` from the repo root. Expect `shared/slack/c0ar967k0kz/thread:1729000000.123456/` three times and `shared/telegram/-1001234567890/thread:42/` once.

#### Manual Verification:
- [ ] None. The Manual E2E section covers a real Slack mention.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 1] source keys for new Slack and chat sessions`.

---

## Phase 2: Source-aware filter and read-only source groups

### Overview

The source filter (`showSource`, and the older `hideSource`) matches every root under a source key prefix as that source, the `sources` facet counts by effective source, and the three move routes refuse writes into source groups (except a move back to the session's own source key).

### Changes Required:

#### 1. Effective source
**File**: `src/assets/source-key.ts`
**Changes**: `effectiveSource(key, source) = sourceOfKey(key) ?? source`.

**File**: `src/be/db/session-tree.ts`
**Changes**:
- `effectiveSourceSql(alias)`: `CASE WHEN <alias>."key" >= ? AND <alias>."key" < ? THEN 'slack' ... ELSE <alias>.source END`, one branch per `SESSION_SOURCES` entry, bounds from `keyPrefixRange`.
- The `hideSource` and `showSource` filters in `sessionRootFilter` (lines 109-119) use it. The generic `source` filter (lines 106-108) keeps the raw `r.source`.
- `getSessionTree` counts the `sources` facet and applies both filters by `effectiveSource(row.key, row.source)` (lines 440-441).

#### 2. Move guard
**File**: `src/assets/source-key.ts`
**Changes**: `sourceMoveError(destination: string | null, root): string | null`. It returns "Source groups are read-only." when the destination sits under a source prefix and differs from `sessionSourceKey(root)`. A null destination (No group) is allowed.

**File**: `src/http/sessions.ts`
**Changes**:
- Bulk move: `checkSessionMove` skips a root when `sourceMoveError(groupKey, root)` returns a reason. The reason goes to the response's `skipped` list.
- Prefix move: a `from` or `to` under a source prefix returns 400 "Source groups are read-only." right after the body parses, before the owner check and any scan (the QA probe below calls it with the API key).

**File**: `src/http/assets.ts`
**Changes**: the task branch of `PATCH /api/assets/task/{id}/key` returns 400 with the same reason when `sourceMoveError` refuses the key.

#### 3. Tests
**Files**: `src/tests/sessions-tree.test.ts`, `src/tests/sessions-move.test.ts`, `src/tests/session-source-keys.test.ts`
**Changes**:
- `showSource=slack` keeps a `slack` root and an `mcp` root under `shared/slack/`. `showSource=mcp` and `showSource=ui` leave the `mcp` root out. `sources` counts it as `slack`. `showSource=telegram` keeps a `chat` root under `shared/telegram/`, and `showSource=chat` leaves it out. The same cases hold for the tree counts and for triage (`POST /api/session-triage` with `showSource`).
- `hideSource=slack` hides the `mcp` root under `shared/slack/` (older clients).
- `source=mcp` still matches the `mcp` root under `shared/slack/` (raw source).
- The query-plan test still finds `SEARCH r USING INDEX` and no `"key" LIKE`.
- Bulk move into `shared/slack/c1/` is skipped with the reason. Bulk move back to the root's own source key works. Bulk move out to `shared/research/` and to No group works. Prefix move with `from` or `to` under `shared/slack/` returns 400. The PATCH route refuses a foreign source key.
- A `send-task` child of a Slack-keyed root still gets the parent key (no new refusal on creation).

### Success Criteria:

#### Automated Verification:
- [x] Session tests pass: `bun run test:root -- src/tests/sessions-tree.test.ts src/tests/sessions-move.test.ts src/tests/session-source-keys.test.ts`
- [x] Route posture and sharing tests pass: `bun run test:root -- src/tests/session-route-posture.test.ts src/tests/session-sharing-routes.test.ts`
- [x] Type check passes: `bun run tsc:check:tsc`
- [x] Lint passes: `bun run lint && bun run lint:slop`
- [x] Promise checks pass: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] RBAC and response coverage pass: `bun run check:rbac-coverage && bun run check:openapi-response-coverage`

#### Automated QA:
- [x] Boot an API on the probe DB (`DATABASE_PATH=/tmp/sss-qa/p1.sqlite PORT=3133 DESPLEGA_TELEMETRY_ENV=test SLACK_DISABLE=true bun run start:http`). `curl -s -X POST http://localhost:3133/api/session-moves/prefix -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"from":"shared/slack/c0ar967k0kz/","to":"shared/research/"}'` returns 400 with "Source groups are read-only."

#### Manual Verification:
- [ ] None.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 2] source-aware filter and read-only source groups`.

---

## Phase 3: Source labels

### Overview

`GET /api/session-tree` returns `labels`, a map from source group key to a readable name. Slack names come from a background lookup into a `kv_entries` cache. Telegram and Discord DM names are saved when a chat message comes in.

### Changes Required:

#### 1. Label cache
**File**: `src/be/db/session-labels.ts` (new)
**Changes**:
- Namespace `session-labels`, key = source group key (for example `shared/slack/c0ar967k0kz/`).
- `getSessionLabels(keys): Promise<Record<string, string>>`: one `SELECT key, value FROM kv_entries WHERE namespace = ? AND key IN (...) AND (expires_at IS NULL OR expires_at > ?)` through `getDbClient()`. `expires_at` is unix ms (`061_kv_store.sql`, `getKv` at `db.ts:13689`), so bind `Date.now()`.
- `rememberSessionLabel(key, label, ttlMs?)`: through `upsertKv` with `valueType: "string"`, so the raw `value` column holds the plain label and the batch read needs no JSON decode (`encodeKvValue`, `db.ts:13654`).

#### 2. Slack lookup
**File**: `src/slack/channel-labels.ts` (new)
**Changes**:
- `warmSlackChannelLabels(channelIds)`: returns at once and runs in the background. It keeps an in-flight set and a bounded in-memory "failed until" map (10 min), runs one call at a time, and no-ops when `getSlackApp()` is null.
- For each id: `callSlackWithRetry(client, "conversations.info", { channel: id.toUpperCase() })`. A channel gives `#<name>`. An IM (`is_im`) gives `users.info` on `channel.user`, then `DM · <display_name || real_name>`. A multi-person IM gives `Group DM`. The label is saved with a 24 h TTL.
- Labels that leave the process go through `scrubSecrets` only if they are logged. Do not log names.

#### 3. Tree route
**Files**: `src/http/sessions.ts` (handler at `1011-1025`, schema at `154-163`), `apps/ui/src/api/types.ts` (`837-860`)
**Changes**:
- `SessionTreeResponseSchema` gains `labels: z.record(z.string(), z.string()).optional()`.
- The handler collects the group keys under a source prefix, reads `getSessionLabels`, and calls `warmSlackChannelLabels` for Slack misses (fire-and-forget with `.catch` logging, the existing `void ... .catch(...)` pattern).
- The UI type gains `labels?: Record<string, string>`.
- Run `bun run docs:openapi` and commit `openapi.json` plus `docs-site/content/docs/api-reference/**`.

#### 4. chat-sdk capture
**File**: `src/integrations/chat-sdk/inbound.ts` (after `createChatTaskWithFiles` at `566`)
**Changes**: compute the group key with `sessionGroupKey(sessionSourceKey(...))`. Telegram groups save the chat title from `readChatMessageFacts` (`src/integrations/chat-sdk/facts.ts:109`). A DM (`chatType: "dm"`) saves `DM · <sender label>`. Discord channels save nothing. No TTL: the next message refreshes the label.

#### 5. Tests
**File**: `src/tests/session-source-labels.test.ts` (new)
**Changes**:
- The cache reads several keys in one call and skips expired rows.
- The Slack lookup with a fake client: channel to `#eng`, IM to `DM · Lena`, uppercase id sent to Slack, a `ratelimited` error retried, a failure cached in memory and not in KV, a null client as a no-op.
- The tree route returns `labels` for cached keys and starts one lookup for a miss.
- chat-sdk capture: a Telegram group title and a DM sender label are saved under the right group key.

**File**: `scripts/e2e/scenarios/slack-mention.ts`
**Changes**: after the task row check, call `GET /api/session-tree` with the API key (the bypass tree includes ownerless roots). Then poll that route until `labels["shared/slack/c0general0/"]` is `#` plus the mock channel name. `@desplega.ai/slack-mock` serves `conversations.info` and `users.info`.

### Success Criteria:

#### Automated Verification:
- [x] Label tests pass: `bun run test:root -- src/tests/session-source-labels.test.ts`
- [x] Session and chat tests pass: `bun run test:root -- src/tests/sessions-tree.test.ts src/tests/chat-sdk-*.test.ts`
- [x] Black-box Slack scenario passes, label included (clean checkout with no `.env`): `env -u ANTHROPIC_API_KEY bun run e2e --only slack-mention`
- [x] OpenAPI is fresh: `bun run docs:openapi && git diff --exit-code openapi.json`
- [x] Response coverage passes: `bun run check:openapi-response-coverage`
- [x] Type check passes: `bun run tsc:check:tsc && cd apps/ui && bunx tsc -b`
- [x] Promise checks pass: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] Lint passes: `bun run lint && bun run lint:slop`

#### Automated QA:
- [x] On the Phase 2 API (:3133), insert a label the way `rememberSessionLabel` writes it: `sqlite3 /tmp/sss-qa/p1.sqlite "INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at) VALUES ('session-labels', 'shared/slack/c0ar967k0kz/', '#swarm-dev-2', 'string', NULL, CAST(unixepoch('subsec')*1000 AS INTEGER), CAST(unixepoch('subsec')*1000 AS INTEGER))"`. Then confirm `curl -s http://localhost:3133/api/session-tree -H "Authorization: Bearer 123123" | jq .labels` shows it.

#### Manual Verification:
- [ ] None. The Manual E2E section covers a real Slack label.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 3] source labels`.

---

## Phase 4: Backfill of old Slack and chat sessions

### Overview

`src/be/session-source-backfill.ts` re-keys every old root with an untouched key and Slack or chat-sdk thread fields, once, after boot, and writes a done marker.

### Changes Required:

#### 1. Backfill job
**File**: `src/be/session-source-backfill.ts` (new)
**Changes**:
- `runSessionSourceBackfill({ batchSize = 200, afterBatch? })`, modeled on `src/be/boot-scrub-sweep.ts`.
- Done marker `seed_state(kind='maintenance', key='session-source-keys-v1')`. When it exists, return.
- Call `assertAssetKeyMovesAllowed()` once. When the audit blocks moves, log a warning and return without the marker (the next boot tries again).
- Batch query: `parentTaskId IS NULL AND id > ? AND ("key" = 'shared/' OR "key" = 'shared/task:' || lower(id) || '/') AND ((slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL) OR contextKey GLOB 'task:chat-sdk:*') ORDER BY id LIMIT ?`.
- For each root: `sessionSourceKey(root)`. Skip null. Collect the chain ids with `getRootTaskChain`. Call `moveSessionChains({ moves, changedBy })`, using the system actor convention of `boot-scrub-sweep.ts` for `changedBy`. Save the cursor in `seed_state`, then yield.
- At the end, write the marker and delete the cursor row. Log one summary line (counts only).
- The job does not touch `lastUpdatedAt`, so read states and the Inbox stay as they are.

#### 2. Boot wiring
**File**: `src/http/index.ts` (next to the boot-scrub entry at `896-900`)
**Changes**: `import("../be/session-source-backfill").then(({ runSessionSourceBackfill }) => runSessionSourceBackfill()).catch((err) => console.error("[session-source-backfill] startup run failed (non-fatal):", err))`.

#### 3. Tests
**File**: `src/tests/session-source-backfill.test.ts` (new)
**Changes**:
- A Slack root with `shared/` and one with `shared/task:<id>/` move, with their children (including a child whose key differs) and a mapped attachment. Each move writes `asset_key_history`.
- A root a user moved (`shared/research/`) stays. An `mcp` root with Slack fields moves. A Teams chat root stays. An ownerless Slack root moves.
- A second run is a no-op (marker). A run cut after one batch resumes from the cursor (`afterBatch` throws once).
- A blocked audit leaves no marker.
- `lastUpdatedAt` and `inbox_item_state` rows do not change, and a session marked Done stays Done (the #2379 `reopensDone` rule ignores key moves).

### Success Criteria:

#### Automated Verification:
- [x] Backfill tests pass: `bun run test:root -- src/tests/session-source-backfill.test.ts`
- [x] Move and key tests pass: `bun run test:root -- src/tests/sessions-move.test.ts src/tests/asset-key-migration.test.ts`
- [x] Type check passes: `bun run tsc:check:tsc`
- [x] Promise checks pass: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] Async seam check passes: `bash scripts/check-async-db-seam.sh`
- [x] Lint passes: `bun run lint && bun run lint:slop`

#### Automated QA:
- [x] Copy a prod-shaped DB: `mkdir -p /tmp/sss-qa && cp /tmp/sv2-qa/db.sqlite /tmp/sss-qa/db.sqlite`. Seed Slack, `mcp`, and Telegram roots with default keys with a QA script `/tmp/sss-qa/seed.ts` (writes only that file, like `/tmp/sv2-qa/backfill-slack.ts`). Boot the API on it (`DATABASE_PATH=/tmp/sss-qa/db.sqlite PORT=3123 DESPLEGA_TELEMETRY_ENV=test SLACK_DISABLE=true bun run start:http`). Confirm the marker with `sqlite3 /tmp/sss-qa/db.sqlite "SELECT key FROM seed_state WHERE kind='maintenance' AND key='session-source-keys-v1'"` and the new keys with `sqlite3 /tmp/sss-qa/db.sqlite "SELECT key, COUNT(*) FROM agent_tasks WHERE parentTaskId IS NULL AND key >= 'shared/slack/' AND key < 'shared/slack0' GROUP BY 1"`. Restart and confirm no new `asset_key_history` rows.

#### Manual Verification:
- [ ] Taras reviews the prod impact numbers in the PR (about 2,400 roots: about 2,210 Slack roots plus about 230 agent roots in Slack threads, each with its chain) before the merge.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 4] backfill old Slack and chat sessions`.

---

## Phase 5: Source sections in the sidebar

### Overview

The desktop and phone sidebars show one collapsed section per source after Shared with me, with labeled, read-only groups.

### Changes Required:

#### 1. Group model
**File**: `apps/ui/src/lib/session-groups.ts`
**Changes**:
- `SESSION_SOURCES` mirror and `sourceOfGroupKey(key)`.
- `buildSessionGroupTree` keeps source keys out of `myGroups` and returns `sources: { source, nodes, counts }[]`, in `SESSION_SOURCES` order, only for sources with groups. `groupTargets` then leaves them out on its own (move dialog, Start in, `targetKeys`, `c` key).
- `sourceGroupLabel(key, labels)`: the label, else a fallback (`#<id>` for a Slack `c…` or `g…` id, `DM` for a `d…` id, the raw id otherwise).
- Do not add the source rule to `groupWriteBlock` (`session-groups.ts:119-121`, wrapped as `writeBlock` in `sessions-v2/use-my-groups.ts:40`). `undoFor` (`sidebar/use-tree-moves.ts:129-143`) returns no Undo when `writeBlock` refuses the old key, so a source rule there would remove Undo after a move out. Leaving source groups out of `groupTargets`, menus, and drop targets is enough, and the server guard of Phase 2 refuses the rest.

#### 2. Tree rows
**File**: `apps/ui/src/components/sessions-v2/sidebar/tree-rows.ts`
**Changes**:
- A new `source` row type: fold id `source:<source>`, label, counts, open. Its groups follow as level-1 `group` rows with `readOnly: true`.
- `foldIds` lists `source:*` ids and source group keys. `openByDefault` stays false for them.

#### 3. Rendering and read-only behavior
**Files**: `sidebar/group-node.tsx`, `sidebar/section-header.tsx`, `sidebar/session-tree.tsx`, `mobile/mobile-tree-body.tsx`, `mobile/mobile-tree-row.tsx`
**Changes**:
- The `source` row draws the source logo, the source name, and the count on the right (SPEC line 126: title and count only). A click or Enter folds it.
- Source groups use `sourceGroupLabel`, a `Hash` icon for channels, and a person icon for DMs.
- `readOnly` groups get no `onMenu`, no `onNewSession`, and `dropKey` undefined. Phone long-press does nothing on them.
- Load `dashboard-ui` (`.claude/internal-skills/dashboard-ui/SKILL.md`) and read `apps/ui/DESIGN.md` before the UI work.

#### 4. Tests
**Files**: `apps/ui/src/lib/session-groups.test.ts`, `apps/ui/src/components/sessions-v2/sidebar/tree-rows.test.ts`
**Changes**: source keys leave My groups and targets, sections come in order after Shared with me, a section is collapsed by default, `foldIds` keeps the new ids, and the label fallbacks.

### Success Criteria:

#### Automated Verification:
- [x] UI unit tests pass: `cd apps/ui && bun test src/lib/session-groups.test.ts src/components/sessions-v2/sidebar/tree-rows.test.ts`
- [x] UI type check passes: `cd apps/ui && bunx tsc -b`
- [x] UI lint and tokens pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [x] UI E2E suite passes (clean checkout with no `.env`): `bun run e2e:ui`

#### Automated QA:
- [x] On the Phase 4 QA stack (API :3123, UI `cd apps/ui && VITE_PROXY_TARGET=http://localhost:3123 bunx vite --port 5294 --strictPort`), with `agent-browser` session `sss-qa`: with the default filter (only `ui` ticked), no source section shows. Tick Slack and Telegram in the filter menu: the Slack and Telegram sections sit after Shared with me and start collapsed. Opening Slack shows labeled channel and DM groups. A source group has no menu and no "+". Dragging a session onto a source group does nothing. The move dialog and Start in list no source group. Moving a session out works, and Undo puts it back. Screenshots for desktop and phone (390 x 844).

#### Manual Verification:
- [ ] Taras checks the look of the source sections against the mockup.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 5] source sections in the sidebar`.

---

## Phase 6: Source marks, labels across the UI, and docs

### Overview

External rows show their source logo, Telegram and Discord have logos and names, group labels read well everywhere, and the docs describe sources.

### Changes Required:

#### 1. Source marks
**Files**: `apps/ui/src/components/shared/task-source-mark.tsx`, `apps/ui/public/integration-logos/telegram.svg`, `apps/ui/public/integration-logos/discord.svg` (new, monochrome like the others)
**Changes**: `telegram` and `discord` entries in the logo and label maps. A helper `sessionSourceOf(root)` returns `sourceOfKey(root.key)`, else the adapter tag of a `chat` root, else `root.source`.

#### 2. Rows and crumbs
**Files**: `sidebar/session-row.tsx`, `mobile/mobile-tree-row.tsx`, the row hover card, and the pane header crumb (find its builder with `semble search "session header crumb group label"`)
**Changes**: an external row (Slack, Telegram, Discord, chat) shows its logo before the title. The group label in flat Inbox, Later, and Done rows, the hover card, the move toast (`labelOf` in `use-tree-moves.ts:98`), and the header crumb use `sourceGroupLabel` for source keys.

#### 3. Filter menu
**File**: `sidebar/filter-menu.tsx`
**Changes**: none expected beyond the new map entries. Confirm that `telegram` and `discord` rows show their logo and name. They come from the effective-source facet of Phase 2, and they start unticked like every non-`ui` source.

#### 4. Docs
**Files**: `docs-site/content/docs/(documentation)/ui/sessions.mdx`, `docs-site/content/docs/(documentation)/guides/asset-namespaces.mdx`
**Changes**: a Sources section (what lands there, off until ticked in the filter menu, collapsed by default, read-only, labels, Undo), the effective-source rule (an agent session in a Slack thread counts as Slack in the filter), the source key shapes, and the one-time backfill. Extend the filter paragraph that #2379 added to `ui/sessions.mdx`, do not write a second one.

### Success Criteria:

#### Automated Verification:
- [x] UI unit tests pass: `cd apps/ui && bun test src/lib/session-groups.test.ts src/components/sessions-v2/sidebar/tree-rows.test.ts`
- [x] UI type check passes: `cd apps/ui && bunx tsc -b`
- [x] UI lint and tokens pass: `cd apps/ui && bun run lint && bun run check:tokens`
- [x] Root lint passes: `bun run lint`

#### Automated QA:
- [x] On the QA stack, with Slack and Telegram ticked in the filter menu: Slack and Telegram rows in Inbox show their logo and a group label such as `#swarm-dev-2`. The filter menu lists Slack and Telegram with logos. Unticking Slack removes the Slack section and the Slack rows from Inbox, Later, and Done, the seeded `mcp` thread session included. Ticking `mcp` alone does not bring that session back. Record the tick and untick flow with `agent-browser record start /tmp/sss-qa/sources.mp4 --cursor`.

#### Manual Verification:
- [ ] Taras reads the docs changes.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 6] source marks, labels, and docs`.

---

## Phase 7: Nested thread groups

### Overview

A Slack thread with 2 or more owned roots is a nested group under its channel, in the tree, the lists, and the UI. Its label is the title of its oldest session.

### Changes Required:

#### 1. Server rule
**Files**: `src/be/db/session-tree.ts`, `src/assets/source-key.ts`, `src/be/db.ts` (row `groupKey` at `13001`)
**Changes**:
- `threadRootsSql(alias)`: for a key whose last segment is `thread:<x>`, the count of owned roots with that exact key (`parentTaskId IS NULL AND requestedByUserId IS NOT NULL`, served by the key index), else 0.
- `sessionThreadGroupKey(key, threadRoots)`: the key itself when it ends in a `thread:` leaf and `threadRoots >= 2`, else `sessionGroupKey(key)`.
- `getSessionTree` selects the count and groups by `sessionThreadGroupKey`. It also returns a label for each nested thread group: the oldest root's title (`COALESCE(r.title, substr(r.task, 1, 80))`), merged into `labels`.
- `groupCondition` for a group leaves out direct `thread:` leaves whose count is 2 or more. The exact-key match already lists a nested thread group.
- List rows use `sessionThreadGroupKey` for `groupKey`, so the UI `groupOf` matches the tree.

#### 2. UI
**Files**: `apps/ui/src/lib/session-groups.ts`, `sidebar/group-node.tsx`
**Changes**: a nested thread group nests under its channel by `/` with no new code. It uses a `MessagesSquare` icon, its label from `labels`, and the read-only rules of Phase 5.

#### 3. Tests
**Files**: `src/tests/sessions-tree.test.ts`, `apps/ui/src/lib/session-groups.test.ts`
**Changes**: 2 roots in one thread form a nested group with the right counts. The channel list leaves them out. The thread list returns both. Moving one out turns the other back into a plain row. A thread with 1 root stays a plain row. The query plan still uses the key index.

### Success Criteria:

#### Automated Verification:
- [x] Session tests pass: `bun run test:root -- src/tests/sessions-tree.test.ts src/tests/sessions-move.test.ts`
- [x] UI unit tests pass: `cd apps/ui && bun test src/lib/session-groups.test.ts src/components/sessions-v2/sidebar/tree-rows.test.ts`
- [x] Type checks pass: `bun run tsc:check:tsc && cd apps/ui && bunx tsc -b`
- [x] Lint passes: `bun run lint && bun run lint:slop && cd apps/ui && bun run lint`
- [x] Promise checks pass: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [x] On the QA stack (seed one Slack thread with 2 roots): the channel group shows a nested thread group with the title of its oldest session and 2 rows inside. Moving one row out turns the other into a plain row in the channel. Screenshot before and after.

#### Manual Verification:
- [ ] None.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 7] nested thread groups`.

---

## Manual E2E

Run against a local stack with the dev Slack app (`.env` with the dev `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`), and against prod after the deploy.

1. Boot a fresh local API with Slack on. Do not start `docker-compose.local.yml`: its `api` service also binds port 3013 and sets `SLACK_DISABLE=true`. No lead is needed, because a mention with no agent still creates a queued root (`src/slack/handlers.ts:730-743`). `start:http` refuses Socket Mode unless `SLACK_ALLOW_DEV_SOCKET_MODE=true` (`runbooks/local-development.md`).
   ```bash
   rm -f /tmp/sss-e2e.sqlite
   DATABASE_PATH=/tmp/sss-e2e.sqlite SLACK_ALLOW_DEV_SOCKET_MODE=true DESPLEGA_TELEMETRY_ENV=test bun run start:http
   ```
2. Mention the dev bot in `#swarm-dev-2` with the Slack MCP tool: `slack_send_message(channel_id: "C0AR967K0KZ", message: "<@U0ALZGQCF96> hi")`. Then check the key and the label:
   ```bash
   sqlite3 /tmp/sss-e2e.sqlite "SELECT key, source FROM agent_tasks WHERE parentTaskId IS NULL ORDER BY createdAt DESC LIMIT 3"
   curl -s http://localhost:3013/api/session-tree -H "Authorization: Bearer 123123" | jq '{groups: [.groups[] | select(.key | startswith("shared/slack/"))], labels}'
   ```
   Expect `shared/slack/c0ar967k0kz/thread:<ts>/` and, on the second call, the label `#swarm-dev-2`.
3. DM the dev bot from Slack. Expect a `shared/slack/d…/thread:<ts>/` key and the label `DM · <your name>`.
4. Open the dashboard (`cd apps/ui && bun run dev`, then `http://localhost:5274/sessions`) with `agent-browser`, as the swarm user that your Slack user maps to. A root with no owner stays out of a user's tree. With the default filter, no Slack section shows. Tick Slack in the filter menu: the Slack section shows collapsed, opens to `#swarm-dev-2` and the DM, and unticking Slack removes both.
5. Backfill on a prod-shaped copy: copy `/tmp/sv2-qa/db.sqlite` to `/tmp/sss-e2e-backfill.sqlite`, boot with `DATABASE_PATH=/tmp/sss-e2e-backfill.sqlite PORT=3143 DESPLEGA_TELEMETRY_ENV=test SLACK_DISABLE=true bun run start:http`, and run the Phase 4 checks.
6. After the merge and deploy, read-only on prod:
   ```bash
   ssh swarm "sqlite3 -readonly /var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite \"SELECT key FROM seed_state WHERE kind='maintenance' AND key='session-source-keys-v1'; SELECT COUNT(*) FROM agent_tasks WHERE parentTaskId IS NULL AND key >= 'shared/slack/' AND key < 'shared/slack0'; SELECT COUNT(*) FROM agent_tasks WHERE parentTaskId IS NULL AND source='slack' AND (key='shared/' OR (key >= 'shared/task:' AND key < 'shared/task;'));\""
   ```
   Expect the marker, about 2,400 Slack-keyed roots (2,213 Slack roots with and without an owner, plus about 230 agent roots in Slack threads), and only the 3 Slack roots with no thread ts left on old keys.
7. Clean up: stop the APIs and the UI, `agent-browser close`, `rm -rf /tmp/sss-*`, and report `df -h /` before and after.

---

## Appendix

- **Follow-up plans**: the A17 setting for ownerless and external sessions (DMs first). Two-way Slack. An "N sessions in this thread" header link. Discord channel names (`GET /channels/{id}`). The my-swarm app port.
- **Derail notes**:
  - A session moved out of a source group keeps `r.source`, so unticking Slack still hides it in a user group. The filter reads origin, not place.
  - A Telegram session moved out of its section has effective source `chat`, not `telegram`.
  - Effective source changes what some ticks show. A user with `mcp` ticked and Slack unticked loses the agent sessions in Slack threads. A user with `chat` ticked must also tick Telegram or Discord to keep those sessions. #2379 shipped on 2026-10-23 and no Telegram or Discord roots exist on prod, so few users see a change.
  - `/tmp/sv2-qa/db.sqlite` has only 3 Slack roots, so the QA seed script must add more.
- **References**:
  - Issue: https://github.com/desplega-ai/agent-swarm/issues/2338
  - Brainstorm: `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md`
  - Research: `thoughts/taras/research/2026-10-20-sessions-ui-power-users.md`
  - Mockup spec: agent-fs `/mockups/agent-swarm/sessions-v2/SPEC.md`
  - Precedent job: `src/be/boot-scrub-sweep.ts`

---

## Review Errata

_Reviewed: 2026-10-24 by Claude (automated review, auto-apply, against main dd1ac9f1d)_

### Applied
- [x] **Critical**: #2379 changed the source filter to an allowlist (`showSource`, only `ui` by default). The plan assumed a denylist (`hideSource`). Source sections now show only when their source is ticked. Phase 2 applies the effective source to `showSource` and `hideSource`, in SQL and in the tree loop. Desired End State, Current State, Phase 5 and 6 QA, the docs step, and Manual E2E use the tick model. Auto-applied.
- [x] **Critical**: Manual E2E step 1 could not run. `docker-compose.local.yml` starts its own `api` on port 3013 with `SLACK_DISABLE=true`, and `start:http` refuses Socket Mode without `SLACK_ALLOW_DEV_SOCKET_MODE=true`. Step 1 now boots only the host API with that flag. Auto-applied.
- [x] **Important**: the generic `source` param keeps the raw `r.source`. Only the sessions v2 filter reads the effective source, so other callers see no change. Auto-applied.
- [x] **Important**: labels are written with `valueType: "string"`, so the batch read gets plain text. The Phase 3 QA insert is now an exact statement (ms timestamps, `string` type). Auto-applied.
- [x] **Important**: the black-box `slack-mention` scenario (`@desplega.ai/slack-mock`) now asserts the source key (Phase 1) and the channel label (Phase 3). The mock serves `conversations.info` and `users.info`. Auto-applied.
- [x] **Important**: Phase 5 keeps the source rule out of `groupWriteBlock`, because `undoFor` drops Undo when that check refuses the old key. Auto-applied.
- [x] **Important**: every moved `file:line` reference now matches main dd1ac9f1d (`db.ts`, `session-tree.ts`, `sessions.ts`, `inbound.ts`). Auto-applied.
- [x] **Important**: the prod impact numbers now agree (about 2,400 roots) in the Implementation Approach, Phase 4, and Manual E2E. Auto-applied.
- [x] **Important**: a derail note covers the users whose ticked sources show something different under effective source (`mcp` without Slack, `chat` without Telegram). Auto-applied.
- [x] **Minor**: frontmatter has `topic` and `tags`. The migration line names main's tail (242). The `context-key.ts` import check is now a fact (it has no imports). The Done rule of #2379 and #2381 is in Current State, and Phase 4 tests that a Done session stays Done. `e2e` and `e2e:ui` run from a clean checkout with no `.env`. Auto-fixed.

---

## Implementation Notes

_Implementation run started 2026-10-25 in worktree `~/worktrees/agent-swarm/2026-10-25-sessions-source-sections` (branch `feat/sessions-source-sections`). Taras switched to "keep going till the end" after Phase 1._

- Phase 1: an id that contains `/` gives no source key (it would add key segments). Taras chose a fallback for Slack through chat-sdk with no ts (`slack:<D…>:`, a top-level DM in the legacy assistant view): `shared/slack/<channel>/task:<id>/`, like Telegram with no topic. The `task-action` tool's `key` description (and `MCP.md`) now names the source key default.
- Phase 2: the move guard allows only `sessionSourceKey(root)`. A root an agent created with an explicit `shared/slack/...` key that differs from its own fields can move out, but its Undo is refused (the UI ignores the Undo result). Accepted as an edge case. The PATCH route falls back to "no source key allowed" when it cannot load the session root.
- Phase 3: `warmSlackChannelLabels` takes source group keys and looks up only channel group keys (`shared/slack/<channel>/`), so a bare `shared/slack/` or a deeper key never queues a lookup. chat-sdk capture covers Telegram and Discord only (a Slack DM through chat-sdk must not block the Slack lookup with an untimed label). Every chat message refreshes the label, once per flush, so a renamed Telegram group shows its new title.
- Phase 4 (after three reviews, Codex included): each root moves in its own write transaction that re-checks the key (a user move after the batch read wins) and reads the chain ids inside the lock (a new child moves too). A failing root is logged and skipped; then the run deletes the cursor and writes no marker, so the next boot retries only the failed roots. `moveTaskChainKeyInTx` now writes `updated_by = COALESCE(?, updated_by)` (no actor keeps the last editor, the repo audit convention), which also changes the bulk and prefix move routes when they have no trusted actor. QA on a prod-shaped copy: `scanned=19 moved=19 skipped=0 failed=0`, marker written, a restart added no history rows.
- Phase 5 (Opus UI agent, QA screenshots in `/tmp/sss-qa/shots/p5-*.png`): a channel row drops the label's leading `#` next to its Hash icon (`eng`, not `# #eng`); flat rows and toasts keep `#eng`. A new or renamed group whose name lands under a source prefix (`slack`) is refused with a toast. `reveal` (pane crumb) opens a folded source section. The source header follows SPEC R5 (title and count, no chevron); a reviewer flagged that a folded section gives no visible "opens" cue, so Taras should judge it in the look check. DM icons come from id rules (Slack `d…`, Telegram positive chat id) plus the `DM · ` label prefix for Discord; a typed DM flag from the server is a possible follow-up. Seen in QA, not fixed (older code): on Android Chrome a tap on the phone filter button enters search mode (`mobile/mobile-search.tsx` `onFocus`).
- Phase 6 (Opus UI agent, QA in `/tmp/sss-qa/shots/p6-*.png` and `p6-sources.mp4`): `sessionSourceOf` and `chatSourceOf` live in `lib/session-groups.ts` (bun tests cannot load the component file). Group tabs, the tab strip, and the all-tabs menu also show source logos and labels, so no surface shows `# #eng`. Review fixes: `GET /api/session-tree` now returns labels for every source group the viewer can see, hidden sources included (`SessionTree.sourceGroups`, not sent on the wire), so a pane of an unticked source still names its group. The backfill keeps its saved cursor behind a failed root, so an interrupted boot cannot skip it. Docs now say that a bulk move lists a refused session in `skipped`, and when Undo is refused. Open design point: a Telegram or Discord session moved out of its section shows its chat logo, while the filter counts it as Chat.
- Phase 7 (Codex, then a Codex fix round after the Standards review; the Spec sub-agent spawn was denied, so the orchestrator checked the spec, probed the leaf SQL on sample keys, and ran the browser QA): nesting applies to source keys only (`isSourceThreadKey`, `NESTED_THREAD_MIN_ROOTS = 2`). A nested thread's label is its oldest owned root's title (`COALESCE(NULLIF(title, ''), substr(task, 1, 80))`); a cached label wins. In flat Inbox rows, a session of a nested thread names the thread, not the channel. QA: a 2-root thread nests under `eng`; moving one root out turns the other into a plain row; moving it back nests them again. Long thread titles truncate and keep their counts (`min-w-max` on the counts slot).
- PR #2408 security review (2 P2, both valid, fixed): nested thread labels come only from roots in the viewer's own tree rows (the count still includes roots the viewer cannot see, as planned). The Slack label lookup runs only for channels backed by a visible root whose `slackChannelId` matches the key, at most 50 queued lookups, and a full failure map skips new ids instead of evicting live failures.
- PR #2408 bot review (2 blocking, both valid, fixed): (B1) a child that inherits its parent's key reads that key again inside its INSERT transaction, so a chain move (the backfill, or a user move) that commits between the parent read and the INSERT no longer leaves the child on the old key. (B2) `GET /api/sessions/{rootTaskId}` returns `groupKey` with the list row's rule, and the pane crumb, `itemFromDetail` and the pane `c` key use it (`detailGroupKey`, with the old key rule as the fallback for older servers). So the crumb of a session in a shared thread names the thread and reveals the thread group, not only the channel.
- PR #2408 security review, third P2 (valid, fixed): the `session-labels` KV namespace is now a reserved family (no generic HTTP, MCP, or realtime writes) and also private (`privateNamespaceError`: no generic HTTP or MCP reads, lead included). Labels reach users only through `GET /api/session-tree`, for the groups each viewer can see.
