---
date: 2026-04-22
author: taras
git_commit: 5e550e857e07e1110bf1d576d500857793924f49
branch: main
repository: agent-swarm
topic: "Jira Cloud integration (basic, Linear parity)"
tags: [plan, integrations, jira, oauth, webhooks, trackers]
status: ready
research_source: thoughts/taras/research/2026-04-21-jira-integration.md
autonomy: critical
last_updated: 2026-04-22
last_updated_by: claude (post-review)
---

# Jira Cloud Integration — Implementation Plan

## Overview

Add Jira Cloud as a first-class tracker mirroring Linear: OAuth 2.0 (3LO) connect flow, webhook-driven inbound task creation, outbound issue comments on task lifecycle, reuse of the existing `oauth_apps` / `oauth_tokens` / `tracker_sync` / `tracker_agent_mapping` tables. Single workspace per install (one `cloudId` stored in `oauth_apps.metadata`). Both auto-registered webhooks (via `manage:jira-webhook` scope + 25-day refresh timer) and manually admin-registered webhooks are supported.

The research in `thoughts/taras/research/2026-04-21-jira-integration.md` already maps every reusable building block. This plan operationalizes it into 6 incremental phases.

## Current State

- **Linear integration** (`src/linear/*`, `src/http/trackers/linear.ts`) is the blueprint. All tracker scaffolding (`oauth_apps`, `oauth_tokens`, `tracker_sync`, `tracker_agent_mapping`) is provider-keyed and reusable as-is.
- **Tracker dispatcher** at `src/http/trackers/index.ts:9` is a 1-line call to `handleLinearTracker` — extend to dispatch Jira.
- **Provider union** at `src/tracker/types.ts:1` is `"linear"` only.
- **Task source enum** at `src/types.ts:56-67` is missing `"jira"`.
- **DB CHECK constraint** on `agent_tasks.source` (last set by migration 009) does not include `"jira"`. Latest migration is `040_slack_thread_composite_index.sql` → new migration is `041`.
- **MCP tracker tools** (`src/tools/tracker/*.ts`) already use `z.string()` for `provider`; only describe-string copy needs updating.
- **OAuth wrapper** (`src/oauth/wrapper.ts`) is generic PKCE-S256, already Jira-ready. `src/oauth/ensure-token.ts` and `src/oauth/keepalive.ts` are provider-agnostic.
- **`initLinear()`** is called at `src/http/index.ts:266` and `src/http/core.ts:125`. `initJira()` hooks in at the same two spots.

## Desired End State

- Connecting a Jira Cloud workspace from the UI triggers the full OAuth 3LO flow and resolves `cloudId` automatically.
- Assigning a Jira issue to the bot user (or @-mentioning it in a comment) creates a swarm task.
- On task lifecycle events (`task.created`, `task.completed`, `task.failed`, `task.cancelled`), a plaintext comment is posted back to the originating Jira issue via REST v2. No status transitions.
- Webhook deliveries are HMAC-verified against `JIRA_SIGNING_SECRET`, deduplicated, and processed idempotently.
- Webhooks registered via the API are auto-refreshed every 25 days via a timer started in `initJira()`.
- Manually admin-registered webhooks work identically — the receiver does not care how the webhook was created.
- `bun test`, `bun run tsc:check`, `bun run lint:fix`, and `bash scripts/check-db-boundary.sh` all pass.
- `openapi.json` is regenerated and committed.
- `docs-site/content/docs/(documentation)/guides/jira-integration.mdx` describes setup end-to-end.

## What We're NOT Doing (v1)

- Multi-workspace per install (single `cloudId` only; v2 concern).
- **Signing-secret rotation machinery.** `JIRA_SIGNING_SECRET` is env-only; rotating it requires re-registering all webhooks manually. Documented as a foot-gun in the integration guide (Phase 6). Drift detection on `/status` is a v2 concern.
- Auto-populating `tracker_agent_mapping` from Jira users — admins will invoke the existing `tracker-map-agent` MCP tool.
- Jira issue status transitions on task completion (mirror Linear's current behavior — comments only).
- Outbound ADF-formatted comments — v1 uses REST v2 plaintext. ADF walker only for inbound parsing.
- Forge / Connect app ecosystem. This is a standard 3LO app.
- Per-event verbose outbound (thought/action/response/error). V1 posts only lifecycle milestones: started, completed, failed, cancelled.

## Implementation Phases

### Phase 1 — Schema migration + type/enum plumbing

Goal: add `"jira"` as a recognized provider & task source throughout the codebase without wiring any new behavior. Safe, reversible-by-forward-migration, unblocks later phases.

Steps:
1. Create `src/be/migrations/041_jira_source.sql`. Use the SQLite table-rebuild pattern from the most-recent `agent_tasks` rebuild at `src/be/migrations/026_drop_epics.sql:7-100` (NOT 009 — 009 predates several column additions like `outputSchema`, `compactionCount`, `peakContextPercent`, `totalContextTokensUsed`, `contextWindowSize`, `was_paused`, and the removal of `epicId`):
   - `CREATE TABLE agent_tasks_new (...)` copying the full current schema (use 026's CREATE TABLE block as the starting point, then also add columns introduced after 026: `slackReplySent` (034), `vcsInstallationId` + `vcsNodeId` (033), `credentialKeySuffix` (028), `credentialKeyType` (029), `requestedByUserId` (031), `swarmVersion` (037)). Verify the final column list against a live DB (`sqlite3 agent-swarm-db.sqlite ".schema agent_tasks"`) before shipping. Add `'jira'` to the `source` CHECK list.
   - Use explicit column lists in `INSERT INTO agent_tasks_new (...) SELECT ... FROM agent_tasks;` (not `SELECT *` — mirror 026's pattern) to be robust against column-order drift.
   - `DROP TABLE agent_tasks; ALTER TABLE agent_tasks_new RENAME TO agent_tasks;`
   - Recreate all indexes that existed on `agent_tasks`. Grep the migrations folder for `ON agent_tasks(` to get the authoritative list — at minimum: idx on agentId, status, offeredTo, taskType, agentmailThreadId, schedule_id, workflow_run, parentTaskId (034), slack_thread composite (040), swarmVersion (037), requested_by (031).
2. Add `"jira"` to `AgentTaskSourceSchema` in `src/types.ts:56-67`.
3. Update `TrackerProvider` union at `src/tracker/types.ts:1` to `"linear" | "jira"`.
4. Update provider describe strings in `src/tools/tracker/tracker-link-task.ts:15`, `tracker-sync-status.ts:15`, and `tracker-map-agent.ts:15` to mention `'jira'` alongside `'linear'` (e.g. `"Tracker provider (e.g. 'linear', 'jira')"`). Note: `tracker-status.ts:19` is part of an `outputSchema` (no describe string there) — instead update the hardcoded provider iteration list at `src/tools/tracker/tracker-status.ts:29` from `const providers = ["linear"] as const;` to `const providers = ["linear", "jira"] as const;` so the tool reports Jira connection status.

Files touched:
- `src/be/migrations/041_jira_source.sql` (new)
- `src/types.ts`
- `src/tracker/types.ts`
- `src/tools/tracker/tracker-link-task.ts`
- `src/tools/tracker/tracker-sync-status.ts`
- `src/tools/tracker/tracker-map-agent.ts`
- `src/tools/tracker/tracker-status.ts`

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] DB boundary check passes: `bash scripts/check-db-boundary.sh`
- [ ] Fresh DB boots clean: `rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && bun run start:http &` then `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq '.agents | length'`
- [ ] Existing DB migrates cleanly (test against a copy of a populated DB if available) — grep for `[migrations] applied 041_jira_source` in logs
- [ ] Existing unit tests still pass: `bun test`
- [ ] `'jira'` is present in the source CHECK: `sqlite3 agent-swarm-db.sqlite "SELECT sql FROM sqlite_master WHERE name='agent_tasks'"` shows `'jira'` in the list

#### Manual Verification:
- [ ] Open DB inspector and confirm `agent_tasks` table has the new CHECK constraint
- [ ] MCP `tracker-link-task` tool (when called with `provider: "jira"`) accepts the value without Zod rejection (smoke test with a dummy task)

**Implementation Note**: Pause for confirmation before Phase 2. Keeping this phase standalone means we can ship it behind no feature flag and safely roll back by a forward-only cleanup migration if needed.

### Phase 2 — OAuth flow + cloudId resolution + status endpoint

Goal: user can click "Connect Jira" in the UI, complete the Atlassian consent screen, and land back on the app with a stored access token + `cloudId` in `oauth_apps.metadata`.

Steps:
1. Create `src/jira/types.ts`:
   - `JiraTokenResponse { access_token, token_type, expires_in, refresh_token, scope }`
   - `JiraAccessibleResource { id, url, name, scopes, avatarUrl }`
   - `JiraOAuthAppMetadata { cloudId?: string, siteUrl?: string, webhookIds?: Array<{id: number, expiresAt: string, jql: string}> }` (JSON shape for `oauth_apps.metadata`).
2. Create `src/jira/metadata.ts` — typed read-modify-write helper to avoid concurrent clobbers on `oauth_apps.metadata` JSON:
   - `getJiraMetadata(): Promise<JiraOAuthAppMetadata>` — reads `oauth_apps` row, parses `metadata`, returns typed object (with `{}` fallback + best-effort shape coercion).
   - `updateJiraMetadata(partial: Partial<JiraOAuthAppMetadata>): Promise<void>` — wraps the read-modify-write in a single SQLite transaction via `db.transaction(...)` so two concurrent writers can't stomp each other's keys. Merges shallowly for scalar keys (`cloudId`, `siteUrl`) and does an id-keyed merge for `webhookIds` (preserves existing entries whose ids aren't being updated).
   - All subsequent phases (Phase 2 cloudId write, Phase 5 webhookIds writes) go through this helper — no inline `JSON.stringify(upsertOAuthApp(...))` from here on.
3. Create `src/jira/app.ts` mirroring `src/linear/app.ts:19-48`:
   - `isJiraEnabled()` — checks `JIRA_DISABLE` + `JIRA_ENABLED` + presence of `JIRA_CLIENT_ID`.
   - `initJira()` — idempotent; calls `upsertOAuthApp("jira", { authorizeUrl: "https://auth.atlassian.com/authorize", tokenUrl: "https://auth.atlassian.com/oauth/token", scopes: "read:jira-work write:jira-work manage:jira-webhook offline_access read:me", metadata: '{}' , ... })`. Returns `true` if enabled. (Outbound sync + webhook-lifecycle timer wired in later phases via this same function.)
   - `resetJira()` — cleanup for reload. **Must also call `resetBotAccountIdCache()`** (from Phase 3) so a reconnect as a different Atlassian user invalidates the cached bot `accountId`.
4. Create `src/jira/oauth.ts` mirroring `src/linear/oauth.ts`:
   - `getJiraOAuthConfig()` — loads from `getOAuthApp("jira")`, builds an `OAuthProviderConfig` for the generic wrapper. `extraParams: { audience: "api.atlassian.com", prompt: "consent" }`.
   - `getJiraAuthorizationUrl()` — wraps `buildAuthorizationUrl(config)`.
   - `handleJiraCallback(code, state)` — calls `exchangeCode(config, code, state)` (see `src/oauth/wrapper.ts:84` for signature), then:
     - `fetch("https://api.atlassian.com/oauth/token/accessible-resources", { headers: { Authorization: "Bearer " + accessToken }})`.
     - Picks the first resource (v1 = single workspace). Throws if empty.
     - Persists `{ cloudId, siteUrl }` via `updateJiraMetadata({ cloudId, siteUrl })` (from step 2).
5. Create `src/jira/client.ts`:
   - `getJiraAccessToken()` — calls `ensureToken("jira")` then reads `getOAuthTokens("jira")`.
   - `getJiraCloudId()` — reads `metadata.cloudId` via `getJiraMetadata()`. Throws if missing.
   - `jiraFetch(path, init?)` — typed fetch wrapper: prepends `https://api.atlassian.com/ex/jira/{cloudId}` to `path`, sets `Authorization: Bearer <token>`, sets `Accept: application/json` (and `Content-Type: application/json` when body provided). On 401, refreshes via `ensureToken("jira", 0)` and retries once. On 429, respects `Retry-After` with a single retry.
6. Create `src/http/trackers/jira.ts` with 4 routes via the `route()` factory (mirror `src/http/trackers/linear.ts:12-68` — Phase 2 ships authorize/callback/status; the `POST /webhook` route shell is added here too but its handler body is a 503 stub until Phase 3):
   - `GET /api/trackers/jira/authorize` — 302 redirect to `getJiraAuthorizationUrl()`. `auth: { apiKey: false }`.
   - `GET /api/trackers/jira/callback?code=&state=` — calls `handleJiraCallback`, returns a simple success HTML page. `auth: { apiKey: false }`.
   - `GET /api/trackers/jira/status` — returns `{ connected: boolean, cloudId?, siteUrl?, tokenExpiresAt?, webhookUrl: <server>/api/trackers/jira/webhook, hasManageWebhookScope: boolean }`.
   - `POST /api/trackers/jira/webhook` — shell route (returns 503 "webhook handler not configured yet" until Phase 3 wires `handleJiraWebhook`). `auth: { apiKey: false }`.
7. Extend `src/http/trackers/index.ts` so it tries `handleJiraTracker` when path starts `api/trackers/jira/...`.
8. Call `initJira()` from `src/http/index.ts:266` next to `initLinear()`, and from `src/http/core.ts:125` next to its `initLinear()` sibling.
9. Update `scripts/generate-openapi.ts` to import the new handler file. Run `bun run docs:openapi` and commit `openapi.json` + regenerated `docs-site/content/docs/api-reference/**`.
10. Env vars (documented in CLAUDE.md updates for Phase 6, declared now in `.env.example` if present): `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_REDIRECT_URI` (default `http://localhost:{PORT}/api/trackers/jira/callback`), `JIRA_SIGNING_SECRET`, `JIRA_DISABLE`, `JIRA_ENABLED`.

Files touched:
- `src/jira/types.ts` (new)
- `src/jira/metadata.ts` (new)
- `src/jira/app.ts` (new)
- `src/jira/oauth.ts` (new)
- `src/jira/client.ts` (new)
- `src/jira/index.ts` (new, re-exports)
- `src/http/trackers/jira.ts` (new)
- `src/http/trackers/index.ts`
- `src/http/index.ts`
- `src/http/core.ts`
- `scripts/generate-openapi.ts`
- `openapi.json` (regenerated)
- `docs-site/content/docs/api-reference/**` (regenerated)
- `.env.example` (if present)

### Success Criteria:

#### Automated Verification:
- [ ] Type check: `bun run tsc:check`
- [ ] Lint: `bun run lint:fix`
- [ ] DB boundary: `bash scripts/check-db-boundary.sh`
- [ ] Build OpenAPI: `bun run docs:openapi` (exit 0, no diff after commit)
- [ ] Server boots with Jira env vars set: start server, `curl -s http://localhost:3013/api/trackers/jira/status` returns `{"connected":false, ...}` with 200
- [ ] Server boots cleanly with Jira env vars NOT set: status endpoint returns 503

#### Manual Verification:
- [ ] Create a Jira Cloud OAuth 2.0 app at https://developer.atlassian.com/console/myapps/, set callback to `http://localhost:3013/api/trackers/jira/callback`, enable the 5 required scopes.
- [ ] Set `JIRA_CLIENT_ID` + `JIRA_CLIENT_SECRET` + `JIRA_SIGNING_SECRET` in `.env`, restart.
- [ ] Open `http://localhost:3013/api/trackers/jira/authorize` in a browser, complete consent, land on success page.
- [ ] `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/trackers/jira/status | jq` shows `connected: true`, non-null `cloudId`, and a reasonable `tokenExpiresAt` (~1h out).
- [ ] `sqlite3 agent-swarm-db.sqlite "SELECT metadata FROM oauth_apps WHERE provider='jira'"` shows JSON containing `cloudId` and `siteUrl`.
- [ ] Confirm secret rows are encrypted at rest (if `SECRETS_ENCRYPTION_KEY` is configured) — this is handled by existing `storeOAuthTokens()` path, no new code.

### QA Spec (optional):

Manual verification focus: OAuth round-trip against a real Jira Cloud site. Screenshot the consent screen + status JSON + DB metadata row.

**Implementation Note**: Pause for confirmation before Phase 3. OAuth is done and observable independent of webhook handling.

### Phase 3 — Webhook receiver + inbound sync (+ ADF walker + templates)

Goal: a signature-verified `POST /api/trackers/jira/webhook` accepts Jira events, dedups, and creates a swarm task on issue-assigned-to-bot or bot-mentioned-in-comment.

Steps:
1. Create `src/jira/adf.ts`:
   - `extractText(adf: unknown): string` — recursive walker over ADF `doc` node; concatenates `text` nodes and inlines mentions as `@<displayName>`. Handles `paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `text`, `mention`, `hardBreak`, `codeBlock`, `blockquote`. Unknown node types: descend into `content` if present, else skip. When an unknown node type is encountered and `NODE_ENV !== "production"`, log a debug-level message (`[jira.adf] unknown node type: <type>`) so edge cases surface in dev without noise in prod.
   - `extractMentions(adf: unknown): string[]` — returns `attrs.id` values (Atlassian `accountId`) from all `mention` nodes.
2. Create `src/jira/webhook.ts` mirroring `src/linear/webhook.ts:30-37` (Linear's helper signature is `verifyLinearWebhook(rawBody: string, signature: string, secret: string)` — keep Jira's signature consistent by also taking `rawBody: string` assembled from request chunks, matching the pattern in `src/http/trackers/linear.ts:166-171`):
   - `verifyJiraWebhook(rawBody: string, signatureHeader: string | undefined, secret: string): boolean` — parses `sha256=<hex>`, computes `createHmac("sha256", secret).update(rawBody).digest("hex")`, timing-safe compare.
   - **Dedup is DB-persisted** (not a process-local `Map`): synthesize a delivery id from `${body.webhookEvent}:${body.timestamp}:${body.issue?.id ?? body.comment?.id}:${sha256(rawBody).slice(0,16)}` (body-hash suffix kills same-ms collisions). Before processing, `SELECT 1 FROM tracker_sync WHERE provider='jira' AND lastDeliveryId=?`. If found, drop. After successful processing, write the delivery id into the relevant `tracker_sync.lastDeliveryId` (update if row exists; row is created by the sync handlers, see step 3). Durable across restarts and past the 5-min window the Linear in-memory Map would lose. Known limitation: dedup is only effective once a `tracker_sync` row exists for the issue — for the very first inbound event (which creates the row), a duplicate delivery within the same request would race; this is acceptable given Jira's at-least-once semantics + idempotent `createTaskExtended` via the `(provider, externalId)` UNIQUE constraint (see step 3).
   - `handleJiraWebhook(req, res)` — reads raw body, verifies signature against `JIRA_SIGNING_SECRET` from env, parses JSON, dispatches to handlers in `src/jira/sync.ts` (fire-and-forget; always returns 200 once accepted to prevent Jira retries).
3. Create `src/jira/sync.ts`:
   - `resolveBotAccountId()` — `jiraFetch("/rest/api/3/myself")`, returns `accountId`. Cached in a module-scoped variable. Export `resetBotAccountIdCache()` — called from `resetJira()` (Phase 2 step 3) to clear the cache on OAuth reconnect so a different Atlassian user identity picks up correctly.
   - `handleIssueEvent(event)` — for `jira:issue_updated`: inspect `event.changelog.items` for `field == "assignee"` transitions. If new assignee is the bot accountId, call `createTaskExtended({ task: <rendered template jira.issue.assigned>, source: "jira", ... })` and insert `tracker_sync` row keyed on `(provider="jira", entityType="task", externalId=event.issue.id, externalIdentifier=event.issue.key)`. Skip if existing sync row already has a swarm task. Both the `createTaskExtended` call and `tracker_sync` insert must go through a single transaction path so the UNIQUE constraint on `(provider, entityType, externalId)` in `tracker_sync` makes the operation idempotent for rapid-fire duplicate deliveries.
   - `handleCommentEvent(event)` — for `comment_created` / `comment_updated`:
     1. **Self-authored skip.** If `event.comment.author.accountId === botAccountId`, return immediately — never process our own comments.
     2. **Outbound-echo skip.** Even for non-bot authors, check the existing `tracker_sync` row (if any) for this issue: if `lastSyncOrigin === "swarm"` AND `now - lastSyncedAt < 5000ms`, return. This catches the race where Jira echoes a just-posted swarm comment through the webhook before the sync row could be updated. (Matches Linear's outbound 5-second window.)
     3. Then `extractMentions(event.comment.body)` to detect bot mention. If found AND no existing `tracker_sync` row for the issue: create task with `jira.issue.assigned` template. If tracker_sync row exists and task is completed/cancelled: create a follow-up task using `jira.issue.followup` template. If task is still in-progress: append prompt to active task (same pattern as Linear's `handleAgentSessionPrompted`).
   - `handleIssueDeleteEvent(event)` — cancel any linked swarm task.
4. Create `src/jira/templates.ts` mirroring `src/linear/templates.ts`:
   - Register `jira.issue.assigned` — initial task instruction using issue key, summary, description (text via `extractText`), reporter, URL.
   - Register `jira.issue.commented` — for comment-triggered tasks (standalone, no prior task).
   - Register `jira.issue.followup` — continuation prompt when existing task exists.
   - Call `registerTemplate()` at module load (mirror Linear). Import this module from `src/jira/app.ts` at top-level so templates register on boot.
5. Wire `POST /api/trackers/jira/webhook` route in `src/http/trackers/jira.ts` to `handleJiraWebhook`. `auth: { apiKey: false }`. Responses: 200 (accepted), 401 (invalid signature), 503 (not configured).
6. Re-run `bun run docs:openapi` and commit regenerated files.

Files touched:
- `src/jira/adf.ts` (new)
- `src/jira/webhook.ts` (new)
- `src/jira/sync.ts` (new)
- `src/jira/templates.ts` (new)
- `src/jira/app.ts` (import templates)
- `src/jira/index.ts`
- `src/http/trackers/jira.ts`
- `openapi.json` (regenerated)

### Success Criteria:

#### Automated Verification:
- [ ] Type check: `bun run tsc:check`
- [ ] Lint: `bun run lint:fix`
- [ ] New unit tests (shell — fuller suite in Phase 6): `bun test src/tests/jira-adf.test.ts` (smoke: text + mention extraction)
- [ ] Existing tests still pass: `bun test`
- [ ] OpenAPI fresh: `bun run docs:openapi` (no diff after commit)
- [ ] Webhook endpoint rejects invalid signatures: `curl -s -o /dev/null -w "%{http_code}" -X POST -H "X-Hub-Signature: sha256=deadbeef" -H "Content-Type: application/json" -d '{}' http://localhost:3013/api/trackers/jira/webhook` returns `401`
- [ ] Webhook endpoint accepts valid signatures: generate HMAC over a crafted body with `JIRA_SIGNING_SECRET`, POST, get `200`

#### Manual Verification:
- [ ] Using the Atlassian REST API Browser or `curl` with the OAuth token, manually register a webhook pointing at an ngrok-tunneled `/api/trackers/jira/webhook` with `jqlFilter: "project = <YOUR_PROJECT>"` and `events: ["jira:issue_updated", "comment_created"]`. Include the `secret` so Jira signs deliveries with `JIRA_SIGNING_SECRET`.
- [ ] Assign a test issue to the bot user in Jira. Confirm a swarm task is created with `source='jira'` in DB.
- [ ] Post a comment mentioning the bot. Confirm a follow-up task (or initial task, depending on state) is created.
- [ ] Confirm `tracker_sync` row is inserted with correct `externalId`, `externalIdentifier` (issue key), `externalUrl`.
- [ ] Delete the issue. Confirm the swarm task is cancelled.
- [ ] Check that duplicate webhook deliveries (same `webhookEvent + timestamp + issue.id + body hash`) are silently dropped (manually POST the same body twice — second delivery should be a no-op because `tracker_sync.lastDeliveryId` matches). Verify via `sqlite3 agent-swarm-db.sqlite "SELECT lastDeliveryId FROM tracker_sync WHERE provider='jira'"`.
- [ ] Confirm inbound loop-prevention: simulate a swarm-posted comment by setting `lastSyncOrigin='swarm', lastSyncedAt=<now>` in `tracker_sync` then POST a comment-created webhook for that issue — handler should skip without creating a task. Wait 6 seconds and re-POST — handler should now process it.

### QA Spec (optional):

Screenshot: Jira issue → swarm task dashboard with `source=jira` badge.

**Implementation Note**: Pause before Phase 4. Inbound sync is the highest-risk surface — we want Taras to manually drive a few edge cases before layering outbound on top.

### Phase 4 — Outbound comments (lifecycle-only)

Goal: task lifecycle events post plaintext comments to the originating Jira issue via REST v2. Loop prevention prevents the just-posted comment from re-triggering inbound.

Steps:
1. Create `src/jira/outbound.ts` mirroring `src/linear/outbound.ts`:
   - `initJiraOutboundSync()` — subscribes to the swarm event bus: `task.created`, `task.completed`, `task.failed`, `task.cancelled`.
   - For each event, look up `tracker_sync` row filtered by `(provider="jira", entityType="task", swarmId=<taskId>)`. Skip if not present.
   - Skip if `lastSyncOrigin === "external"` AND `now - lastSyncedAt < 5000ms` (same window Linear uses).
   - Call `jiraFetch(`/rest/api/2/issue/${sync.externalIdentifier}/comment`, { method: "POST", body: JSON.stringify({ body: <rendered message> }) })`. Message bodies:
     - `task.created`: `":rocket: Swarm task started: <task summary>"`
     - `task.completed`: `":white_check_mark: Swarm task completed.\n\n<task.output truncated to 4k chars>"`
     - `task.failed`: `":x: Swarm task failed.\n\n<task.failureReason>"`
     - `task.cancelled`: `":no_entry: Swarm task cancelled."`
   - After posting, update `tracker_sync.lastSyncOrigin = "swarm"`, `lastSyncedAt = now`.
   - `teardownJiraOutboundSync()` — unsubscribes listeners.
2. Call `initJiraOutboundSync()` at the end of `initJira()` (Phase 2 file). Call `teardownJiraOutboundSync()` in `resetJira()`.
3. Handle token refresh transparently via the existing retry-once logic in `jiraFetch` (Phase 2).

Files touched:
- `src/jira/outbound.ts` (new)
- `src/jira/app.ts`
- `src/jira/index.ts`

### Success Criteria:

#### Automated Verification:
- [ ] Type check: `bun run tsc:check`
- [ ] Lint: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`

#### Manual Verification:
- [ ] Reuse the ngrok-tunneled webhook from Phase 3. Assign an issue to trigger a swarm task.
- [ ] Wait for `task.created` — confirm a `:rocket: Swarm task started` comment appears on the Jira issue.
- [ ] Let the task complete — confirm a `:white_check_mark: Swarm task completed` comment appears with output.
- [ ] Trigger a task cancellation (via MCP `cancel-task`) — confirm `:no_entry: Swarm task cancelled` comment.
- [ ] Confirm no infinite loop: the swarm-posted comment does NOT re-create a task. Tail server logs to confirm inbound handler short-circuits on `lastSyncOrigin="swarm"` within the 5-second window.
- [ ] Inspect `tracker_sync` row — `lastSyncOrigin` toggles between `"swarm"` and `"external"` as expected.

### QA Spec (optional):

Screenshot: Jira issue comment thread showing the 3 lifecycle comments from a completed task run.

**Implementation Note**: Pause before Phase 5. At this point we have full inbound+outbound parity with Linear's basic flow. Phase 5 is UX polish (auto-webhook-register) and can be deferred if timeboxed.

### Phase 5 — Webhook auto-registration + 25-day refresh timer

Goal: users who grant the `manage:jira-webhook` scope get an automatic webhook without touching Jira's admin UI. The webhook is auto-refreshed before the 30-day expiry.

Steps:
1. Create `src/jira/webhook-lifecycle.ts` mirroring the pattern in `src/oauth/keepalive.ts`:
   - `registerJiraWebhook(jqlFilter: string)` — called manually (from Phase 6 admin endpoint, or from a UI button). Body:
     ```json
     {
       "url": "<MCP_BASE_URL>/api/trackers/jira/webhook",
       "webhooks": [{
         "events": ["jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated"],
         "jqlFilter": <jqlFilter>,
         "fieldIdsFilter": ["assignee"]
       }]
     }
     ```
     POST to `/rest/api/3/webhook`. Pass the webhook `secret` query param (or header — consult Atlassian docs at implementation time) set to `JIRA_SIGNING_SECRET` so Jira signs deliveries.
     Response contains `webhookRegistrationResult[].createdWebhookId` + expiry. Persist via `updateJiraMetadata({ webhookIds: [...] })` (from Phase 2 step 2) so concurrent writes don't clobber `cloudId`/`siteUrl`.
   - `refreshJiraWebhooks()` — reads `metadata.webhookIds` via `getJiraMetadata()`, calls `PUT /rest/api/3/webhook/refresh`. **TBD at implementation time:** the exact request body shape is not confirmed in the research doc — plan assumes `{ webhookIds: [<id>, ...] }`, but verify against current Atlassian docs (via Context7 `/atlassian/jira-cloud-rest-api` or the live docs at `developer.atlassian.com`) before coding. Updates new expiry times via `updateJiraMetadata(...)`.
   - `startJiraWebhookKeepalive()` — timer every 12 hours; if any webhook expires within 7 days, calls `refreshJiraWebhooks()`. Logs + optional Slack alert on failure (mirror `src/oauth/keepalive.ts` alert pattern).
   - `stopJiraWebhookKeepalive()` — cleanup.
2. Call `startJiraWebhookKeepalive()` at the end of `initJira()`; call `stopJiraWebhookKeepalive()` in `resetJira()`.
3. Add `POST /api/trackers/jira/webhook-register` route in `src/http/trackers/jira.ts` (authenticated, not public): accepts `{ jqlFilter }`, calls `registerJiraWebhook`. Returns the registered webhook ids + expiry.
4. Add `DELETE /api/trackers/jira/webhook/:id` for admin cleanup: calls `DELETE /rest/api/3/webhook` with the id.
5. Fallback path: if `hasManageWebhookScope === false` (status endpoint exposes this from `oauth_tokens.scope`), surface instructions in `/status` for manual registration (the status endpoint should return `{ manualWebhookInstructions: "..." }` pointing at the docs guide section).
6. Re-run `bun run docs:openapi`.

Files touched:
- `src/jira/webhook-lifecycle.ts` (new)
- `src/jira/app.ts`
- `src/http/trackers/jira.ts`
- `src/jira/index.ts`
- `openapi.json` (regenerated)

### Success Criteria:

#### Automated Verification:
- [ ] Type check: `bun run tsc:check`
- [ ] Lint: `bun run lint:fix`
- [ ] OpenAPI fresh: `bun run docs:openapi`
- [ ] `curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"jqlFilter":"project = TEST"}' http://localhost:3013/api/trackers/jira/webhook-register` returns 200 with webhook id(s)

#### Manual Verification:
- [ ] After Phase 2 OAuth connect, hit `/webhook-register` with a JQL filter. Confirm Jira returns a valid webhook id.
- [ ] Verify webhook shows up in Atlassian's webhook list for the OAuth app (via the Atlassian API: `GET /rest/api/3/webhook`).
- [ ] Assign an issue matching the JQL filter to the bot — confirm inbound sync still works end-to-end via the auto-registered webhook.
- [ ] Manually move `metadata.webhookIds[0].expiresAt` to ~3 days out in DB, trigger `refreshJiraWebhooks()` manually (via a tiny debug endpoint or REPL), confirm expiry updates.
- [ ] Confirm fallback: rescope the OAuth app to exclude `manage:jira-webhook`, reconnect, hit `/status` — `hasManageWebhookScope: false` and instructions returned.
- [ ] Hit `DELETE /api/trackers/jira/webhook/:id` — confirm webhook is removed from Jira.

### QA Spec (optional):

Screenshot: Atlassian webhook admin list before & after auto-registration. Plus `/status` JSON showing `webhookIds` + expiries populated.

**Implementation Note**: Pause before Phase 6. This phase adds the most runtime surface area (timers, admin endpoints) — worth a pre-docs checkpoint.

### Phase 6 — Tests, docs, OpenAPI, UI, CLAUDE.md

Goal: bring Jira to the same observability + documentation bar as Linear. Includes unit-test coverage, the integration guide, UI connect card, and CLAUDE.md "Local development" + "Env vars" updates.

Steps:
1. **Unit tests** (isolated SQLite DBs per CLAUDE.md rules):
   - `src/tests/jira-adf.test.ts` — text extraction, mention extraction, nested list handling, code-block passthrough, unknown-node dev-log path.
   - `src/tests/jira-metadata.test.ts` — `getJiraMetadata` / `updateJiraMetadata` read-modify-write semantics: concurrent updates preserve both writers' keys; `webhookIds` id-keyed merge preserves untouched entries.
   - `src/tests/jira-webhook.test.ts` — HMAC valid/invalid, DB-persisted dedup via `lastDeliveryId` (including across restart), dispatcher routing (issue assigned, comment mention, issue deleted).
   - `src/tests/jira-sync.test.ts` — inbound: tracker_sync insert, createTaskExtended source verification, bot-mention triggers follow-up on completed task, **self-authored comment skip, 5-second outbound-echo skip** (the loop-prevention paths added in Phase 3).
   - `src/tests/jira-outbound-sync.test.ts` — event bus → comment posting mock; loop-prevention short-circuit; token refresh on 401.
   - `src/tests/jira-oauth.test.ts` — callback path: accessible-resources fetched, metadata persisted via `updateJiraMetadata`.
   - Mirror the mocking strategy from `src/tests/linear-webhook.test.ts` and `src/tests/linear-outbound-sync.test.ts`.
2. **Docs guide**: `docs-site/content/docs/(documentation)/guides/jira-integration.mdx` — mirror sections of `linear-integration.mdx`:
   - Features
   - Setup (Atlassian developer console app creation — scopes list, callback URL, signing secret)
   - Config (env vars, `JIRA_DISABLE` / `JIRA_ENABLED`)
   - Connecting (OAuth flow, manual webhook fallback instructions)
   - How it works (inbound, outbound, loop prevention, webhook refresh)
   - MCP tools (just `tracker-*` tools with `provider: "jira"`)
   - Architecture
   - **Known limitations (v1)** — explicitly call out: (a) single-workspace-per-install (`cloudId` is fixed at first OAuth connect); (b) `JIRA_SIGNING_SECRET` rotation requires re-registering every webhook manually — there is no drift detection between the env value and what Jira was configured with. Recommended rotation flow: set new `JIRA_SIGNING_SECRET` → restart → `DELETE` all existing webhooks → `POST /webhook-register` to re-register with new secret. For manually admin-registered webhooks, admins must also update the secret in Jira's webhook UI.
   - Related
3. **OpenAPI**: final `bun run docs:openapi` after all routes are in. Commit `openapi.json` + `docs-site/content/docs/api-reference/**`.
4. **UI**: `new-ui/src/pages/config/page.tsx` currently has NO provider-specific cards (Linear/GitHub/Slack are all configured via raw `swarm_config` rows). The dedicated integrations UI is tracked separately in `thoughts/taras/plans/2026-04-21-integrations-ui.md`. For this plan: if the integrations-ui plan has landed by the time Phase 6 runs, add a Jira card there (same `/api/trackers/jira/{authorize,status}` pattern as the Linear card). Otherwise, defer UI work to the integrations-ui plan and surface a note in the docs guide explaining that the current path is to set env vars + hit `/api/trackers/jira/authorize` directly.
5. **CLAUDE.md**: add Jira env vars to the "Key env vars" list in the "Local development" `<important if>` block. Add a note about cloudId storage in the "Architecture invariants" section if needed (single-workspace assumption).
6. **README / integrations-ui research**: no README change required for v1. If `thoughts/taras/plans/2026-04-21-integrations-ui.md` covers Jira UI cards, cross-reference.

Files touched:
- `src/tests/jira-*.test.ts` (5 new files)
- `docs-site/content/docs/(documentation)/guides/jira-integration.mdx` (new)
- `openapi.json` (regenerated)
- `docs-site/content/docs/api-reference/**` (regenerated)
- `new-ui/src/pages/config/page.tsx`
- `CLAUDE.md`

### Success Criteria:

#### Automated Verification:
- [ ] All new unit tests pass: `bun test src/tests/jira-adf.test.ts src/tests/jira-metadata.test.ts src/tests/jira-webhook.test.ts src/tests/jira-sync.test.ts src/tests/jira-outbound-sync.test.ts src/tests/jira-oauth.test.ts`
- [ ] Full test suite: `bun test`
- [ ] Type check: `bun run tsc:check`
- [ ] Lint: `bun run lint:fix`
- [ ] DB boundary: `bash scripts/check-db-boundary.sh`
- [ ] OpenAPI fresh: `bun run docs:openapi`
- [ ] UI type check: `cd new-ui && pnpm lint && pnpm exec tsc --noEmit`
- [ ] Docs site builds (if applicable): `cd docs-site && pnpm build` or `bun run build` depending on configured script

#### Manual Verification:
- [ ] Read the new `jira-integration.mdx` end-to-end — verify every step is actionable for a fresh user.
- [ ] If a UI card was added (see Step 4): screenshot the "Connect Jira" card state transitions: disconnected → consent → connected → disconnected (per CLAUDE.md UI PR requirement). If UI was deferred to the integrations-ui plan, skip this step.
- [ ] Drive the full loop end-to-end against a real Jira Cloud site: create issue → assign to bot → task created → task completes → comment posted back → complete task deletion.

### QA Spec (optional):

- Run `qa-use` session covering: OAuth connect card, status reflecting post-connect state, inbound issue→task, outbound comment appearance.
- Attach qa-use session ID + screenshots to the PR per CLAUDE.md frontend PR requirement.

**Implementation Note**: After Phase 6 passes, run the manual E2E script below, then open PR.

## Manual E2E (run after all phases)

Against a real Jira Cloud site, with ngrok tunnel + server running (`bun run start:http` or `pm2-start`):

```bash
# 1. Reset DB for a clean run
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm

# 2. Start server with Jira env vars configured
bun run start:http &

# 3. Complete OAuth connect
open "http://localhost:3013/api/trackers/jira/authorize"
# ... consent in browser, land on success page ...

# 4. Check status
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/trackers/jira/status | jq

# 5. Auto-register webhook (if you have the manage:jira-webhook scope)
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"jqlFilter":"project = <YOUR_PROJECT>"}' \
  http://localhost:3013/api/trackers/jira/webhook-register | jq

# 6. In Jira UI: assign an issue in <YOUR_PROJECT> to the bot account
#    -> confirm swarm task created:
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks | jq '.tasks[] | select(.source=="jira")'

# 7. Watch the task complete; check Jira issue for lifecycle comments
#    (browser: open the issue URL from tracker_sync.externalUrl)

# 8. Post a @-mention comment on the completed issue
#    -> confirm a follow-up task is created:
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks | jq '.tasks[] | select(.source=="jira")'

# 9. Cleanup webhook
WEBHOOK_ID=$(sqlite3 agent-swarm-db.sqlite "SELECT json_extract(metadata, '$.webhookIds[0].id') FROM oauth_apps WHERE provider='jira'")
curl -s -X DELETE -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/trackers/jira/webhook/$WEBHOOK_ID"
```

Replace `<YOUR_PROJECT>` with a Jira project key (e.g. `TEST`). Swap `123123` for your `API_KEY` if different.

## Rollback Plan

- **Schema rollback** (Phase 1): forward-only cleanup migration that rebuilds `agent_tasks` without `'jira'` in the CHECK list. Only safe if no `source='jira'` rows exist.
- **Runtime rollback**: set `JIRA_DISABLE=true` in `.env` and restart. `isJiraEnabled()` short-circuits `initJira()`, all routes return 503, no new webhooks register.
- **Webhook rollback (happy path)**: call the `DELETE /api/trackers/jira/webhook/:id` endpoint (Phase 5) or manually delete via Atlassian REST API.
- **Webhook rollback (stuck path — OAuth revoked)**: if the OAuth app's tokens have been revoked from Atlassian's side, the DELETE endpoint will 401 because we can no longer authenticate to the Atlassian API. Two options:
  1. **Wait it out**: registered webhooks auto-expire after 30 days of no refresh. Our `/webhook` endpoint will start returning 401 (signature verify will still fail against the old secret, or Jira stops retrying after the max-retry cap), and the issue self-resolves.
  2. **Force local cleanup**: clear our DB state so the swarm stops trying to sync:
     ```bash
     sqlite3 agent-swarm-db.sqlite <<SQL
     DELETE FROM oauth_tokens WHERE provider = 'jira';
     UPDATE oauth_apps SET metadata = '{}' WHERE provider = 'jira';
     DELETE FROM tracker_sync WHERE provider = 'jira';
     DELETE FROM tracker_agent_mapping WHERE provider = 'jira';
     SQL
     ```
     The incoming webhook deliveries will then be rejected at `/api/trackers/jira/webhook` (no stored secret → signature verify fails → 401). Jira will eventually stop delivering after its retry cap.

## Related

- Research: `thoughts/taras/research/2026-04-21-jira-integration.md`
- Linear finalization prior art: `thoughts/taras/research/2026-03-18-linear-integration-finalization.md`
- Integrations UI plan (cross-cutting): `thoughts/taras/plans/2026-04-21-integrations-ui.md`
- `src/linear/*` (the blueprint this plan mirrors)
- `src/oauth/wrapper.ts` + `src/oauth/ensure-token.ts` + `src/oauth/keepalive.ts` (reused as-is)
- `src/http/trackers/linear.ts` (route shape to mirror)
