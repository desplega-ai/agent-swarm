---
date: 2026-11-04T00:00:00+01:00
researcher: Claude (with Taras)
git_commit: fd6131322
branch: t3/post-onboarding
repository: desplega-ai/agent-swarm (+ desplega-ai/agent-fs at 629388f)
topic: "Post-onboarding: answers to the 10 open questions of the post-onboarding brainstorm"
tags: [research, onboarding, agent-fs, comb, oauth, integrations, sessions, schedules, pages, home, favorites, redirects]
status: complete
autonomy: critical
last_updated: 2026-11-04
last_updated_by: Claude
---

# Research: post-onboarding open questions

**Date**: 2026-11-04
**Researcher**: Claude (with Taras)
**Git Commit**: agent-swarm `fd6131322`, agent-fs `629388f`
**Branch**: `t3/post-onboarding`
**Input**: `thoughts/taras/brainstorms/2026-11-03-post-onboarding.md` (Open Questions section)
**Method**: Workflow run `wf_203eee0e-699`. One Sonnet researcher per question, then one adversarial Sonnet verifier per question. The verifier re-opened the cited lines of the top 8 claims. 70 of 80 checked claims were confirmed and 10 were partial (corrections folded in below). No claim was marked wrong. The verbatim evidence is in the appendix at the end.

## Research Question

Answer the 10 fact-shaped Open Questions from the brainstorm. Their answers feed `/desplega:v-plan` for tracks A to E (agent-fs wall, "Continue with your swarm", IA and Connect hub, use-case groups, Home command center).

Q1 was reframed after Taras said the user "probably was from base install skill". It now traces the base install paths instead of the user's actual deployment.

## Summary

**Base install (Q1).** The landing page offers two paths, and they give different file behavior.
- **Prompt path:** "Read skill.md and help me install" leads to the operator skill, then to the Compose example or Helm. The Compose example starts agent-fs and MinIO, but Comb resolves OFF: the host `agent-fs` is not reachable from a browser. No link target is set, so agents hand out `live.agent-fs.dev` links. That host needs a key the user never received.
- **`install.sh` path:** it bundles agent-fs with `COMB_ENABLED=true`, `AGENT_FS_PROXY=true` and `AGENT_FS_LINK_TARGET=dashboard`. Links open in-app, but only in the browser that ran `/setup`. A second browser hits the 409 "This email already has an agent-fs account" state, with a paste-key form. No UI anywhere shows the saved key.

**agent-fs keys and login (Q2, Q3).**
- **Key model:** agent-fs has exactly one API key per user (a hash on `users`). It has no scopes and no expiry.
- **Minting for another user:** an org admin can mint a new key for a member with `POST /orgs/{orgId}/members/{userId}/reset-key`. That call overwrites the user's single key everywhere, in all orgs.
- **Swarm side:** the swarm already stores agent-fs keys encrypted in `swarm_config`: the bootstrap key (global) and one key per agent (agent scope). It stores none per human user.
- **Live UI:** agent-fs has no OAuth, magic link, device code, JWT, cookie or token-exchange route. Orgs have no settings or URL field. The live SPA keeps credentials in localStorage. A deep link with no credential redirects to `/credentials` and loses the path.
- **Prior art:** agent-fs has short-lived hashed tokens for shares, view grants and invites. The swarm has one-time hashed `connector_codes` and the invite fragment flow (`#code=`).

**IA (Q4, Q5).**
- **Redirects:** none of the 15 routes the IA rethink would move is a redirect source today. The existing `REDIRECTS` table drops search and hash.
- **Server-built URLs:** the server builds dashboard URLs in a few places: `/tasks/<id>` (Slack, Linear, citations persisted in `task_citations`), automation preflight (`/schedules/:id`, `/workflows/:id`, `/settings/integrations/<provider>`), and MCP OAuth (`/mcp-servers/<id>?oauth=`, persisted in pending rows). Prompts and seeded skills hold none of these paths.
- **OAuth:** connections use three storage families: `swarm_config` rows, `oauth_*` tables, and MCP OAuth on the same tables. Linear and Jira span two families. Gmail and MS365 exist only in `oauth_*`.

**Use cases (Q6, Q7, Q9).**
- **Groups:** a Sessions group is the task key without its last `task|thread|schedule|workflow:<id>/` leaf.
- **Schedule runs:** the default schedule key `shared/schedule:<id>/` therefore lands in "No group". Schedule runs are hidden in a group view by default, for two reasons: "Mine" excludes `source='schedule'`, and the shown sources default to `comb,ui`.
- **Schedule keys:** schedules accept an explicit `key`, but schedules and workflows have no channel or thread field. No code links a key to a channel.
- **Pages:** `create-page` ignores the calling task's key. #963 introduced this default and recorded no reason.

**Home and checklist (Q8, Q10).**
- **Workflow runs:** no global workflow-runs list exists. The UI does N+1 fetches.
- **Inbox hooks:** four inbox hooks exist but nothing mounts them.
- **Onboarding state:** it is one per-swarm JSON row (`swarm_config` global key `onboarding_state`), with signals derived on every read. No prompt template exposes it to agents.
- **Favorites:** `user_favorites` has a CHECK-constrained type list (migrations 105, 116, 192, 205).
- **Migration tail:** 278.

## Detailed Findings

### Q1. Base install paths and what the owner sees

**Two landing entry points** (`~/Documents/code/agent-swarm-landing/src/lib/landing-v2-copy.ts:11-15`):
- The prompt "Read https://agent-swarm.dev/skill.md and help me install and operate Agent Swarm on our infra." The operator skill (`skills/agent-swarm/SKILL.md:13,22,25`) defaults to the Compose example or Helm and treats agent-fs as optional. It never mentions `install.sh` or `onboard`.
- `curl -fsSL https://agent-swarm.dev/install.sh | bash`.

**Config by path:**

| Setting | `install.sh` (`onboard --yes --preset full`) | Compose example (skill path) | Helm default |
|---|---|---|---|
| agent-fs started | Yes, local disk + TEI (`install.sh:107-110,284`, `onboard.tsx:240`) | Yes, with MinIO (`docker-compose.example.yml:117,130-138`) | No, `agentFs.enabled: false` (`values.yaml:301`) |
| `AGENT_FS_API_URL` | `http://agent-fs:7433` | `http://agent-fs:7433` (`:203`) | n/a |
| `COMB_ENABLED` | `true` (`compose-generator.ts:97-100`) | unset; Comb resolves OFF because `agent-fs` is not browser-reachable (`constants.ts:285,314-329`) | off |
| `AGENT_FS_PROXY` | `true` | unset | `proxy: false` (`values.yaml:329`) |
| `AGENT_FS_LINK_TARGET` | `dashboard` (API and workers, `:352-356`) | unset, so the link base is null and agents fall back to the live URL (`constants.ts:134`) | n/a |
| `APP_URL` | `https://app.agent-swarm.dev` (`:85,255`) | `${APP_URL:-}`, `.env.docker.example:72` sets the hosted dashboard | `appUrl: ""` |
| `AGENT_FS_LIVE_URL` | never set, so the default is `https://live.agent-fs.dev` (`constants.ts:100`) | same | same |

- The interactive `onboard` wizard does not bundle agent-fs (`agent-fs-co-deployment.mdx:98`).
- On the bundle, `AGENT_FS_PUBLIC_URL` goes only to the agent-fs container, as `${PUBLIC_MCP_BASE_URL:-http://localhost:3013}/agentfs`. `AGENT_FS_APP_URL` also goes there (`compose-generator.ts:126-127`).
- The Comb endpoint the browser uses is `<public API URL>/agentfs` (`src/comb/config.ts:35-42`).

**Owner experience on the `install.sh` bundle:**
- **`/setup` Files step:** it runs `createAndConnect` once with no click, using the step-1 email (`step-files.tsx:56-60`). It then shows "Your files account is ready." (`:174-176`).
- **Same browser:** agent links are `https://app.agent-swarm.dev/file/~/...` (`constants.ts:135-138`, `session-templates.ts:219`). They open Comb when this browser holds the key for the same API URL and endpoint.
- **Second browser:** register returns 409, mapped to `email-taken`. The Files step shows "This email already has an agent-fs account" with a paste-key form (`step-files.tsx:205-210`). A grep found no UI that reveals the saved key.
- **Comb off:** the Files step says "Files is off on this swarm. Skip this step." (`step-files.tsx:261-262`).

**Unknowns:**
- Which path the user used.
- Whether the published `agent-swarm.dev/skill.md` differs from the repo copy.
- The cloud tenant defaults (no provisioning code in this repo).
- What happens after a tunnel URL change. Derived, not run: the saved credential is keyed to the API URL.

### Q2. agent-fs key model and server-side minting

**agent-fs (repo `~/Documents/code/agent-fs`):**
- **Key model:** one key per user, stored as `users.api_key_hash` (unsalted SHA-256 hex). The key format is `af_` plus 64 hex characters. Keys have no scopes and no expiry. Access comes from org and drive roles.
- **Rotation routes:** `POST /auth/reset-key` rotates the caller's own key. `POST /orgs/{orgId}/members/{userId}/reset-key` needs `requireOrgAdmin` and a target who is a member (`orgs.ts:211`). It returns `{ apiKey, userId, email }` and writes an `api_key_reset` event.
- **Blast radius:** `resetApiKey` overwrites the single hash by user id (`users.ts:58-90`). The old key stops working in every org.
- No route lists keys. agent-fs has no special bootstrap or admin key type.
- **Registration:** `POST /auth/register` is public and returns `{ apiKey, userId, orgId }` (`routes/auth.ts:53-57`). An existing email gets 409 (`:59-62`). `AGENT_FS_REGISTER_ALLOWED_DOMAINS` can restrict it (403 `REGISTRATION_DOMAIN_NOT_ALLOWED`, `config.ts:25-29`, `auth.ts:28-47`).

**agent-swarm:**
- **Bootstrap key:** global `swarm_config` key `API_AGENT_FS_API_KEY`, `isSecret` (`agent-fs-provision.ts:24,193-199`). Lookup order: the config row, then env `API_AGENT_FS_API_KEY`, then env `AGENT_FS_API_KEY`, then the legacy row. The bootstrap user is an ordinary agent-fs user. It is admin of the shared org it created.
- **Per-agent keys:** minted with `/auth/register` and stored as `swarm_config` scope `agent`, key `AGENT_FS_API_KEY`, `isSecret`. Provisioning re-registers only when the row is missing (`agent-fs-provision.ts:310`).
- **Encryption:** `upsertSwarmConfig` encrypts secrets with `encryptSecret(..., getEncryptionKey())` (`src/be/db.ts:6827`), using AES-256-GCM (`src/be/crypto/secrets-cipher.ts:18`).
- **Invite route:** `POST /api/fs/members/invite` uses the bootstrap key and returns no key.
- **Per-user keys:** the swarm stores none server-side. The dashboard keeps the credential in browser localStorage only.
- The swarm never calls `reset-key` (grep).

### Q3. Prior art for "Continue with your swarm"

**agent-fs:**
- **Orgs:** the table has only `id, name, is_personal, created_at`. It has no settings blob, no URL field, and no org update route.
- **Server-wide URLs:** `appUrl` builds web-app links (file deep links, signed-url, invite accept). `server.publicUrl` (`AGENT_FS_PUBLIC_URL`) builds absolute share links (`packages/core/src/config.ts:126,135-136,332,335`).
- **Credential types:**
  - `af_` API key: Bearer on every authed route, including `/mcp` (`app.ts:99`).
  - Share tokens: 24h default, 7d max. View grants: 1h.
  - Presigned S3 URLs: 24h default.
  - Invite tokens: 7d, sent as a fragment link.
  - Live HTML viewer: mints a 15-minute site share.
  - Token tables store only SHA-256 hashes with expiry (`schema.ts:242-262` shares, `:285-295` view grants, `:300-320` org invites).
- **Auth routes:** `POST /auth/register` (public), `GET /auth/me` (returns userId, email, displayName, defaultOrgId, defaultDriveId, `auth.ts:73-95`), and the self and admin reset-key routes. A grep found no OAuth, magic link, device code, JWT, cookie or token-exchange route.
- **Public routes before auth:** `/share` (`app.ts:58`), `/site` (`:64`) and `GET /invites/:token` (`:71`). Comment at `:56`: "the token is the only credential". `authMiddleware` mounts at `:73`.
- **Live SPA (`live/`):** credentials live in localStorage. A deep link with no credential redirects to `/credentials` and loses the path.
- **CORS:** `config.server?.cors?.origins ?? ["*"]` (`app.ts:37-39`). The value is set in the config file only.

**agent-swarm:**
- **`connector_codes`:**
  - Two kinds: connector (10 min) and invite (7 days).
  - Each code is single-use (`UPDATE ... RETURNING`) and stored hashed.
  - The exchange mints an `aswt_` token.
- **Invite flow:** `<api>/invite/<code>` redirects to `APP_URL/join?swarm=...#code=`.
- **`/connect` flow:** it redirects a code to an allowlisted https origin, in the query string.

### Q4. Hard-coded dashboard paths and redirect prior art

**Router (`apps/ui/src/app/routes.tsx`):**
- **Existing redirects:** the `REDIRECTS` table covers older top-level paths (dashboard, budgets, config, keys, integrations, repos, debug, metrics, script-runs). `integrations/:id` goes through `RouteRedirect`. The targets are static strings, and `RouteRedirect` passes only route params, so search and hash are dropped.
- **Placement:** `...redirectRoutes` is spread at `routes.tsx:570`, before the `*` catch-all.
- **Command palette:** redirect routes carry an unlisted `handle` so the Cmd+K guard accepts them (`:153`). `:id` patterns need no handle (`route-meta.ts:138`).
- **Search and hash preserved in only three places:**
  - Comb: `${redirect}${search}`.
  - The `/setup` bounce: `root-layout.tsx:103` stores `from` with pathname, search and hash, consumed at `setup/page.tsx:493`.
  - `ConnectionParamsCleanup`: `root-layout.tsx:69-74` keeps hash and state.
- **Guard redirects:** `<Navigate>` guards exist in `settings-layout.tsx:79`, `runtime-pools-shared.tsx:23`, `onboarding-redirect.tsx:64` and `file-view.tsx:172`.

**Dashboard URLs built outside `apps/ui`:**
- `automation-preflight.ts` builds `/schedules/:id`, `/workflows/:id` and `/settings/integrations/<provider>`. These reach Slack through `automation-preflight-alert.ts` and the UI through the `status.ts` `action_url`.
- `/tasks/<id>` is built in Slack, Linear, Comb, citations (persisted in `task_citations.resolved_url`) and page feedback.
- `mcp-oauth.ts` builds `/mcp-servers/<id>?oauth=` (persisted as `mcp_oauth_pending.finalRedirect`).
- No references in: `templates/skills`, `src/prompts`, `skills/`, `apps/templates-ui`, and the chat-sdk code.
- One reference in `plugin/commands/create-pr.md:34` (`/tasks/`). Three in `docs-site/content`.
- `/settings/api-keys`, `/settings/connections` and `/settings/secrets` appear only in `apps/ui` and `packages/ui-e2e`.
- Per-route counts are in the appendix.

**Unknowns:**
- Dashboard URLs stored in other DB content (task outputs, memory, agent-fs comments).
- External copies: old Slack, Linear and PR messages, and bookmarks.

### Q5. OAuth and integration flows per provider

**Three storage families:**
- **A, global `swarm_config` rows:** written by Integrations cards and `/setup` panes. Config load copies them into `process.env` (`src/http/core.ts:105-117`).
- **B, `oauth_apps` / `oauth_authorizations` / `oauth_pending`:** written by `/connections` presets, Linear and Jira tracker OAuth, and `/setup` Gmail and MS365.
- **C, MCP OAuth:** `oauth_apps` rows with `mcpServerId`. Its pending handling is separate (`mcp-oauth.ts`, `oauth-callback.ts:~352-360`), and a legacy `mcp_oauth_pending` table exists (migration 041). `oauth_pending.flow` is CHECKed to `('generic','tracker','mcp')` (`117_unified_oauth.sql:218-224`).

| Provider | UI flows | Storage | Runtime consumers |
|---|---|---|---|
| Slack | Integrations card, `/setup` (tokens); `/connections` preset | A `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`; preset in B | Socket app, slack tools; scripts |
| GitHub | Integrations card, `/setup` (PAT/App); preset | A `GITHUB_*`; preset in B | webhook handler, workers, script broker |
| GitLab | Integrations card, `/setup` | A `GITLAB_*` | webhook, workers |
| Bitbucket | Integrations card, `/setup` | A `BITBUCKET_*` | webhook, workers |
| Linear | Integrations card + `/setup` (A keys, then `/api/trackers/linear/authorize`); preset | A + B (provider-keyed row) + KV `integration:linear:bot-app-user-id` (`linear/oauth.ts:7,66`) | sync, webhook, tools |
| Jira | same as Linear, plus cloudId | A + B; cloudId and siteUrl in `oauth_apps.metadata WHERE provider='jira'` (`jira/metadata.ts:59-62`) | sync, webhook |
| Gmail | `/connections` preset `google`, `/setup` | B | scripts only |
| Microsoft 365 | preset `microsoft`, `/setup` | B | scripts only |
| Any MCP | `/mcp-servers` | C | workers, script MCP |

**How the overlapping flows behave:**
- **Boot seeding:** `initLinear` and `initJira` seed the provider-keyed `oauth_apps` row from env, with redirect `/api/trackers/<provider>/callback` (`linear/app.ts:44-45,60`). `/connections` apps use the static `/api/oauth/callback` (`script-connections.ts:2284`).
- **Create vs edit:** `/connections` creates a new row when the body has no `id` and updates that row when it has one (`:2305-2310`).
- **Which row trackers read:** tracker sync reads the oldest app for the same provider (derived, not run).
- **Preset hint:** the Linear and Jira presets carry a "reserved provider" hint (`oauth/presets.ts:154,172`).
- **Linear gate:** `isLinearEnabled()` needs `LINEAR_CLIENT_ID`. `LINEAR_DISABLE` or `LINEAR_ENABLED=false` turns it off (`linear/app.ts:11-14`).

### Q6. Channels, threads and use-case keys

**Inbound mapping:**
- **Slack tasks** (`slack/handlers.ts`, `thread-buffer.ts:331,335`, `assistant.ts:294,344`) set `slackChannelId`, `slackThreadTs`, and contextKey `task:slack:<ch>:<ts>`.
- **Chat SDK messages** (Telegram, Discord, Slack-via-adapter) go through `inbound.ts` `flushChatThread`. They set source `chat`, taskType `chat-inbound`, and contextKey `task:chat-sdk:<adapter>:<threadId>`. Follow-ups pass `parentTaskId: mostRecentTask?.id` (`inbound.ts:581`).

**Keys:**
- Neither inbound path passes a key. `createTaskExtended` derives `shared/<slack|telegram|discord>/<channel>/thread:<id>/` with `sessionSourceKey`.
- A child task inherits its parent's key, Slack columns, mention columns and contextKey (`db.ts:2551-2575,2695`).
- A backfill re-keys older roots (`session-source-backfill.ts:83`).
- Source groups are read-only (`source-key.ts:76`, enforced at `sessions.ts:783` and `assets.ts:343`).

**Storage:** `agent_tasks` (`slackChannelId`, `slackThreadTs`, `slackTriggerMessageTs`, `mentionMessageId`, `mentionChannelId`, `contextKey`, `key`), plus `slack_messages`, `chat_subscriptions` and `chat_relay_obligations`.

**Posting tools:**
- Slack: `slack-reply`, `slack-post`, `slack-start-thread`, `slack-update`, `slack-delete`, `slack-upload-file`, `slack-read`, `slack-leave-thread`.
- Chat SDK: `chat-reply`, `chat-post`, `chat-open-dm`, `chat-read-thread`.
- Channel registration: `register-chat-channel`.
- Final answers also relay automatically.

**Delivery targets:**
- Schedules have no channel or thread column or input. Only `defer-task` wake-ups reuse a chat contextKey.
- Workflow notify and HITL nodes post to a Slack channel through a target string. They have no thread.
- No code links an arbitrary asset key to a channel or thread.

### Q7. Sessions groups as a use-case home

**Group derivation:**
- The derivation is in `src/be/db/session-tree.ts` (`getSessionTree`, `groupCondition` at `:189-212`) and `src/assets/key.ts`. `src/http/sessions.ts:706-745` holds only the move and rename routes.
- A group is the task key without a trailing `task|thread|schedule|workflow:<id>/` leaf (`sessionGroupKey`). `SESSION_LEAF_KINDS` omits `page` (`key.ts:92`).
- A Slack, Telegram or Discord thread with 2 or more owned roots becomes its own group.
- `shared/` and `personal/<me>/` mean "No group".

**UI:**
- The route is `/sessions?view=<groupKey>`. It opens `GroupTab` with a title crumb, a count, search, filters (All, Unread, Running, Needs you) and a grid.
- The group list sends `scope=tree`, `groupKey`, `show` (default Mine) and `showSource` (default `comb,ui`) (`group-tab.tsx:131-142`, `sessions-v2.ts:243-252`, `session-query-keys.ts:79-80`).

**Visibility rules:**
- Tree scope drops roots with no requester.
- "Mine" excludes sources `workflow`, `schedule` and `system` (except `kapso-inbound`) unless the session is shared. It also requires `requestedByUserId = viewer` (`session-visibility.ts:47-48,65-78`).
- These filters apply only for user actors (`session-tree.ts:301-308`, `sessions.ts:1050-1062`).
- Triaged rows (Later, Done) leave the group list.

**Schedule runs in a group:**
- A run has source `schedule`, key `schedule.key`, and requester `schedule.createdBy`.
- By default it is hidden. It appears only under All, with `schedule` ticked, and with a non-null requester.
- A group whose only rows are hidden runs does not appear in the sidebar.

**How a session gets its key:**
- The UI composer sends the picked "Start in" key, or none.
- The contextual panel sends none, which gives `shared/task:<id>/` (or a source key).
- Children inherit the parent key, so the Lead's `send-task` does too (`send-task.ts:470`).

**Schedules:**
- `create`, `update` and `patch` accept `key`. The default is `shared/schedule:<id>/`, which groups as "No group".
- Changing a schedule's key appears not to rewrite the key of earlier runs. This comes from reading part of the code and was not run.
- No group header or group metadata exists beyond the title, the count and the tree counts.

### Q8. Home command-center data sources

**(a) Workflow runs:**
- **List endpoint:** only `GET /api/workflows/{id}/runs` (status filter, `limit` up to 100, default 50, `offset`, page envelope with `hasMore`/`nextOffset`, `workflows.ts:358`). The MCP tool `list-workflow-runs` also requires `workflowId`. No global list exists.
- **Summary columns:** they omit context (`workflow-runs.ts:73-74`).
- **Status indexes:** `(status)` and `(workflowId, status, startedAt DESC, id DESC)`.
- **Only global aggregate:** a completed-runs count for `/status` (`instance-signals.ts:22`).
- **UI:** `fetchAllWorkflowRuns` (`client.ts:~1712`) fetches each workflow's newest 50 runs one at a time and sorts on the client. Only the Workflows page uses it.

**(b) "Needs you" sources:**
- `useBlockingInbox`, `useBrokenInbox`, `useToReadInbox` and `useToStartInbox` are re-exported only, and nothing mounts them.
- The approvals list has no per-user filter (limit 100).
- Credential status is global across agents.
- `/api/session-tree` counts (`needsYou`, `unread`, `running`) are per viewer. An operator key with no picked user gets no read state.

**(c) "In progress" sources:** `/api/tasks` and `/api/sessions` filter by `key`, `keyPrefix`, `groupKey` and `status`. Neither groups its results. Only the session tree gives per-group running counts.

**(d) Home components:** Home mounts the setup checklist, `DashboardNudges`, `FleetBenchmarkCard`, and then the activity timeline (desktop) or `MobileNow` (mobile).

### Q9. Why `create-page` ignores the task key

**Current behavior:**
- The key comes only from an explicit `input.key`.
- The tool resolves the source task (`create-page.ts:207-216`), but only to get a trusted user for `personal/` authorization.
- With no key, `createPage` falls back to `shared/page:<id>/` (`db.ts:8700`, `key.ts:81-83`).
- The HTTP page routes also never read a task key (`pages.ts:631-634,876-877`).
- The migration-level default is `shared/` (`115_asset_namespace_keys.sql:11`).

**History:**
- Both lines come from `9fc74c7ef` "feat: add asset namespace keys (#963)". The per-resource default came from inner commit `1fc15441f` "fix: preserve asset namespace compatibility". That commit has an empty body.
- The PR #963 body says only "defaulting existing and omitted writes to `shared/`". No rationale for skipping inheritance is recorded.
- Commit `22a348f67` (#1204) only added `await`.

**Key inheritance in other creators:**

| Creator | Key source |
|---|---|
| Child tasks | parent key (`db.ts:2691-2694`) |
| `send-task` | `key ?? effectiveParentTask?.key` (`send-task.ts:470`) |
| Schedule runs | `schedule.key` |
| Workflow tasks | `workflow.key` |
| `create-schedule`, `create-workflow` | explicit `key` only |
| apps, scripts | always the default, no key param |
| `defer-task` | none passed |
| Root tasks with no key | `sessionSourceKey` (Slack/chat) or `shared/task:<id>/` (`db.ts:2883-2894`) |

**Tests:** only a DB-level test asserts the default (`asset-key-invariants.test.ts:86`).

**Pages model:** `key`, `agentId`, `slug` (unique together with `agentId`), plus content and theme fields. Pages have no task column. A task links to a page only through a `task_attachments` row with `kind='page'` and `page_id`.

### Q10. Checklist storage, prompt access, favorites

**Onboarding state:**
- **Storage:** one JSON row in `swarm_config`, scope global, key `onboarding_state`, so it is per swarm. `upsertSwarmConfig` rejects only reserved keys (`db.ts:6811-6813`), so `persistState` can write this row (`onboarding.ts:476-482`). The HTTP and MCP config surfaces refuse it.
- **Signals:** derived on every read (`src/http/onboarding.ts` `buildSignals`):
  - providers: from the harness credential rollups.
  - embeddings: from the provider config.
  - integrations: from automation setup states, plus the GitHub, GitLab and Bitbucket tokens.
  - agents: from the ready lead and worker counts.
  - firstTask: from `state.firstTaskId`.
  - files: from Comb.
- **Routes:**
  - `GET /api/onboarding`: a read-only transaction that persists only when the derived state changed (`onboarding.ts:728-755`).
  - `PUT /api/onboarding`: actions `view`, `complete`, `skip`, `fail`, `first_task`, `minimize`, `resume`, `dismiss`. Gated by `config.write.any`.
  - `POST /api/onboarding/memory`.
- **Open or closed:** decided on the UI side. `isOnboardingOpen` returns `!(completedAt || autoCompleted) && !dismissedAt` (`use-onboarding.ts:124-132`).
- **Completion:** `completedAt` is set when the first task's tree settles (`onboarding.ts:629-635`). `autoCompleted` is set at creation for an existing install (`:365-373`).

**Prompt access:**
- No template in `src/prompts` mentions onboarding or setup state.
- Templates register with `registerTemplate`. Callers pass a variables object to `resolveTemplateAsync`, which interpolates `{{var}}`. Heartbeat templates get `{{system_status}}` this way.

**Favorites:**
- `user_favorites` is touched by migrations 105, 116, 192 (the CHECK adds `agent-fs-path`) and 205 (data only).
- Scope is `user:<id>` or `operator` (`src/http/favorite-owner.ts`).
- The appendix lists where the item types are enumerated.

**Migration tail:** 278.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/commands/onboard/compose-generator.ts` | 85, 97-100, 126-127, 352-356 | Bundle env: proxy, Comb, link target, APP_URL, agent-fs public/app URL |
| `src/utils/constants.ts` | 100, 134-138, 285, 314-329, 346 | Live URL default, link base, browser reachability, Comb resolution, proxy flag |
| `apps/ui/src/pages/setup/steps/step-files.tsx` | 56-60, 174-176, 205-210, 261-262 | Auto-connect, success, email-taken, Comb-off copy |
| `src/be/seed/agent-fs-provision.ts` | 24, 193-199, 310 | Bootstrap key row, per-agent key mint and re-register rule |
| `src/be/db.ts` | 6811-6827 | `upsertSwarmConfig` reserved-key guard and secret encryption |
| agent-fs `packages/server/src/routes/orgs.ts` | 211 | Admin reset-key for a member |
| agent-fs `packages/server/src/routes/auth.ts` | 28-62, 73-97 | Register (domains, 409), `/auth/me`, self reset-key |
| agent-fs `packages/server/src/app.ts` | 37-39, 56-73, 99 | CORS, public share/site/invite routes, auth middleware, `/mcp` |
| `apps/ui/src/app/routes.tsx` | 150-164, 570 | REDIRECTS table, `RouteRedirect`, placement before catch-all |
| `apps/ui/src/components/layout/root-layout.tsx` | 69-74, 103 | Search/hash-preserving navigation prior art |
| `src/http/script-connections.ts` | 2284, 2305-2310 | OAuth app create/edit, static callback |
| `src/linear/app.ts` | 11-14, 44-60 | Linear gate, boot-seeded provider row |
| `src/assets/source-key.ts` | 76, 88 | Read-only source groups |
| `src/be/db/session-tree.ts` | 189-212, 301-308 | Group membership, viewer-only filters |
| `src/be/db/session-visibility.ts` | 47-78 | Mine rule |
| `apps/ui/src/components/sessions-v2/group-tab.tsx` | 131-142 | Group list query params |
| `src/tools/create-page.ts` | 207-216 | Source task used only for `personal/` auth |
| `src/be/db.ts` | 2551-2575, 2691-2695, 2883-2894, 8700 | Parent inheritance, root task key, page key default |
| `src/http/workflows.ts` | 358 | Per-workflow runs list |
| `src/be/onboarding.ts` | 365-373, 476-482, 629-635, 728-755 | Fresh state, persist, completion, read/update |
| `apps/ui/src/api/hooks/use-onboarding.ts` | 124-132 | UI-side open/closed rule |

## Open Questions

- Which install path the user used. The repo cannot answer this. Taras believes it was the base install skill, which by default leads to the Compose example (Comb off, live links).
- Whether the published `agent-swarm.dev/skill.md` matches `skills/agent-swarm/SKILL.md`.
- The cloud tenant's agent-fs defaults (no provisioning code in this repo).
- The production `server.cors.origins` on agent-fs and the hosting of `live.agent-fs.dev`.
- Dashboard URLs held in stored content (task outputs, memory, agent-fs comments) and in external messages.
- Whether tracker sync picks the boot-seeded or the `/connections` Linear/Jira app when both exist (derived from code, not run).
- Whether the UI ever sends a `key` when it creates a schedule.

## Appendix

- **Architecture notes:**
  - Asset `key` is the cross-entity grouping label. Sessions groups, source groups and favorites all hang off existing tables (`agent_tasks.key`, `user_favorites`).
  - Secrets live in `swarm_config` with per-scope encryption. One-time hashed codes (`connector_codes`) are the swarm's existing pattern for handing credentials across origins.
- **Historical context:** `thoughts/taras/brainstorms/2026-10-25-agent-fs-onboarding.md` and its plan dir `thoughts/taras/plans/2026-10-26-agent-fs-onboarding/` (PR #2442). That work added the bundle, the `/agentfs` proxy, the Files step and invite auto-connect.
- **Related:** `thoughts/taras/brainstorms/2026-11-03-post-onboarding.md`, the input for this research.

## Evidence (verbatim, workflow run wf_203eee0e-699)

Generated from the run's structured output. Paths are repo-relative to agent-swarm unless they start with `~/Documents/code/`. Em dashes in quotes were replaced with a hyphen.

### Q1-base-install

**Findings (38):**

- The landing-page prompt only points the agent at skill.md (the operator skill). (`~/Documents/code/agent-swarm-landing/src/lib/landing-v2-copy.ts:11-15`): `Read https://agent-swarm.dev/skill.md and help me install and operate Agent Swarm on our infra. Ask about my setup before running anything.`
- The same landing file also holds a curl install-script line, so a second landing path exists. (`~/Documents/code/agent-swarm-landing/src/lib/landing-v2-copy.ts:14-15`): `curl -fsSL https://agent-swarm.dev/install.sh | bash`
- The operator skill defaults to the Compose example reference deployment. It treats agent-fs as optional and calls the onboarding wizard an alternative. It never mentions install.sh. (`skills/agent-swarm/SKILL.md:13, 22, 25`): `**Optional: co-deploy agent-fs.** Enable shared files, attachments, and search when agents need durable file exchange.`
- install.sh runs onboard --yes with the full preset and bundles agent-fs and TEI unless --no-agent-fs is passed. (`install.sh:107-110, 284`): `a lead and 10 workers, plus agent-fs (files on local`
- Only the --yes path sets bundleAgentFs. The wizard default is false. (`src/commands/onboard.tsx:240`): `const bundleAgentFs = !noAgentFs;`
- The onboard bundle docs say the interactive wizard does not add agent-fs. (`docs-site/content/docs/(documentation)/guides/agent-fs-co-deployment.mdx:98`): `The interactive wizard does not add them.`
- Generated API env: agent-fs URL, proxy on, COMB_ENABLED true, link target dashboard. AGENT_FS_LIVE_URL is not set. (`src/commands/onboard/compose-generator.ts:97-100`): `lines.push(" - AGENT_FS_PROXY=true");`
- APP_URL is the hosted dashboard for the API. (`src/commands/onboard/compose-generator.ts:85, 255`): `const APP_URL = "https://app.agent-swarm.dev";`
- AGENT_FS_PUBLIC_URL goes to the agent-fs container only, via the API proxy path, not to the API. The agent-fs container also gets AGENT_FS_APP_URL. (`src/commands/onboard/compose-generator.ts:126-127`): `lines.push(' - AGENT_FS_APP_URL=${APP_URL}');`
- Workers get the agent-fs API URL, APP_URL and the dashboard link target. They get no COMB_ENABLED or AGENT_FS_PROXY. (`src/commands/onboard/compose-generator.ts:352-356`): `lines.push(" - AGENT_FS_LINK_TARGET=dashboard");`
- install.sh sets PUBLIC_MCP_BASE_URL (tunnel URL by default) on the API through an override. The /setup link targets the hosted dashboard. (`install.sh:29, 755, 885`): `dash_url="${DASHBOARD_BASE}/setup?apiUrl=$(urlencode "${PUBLIC_URL:-$local_url}")&apiKey="`
- An explicit COMB_ENABLED=true with AGENT_FS_API_URL set turns Comb on, so Comb is on on a base install. (`src/utils/constants.ts:306-315`): `if (explicit) return { enabled: true, explicit, reason: null };`
- The Comb endpoint the browser uses is `<PUBLIC_MCP_BASE_URL or MCP_BASE_URL>/agentfs`. live_url falls back to live.agent-fs.dev. (`src/comb/config.ts:35-42`): `isAgentFsProxyEnabled() && internalUrl ? '${getPublicMcpBaseUrl()}/agentfs' : internalUrl;`
- AGENT_FS_LIVE_URL defaults to the public host when unset. (`src/utils/constants.ts:100`): `export const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";`
- With link target dashboard and APP_URL set, the agent prompt link base is APP_URL. Attachment links also need Comb on. (`src/utils/constants.ts:135-138`): `if (surface === "prompt" || isCombEnabled()) return getAppUrl();`
- The agent prompt tells agents to give people `{{fileLinkBase}}/file/~/<org>/<drive>/<path>`. When the target is unset, the base is the literal ${AGENT_FS_LIVE_URL}. (`src/prompts/session-templates.ts:219`): `Give people the live app link '{{fileLinkBase}}/file/~/<org>/<drive>/<path>'.`
- The /setup Files step runs createAndConnect once with no click, using the step-1 email. (`apps/ui/src/pages/setup/steps/step-files.tsx:56-60`): `Runs Comb's own flow ('createAndConnect')`
- Files step in-progress copy. (`apps/ui/src/pages/setup/steps/step-files.tsx:271-272`): `title="Creating your files account…"`
- Files step success copy and button. (`apps/ui/src/pages/setup/steps/step-files.tsx:174-176`): `title="Your files account is ready."`
- Files step copy for the email-taken state, shown with a paste-key form. (`apps/ui/src/pages/setup/steps/step-files.tsx:205-210`): `? "This email already has an agent-fs account"`
- When Comb is off the Files step says: Files is off on this swarm. Skip this step. (`apps/ui/src/pages/setup/steps/step-files.tsx:261-262`): `Files is off on this swarm. Skip this step.`
- Step 1 of /setup asks for the email that the Files step later registers. (`apps/ui/src/pages/setup/steps/step-connect.tsx:233`): `description="Enter your email. The swarm attributes your tasks to this user."`
- Register returning HTTP 409 maps to the email-taken outcome. (`apps/ui/src/components/comb/connect-flow.ts:103`): `if (err instanceof AgentFsError && err.status === 409) return { kind: "email-taken" };`
- ConnectCard on email-taken switches to the Paste tab and shows this notice. The paste form has the label 'agent-fs key', placeholder 'af_...' and button 'Connect'. (`apps/ui/src/components/comb/connect-card.tsx:73-75`): `setNotice("This email already has an agent-fs account. Paste its key.");`
- ConnectCard header copy, tab names and footer. (`apps/ui/src/components/comb/connect-card.tsx:113-115, 131-132, 174`): `<TabsTrigger value="create">Create with my email</TabsTrigger>`
- A browser with no saved swarm connection is redirected to /setup, carrying the original path in state.from. (`apps/ui/src/components/layout/root-layout.tsx:102-103`): `return <Navigate to="/setup" replace state={{ from: '${pathname}${search}${hash}' }} />;`
- The Comb page shows ConnectCard in needs-connect or invalid-key state, with an 'Open in agent-fs' button beside it. That button uses live_url. (`apps/ui/src/pages/comb/page.tsx:78-85`): `case "needs-connect":`
- The agent-fs credential is stored in localStorage and namespaced by apiUrl and agent-fs endpoint. A second browser, or a changed API or tunnel URL, starts with no key. (`apps/ui/src/lib/agent-fs/credential-store.ts:1-5`): `namespaced by // the swarm API URL and the agent-fs URL`
- Account menu offers Disconnect and Show cursors. I saw no control that shows or copies the saved key. (`apps/ui/src/components/comb/account-menu.tsx:101-104, 112`): `This removes your agent-fs key from this browser.`
- The register proxy requires a swarm credential. A user token may register only its own email. (`src/http/agentfs-proxy.ts:130-165`): `You can create an agent-fs account only for your own email`
- Boot provisioning does not create accounts for users. It invites only emails that already have accounts, and 'no-account' is not retried. The person's account is created later in the browser. (`src/be/seed/agent-fs-provision.ts:129-132`): `"no-account" is not a failure to retry: agent-fs has no pending invites.`
- Docs: on a bundled install, agent-fs signed-url returns an app link that needs a login. (`docs-site/content/docs/(documentation)/guides/agent-fs-co-deployment.mdx:110`): `On a bundled install, 'agent-fs signed-url' returns a link that needs a login`
- Compose example (operator-skill path): the API gets only the agent-fs URL and register email. It has no COMB_ENABLED, AGENT_FS_PROXY, AGENT_FS_LINK_TARGET or AGENT_FS_PUBLIC_URL. APP_URL and PUBLIC_MCP_BASE_URL default to blank. agent-fs runs on MinIO. (`docker-compose.example.yml:203-225`): `- AGENT_FS_API_URL=http://agent-fs:7433`
- Under that Compose example config, a single-label host like agent-fs is judged not browser-reachable, so Comb is off. My inference from the code, not a run. (`src/utils/constants.ts:285`): `if (!host.includes(".")) return false;`
- Helm: agentFs.enabled defaults to false, and proxy defaults to false. The chart sets no COMB_ENABLED or AGENT_FS_LINK_TARGET (grep found none). (`charts/agent-swarm/values.yaml:300-301, 329`): `proxy: false`
- Helm sets AGENT_FS_PUBLIC_URL, from publicUrl or the agent-fs ingress, and AGENT_FS_PROXY only when configured. (`charts/agent-swarm/templates/api-statefulset.yaml:80-93`): `the in-cluster AGENT_FS_API_URL above never qualifies.`
- Railway template: proxy, COMB_ENABLED, link target dashboard and APP_URL are all preset on the api service. (`deploy/railway/README.md:55-58`): `| 'AGENT_FS_LINK_TARGET' | 'dashboard' | Opens agent-fs file links in the dashboard. Leave as is. |`
- DigitalOcean cloud-init, one-box and cloud-init.yaml all call install.sh, so they inherit the bundle. DigitalOcean passes --no-tunnel and --public-url. (`deploy/digitalocean/README.md:18`): `runs 'install.sh --no-tunnel --public-url https://<host> --bind 127.0.0.1'`

**Verifier:** 8/8 confirmed.

**Verifier: missed facts:**

- The skill-led (Compose example) path DOES start agent-fs and MinIO. docker-compose.example.yml:117 `agent-fs:`, :197-198 the api `depends_on: agent-fs: condition: service_healthy`. The API env there is only `AGENT_FS_API_URL=http://agent-fs:7433` (:203) and `APP_URL=${APP_URL:-}` (:222). There is no COMB_ENABLED, AGENT_FS_PROXY, AGENT_FS_LINK_TARGET, AGENT_FS_PUBLIC_URL or AGENT_FS_LIVE_URL in the file (grep returns nothing). .env.docker.example:72 sets `APP_URL=https://app.agent-swarm.dev`. Comb is off there by derivation, not by a flag: src/utils/constants.ts:314-329 returns reason "AGENT_FS_API_URL (...) is not reachable from a browser" for the single-label host `agent-fs` (isBrowserReachableUrl, constants.ts:285). With LINK_TARGET unset, resolveAgentFsLinkBase returns null (constants.ts:134), so agent links keep the old path.
- Helm defaults: charts/agent-swarm/values.yaml:301 `enabled: false` for agentFs, :312 `storageProvider: s3`, :329 `proxy: false`, :324 `publicUrl: ""`, :318 `appUrl: ""`. The comment at :319-323 says Files (Comb) is on by default only when a browser can reach agent-fs. So "Helm leaves Comb off" holds mainly because agentFs.enabled is false. Setting publicUrl, an agentFs ingress host, or proxy turns it on with no COMB_ENABLED. The Compose example uses MinIO S3 (docker-compose.example.yml:130-138). The onboard bundle uses AGENT_FS_STORAGE_PROVIDER=local (compose-generator.ts:118).
- The bundle's agent-fs container gets AGENT_FS_APP_URL=https://app.agent-swarm.dev (compose-generator.ts:127). It also gets AGENT_FS_PUBLIC_URL=${PUBLIC_MCP_BASE_URL:-http://localhost:<port>}/agentfs (:126). So `agent-fs signed-url` on a bundled install returns `<AGENT_FS_APP_URL>/file/~/...`, a login-gated Comb link (agent-fs-co-deployment.mdx:110). Public no-login links need `agent-fs share-create`.
- Link resolution: resolveAgentFsLinkBase (constants.ts:132-139) returns APP_URL for the prompt surface with no Comb check (constants.ts:129-130, :136). Task attachments need isCombEnabled() as well. Workers never get COMB_ENABLED (compose-generator.ts:353-355 sets only AGENT_FS_API_URL, APP_URL and LINK_TARGET). AGENT_FS_LIVE_URL is only the fallback target (constants.ts:138).
- Where the key lives: the owner's agent-fs key is stored only in this browser's localStorage, namespaced by swarm apiUrl plus agent-fs endpoint, and never sent to the swarm API (apps/ui/src/lib/agent-fs/credential-store.ts:1-6, credentialStorageKey at :31). The same-browser link works only if apiUrl and endpoint (the tunnel or public URL plus /agentfs) match the saved key. Nothing in account-menu.tsx shows the key. The only key text there is the disconnect warning at :112.
- The /setup redirect is conditional. OnboardingRedirect (apps/ui/src/components/onboarding/onboarding-redirect.tsx:57-64) sends only a user with `config.write.any` to /setup, and only while onboarding is open and not minimized. A second browser after setup finishes is not redirected. It lands on /file and sees the Comb ConnectCard, so "a second browser is sent to /setup first" holds only mid-onboarding.
- Exact email-taken copy in /setup Files step (step-files.tsx:204-211): title "This email already has an agent-fs account", description "Paste its key to connect this browser." PasteKeyForm gets notice={null}. The rejected-saved-key case uses the title "agent-fs no longer accepts your saved key" (:208). In the Comb ConnectCard (connect-card.tsx:73-75) a 409 switches to the "Paste a key" tab with the info notice "This email already has an agent-fs account. Paste its key." The form shows the label "agent-fs key", placeholder "af_..." and the button "Connect" (:204-221). The 409 maps to { kind: "email-taken" } at connect-flow.ts:103. The footer is "Your agent-fs key is stored in this browser only. Disconnect removes it." (connect-card.tsx:173-175).
- Other /setup Files strings: no email gives "Add your email in step 1 to create your files account." (step-files.tsx:197). A done step with no key in this browser re-runs createAndConnect (comment at :148, effect at :147-151). Comb off gives "Files is off on this swarm. Skip this step." (:262). A finished first run shows "Your files account is ready." with "Connected as <email>." (:175-176).
- Landing skill source: public/skill.md in the landing repo is a committed fallback. It lacks the "Default to every agent in the Compose example ... (1 lead and 11 workers)" sentence from skills/agent-swarm/SKILL.md:13. The build fetches upstream main (skill-source.ts:3-4,9-11). What the user's agent read depends on the landing build date.
- getting-started.mdx (docs-site/content/docs/(documentation)/getting-started.mdx:55-67) lists the interactive `bunx @desplega.ai/agent-swarm onboard` wizard first, then install.sh. So the wizard path (no agent-fs bundle) is a documented base path distinct from install.sh. install.sh prints a /setup link on DASHBOARD_BASE=https://app.agent-swarm.dev (install.sh:29, :885). The tunnel or public URL becomes the apiUrl and PUBLIC_MCP_BASE_URL (install.sh:117-118).

**Unknowns:**

- Which path the user actually used. The landing prompt leads to the Compose example, where Comb is off by default. install.sh gives the bundle with Comb on. Nothing in the repo records it.
- Whether skill.md on agent-swarm.dev differs from skills/agent-swarm/SKILL.md. The landing repo builds it from upstream with a committed fallback. I did not diff the two.
- cloud.agent-swarm.dev: no cloud provisioning code in this repo. Its agent-fs defaults are unknown.
- Whether the agent-fs CLI or worker image sets AGENT_FS_LIVE_URL. Grep found it nowhere in this repo. With no link target set, agents get the literal shell reference ${AGENT_FS_LIVE_URL}.
- The user's actual second-browser sequence and whether they knew their agent-fs key. My grep of apps/ui found no UI that reveals the saved key, but it was not exhaustive.
- Behaviour when a base install uses --no-tunnel with no public URL. Comb's endpoint is then http://localhost:3013/agentfs, opened from https://app.agent-swarm.dev. I did not test browser mixed-content handling.
- What agent-fs does with AGENT_FS_APP_URL beyond the docs statement. The agent-fs repo was out of scope.
- Behaviour after the tunnel URL changes on restart or reboot. I derived that the saved credential and connection keys would no longer match. I did not run it.

### Q2-agentfs-key-minting

**Findings (36):**

- agent-fs stores one key per user as an unsalted SHA-256 hash column on users; no api_keys table (`~/Documents/code/agent-fs/packages/core/src/db/schema.ts:11-17`): `apiKeyHash: text("api_key_hash").notNull(),`
- Key format af_ + 64 hex (32 random bytes); hash is sha256 hex (`~/Documents/code/agent-fs/packages/core/src/identity/users.ts:8-19`): `return 'af_${hex}';`
- Auth is lookup by hash; the resolved user carries only id and email, so no key scopes or expiry exist (`~/Documents/code/agent-fs/packages/server/src/middleware/auth.ts:28-42`): `const user = getUserByApiKey(db, apiKey);`
- resetApiKey overwrites users.api_key_hash in a transaction and logs an api_key_reset event (method self or admin); the old key stops working immediately (`~/Documents/code/agent-fs/packages/core/src/identity/users.ts:58-101`): `type: "api_key_reset",`
- Org admin can reset another member's key: needs requireOrgAdmin on the caller and requireOrgMember on the target; response is {apiKey,userId,email} (`~/Documents/code/agent-fs/packages/server/src/routes/orgs.ts:211-227`): `router.post("/:orgId/members/:userId/reset-key", (c) => {`
- OpenAPI states old key stops immediately on admin reset (`~/Documents/code/agent-fs/packages/core/src/openapi.ts:352-357`): `Org admins can rotate a member's API key on their behalf, e.g. to recover a locked-out user.`
- Tests: non-admin gets 403, outsider and non-member get 404, old key then returns 401 (`~/Documents/code/agent-fs/packages/server/src/__tests__/server.test.ts:976-1045`): `expect((await keyReq(member.apiKey, "/auth/me")).status).toBe(401);`
- Self reset route rotates the caller's own key; orgless fallback skips the audit event (`~/Documents/code/agent-fs/packages/server/src/routes/auth.ts:97-117`): `router.post("/reset-key", (c) => {`
- Register is public (no auth), returns apiKey once, 409 for an existing email, optional domain allowlist (`~/Documents/code/agent-fs/packages/server/src/routes/auth.ts:18-66`): `User with this email already exists`
- Org creator becomes org admin, so the swarm bootstrap user (creator of org swarm) can admin it; no separate bootstrap/admin key concept exists in agent-fs (`~/Documents/code/agent-fs/packages/core/src/identity/orgs.ts:29-32`): `// Add creator as admin`
- Docs confirm lost-key recovery goes through an org admin running member reset-key; the CLI wraps the same endpoint (`~/Documents/code/agent-fs/docs/api-reference.md:50`): `Recovering a lost key requires an org admin to run 'agent-fs member reset-key <email>' on the locked-out user's behalf.`
- Org member invite route requires org admin; an existing account is added at once, an unknown email gets a pending invite with a one-time token (no API key) (`~/Documents/code/agent-fs/packages/server/src/routes/orgs.ts:151-168`): `router.post("/:orgId/members/invite", async (c) => {`
- Org member listing returns only userId, email, role (no key data); requires org admin (`~/Documents/code/agent-fs/packages/core/src/identity/orgs.ts:83-97`): `): Array<{ userId: string; email: string; role: string }> {`
- Swarm stores the API-owned bootstrap key as a global secret config row API_AGENT_FS_API_KEY; the bootstrap user is registered with a swarm.local email (`src/be/seed/agent-fs-provision.ts:192-199`): `description: 'API-owned agent-fs bootstrap key for ${registerEmail}',`
- Per-agent key minting: POST /auth/register with the agent email (recovery email on 409), invite as editor with the bootstrap key, then store the key agent-scoped and secret (`src/be/seed/agent-fs-provision.ts:324-362`): `key: "AGENT_FS_API_KEY",`
- Agent email is configured AGENT_EMAIL or <agentId>@swarm.local (`src/be/seed/agent-fs-provision.ts:604-611`): `return '${agentId}@${domain}';`
- If an agent-scoped AGENT_FS_API_KEY row already exists it is reused and no new key is minted (`src/be/seed/agent-fs-provision.ts:303-322`): `if (existing?.value) {`
- Secret config values are AES-256-GCM encrypted at write; table swarm_config has value, isSecret, encrypted columns and scope limited to global/agent/repo (`src/be/db.ts:6825-6828`): `const storedValue = data.isSecret ? encryptSecret(data.value, getEncryptionKey()) : data.value;`
- swarm_config scope CHECK has no user scope (`src/be/migrations/001_initial.sql:248`): `scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),`
- Encryption helper is encryptSecret/decryptSecret (aes-256-gcm, iv||ciphertext||tag, base64) (`src/be/crypto/secrets-cipher.ts:3-12`): `* AES-256-GCM secrets cipher.`
- Encryption key source: SECRETS_ENCRYPTION_KEY env, then key file, then <dbdir>/.encryption-key, else auto-generated (`src/be/crypto/key-bootstrap.ts:9-13`): `1. 'SECRETS_ENCRYPTION_KEY' env var`
- The bootstrap key is an API-only config key, never handed out over HTTP or to scripts (`src/be/swarm-config-guard.ts:77-86`): `"API_AGENT_FS_API_KEY",`
- POST /api/fs/members/invite uses the API's bootstrap credentials and returns no keys (`src/http/fs.ts:127-129`): `No keys are returned; the invitee obtains their own key via agent-fs registration.`
- Invite permission: operator key and grant-all users may invite any email; other users only their own email, role derived from grant (`src/http/fs.ts:263-284`): `You can only join the shared drive with your own account email`
- inviteEmailToSharedOrg runs ensureAgentFsSharedProvisioning (bootstrap key) then POSTs /orgs/{id}/members/invite; status already_member/added/pending (`src/be/seed/agent-fs-provision.ts:250-274`): `headers: shared.authHeaders,`
- Swarm proxy gates POST /agentfs/auth/register on a swarm credential (user token limited to own email/alias), rate-limited 5/min/IP (`src/http/agentfs-proxy.ts:128-176`): `You can create an agent-fs account only for your own email`
- Proxy forwards only an af_ bearer from the request, never the swarm key; it injects no stored key (`src/http/agentfs-proxy.ts:260-270`): `authorization.replace(/^bearer\s+/i, "") !== getApiKey()`
- Proxy is off by default (`src/utils/constants.ts:345-347`): `return isEnvFlagEnabled("AGENT_FS_PROXY", false);`
- Dashboard keeps the human's agent-fs credential only in browser localStorage, never sent to the swarm API, namespaced by swarm API URL + agent-fs endpoint (`apps/ui/src/lib/agent-fs/credential-store.ts:1-4`): `It lives only in this browser's`
- Stored credential shape: apiKey, userId, email, displayName, connectedAt as JSON via localStorage.setItem (`apps/ui/src/lib/agent-fs/credential-store.ts:8-15, 106-120`): `storage?.setItem(key, JSON.stringify(credential));`
- Storage key derives from apiUrl and comb:agent-fs:<endpoint> (`apps/ui/src/lib/agent-fs/credential-store.ts:27-29`): `return deriveStorageKey(apiUrl, 'comb:agent-fs:${endpoint}');`
- Context reads the credential with useSyncExternalStore and builds AgentFsClient with the key; the key is stripped from the exposed credential object (`apps/ui/src/contexts/agent-fs-context.tsx:111-122`): `const { apiKey: _key, ...rest } = saved;`
- Browser mints its own user key by calling register through the proxy with the swarm credential, then connects; a 409 means email taken (`apps/ui/src/components/comb/connect-flow.ts:94-111`): `if (err instanceof AgentFsError && err.status === 409) return { kind: "email-taken" };`
- UI client sends Authorization: Bearer <agent-fs key> straight to the agent-fs endpoint (`apps/ui/src/lib/agent-fs/client.ts:89`): `if (opts.apiKey) headers.Authorization = 'Bearer ${opts.apiKey}';`
- The swarm never calls agent-fs reset-key (no match in src or apps/ui/src) (`src/be/seed/agent-fs-provision.ts:1-628`): `const API_KEY_CONFIG = "API_AGENT_FS_API_KEY";`
- Swarm users table has no agent-fs column (name, email, role, slack/linear/github ids, aliases, channel, timezone) (`src/be/migrations/031_user_registry.sql:2-17`): `emailAliases TEXT DEFAULT '[]',`

**Verifier:** 8/8 confirmed.

**Verifier: missed facts:**

- Blast radius: the key is per user, not per org. An org admin's reset-key in org X rotates the target's single hash, which invalidates that user's key everywhere (personal org and every other org). Swarm agent users in the shared org are included. Evidence: users.ts:76-80 updates users.api_key_hash by user id only.
- Swarm never calls reset-key. grep for reset-key/resetKey in swarm src and apps/ui/src finds only unrelated hits in apps/ui/src/hooks/use-url-search-state.ts:78/96. A rotation by an agent-fs admin would leave the stored per-agent AGENT_FS_API_KEY stale. The swarm only re-registers on a missing row (agent-fs-provision.ts:310 'if (existing?.value)'), so it would not detect a rotated key.
- POST /auth/register can be gated by env AGENT_FS_REGISTER_ALLOWED_DOMAINS (agent-fs config.ts:25-29, applied in routes/auth.ts:28-47, returns 403 REGISTRATION_DOMAIN_NOT_ALLOWED). Empty means open registration. The answer only says it is public. The register response is { apiKey, userId, orgId } (routes/auth.ts:53-57).
- Swarm bootstrap key storage: global scope swarm_config key API_AGENT_FS_API_KEY, isSecret true, description 'API-owned agent-fs bootstrap key for <email>' (agent-fs-provision.ts:24 and 193-199, 'const API_KEY_CONFIG = "API_AGENT_FS_API_KEY";'). Legacy shared key AGENT_FS_API_KEY at global scope is deleted at line 41 of the excerpt (deleteSwarmConfigByKey). Key lookup order: config row, then process.env.API_AGENT_FS_API_KEY, then process.env.AGENT_FS_API_KEY, then the legacy row.
- Encryption helper: upsertSwarmConfig in src/be/db.ts:6827 runs 'const storedValue = data.isSecret ? encryptSecret(data.value, getEncryptionKey()) : data.value;' and sets an encrypted flag. The cipher is aes-256-gcm in src/be/crypto/secrets-cipher.ts:18. Table swarm_config scope CHECK is ('global','agent','repo') in src/be/migrations/001_initial.sql:248, so there is no 'user' scope for a per-user agent-fs key.
- The bootstrap user becomes shared-org admin by creating it: agent-fs-provision.ts ~406 POSTs /orgs with name ORG_NAME, and agent-fs identity/orgs.ts:31 inserts the creator as role 'admin'. Per-agent users are invited as editor (agent-fs-provision.ts:349-351), so the bootstrap key (admin) is the one that could call the member reset-key endpoint for them.
- Invite behavior: agent-fs POST /orgs/:orgId/members/invite (routes/orgs.ts:151-168) is org-admin only. For an email with an account it adds directly; for one without it returns status pending with acceptUrl when appUrl is set. Swarm wrapper inviteEmailToSharedOrg (agent-fs-provision.ts:250-287) returns { orgId, invited, status, inviteId?, expiresAt?, acceptUrl? } and no key. Route src/http/fs.ts:125-129 doc says 'No keys are returned; the invitee obtains their own key via agent-fs registration.' It is gated by resolveInvite (fs.ts:316) which can answer 403.
- Per-agent mint flow detail: ensureAgentFsCredentialsForAgent (agent-fs-provision.ts:289-372) POSTs /auth/register with a derived agent email, retries once with recoveryAgentEmail(email) on 409 (lines 334-341), invites the agent as editor, then upserts the key at scope 'agent', scopeId agentId, key AGENT_FS_API_KEY, isSecret true. There is no list or rotate path on the swarm side.
- Dashboard browser credential: apps/ui/src/lib/agent-fs/credential-store.ts:1-3 says it lives only in localStorage 'and is never sent to the swarm API'. It is namespaced by swarm API URL plus agent-fs URL via credentialStorageKey -> deriveStorageKey(apiUrl, `comb:agent-fs:${endpoint}`) (line 24-26). The stored object is { apiKey, userId, email, displayName, connectedAt } (lines 8-14) with the key in plaintext JSON. Writers are in writeCredential (line 106); consumers are contexts/agent-fs-context.tsx and components/comb/connect-flow.ts. The cross-tab 'storage' listener treats key === null as localStorage.clear() (line ~152).
- The agent-fs CLI also exposes the admin reset as 'member reset-key <email>' (packages/cli/src/commands/member.ts:200-230), which resolves the email to a userId within the org first and persists the new key locally only when the admin targets themselves.
- agent-fs has an embedded/local mode ensureLocalUser (packages/core/src/identity/bootstrap.ts:10-25) that creates local@agent-fs.local and stores its key in local config auth.apiKey. This is the only 'bootstrap'-named identity code in agent-fs and it is a normal user, which supports the answer's claim that no distinct bootstrap key exists.

**Unknowns:**

- Whether agent-fs runs behind a gateway outside this repo that adds extra key or admin endpoints. Only the repo source was read.
- Whether any later swarm migration (above 031) added an agent-fs column to swarm users. The grep for agent-fs in migrations found only task-attachment tables.
- Whether a prod swarm has AGENT_FS_REGISTER_ALLOWED_DOMAINS set. That would affect minting keys for non-allowlisted emails, and it is deployment config.
- agent-fs's OpenAPI says /auth/register returns driveId, but the route handler returns only apiKey, userId and orgId. I did not check which one clients rely on.
- I did not read the Comb connect UI components (beyond connect-flow.ts and use-connect-flow-deps.ts) or the full /setup Files step. Other storage uses of the credential may exist.
- I did not check whether agent-swarm calls /orgs/{orgId}/members/{userId}/reset-key through the /agentfs proxy anywhere outside src and apps/ui/src (for example scripts or docs). No source reference was found there.

### Q3-agentfs-live-login

**Findings (50):**

- orgs table has only id, name, is_personal, created_at (no settings/metadata/URL column) (`~/Documents/code/agent-fs/packages/core/src/db/schema.ts:20-27`): `export const orgs = sqliteTable("orgs", {`
- getOrg exposes only id, name, isPersonal (`~/Documents/code/agent-fs/packages/core/src/identity/orgs.ts:80`): `return { id: org.id, name: org.name, isPersonal: org.isPersonal };`
- Org routes: only GET /:orgId on the org itself; PATCH routes exist only for members (no org update route) (`~/Documents/code/agent-fs/packages/server/src/routes/orgs.ts:117, 197`): `router.patch("/:orgId/members/:userId", async (c) => {`
- The only configurable URL for links is a server-wide appUrl from config or env, not per org (`~/Documents/code/agent-fs/packages/core/src/config.ts:135, 335`): `if (env.AGENT_FS_APP_URL) config.appUrl = env.AGENT_FS_APP_URL;`
- API key format is af_ plus 64 hex chars, one per user (`~/Documents/code/agent-fs/packages/core/src/identity/users.ts:14-19`): `return 'af_${hex}';`
- Only the SHA-256 hash of the single API key is stored on users; no expiry column (`~/Documents/code/agent-fs/packages/core/src/db/schema.ts:15`): `apiKeyHash: text("api_key_hash").notNull(),`
- Auth middleware: only /auth/register and /health are public; everything else needs a Bearer API key (`~/Documents/code/agent-fs/packages/server/src/middleware/auth.ts:6, 28`): `const PUBLIC_PATHS = ["/auth/register", "/health"];`
- POST /auth/register returns the key once; existing email returns 409 CONFLICT with no recovery path (`~/Documents/code/agent-fs/packages/server/src/routes/auth.ts:18, 61`): `{ error: "CONFLICT", message: "User with this email already exists" },`
- Registration is open or domain-restricted by env; it does not prove email ownership (`~/Documents/code/agent-fs/DEPLOYMENT.md:336`): `it does not prove the registrant owns the address.`
- Self reset-key rotates the caller's key (needs the current key) (`~/Documents/code/agent-fs/packages/server/src/routes/auth.ts:97`): `router.post("/reset-key", (c) => {`
- Org admin can mint a new key for another member; the key is returned in the response (`~/Documents/code/agent-fs/packages/server/src/routes/orgs.ts:211`): `router.post("/:orgId/members/:userId/reset-key", (c) => {`
- Share link TTL default 24h, max 7d; token is 32 random bytes, only hash stored (`~/Documents/code/agent-fs/packages/core/src/ops/share.ts:14, 16`): `export const SHARE_MAX_TTL_SECONDS = 604_800;`
- View-limited shares issue a 1h view grant passed as ?g= (`~/Documents/code/agent-fs/packages/core/src/ops/share.ts:24`): `export const SHARE_VIEW_GRANT_TTL_SECONDS = 3_600;`
- Presigned S3 URL from signed-url op defaults to 24h; backends without presign return a non-expiring auth-gated app link (`~/Documents/code/agent-fs/packages/core/src/ops/signed-url.ts:42`): `const expiresIn = params.expiresIn ?? 86400;`
- Org invite tokens last 7 days and the accept link carries the token in the fragment (`~/Documents/code/agent-fs/packages/core/src/identity/invites.ts:11, 85`): `return appUrl ? '${appUrl.replace(/\/+$/, "")}/invite#${token}' : undefined;`
- Invite accept POST needs an authenticated caller (authMiddleware), preview GET is public (`~/Documents/code/agent-fs/packages/server/src/routes/invites.ts:29`): `router.post("/:token/accept", (c) => {`
- Live SPA stores credentials (endpoint + apiKey) in localStorage under agent-fs-credentials (`~/Documents/code/agent-fs/live/src/stores/credentials.ts:8`): `const CREDENTIALS_KEY = "agent-fs-credentials"`
- Live SPA sends the stored key as a Bearer header on every request (`~/Documents/code/agent-fs/live/src/api/client.ts:145`): `Authorization: 'Bearer ${this.apiKey}',`
- Deep link with no active credential: AuthProvider redirects to /credentials keeping only the query string, dropping the pathname (`~/Documents/code/agent-fs/live/src/contexts/auth.tsx:48-52`): `navigate('/credentials${window.location.search}', { replace: true })`
- Deep link route /file/~/:orgId/:driveId/* sits inside the authenticated layout (`~/Documents/code/agent-fs/live/src/App.tsx:223`): `<Route path="/file/~/:orgId/:driveId/*" element={<FileRoute />} />`
- Credentials page prefills endpoint from ?apiUrl and key from ?apiKey in the query string (`~/Documents/code/agent-fs/live/src/pages/Credentials.tsx:34-35`): `const [apiKey, setApiKey] = useState(() => initialParams.get("apiKey") ?? "")`
- With both apiUrl and apiKey in the query, the page auto-submits a connect (`~/Documents/code/agent-fs/live/src/pages/Credentials.tsx:119-127`): `if (!initialParams.get("apiUrl") || !initialParams.get("apiKey")) return`
- After connect, the target is orgId/driveId from query, else /files; ?next is honoured only for invite paths (`~/Documents/code/agent-fs/live/src/pages/Credentials.tsx:44-53`): `return "/files"`
- Only /invite paths are allowed as ?next return targets (`~/Documents/code/agent-fs/live/src/lib/invites.ts:109`): `return /^\/invite(\/[A-Za-z0-9_-]+)?(\?[^#]*)?$/.test(next)`
- Accept-invite page removes the fragment token from the address bar and keeps it in sessionStorage (`~/Documents/code/agent-fs/live/src/pages/AcceptInvite.tsx:73`): `window.history.replaceState(window.history.state, "", '/invite${window.location.search}')`
- Live UI cannot use EventSource because it sends no Authorization header; SSE uses fetch with Bearer (`~/Documents/code/agent-fs/live/src/lib/sse.ts:3`): `cannot use 'EventSource': it sends no Authorization header`
- HTML viewer mints a 15 minute site share and caches it in localStorage liveui:site-tokens (`~/Documents/code/agent-fs/live/src/lib/html-view.ts:7, 15`): `export const VIEWER_SITE_TTL_SECONDS = 900`
- CORS: allowed origins come from config.server.cors.origins, default wildcard; no env var maps to it (`~/Documents/code/agent-fs/packages/server/src/app.ts:37`): `const origins = config.server?.cors?.origins ?? ["*"];`
- CORS config shape is origins list only; no credentials flag in the Hono cors options (`~/Documents/code/agent-fs/packages/core/src/config.ts:103-105`): `origins: string[];`
- Same-origin deployment is the documented alternative to CORS for the live UI (`~/Documents/code/agent-fs/DEPLOYMENT.md:85`): `To keep the UI and the API on one origin (no CORS)`
- Live UI deployed to live.agent-fs.dev via Vercel; nginx config notes that query strings can carry credentials (`~/Documents/code/agent-fs/live/nginx.conf:3`): `# Query strings can carry credentials, so the log line keeps the path only and drops the referrer.`
- connector_codes kinds are connector and invite; TTLs 10 min and 7 days (`src/be/connector-codes.ts:25-28`): `export const CONNECTOR_CODE_TTL_MS = 10 * 60 * 1000;`
- Code is 32 random bytes base64url; only sha256 stored (`src/be/connector-codes.ts:48`): `const code = randomBytes(32).toString("base64url");`
- One-time use: atomic UPDATE...RETURNING requires unused, unexpired and matching kind (`src/be/connector-codes.ts:84-86`): `WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND kind = ?`
- Token is minted only at exchange time via mintToken (`src/be/connector-codes.ts:116`): `const { plaintext } = await mintToken(row.user_id, row.label, actor, {`
- user_tokens (aswt_) has revokedAt but no expiry column (`src/be/migrations/067_users_first_class.sql:67-76`): `revokedAt TEXT`
- Invite exchange activates the invited user and mints a token; unknown/used/expired/other-kind all return 404 code_invalid (`src/http/users.ts:552-573`): `Unknown, expired, used and connector codes, and codes for users who are no longer invited, all return 404 code_invalid.`
- GET <api>/invite/<code> 302s to APP_URL/join with the code in the fragment, no-store and no-referrer (`src/http/users.ts:1259-1261`): `Location: '${appUrl}/join?swarm=${encodeURIComponent(apiUrl)}#code=${code}',`
- Invite link is built as <api>/invite/<code> (`src/http/users.ts:1236`): `const inviteUrl = '${apiUrl}/invite/${invited.code}';`
- Exchange endpoints are unauthenticated, 10 per minute per IP, 1 KB body cap, code shape pre-checked (`src/http/users.ts:841-857`): `const CONNECTOR_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;`
- /join requires user confirmation of the host, trades the code, and saves the token as a dashboard connection (`apps/ui/src/pages/join/join-flow.ts:137`): `connection = deps.addConnection({ name: host, apiUrl: params.swarm, apiKey: token });`
- Dashboard connections (with the token) persist in localStorage (`apps/ui/src/lib/config.ts:108`): `localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(multi));`
- Existing hand-off of a code to another origin: /connect validates return_to against an https allowlist, then appends swarm, code and client as query params (`apps/ui/src/pages/connect/connect-flow.ts:95-109`): `target.searchParams.set("code", code);`
- Only exact allowlisted origins (static connector origins, discovery connectUrl, dev localhost) pass as return_to (`apps/ui/src/pages/connect/connect-flow.ts:24-27, 47-69`): `return allowed.has(url.origin) ? url : null;`
- connector-codes route mints a code and returns a connectUrl on an https CONNECTOR_CONNECT_URL carrying swarm and code (`src/http/users.ts:444`): `Returns a 10-minute single-use code and the connector URL that carries it.`
- Swarm credentialed CORS allowlist defaults to *.agent-swarm.dev/.cloud and localhost UI ports; live.agent-fs.dev is not in it (`src/http/utils.ts:14-21`): `"https://*.agent-swarm.dev",`
- An unlisted browser Origin gets no Access-Control-Allow-Origin unless CORS_ALLOW_ANY_ORIGIN is set (`src/http/utils.ts:121-124`): `if (origin && !allowCredentials && !allowAnyOrigin) {`
- /agentfs proxy forwards only af_ bearers and never swarm credentials; register through it needs a swarm credential (`src/http/agentfs-proxy.ts:74-75`): `swarm credentials are never forwarded`
- Other short-lived credentials in swarm: aseph_ session tokens (ACP/runtime) and 1h HttpOnly page-session cookies from /api/pages/{id}/launch (`src/utils/page-session.ts:339`): `const PAGE_SESSION_TTL_SECONDS = 3600;`
- Swarm default live agent-fs host constant (`src/utils/constants.ts:100`): `export const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";`

**Verifier:** 5/8 confirmed.
- [partial] The only configurable URL for links is a server-wide appUrl from config or env, not per org. Correction: Server-wide and not per org is true, but appUrl is not the only configurable URL. A second one, server.publicUrl (env AGENT_FS_PUBLIC_URL), is the base for absolute share links. It is validated by normalizePublicUrl and used for apiUrl in ops/MCP. appUrl builds web-app links (file deep links, signed-url, invite accept URL /invite#<token>). There is also a client-side apiUrl in config. (`~/Documents/code/agent-fs/packages/core/src/config.ts:126, 135, 136, 332, 335`)
- [partial] Auth middleware: only /auth/register and /health are public; everything else needs a Bearer API key. Correction: The middleware's own PUBLIC_PATHS is exactly those two (matched with path === p || path.startsWith(p), auth.ts:12). But app.ts mounts three public, token-gated route groups before authMiddleware: /share (app.ts:58), /site (app.ts:64) and GET /invites/:token preview via publicInviteRoutes (app.ts:71). authMiddleware is applied at app.ts:73. So 'everything else needs a Bearer API key' is wrong for /share/*, /site/* and GET /invites/:token. POST /invites/:token/accept does require auth (inviteRoutes, invites.ts:29). (`~/Documents/code/agent-fs/packages/server/src/app.ts:56-73`)
- [partial] POST /auth/register returns the key once; existing email returns 409 CONFLICT with no recovery path. Correction: Register returns { apiKey, userId, orgId } (auth.ts:53-57) and the 409 CONFLICT is returned when the error message includes "UNIQUE" (auth.ts:59-62). 'No recovery path' is too strong: an authenticated self reset exists (POST /auth/reset-key, auth.ts:97) and an org admin can reset a member's key (POST /orgs/:orgId/members/:userId/reset-key, orgs.ts:211, requireOrgAdmin). There is no unauthenticated recovery (no email proof, magic link or similar). Register can also be closed by domain with 403 REGISTRATION_DOMAIN_NOT_ALLOWED when AGENT_FS_REGISTER_ALLOWED_DOMAINS is set (auth.ts:28-47, config.ts:26-29). (`~/Documents/code/agent-fs/packages/server/src/routes/auth.ts:18, 59-62, 97`)

**Verifier: missed facts:**

- Public pre-auth route groups: /share (app.ts:58 `app.route("/share", shareRoutes(db, s3, {`), /site (app.ts:64 `app.route("/site", siteRoutes(db, s3, {`) and GET /invites/:token preview (app.ts:71 `app.route("/invites", publicInviteRoutes(db, { requestsPerMinute: 120 }));`). The comment at app.ts:56 reads 'the token is the only credential'.
- Registration can be restricted by email domain: AGENT_FS_REGISTER_ALLOWED_DOMAINS, returning 403 REGISTRATION_DOMAIN_NOT_ALLOWED (auth.ts:28-47; config.ts:26-29 `export function getRegisterAllowedDomains(): string[] {`).
- Authenticated key reset: POST /auth/reset-key (auth.ts:97 `router.post("/reset-key", (c) => {`) and org-admin reset (orgs.ts:211). resetApiKey overwrites the single api_key_hash (users.ts:58-90), so any reset invalidates the previous key. It also writes an api_key_reset event with method self/admin.
- GET /auth/me returns userId, email, displayName, defaultOrgId, defaultDriveId for a valid key (auth.ts:73-95). This is the natural key-validation call for a UI.
- server.publicUrl / AGENT_FS_PUBLIC_URL is validated at server start by normalizePublicUrl (public-url.ts:14-33) and resolveApiUrl derives the API URL from X-Forwarded-* when unset (public-url.ts:48-60).
- CORS: app.ts:37-39 `const origins = config.server?.cors?.origins ?? ["*"];` then cors() for '*' or cors({ origin: origins }). /site skips it (isSitePath) and sets its own headers.
- MCP endpoint /mcp uses the same Bearer API key via authMiddleware (app.ts:99 `app.all("/mcp", async (c) => {`, reads c.get("user")).
- Token tables store only SHA-256 hashes with expiry: shares (schema.ts:242-262, expiresAt notNull, maxViews, revokedAt), shareViewGrants (schema.ts:285-295), orgInvites (schema.ts:300-320, tokenHash, expiresAt, acceptedAt, revokedAt).
- Invite accept URL is built from appUrl as `${appUrl}/invite#${token}` (core/src/identity/invites.ts:84-85), a fragment-based token. This is relevant prior art for passing a credential to the SPA.

**Unknowns:**

- The absence of OAuth, magic link, device code, JWT, cookie and token-exchange routes in agent-fs rests on a case-insensitive grep over packages/*/src and live/src. It matched only embedding test fixtures. A negative result has no line to quote.
- Where live.agent-fs.dev is actually hosted (Vercel per DEPLOYMENT.md) and the production server.cors.origins value on agent-fs-taras were not checked. Only the code default (wildcard) is known.
- Whether the live SPA reads anything from the URL fragment besides the invite token was not exhaustively checked. Only /invite and /credentials query handling were read.
- The live SPA FileBrowser behavior when a credential exists but lacks access to the deep-linked org or drive was not traced.
- The swarm UI Comb connect flow (apps/ui/src/lib/comb/connect-flow.ts is not at that path) was not re-read. The brainstorm Facts cover it.
- Whether the external agent-swarm.dev connector calls /api/connector/exchange server-side or from a browser was not determined from this repo.

### Q4-hardcoded-paths

**Findings (67):**

- REDIRECTS is a static table of 9 legacy top-level paths (dashboard, budgets, config, keys, integrations, repos, debug, metrics, script-runs). None of the 15 routes is a source. Targets include /settings/connections, /settings/api-keys, /settings/integrations and /scripts?tab=runs. (`apps/ui/src/app/routes.tsx:140`): `const REDIRECTS: Record<string, string> = {`
- Each table entry renders a replacing Navigate to a fixed string. The incoming location.search and hash are not read. (`apps/ui/src/app/routes.tsx:158`): `element: <Navigate to={to} replace />,`
- The only param-aware redirect is /integrations/:id to /settings/integrations/:id. (`apps/ui/src/app/routes.tsx:163`): `element: <RouteRedirect to={({ id }) => '/settings/integrations/${id}'} />,`
- RouteRedirect's callback receives only useParams() values, so query and hash cannot be carried by it. It was introduced in commit beaea897a (sidebar trim, v1.82.0, #534). (`apps/ui/src/app/route-redirect.tsx:8`): `to: (params: Record<string, string | undefined>) => string;`
- Inside /settings, the index route and settings/config both redirect to /settings/connections. (`apps/ui/src/app/routes.tsx:339`): `element: <Navigate to="/settings/connections" replace />,`
- Redirect routes carry an unlisted handle so the Cmd+K guard accepts them. routes.test.tsx checks palette metadata only. I found no UI unit test or ui-e2e spec that asserts a redirect target. (`apps/ui/src/app/routes.tsx:153`): `const REDIRECT = unlisted("redirect", { searchOptOut: "redirect" });`
- Positive-control test for the palette guard that uses a redirect-shaped route. (`apps/ui/src/app/routes.test.tsx:40`): `{ path: "old", handle: unlisted("redirect") },`
- Prior art that keeps the query on redirect: Comb appends the current search to the target, so /join can send teammates to /file?connect=auto. (`apps/ui/src/pages/comb/page.tsx:35`): `if (redirect) return <Navigate to={'${redirect}${search}'} replace />;`
- Prior art that keeps the full origin URL: the unconfigured-shell bounce to /setup stores path, search and hash in router state. (`apps/ui/src/components/layout/root-layout.tsx:103`): `return <Navigate to="/setup" replace state={{ from: '${pathname}${search}${hash}' }} />;`
- A non-admin hitting any AdminRoute settings page (secrets, api-keys, integrations, ...) is redirected to /settings/appearance. (`apps/ui/src/pages/settings/settings-layout.tsx:79`): `if (!isAdmin) return <Navigate to="/settings/appearance" replace />;`
- Prior art for a legacy deep link handled in a page rather than the router: old provider-keyed OAuth-app bookmarks are resolved, then rewritten with navigate(..., {replace:true}). (`apps/ui/src/pages/connections/oauth-apps/[id]/page.tsx:144`): `// Resolve by id first, then fall back to provider so old provider-keyed`
- The client-side rewrite for the legacy OAuth-app bookmark. (`apps/ui/src/pages/connections/oauth-apps/[id]/page.tsx:161`): `void navigate('/connections/oauth-apps/${encodeURIComponent(app.id)}', { replace: true });`
- Two other alias patterns exist. /sessions/:rootTaskId is deliberately both the new focus URL and the old link. apps/:id/p/:page is a second valid URL with no redirect. (`apps/ui/src/components/sessions-v2/use-sessions-url-state.ts:59`): `is the focused session, so old links keep working. Opening or focusing a`
- The no-redirect alias for app pages. (`apps/ui/src/app/routes.tsx:557`): `// renders the app's 'defaultPage') - both URLs stay valid, no redirect.`
- The whole route table is one createBrowserRouter(appRoutes) with no basename. REDIRECTS and the settings redirects live inside the RootLayout children, so redirects render within the shell. (`apps/ui/src/app/router.tsx:4`): `export const router = createBrowserRouter(appRoutes);`
- The server still emits the legacy /integrations path as a setup-milestone action_url. It would hit the REDIRECTS entry integrations -> /settings/integrations. (`src/http/status.ts:459`): `action_url: aggregateState === "unverified" ? "/agents" : "/integrations",`
- The docs show the same legacy /integrations action_url in an example payload. (`docs-site/content/docs/(documentation)/guides/personalization.mdx:66`): `"action_url": "/integrations",`
- Inbound query contract on /mcp-servers: ?new=1&name&url&transport prefill the create dialog. Producer: connections/page.tsx:966 (createHref). (`apps/ui/src/pages/mcp-servers/page.tsx:38`): `* /mcp-servers?new=1&name=<name>&url=<url>&transport=http (used by the`
- The MCP OAuth callback lands on /mcp-servers/:id with ?oauth=success|error&error&error_description. The detail page reads and clears them. A redirect that dropped the query would lose them. The server default return URL is built at mcp-oauth.ts:54, and the UI sends origin+pathname at mcp-oauth-panel.tsx:238. (`apps/ui/src/pages/mcp-servers/[id]/page.tsx:74`): `const oauthParam = searchParams.get("oauth");`
- The server builds the default OAuth return URL on /mcp-servers/:id. The caller-supplied redirect is stored in mcp_oauth_pending.finalRedirect (mcp-oauth.ts:642). (`src/http/mcp-oauth.ts:54`): `return '${dashboardBase()}/mcp-servers/${mcpServerId}?oauth=success';`
- Links out of /setup append ?fromSetup=1 to /connections, /settings/integrations(/memory) and /settings/connections (step-integrations.tsx:176, step-ai.tsx:246, step-memory.tsx:806, business-panes.tsx:107, setup/page.tsx:700). A redirect on those paths would sit before the marker is read. (`apps/ui/src/components/onboarding/onboarding-redirect.tsx:30`): `return '${path}${path.includes("?") ? "&" : "?"}${FROM_SETUP_PARAM}=1';`
- The server composes ?param=KEY fix URLs on /schedules/:id and /workflows/:id. The schedule page reads param. The workflow page reads it at workflows/[id]/page.tsx:125. (`src/be/automation-preflight.ts:184`): `url: '${baseUrl}?param=${encodeURIComponent(key)}',`
- Reader of the ?param= query on the schedule detail page. (`apps/ui/src/pages/schedules/[id]/page.tsx:144`): `const focusedParam = searchParams.get("param") ?? undefined;`
- /tasks query contracts used by links and the palette: ?status=pending|in_progress|completed|failed (stats-bar.tsx:93-114, mobile-now.tsx:110,138) and ?new=true[&agentId=] (command-menu.tsx:633,641, health-badge.tsx:256). (`apps/ui/src/components/shared/stats-bar.tsx:93`): `to="/tasks?status=pending"`
- getAppUrl() is the single dashboard-origin helper. Its callers (16 files) build paths on it. Of the 15 routes, only the callers in findings below build /tasks, /schedules, /workflows, /settings/integrations and /mcp-servers. The others build /script-runs, /approval-requests, /pages, /usage/metrics and /file/~. (`src/utils/constants.ts:45`): `export function getAppUrl(fallback = DEFAULT_APP_URL): string {`
- Automation preflight builds the /schedules/:id and /workflows/:id dashboard paths (route: /schedules, /workflows). They become fixUrl. (`src/be/automation-preflight.ts:134`): `return input.kind === "schedule" ? '/schedules/${input.id}' : '/workflows/${input.id}';`
- Seven literal /settings/integrations/<provider> paths (lines 138-144: slack, github, linear, jira, agentmail, gsc, agentfs). (`src/be/automation-preflight.ts:138`): `slack: "/settings/integrations/slack",`
- The fixUrl is posted to Slack as an absolute URL. These messages stay in Slack history. (`src/automation-preflight-alert.ts:30`): `'Fix setup: ${getAppUrl()}${preflight.fixUrl}',`
- status.ts calls automationIntegrationFixUrl at 12 sites (lines 510-623) as the setup milestone action_url. The UI renders it as a Link (health-badge.tsx:224). Also /tasks and /tasks?new=true at status.ts:673,681. (`src/http/status.ts:510`): `action_url: automationIntegrationFixUrl("slack"),`
- The first-task milestone emits /tasks?new=true to the UI. (`src/http/status.ts:681`): `action_url: "/tasks?new=true",`
- The Slack task URL builder is the central /tasks/<id> source. Callers: slack/render-v2.ts (1096,1107,1209,1272,1315), responses.ts:71, actions.ts:147, work-objects.ts:52, tools/slack-reply.ts:156,171, tools/slack-post.ts:110. DEPLOYMENT.md:718 documents the same url for the Slack work-object pane. (`src/slack/blocks.ts:37`): `return '${getAppUrl()}/tasks/${taskId}';`
- Linear AgentSession externalUrls point at /tasks/<id> (second site at line 1001). The Linear outbound comment does the same. (`src/linear/sync.ts:714`): `{ label: "View in Agent Swarm", url: '${dashboardUrl}/tasks/${task.id}' },`
- A Linear comment embeds the /tasks/<id> URL. It reads SWARM_DASHBOARD_URL or APP_URL directly, not getAppUrl. (`src/linear/outbound.ts:123`): `const where = dashboardUrl ? '${dashboardUrl}/tasks/${taskId}' : 'swarm task \'${taskId}\'';`
- The Comb review batch writes a /tasks/<id> link into agent-fs comments as the sent marker. (`src/comb/review-batch.ts:403`): `return '${sentMarker(taskId)} Sent to the swarm: ${getAppUrl()}/tasks/${taskId}';`
- The citation resolver builds /tasks/<ref> and persists it (INSERT INTO task_citations ... resolved_url, passed at line 136). (`src/be/task-citations.ts:56`): `if (kind === "task") return citationHttpUrl('${getAppUrl()}/tasks/${encodeURIComponent(ref)}');`
- The page-feedback response returns a /tasks/<id> URL to the caller. scripts/e2e knowledge-pages.ts:510 asserts it. (`src/http/pages.ts:1009`): `task_url: '${getAppBaseUrl()}/tasks/${task.id}',`
- The server also parses dashboard task URLs found in memory content. A /tasks path change would affect this regex. (`src/be/memory/link-resolver.ts:48`): `const AGENT_UI_TASK_RE = /(?:app\.[^/]+|localhost:\d+)\/tasks\/([a-f0-9-]+)/g;`
- The only server-side /connections string is the external connector site (mcp.agent-swarm.dev), not the dashboard route. The same URL is at apps/ui/src/pages/connect/connect-flow.ts:21 and in 15 lines of connect-flow.test.ts. (`src/http/users.ts:805`): `const DEFAULT_CONNECTOR_CONNECT_URL = "https://mcp.agent-swarm.dev/connections";`
- src/prompts names no dashboard path from the 15 routes. The only dashboard link rule is to use the APP_URL env var for pages. Telegram/Discord/Slack-via-chat-sdk code (src/integrations/chat-sdk) has no getAppUrl, APP_URL or /tasks/ matches. (`src/prompts/session-templates.ts:218`): `Link env: \'APP_URL\' for pages, \'MCP_BASE_URL\' for the API, \'AGENT_FS_LIVE_URL\' for files. Report missing variables.`
- The only plugin/commands hit among the 15 routes is /tasks/<taskId>, in the PR-provenance instruction. The generated copy plugin/pi-skills/create-pr/SKILL.md:34 repeats it. These links land in PR bodies and are checked by src/utils/pr-body-leaks.ts:85 (app.agent-swarm.dev/...). (`plugin/commands/create-pr.md:34`): `Link the task ('$APP_URL/tasks/<taskId>')`
- templates/skills has zero hits for the 15 routes. Its only dashboard-link rule is for pages (/pages/:id), not for the 15 routes. (`templates/skills/pages/content.md:603`): `| 'app_url' | '${APP_URL}/pages/:id' | SPA route.`
- docs-site/content has 3 path references to the 15 routes: /connections (here), /memory (memory.mdx:153) and /memory (releases/2026-10-05.mdx:44). (`docs-site/content/docs/(documentation)/guides/script-connections.mdx:48`): `and the dashboard's '/connections' page`
- /memory docs reference (1 of 2). (`docs-site/content/docs/(documentation)/architecture/memory.mdx:153`): `on the dashboard's '/memory' page`
- Docs refer to Settings pages by name rather than path in many places, e.g. Settings → Integrations (chat-sdk.mdx:30, serply.mdx:10), Settings → MCP Servers (salesforce.mdx:120), Settings → Provider keys (ui/index.mdx:26). A renamed page would leave these prose paths stale. (`docs-site/content/docs/(documentation)/integrations/chat-sdk.mdx:30`): `**Settings → Integrations → Chat SDK**`
- The public operator skill refers to a Settings page by name: Settings → Connections. (`skills/agent-swarm/SKILL.md:37`): `Configure connections through the lead or Settings → Connections.`
- Root docs: LOCAL_TESTING.md:483 opens http://localhost:5274/tasks, and seed-people.ts prints the People URL. (`scripts/seed-people.ts:459`): `console.log(' People page: http://localhost:5274/people');`
- A same-string collision: the template registry site uses skills, schedules and workflows as category paths. templates.agent-swarm.dev/schedules/<name> appears in docs (dora-metrics.mdx:84, code-health-reports.mdx:82) and is not the dashboard route. (`templates/schema.ts:63`): `export const ASSET_CATEGORIES: AgentAssetCategory[] = ["skills", "schedules", "workflows"];`
- apps/templates-ui has no reference to any of the 15 dashboard routes. It is a separate site with its own [category]/[name] routes. (`apps/templates-ui/src/app/layout.tsx:20`): `const siteUrl = "https://templates.agent-swarm.dev";`
- Persisted legacy output holds dashboard /schedules/<id> links. Slack still has to parse them, and the test fixture uses an app.agent-swarm.dev/schedules URL. (`src/slack/task-output.ts:6`): `* 'Deferred until {date} {time} ([shortId](url)) -> {note excerpt}'`
- Fixture for the legacy deferral output with a dashboard /schedules/ link. (`src/tests/slack-render-v2.test.ts:2497`): `"Deferred until today 17:30:19 UTC ([715bf847](https://app.agent-swarm.dev/schedules/715bf847-fe3e-40e9-9fef-3297a62d9afd)) -> checking the new defer card";`
- COUNT /connections (+/:id, /oauth-apps/:id): apps/ui 15 non-test refs in 8 files (oauth-apps/[id]/page.tsx 4, connections/page.tsx 3, connections/[id]/page.tsx 4, business-panes.tsx 1, page-context.ts:49, app-sidebar.tsx:179, breadcrumbs.tsx:91) plus 1 comment and 1 external URL. UI tests 17 (15 external URLs). Server dashboard refs 0. docs 1. templates/plugin/skills/prompts 0. ui-e2e 7 (routes.ts:23,70,72; connect.spec.ts:80 pathname assert). Other tests 5, all external connector URL or a DB fixture. (`apps/ui/src/app/routes.tsx:270`): `path: "connections",`
- COUNT /settings/integrations (bare): apps/ui 7 non-test refs (integrations/[id]/page.tsx:150,365; routes.tsx:145; settings-layout.tsx:52; step-integrations.tsx:176; step-ai.tsx:246; app-sidebar.tsx:203) plus 2 comments. UI tests 9. ui-e2e 1 (routes.ts:33). Server 0 bare, but legacy /integrations at status.ts:459. docs 0 path strings. (`apps/ui/src/app/routes.tsx:379`): `path: "integrations",`
- COUNT /settings/integrations/:id: apps/ui 3 non-test (routes.tsx:163, step-memory.tsx:806 '/settings/integrations/memory', integration-card.tsx:103). Server 7 literal lines (automation-preflight.ts:138-144) plus 12 status.ts action_url call sites. Tests: src/be/automation-preflight.test.ts 14, src/tests/status.test.ts 4, UI tests in the 9 above. ui-e2e 1 (routes.ts:61). (`apps/ui/src/app/routes.tsx:392`): `{ path: "integrations/:id", element: admin(<IntegrationDetailPage />) },`
- COUNT /mcp-servers: apps/ui 8 non-test refs in 7 files (mcp-servers/page.tsx:85,321; [id]/page.tsx:118,130; connections/page.tsx:966; app-sidebar.tsx:178; providers.tsx:339; page-context.ts:46) plus 1 comment and 1 API path (client.ts:3061). UI tests 1. Server 1 (mcp-oauth.ts:54). docs 0 paths. Other tests 0: every non-UI hit is /api/agents/:id/mcp-servers. ui-e2e 2 (routes.ts:38,56). (`apps/ui/src/app/routes.tsx:498`): `path: "mcp-servers",`
- COUNT /settings/api-keys: apps/ui 5 in 5 files (subscriptions-card.tsx:220, task-details-rail.tsx:753, settings-layout.tsx:51, routes.tsx:144 keys redirect target, app-sidebar.tsx:202). Server, docs, templates, plugin, skills: 0. ui-e2e 1 (routes.ts:32). Prose 'Settings → Provider keys' in ui/index.mdx:26. (`apps/ui/src/app/routes.tsx:368`): `path: "api-keys",`
- COUNT /settings/connections: apps/ui 9 in 7 files (setup/page.tsx:700, unified-home.tsx:97, connect/page.tsx:515, swarm-switcher.tsx:135, settings-layout.tsx:47, app-sidebar.tsx:199, routes.tsx:143,339,344). Server, docs, templates, plugin, skills: 0. ui-e2e 1 (routes.ts:29). It is the target of /config, /settings, /settings/config redirects. (`apps/ui/src/app/routes.tsx:348`): `path: "connections",`
- COUNT /settings/secrets: apps/ui 2 (settings-layout.tsx:50, app-sidebar.tsx:201). Everything else 0 except ui-e2e routes.ts:31. (`apps/ui/src/app/routes.tsx:363`): `path: "secrets",`
- COUNT /schedules: apps/ui 10 non-test in 8 files (schedules/page.tsx:614,680; [id]/page.tsx:188,560; workflows/[id]/page.tsx:1334; lineage-view.tsx:304; task-source-line.tsx:218; providers.tsx:241; app-sidebar.tsx:170; page-context.ts:37). UI tests 3. Server 1 (automation-preflight.ts:134). Other tests 14 (automation-preflight.test.ts 4, status.test.ts 2, automation-preflight-alert.test.ts 2, slack-render-v2.test.ts 2, slack-task-output.test.ts 1, scripts/e2e slack-defer-eta.ts 2 and slack-defer-wake.ts 1, the last three assert the link is absent). ui-e2e 2 (routes.ts:21,52). docs 0 (the 2 templates.agent-swarm.dev links are another site). (`apps/ui/src/app/routes.tsx:251`): `path: "schedules",`
- COUNT /tasks: apps/ui 59 non-test refs in 41 files (plus 5 comments), UI tests 30. Server 10 line sites (blocks.ts:37, linear/sync.ts:714,1001, linear/outbound.ts:123, review-batch.ts:403, task-citations.ts:56, pages.ts:1009, status.ts:673,681, link-resolver.ts:48). plugin 1 (+1 generated copy). DEPLOYMENT.md 2 (718,729). LOCAL_TESTING.md:483. Other tests 26 (src/tests 22: slack-blocks 7, slack-render-v2 5, slack-caption-block 2, slack-tool-blocks 1, comb-review-batch 2, linear-outbound-sync 1, task-citations 1, pr-body-leaks 2, pages-feedback 1; scripts/e2e 4). ui-e2e 16 (routes.ts:14,48; tasks.spec 4, create-task.spec 3, codex-logs.spec 4, organization-name.spec 3). (`apps/ui/src/app/routes.tsx:224`): `path: "tasks",`
- COUNT /people: apps/ui 10 non-test refs in 7 files (people/page.tsx:218,314; [id]/page.tsx:661,680; merge-modal.tsx:95; usage-content.tsx:154; app-sidebar.tsx:163,631; page-context.ts:48; tasks-table.tsx:301) plus 2 comments. UI tests 2. Server 0 (scripts/seed-people.ts:459 prints a URL). docs/templates/plugin/skills 0. ui-e2e 6 (routes.ts:40,41,58; invites.spec.ts:17,99,107). (`apps/ui/src/app/routes.tsx:514`): `path: "people",`
- COUNT /skills: apps/ui 8 non-test refs in 7 files (skills/page.tsx:213; [id]/page.tsx:150,177; adoption-view.tsx:185,213; app-sidebar.tsx:177; providers.tsx:318; page-context.ts:43) plus 1 comment and 1 API path (client.ts:2839). UI tests 1. Server 0. Every /skills/ hit in templates, scripts, src/tests and docs is a filesystem or API path. ui-e2e 2 (routes.ts:39,55). (`apps/ui/src/app/routes.tsx:507`): `path: "skills",`
- COUNT /memory: apps/ui 1 real ref (app-sidebar.tsx:180) plus 4 comments in 4 other files. Server 0 (browser-sdk.ts:90-93 are /api/memory shorthand). docs 2 (memory.mdx:153, releases/2026-10-05.mdx:44). ui-e2e 1 (routes.ts:42). Prose: talks/2026-09-21-ai-builders-memory/index.html:416, scripts/seed.ts:391. (`apps/ui/src/app/routes.tsx:540`): `path: "memory",`
- COUNT /templates: apps/ui 13 non-test refs in 7 files (templates/page.tsx:96; [id]/page.tsx:146,159,263,283,295; history/[version]/page.tsx:83,97,101; page-context.ts:44,45; app-sidebar.tsx:181; template-recommendation-card.tsx:56) plus 4 comments. UI tests 2. Server, docs, templates, plugin, skills: 0 (the src hits are the registry host and filesystem paths). ui-e2e 2 (routes.ts:37,59). (`apps/ui/src/app/routes.tsx:488`): `path: "templates",`
- COUNT /workflows: apps/ui 15 non-test refs in 12 files (schedules/[id]/page.tsx:424,512; workflow-runs/[id]:278,291; workflows/page.tsx:219,489; workflows/[id]:240,467,916; providers.tsx:215; step-card.tsx:918; action-node.tsx:151; app-sidebar.tsx:168; breadcrumbs.tsx:89; page-context.ts:35) plus 3 comments. UI tests 7. Server 1 (automation-preflight.ts:134). Other tests 3 (automation-preflight.test.ts 2, status.test.ts 1). docs/templates/plugin/skills 0. ui-e2e 2 (routes.ts:22,51). (`apps/ui/src/app/routes.tsx:260`): `path: "workflows",`
- COUNT /scripts: apps/ui 11 non-test refs in 10 files (scripts/page.tsx:127; [id]/page.tsx:108; playground-panel.tsx:348; schedules/[id]/page.tsx:519; routes.tsx:150 and breadcrumbs.tsx:90 (/scripts?tab=runs); script-runs/[id]/page.tsx:152,200,201; app-sidebar.tsx:169; page-context.ts:38) plus 4 comments. UI tests 1. Server, docs, templates, plugin, skills: 0 (all /scripts/ hits are filesystem paths). ui-e2e 2 (routes.ts:24,53). (`apps/ui/src/app/routes.tsx:285`): `path: "scripts",`
- ui-e2e route list holds canonical paths only. The matching legacy-redirect specs are absent; the rg for redirect/legacy/'/integrations'/'/keys' in packages/ui-e2e/specs found only /api/config calls and the connector OAuth return. (`packages/ui-e2e/specs/routes.ts:11`): `export const routes: Route[] = [`
- API shorthand excluded from counts: the pages browser SDK uses '/schedules', '/memory', '/tasks' relative to the API base, not dashboard paths. (`src/pages/browser-sdk.ts:105`): `list: () => call('GET', '/schedules'),`

**Verifier:** 7/8 confirmed.
- [partial] Redirect routes carry an unlisted handle so the Cmd+K guard accepts them. routes.test.tsx checks palette metadata only. No UI unit test or ui-e2e spec asserts a redirect target.. Correction: Line 153 is correct and the table-derived routes (routes.tsx:159) and the two settings redirects (:340, :345) use it. But the `integrations/:id` RouteRedirect route (routes.tsx:161-164) has no `handle`. The guard does not need one because `missingNavMetadata` filters to `route.staticPath !== null` (apps/ui/src/lib/command-palette/route-meta.ts:138) and a `:id` pattern has staticPath null. routes.test.tsx has five tests, all palette or search-provider metadata. No test imports REDIRECTS or RouteRedirect (grep). ui-e2e specs have no in-app redirect-target assertion; packages/ui-e2e/specs/connect.spec.ts:80 `expect(landed.pathname).toBe("/connections");` asserts the landing path on the external origin https://mcp.agent-swarm.dev (line 76), not a router redirect. (`apps/ui/src/app/routes.tsx:153`)

**Verifier: missed facts:**

- The summary says Comb and the /setup bounce are the only places that carry search or hash. A third one exists: ConnectionParamsCleanup in apps/ui/src/components/layout/root-layout.tsx:69-74 runs `void navigate({ pathname: location.pathname, search: stripped, hash: location.hash }, { replace: true, state: location.state })`. It keeps hash, state and the filtered search while it strips credential params. It is a navigate effect, not a Navigate element. The /setup bounce itself is root-layout.tsx:103: `<Navigate to="/setup" replace state={{ from: `${pathname}${search}${hash}` }} />`, consumed at apps/ui/src/pages/setup/page.tsx:493 `if (data === null) return <Navigate to={from} replace />;`.
- Other guard-style Navigate prior art that the answer left out (none carry search or hash): apps/ui/src/pages/settings/settings-layout.tsx:79 `if (!isAdmin) return <Navigate to="/settings/appearance" replace />;`, apps/ui/src/pages/settings/runtime-pools-shared.tsx:23 `if (!gate.open) return <Navigate to="/settings" replace />;`, apps/ui/src/components/onboarding/onboarding-redirect.tsx:64 `return <Navigate to="/setup" replace />;`, apps/ui/src/pages/setup/page.tsx:260 `if (pendingConnection) return <Navigate to="/" replace />;`, apps/ui/src/components/comb/file-view.tsx:172 `return <Navigate to={combPath(folder)} replace />;`. Of these, settings-layout.tsx:79 and runtime-pools-shared.tsx:23 point at /settings paths.
- Placement and ordering: `...redirectRoutes` is spread at apps/ui/src/app/routes.tsx:570, just before the catch-all `{ path: "*", element: <NotFoundPage /> }`, inside the root layout children. The `script-runs` redirect (routes.tsx:150) coexists with a real `{ path: "script-runs/:id", element: <ScriptRunDetailPage /> }` at routes.tsx:293, so /script-runs/:id is not redirected.
- The `integrations/:id` redirect has no search or hash preservation, so `/integrations/abc?x=1#y` loses `?x=1#y`. This follows from route-redirect.tsx:17-18.
- The original redirect table was first added in a PR-branch commit before the squash: `fa772820e [phase 6] router: backward-compat redirect table (no 404s)` (visible via `git log --all -S RouteRedirect`). The squash commit is beaea897a.
- packages/ui-e2e/specs/routes.ts lists /connections (:23), /settings/connections (:29), /settings/secrets (:31), /settings/api-keys (:32), /settings/integrations (:33), /mcp-servers (:38) and /settings/integrations/:id (:61) as walked routes, and none of the legacy redirect sources (/keys, /config, /integrations, /script-runs list) appears there. Only `/script-runs/:id` appears, at :77 with `skip: "no seed entity yet"`.

**Unknowns:**

- Counts come from a PCRE match on quoted/backticked/host-prefixed '/route' strings. Hand-built forms that this misses, such as string concatenation or a path assembled from segments, were only spot-checked, not enumerated.
- UI counts were classified by reading each line. Each line is counted once, even when it holds more than one occurrence.
- Where the UI sets the OAuth return redirect for script-connections / oauth-apps flows (finalRedirect in oauth-callback.ts, linear/oauth.ts, jira/oauth.ts). Only the MCP-server panel (mcp-oauth-panel.tsx:238) was confirmed.
- Whether stored data other than task_citations.resolved_url, mcp_oauth_pending.finalRedirect and legacy deferral outputs contains dashboard URLs (task outputs, memory content, agent-fs comments). I did not scan DB contents.
- Which external, unversioned places hold old dashboard URLs (past Slack, Linear and PR messages, user bookmarks). They cannot be derived from the repo.
- Prose references to Settings pages by name in docs and skills (e.g. 'Settings → Integrations') were sampled, not exhaustively counted.
- The agent-fs repo was not searched, as the question did not ask for it.
- thoughts/, openapi.json, CHANGELOG.md, bun.lock and generated api-reference docs were excluded from the search.

### Q5-oauth-duplication

**Findings (58):**

- Presets are Google, Slack, GitHub, Jira, Linear, Notion and Microsoft. GitLab and Bitbucket have none. (`src/oauth/presets.ts:85, 104, 122, 139, 158, 193`): `id: "microsoft",`
- The Linear preset hint still calls Linear reserved, but the step-8 comment says the carve-out was removed. (`src/oauth/presets.ts:172`): `Linear is a reserved provider`
- The Linear and Jira OAuth apps are ordinary rows on the /connections surface. (`src/http/script-connections.ts:2264`): `reserved-provider carve-out was removed in step-8`
- The /connections app create always inserts a new oauth_apps row with the static redirect URI. (`src/http/script-connections.ts:2284, 2310`): `savedId = await createOAuthApp(provider, appData);`
- /connections authorize-url builds a generic-flow URL against the static callback, written into oauth_pending. (`src/http/script-connections.ts:2379`): `redirectUri: staticOAuthCallbackUri()`
- The shared callback upserts oauth_authorizations. Tracker-flow rows get Jira cloudId or Linear appUserId post-processing. (`src/http/oauth-callback.ts:237, 285`): `if (pending.flow === "tracker") {`
- The static callback falls through to the MCP callback when the state is not a generic or tracker one. (`src/http/oauth-callback.ts:340`): `const mcpHandled = await completeMcpOAuthCallback(res, parsed.query);`
- The Linear integration is enabled only when the LINEAR_CLIENT_ID env var is set. That env var comes from the swarm_config row. (`src/linear/app.ts:14`): `return !!process.env.LINEAR_CLIENT_ID;`
- Boot init writes the Linear client ID and secret from env into oauth_apps, with the tracker redirect URI and a wide scope list. (`src/linear/app.ts:61, 67`): `await upsertOAuthApp("linear", {`
- The Jira integration is enabled only when the JIRA_CLIENT_ID env var is set. (`src/jira/app.ts:16`): `return !!process.env.JIRA_CLIENT_ID;`
- Boot reconcile writes the Jira app row with rotation enforcement on. (`src/jira/app.ts:47`): `await upsertOAuthApp("jira", {`
- The provider-keyed upsert overwrites the oldest same-provider row, so a /connections-created Linear or Jira app can be overwritten by boot init. (`src/be/db-queries/oauth.ts:352`): `Updates the oldest row for the provider, or`
- Provider-string token reads use the oldest non-MCP app of that provider and its label 'default' authorization. (`src/be/db-queries/oauth.ts:182`): `WHERE a.provider = ? AND a.mcpServerId IS NULL AND z.label = 'default'`
- The Linear client reads tokens by provider string. (`src/linear/client.ts:7`): `const tokens = await getOAuthTokens("linear");`
- The Jira client reads tokens by provider string. (`src/jira/client.ts:13`): `const tokens = await getOAuthTokens("jira");`
- Jira REST calls need the cloudId that OAuth post-processing stored. (`src/jira/client.ts:28`): `Jira cloudId not resolved`
- Config reload copies global swarm_config rows into process.env. (`src/http/core.ts:123`): `process.env[config.key] = config.value;`
- Config reload tears down and re-inits Linear, Jira, Slack and the Git providers. (`src/http/core.ts:268`): `resetLinear();`
- /setup field saves write global swarm_config rows via PUT /api/config. (`apps/ui/src/components/onboarding/use-setup-save.ts:56`): `await api.upsertConfig({`
- The Integrations detail page also saves global swarm_config rows. (`apps/ui/src/pages/integrations/[id]/page.tsx:317`): `scope: "global",`
- The Slack card is token paste, not OAuth (SLACK_BOT_TOKEN). (`apps/ui/src/lib/integrations-catalog.ts:308`): `key: "SLACK_BOT_TOKEN",`
- The /setup Slack pane uses the same two token keys. (`apps/ui/src/pages/setup/steps/integrations/catalog.ts:87`): `chipKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],`
- The Slack Bolt app reads its bot token from env. (`src/slack/app.ts:74`): `const botToken = process.env.SLACK_BOT_TOKEN as string;`
- The slack-read tool reads the bot token from env. (`src/tools/slack-read.ts:273`): `const token = process.env.SLACK_BOT_TOKEN;`
- The slack-thread-flatten seed script resolves SLACK_BOT_TOKEN from swarm config. (`src/be/seed-scripts/catalog/slack-thread-flatten.ts:44`): `resolveSecret(ctx, "SLACK_BOT_TOKEN"`
- The GitHub card has no OAuth. It stores a PAT, or App ID and private key (App mode). (`apps/ui/src/lib/integrations-catalog.ts:497`): `key: "GITHUB_TOKEN",`
- The webhook handler reads GITHUB_WEBHOOK_SECRET from env. (`src/github/app.ts:42`): `webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? null;`
- The GitHub handlers fall back to the GITHUB_TOKEN PAT. (`src/github/handlers.ts:1113`): `return process.env.GITHUB_TOKEN?.trim() || null;`
- The script credential broker has a default GITHUB_TOKEN binding for api.github.com. It reads the Integrations-stored key. (`src/scripts-runtime/credential-broker/default-bindings.ts:12`): `configKey: "GITHUB_TOKEN",`
- The GitLab handler reads the token from env, GITLAB_* only. (`src/gitlab/auth.ts:27`): `apiToken = process.env.GITLAB_TOKEN ?? null;`
- The Bitbucket handler reads the token from env, BITBUCKET_* only. (`src/bitbucket/auth.ts:29`): `apiToken = process.env.BITBUCKET_TOKEN ?? null;`
- Webhook routes for GitHub, GitLab and Bitbucket are served by the API. (`src/http/webhooks.ts:147, 164, 196`): `path: "/api/bitbucket/webhook",`
- Onboarding signals count GitLab and Bitbucket as connected when the token is present in env. (`src/http/onboarding.ts:146-147`): `bitbucket: Boolean(process.env.BITBUCKET_TOKEN?.trim()),`
- Integrations Linear and Jira cards pair a special OAuth section with the env-key form. (`apps/ui/src/components/integrations/special-flows.tsx:37-38`): `"linear-oauth": { Section: LinearOAuthSection, genericFields: "shown" },`
- The Linear card opens /api/trackers/linear/authorize in a new tab (flow='tracker'). (`apps/ui/src/components/integrations/linear-oauth-section.tsx:55`): `window.open(buildLinearAuthorizeUrl(), "_blank", "noopener,noreferrer");`
- The Jira card gives a copyable authorize URL pointing at the tracker route. (`apps/ui/src/api/hooks/use-jira-status.ts:117`): `/api/trackers/jira/authorize`
- The /setup Linear and Jira panes redirect to the same tracker authorize route, after saving the client ID and secret. (`apps/ui/src/pages/setup/steps/integrations/oauth-panes.tsx:116`): `/authorize?redirect=${encodeURIComponent(back)}`
- The /setup Gmail and MS365 panes use OAuth presets inline, with a locked preset, creating an oauth_apps row. (`apps/ui/src/pages/setup/steps/integrations/business-panes.tsx:76`): `lockPreset`
- The /setup Gmail tool maps to preset google with the Gmail scope. (`apps/ui/src/pages/setup/steps/integrations/catalog.ts:149`): `oauthPresetId: "google",`
- The /setup MS365 tool maps to preset microsoft. (`apps/ui/src/pages/setup/steps/integrations/catalog.ts:160`): `oauthPresetId: "microsoft",`
- The shared inline connect component creates the app via POST /api/oauth-apps and authorizes through a popup. (`apps/ui/src/pages/connections/components/oauth-inline-connect.tsx:224`): `await buildAuthorizeUrl.mutateAsync({ appId, label })`
- The /connections legacy-callback warning exempts linear and jira apps because they use dedicated callbacks. (`apps/ui/src/pages/connections/page.tsx:366`): `if (app.provider === "linear" || app.provider === "jira") return false;`
- Vendored (blessed) OpenAPI catalog has github, slack, linear, jira, gmail and microsoft-graph, with preset links. GitLab and Bitbucket are absent. (`vendored-openapi/manifest.json:19, 45, 67, 92, 117, 150`): `"presetId": "microsoft",`
- Scripts reach connections as ctx.api and ctx.mcp registries (not ctx.connections). (`src/scripts-runtime/ctx.ts:22-23`): `mcp: ScriptMcpRegistryClient;`
- The credential broker resolves OAuth binding tokens per authorization id at script egress. (`src/be/script-credential-broker.ts:127`): `(oauthAuthorizationId) => resolveOAuthBindingToken(oauthAuthorizationId),`
- The agent MCP tool get-oauth-access-token returns tokens by provider or authorization id. (`src/tools/oauth-access-token.ts:91`): `"get-oauth-access-token",`
- The tracker-status tool reads only linear and jira. (`src/tools/tracker/tracker-status.ts:31`): `const providers = ["linear", "jira"] as const;`
- Onboarding 'verified' for Linear and Jira comes from the oauth_authorizations tokens (Jira also needs cloudId). (`src/be/automation-preflight.ts:298-299`): `linear: linearTokens ? "verified" : "unverified",`
- Linear webhook verification uses LINEAR_SIGNING_SECRET from env. (`src/linear/webhook.ts:70`): `const signingSecret = process.env.LINEAR_SIGNING_SECRET;`
- Jira webhook verification uses JIRA_WEBHOOK_TOKEN from env. (`src/jira/webhook.ts:92`): `const expected = process.env.JIRA_WEBHOOK_TOKEN;`
- The keepalive sweep refreshes active authorizations where rotation is on or metadata has keepAlive. (`src/be/db-queries/oauth.ts:938`): `a.requiresRefreshTokenRotation = 1`
- MCP OAuth uses its own callback path on the API. (`src/http/mcp-oauth.ts:45`): `return '${getPublicMcpBaseUrl()}/api/mcp-oauth/callback';`
- The MCP OAuth app is stored in oauth_apps with provider mcp-<serverId>. (`src/be/db-queries/mcp-oauth.ts:287`): `'mcp-${input.mcpServerId}',`
- The MCP authorization label is 'default' or user:<id>. (`src/be/db-queries/mcp-oauth.ts:586`): `label: userId ? 'user:${userId}' : "default",`
- The /mcp-servers Connect button navigates to the provider URL from the mcp-oauth route. (`apps/ui/src/pages/mcp-servers/[id]/mcp-oauth-panel.tsx:243`): `window.location.href = providerUrl;`
- MCP tokens are read when the API resolves worker MCP server headers. (`src/http/mcp-servers.ts:392`): `const token = await ensureMcpToken(server.id);`
- MCP tokens are read by the script MCP-connection client. (`src/be/mcp-proxy.ts:77`): `const token = await ensureMcpToken(server.id);`
- Script MCP connections reference an mcpServerId. (`src/http/script-connection-proxy.ts:176`): `connection.mcpServerId,`

**Verifier:** 5/8 confirmed.
- [partial] The /connections app create always inserts a new oauth_apps row with the static redirect URI.. Correction: The static redirect URI part is right (line 2284). The 'always inserts' part holds only when the body has no `id`. With an `id`, the same route calls updateOAuthAppById(editing.id, appData) and reuses the row (lines 2305-2309). The code comment reads "No id → always create a fresh row (N apps per provider). With an id → update exactly that row". The upsert route is create-or-edit, and the boot-only provider-keyed upsertOAuthApp is documented as not for this path (src/be/db-queries/oauth.ts:351-355). (`src/http/script-connections.ts:2284, 2305-2310`)
- [partial] The shared callback upserts oauth_authorizations. Tracker-flow rows get Jira cloudId or Linear appUserId post-processing.. Correction: The upsert at line 237 and the tracker branch at 285 are right. The post-processing does not write to the authorization row. Jira cloudId/siteUrl go to oauth_apps.metadata via updateJiraMetadata, which does `SELECT metadata FROM oauth_apps WHERE provider = 'jira'` (src/jira/oauth.ts:~75, src/jira/metadata.ts:59-62). Linear appUserId goes to KV via upsertKv under namespace "integration:linear:bot-app-user-id" (src/linear/oauth.ts:7, 66-72). The Jira step is fatal on failure and the Linear step is swallowed (oauth-callback.ts:129-155). The tracker flow value is set only by src/linear/oauth.ts:26 and src/jira/oauth.ts:29 (flow: "tracker"). (`src/http/oauth-callback.ts:237, 285`)
- [partial] The Linear integration is enabled only when the LINEAR_CLIENT_ID env var is set. That env var comes from the swarm_config row.. Correction: LINEAR_CLIENT_ID is necessary but not sufficient. isLinearEnabled() also returns false when LINEAR_DISABLE is truthy or LINEAR_ENABLED is false (src/linear/app.ts:12-13). The env var comes from swarm_config only when a global row exists. loadGlobalConfigsIntoEnv copies global swarm_config rows into process.env (src/http/core.ts:105-117), and the deployment env supplies the same variable otherwise. The Integrations card registers LINEAR_CLIENT_ID as a field with restartRequired (apps/ui/src/lib/integrations-catalog.ts:716-731), and /setup lists it (apps/ui/src/pages/setup/steps/integrations/catalog.ts:332). initLinear reads the env var at app.ts:35 and writes the oauth_apps 'linear' row from it (app.ts:60+). (`src/linear/app.ts:11-14`)

**Verifier: missed facts:**

- Linear appUserId is stored in KV, not in an oauth table: src/linear/oauth.ts:7 `const APP_USER_ID_NAMESPACE = "integration:linear:bot-app-user-id";` and the upsertKv call at src/linear/oauth.ts:66. The answer's table lists Linear storage as only 'A + B "default"', so it omits this KV family. src/linear/sync.ts:369 reads the same namespace.
- Jira cloudId and siteUrl live in oauth_apps.metadata, found by `WHERE provider = 'jira'` (src/jira/metadata.ts:62). This keys on the provider string, not on a row id, so the Jira tracker consumers depend on the provider-keyed row even though /connections allows N apps per provider.
- initLinear/initJira boot-seed the provider-keyed oauth_apps row from env: `await upsertOAuthApp("linear", {` at src/linear/app.ts:60 with redirectUri defaulting to `${apiBaseUrl}/api/trackers/linear/callback` (app.ts:44-45). That is a different redirect URI from the static /api/oauth/callback. The tracker authorize path (src/http/trackers/linear.ts, `GET /api/trackers/linear/authorize`) is a separate entry point from /connections.
- The Jira preset carries the same stale 'reserved provider' hint (src/oauth/presets.ts:154), not only Linear (line 172).
- The pending-state table is oauth_pending with flow CHECK IN ('generic','tracker','mcp') (src/be/migrations/117_unified_oauth.sql:218-224). The answer's family C 'same tables, with mcpServerId set' is true for oauth_apps rows (script-connections.ts rejects `app.mcpServerId !== null` at the authorize-url, list-authorizations and edit routes). MCP pending state is separate in code: gcMcpOAuthPending and completeMcpOAuthCallback (src/http/oauth-callback.ts:~352-360, src/http/mcp-oauth.ts). A legacy mcp_oauth_pending table also exists in migration 041.
- Reload path: on swarm_config change, src/http/core.ts:255-270 runs reset-then-init for Bitbucket, Linear, Jira and Slack (`resetLinear(); if (await initLinear()) integrations.push("linear");`). This is the mechanism that connects the Integrations-card swarm_config writes to the runtime consumers. The first-boot init is at src/http/index.ts:835.
- loadGlobalConfigsIntoEnv excludes some global keys from injection (API_KEY, SECRETS_ENCRYPTION_KEY, CORS_ALLOW_ANY_ORIGIN, EXTENSION_ALLOW_LEAD_ACTIVATION, CHAT_SDK_API_URL_OVERRIDES, Teams SDK keys) via getInjectableGlobalConfigs (src/be/db.ts:6750-6757). LINEAR_* keys are not excluded.

**Unknowns:**

- Whether the /connections preset Linear/Jira app clobbering with boot init is hit in practice (derived from code only, not run).
- Whether an OAuth app created from the Linear/Jira presets in /connections is ever read by tracker sync when a seeded row also exists. Code reads only the oldest same-provider app (derived, not run).
- The Chat SDK Slack and Teams adapters (Integrations card chat-sdk, CHAT_SDK_ADAPTERS) were not traced.
- No provider-specific MCP server presets were found for the 8 providers. /mcp-servers is generic, so any hosted MCP per provider is not documented here.
- The Jira webhook-register and keepalive flow was not traced in full.
- Did not trace GitHub App installation-token storage beyond src/github/app.ts getInstallationToken.

### Q6-channels-threads

**Findings (56):**

- Only slack, telegram and discord have source asset keys (`src/assets/source-key.ts:4`): `export const SESSION_SOURCES = ["slack", "telegram", "discord"] as const;`
- Source key shape: thread id gives thread:<id>, no thread id gives task:<id> (`src/assets/source-key.ts:51`): `shared/${source}/${channel}/${thread ? 'thread:${thread}' : 'task:${id}'}/`
- Telegram and Discord thread id formats mapped to keys (`src/assets/source-key.ts:12-13`): `'discord:<guild|@me>:<channelId>[:<threadId>]': 'shared/discord/<channelId>/thread:<threadId>/'`
- createTaskExtended derives the key: explicit key, else (no parent) sessionSourceKey, else default task key (`src/be/db.ts:2883-2893`): `defaultAssetKey("task", id),`
- A child task inherits its parent's key, so a thread's follow-ups stay in one session (`src/be/db.ts:2691`): `if (parent.key && !options.key) {`
- Simple createTask also derives the key from Slack fields (`src/be/db/tasks/write.ts:94`): `sessionSourceKey({`
- Built-in Slack inbound: thread ts is the message ts when not in a thread (`src/slack/handlers.ts:783`): `const threadTs = msg.thread_ts || msg.ts;`
- Slack inbound task carries slack columns and a slack contextKey, no key (`src/slack/handlers.ts:814`): `contextKey: slackContextKey({ channelId: msg.channel, threadTs }),`
- Buffered Slack thread follow-ups are chained to the latest thread task (`src/slack/thread-buffer.ts:331`): `parentTaskId: mostRecentTask?.id,`
- Slack contextKey format (`src/tasks/context-key.ts:126`): `return ["task", "slack", channelId, threadTs].join(SEPARATOR);`
- Chat SDK contextKey format: adapter plain, platform thread id URI-encoded (`src/tasks/context-key.ts:146`): `return ["task", "chat-sdk", adapter, rest].join(SEPARATOR);`
- SDK registers mention, DM and subscribed-thread handlers for all adapters (`src/integrations/chat-sdk/handlers.ts:22-24`): `chat.onNewMention((thread, message) => onHumanMessage(thread, message, "mention"));`
- Chat inbound derives contextKey from the SDK thread id (`src/integrations/chat-sdk/inbound.ts:411`): `const contextKey = chatSdkContextKey(threadId);`
- Chat tasks use source chat and taskType chat-inbound (`src/integrations/chat-sdk/inbound.ts:574-576`): `taskType: "chat-inbound",`
- Chat task stores the inbound message as the reply anchor (`src/integrations/chat-sdk/inbound.ts:590-591`): `mentionMessageId: answered.messageId,`
- Chat inbound reads the task's source key and stores a label for the group (`src/integrations/chat-sdk/inbound.ts:595`): `sourceKey ??= sessionSourceKey(task);`
- A channel mapped to a workflow starts a workflow run with the thread info as trigger data (`src/integrations/chat-sdk/inbound.ts:495`): `const { runId } = await handleWebhookTrigger(`
- Channel to agent or workflow routes live in KV namespace, not in asset keys (`src/integrations/chat-sdk/router.ts:16`): `export const CHAT_CHANNELS_NAMESPACE = "integrations:chat:channels";`
- Chat SDK adapters: telegram, slack, discord, teams (`src/integrations/chat-sdk/schema.ts:9`): `export const CHAT_SDK_ADAPTER_NAMES = ["telegram", "slack", "discord", "teams"] as const;`
- One Chat instance per adapter (`src/integrations/chat-sdk/runtime.ts:48`): `const instances = new Map<ChatSdkAdapterName, Chat>();`
- Slack thread columns on agent_tasks (`src/be/migrations/001_initial.sql:85-89`): `slackChannelId TEXT,`
- Task asset key column (`src/be/migrations/115_asset_namespace_keys.sql:8`): `ALTER TABLE agent_tasks ADD COLUMN "key" TEXT NOT NULL DEFAULT 'shared/';`
- Task contextKey column (`src/be/migrations/042_task_context_key.sql:4`): `ALTER TABLE agent_tasks ADD COLUMN contextKey TEXT;`
- slack_messages stores bot message ts per context_key, channel and thread (`src/be/migrations/123_slack_messages.sql:6`): `CREATE TABLE slack_messages (`
- Chat SDK thread subscription table (`src/be/migrations/217_chat_sdk_state.sql:14`): `CREATE TABLE chat_subscriptions (`
- Chat relay obligations triggered by chat-sdk contextKey on terminal tasks (`src/be/migrations/217_chat_sdk_state.sql:73`): `AND NEW.contextKey GLOB 'task:chat-sdk:*'`
- slack-reply posts to the task's stored Slack channel and thread (`src/tools/slack-reply.ts:102`): `slackChannelId = task.slackChannelId;`
- slack-post takes channelId, message, blocks, optional threadTs and needs lead (`src/tools/slack-post.ts:24`): `pass 'threadTs' to post as a threaded reply under an existing message`
- slack-start-thread returns a ts for later threadTs use; lead only (`src/tools/slack-start-thread.ts:54`): `verb: "integration.slack.thread.start",`
- chat-reply posts to the thread parsed from the task's contextKey; inputs text and attachments (`src/tools/chat-reply.ts:51`): `const thread = chatThreadOfContextKey(task.contextKey);`
- chat-post is lead only, takes adapter plus threadId or channelId, text, attachments (`src/tools/chat-post.ts:20`): `Lead only. Post a message to any Chat SDK thread or channel`
- chat-open-dm returns a DM threadId for chat-post (`src/tools/chat-open-dm.ts:49`): `const threadId = await platform.openDM(userId);`
- chat-read-thread: any agent reads its own task thread, others lead only (`src/tools/chat-read-thread.ts:19`): `Every agent can read the thread of its current task.`
- register-chat-channel routes a channel to one agent or one workflow (`src/tools/register-chat-channel.ts:78`): `Give exactly one of agentId or workflowId.`
- Chat tools are gated by the chat-sdk capability, Slack tools by slack (`src/server.ts:734`): `if (hasCapability("chat-sdk")) {`
- Chat SDK send path splits, scrubs and posts to a thread or channel (`src/integrations/chat-sdk/outbound.ts:342`): `export async function postChatMessage(args: {`
- Terminal chat tasks are relayed to the thread from contextKey automatically (`src/integrations/chat-sdk/relay.ts:131`): `const target = chatThreadOfContextKey(task.contextKey);`
- ScheduledTaskSchema has targetType agent-task/workflow/script and no channel or thread field (`src/types.ts:1969`): `targetType: ScheduledTaskTargetTypeSchema.default("agent-task"),`
- create-schedule input targetType (`src/tools/schedules/create-schedule.ts:37`): `targetType: ScheduledTaskTargetTypeSchema.default("agent-task")`
- scheduled_tasks has a key column and targetType CHECK (`src/be/migrations/103_schedule_target_type.sql:36`): `CHECK(targetType IN ('agent-task', 'workflow', 'script')),`
- Schedule-created tasks get key schedule.key and the schedule contextKey (`src/scheduler/schedule-task.ts:66`): `key: schedule.key,`
- Only a defer-task wake-up of a chat task reuses the parent's chat contextKey (`src/scheduler/schedule-task.ts:45`): `return parent.contextKey;`
- Schedule fallback contextKey is task:schedule:<id> (`src/scheduler/schedule-task.ts:48`): `return scheduleContextKey({ scheduleId: schedule.id });`
- Seeded schedule passes the Slack channel as a template placeholder (params), not a column (`src/be/migrations/141_scheduled_task_automation_preflight.sql:61`): `REPLACE(taskTemplate, 'the configured channel or thread', '{{SLACK_CHANNEL_ID}}')`
- Schedule params are generic key/value, accepted by HTTP update (`src/http/schedules.ts:62`): `params: z.record(z.string(), z.unknown()).optional(),`
- Notify workflow node targets a Slack channel id string (`src/workflows/executors/notify.ts:9`): `channel: z.enum(["swarm", "slack", "email"]),`
- Notify posts to a channel with no thread_ts (`src/workflows/executors/notify.ts:74`): `channel: config.target || "",`
- HITL node notifications take channel slack/email plus a target (`src/workflows/executors/human-in-the-loop.ts:81`): `channel: z.enum(["slack", "email"]),`
- HITL Slack card posts to notification.target, no thread (`src/workflows/approval-notifications.ts:188`): `channel: notification.target,`
- Workflow agent-task node tasks get a workflow contextKey, not a chat or Slack one (`src/workflows/executors/agent-task.ts:136`): `contextKey: workflowContextKey({ workflowRunId: meta.runId }),`
- Workflow event trigger names are limited; slack.message exists, no chat event (`src/types.ts:2650`): `eventName: z.enum([`
- Scripts (and so swarm-script nodes) can call slack_post and chat_post via the SDK allowlist (`src/scripts-runtime/sdk-allowlist.ts:111`): `chat_post: "chat-post", // external: sends to a chat platform`
- POST /api/tasks accepts a contextKey; binding to a foreign chat thread needs lead or admin (`src/http/tasks.ts:1113`): `!(await mayBindChatThread(principal))`
- Source groups are read-only, so users cannot move sessions into a source key (`src/assets/source-key.ts:76`): `export const SOURCE_GROUPS_READ_ONLY = "Source groups are read-only.";`
- Only session-label KV is keyed by source group key (label text, not a channel link) (`src/be/db/session-labels.ts:3`): `const NAMESPACE = "session-labels";`
- AssetKeyMapping links an asset key to an agent-fs provider key, not a channel (`src/types.ts:52`): `export const AssetKeyMappingSchema = z`

**Verifier:** 8/8 confirmed.

**Verifier: missed facts:**

- The answer cites only handlers.ts for Slack task creation. Other Slack task-creation sites also set slackContextKey: src/slack/thread-buffer.ts:331 (`parentTaskId: mostRecentTask?.id,`) and :335 (`contextKey: slackContextKey({ channelId, threadTs }),`), and src/slack/assistant.ts:294 and :344.
- Chat SDK follow-ups pass the previous task as parent: src/integrations/chat-sdk/inbound.ts:581 `parentTaskId: mostRecentTask?.id,`. They inherit the parent's key instead of re-deriving it. After a task is created, inbound.ts:595 `sourceKey ??= sessionSourceKey(task);` feeds rememberSessionLabel (the session-group label).
- createTaskExtended also copies Slack columns from the parent: src/be/db.ts:2551-2562 sets slackChannelId, slackThreadTs and slackUserId, with a guard for an explicit foreign channel. Lines 2564-2575 copy mentionMessageId and mentionChannelId. Line 2695 copies the parent's contextKey: `if (parent.contextKey && !options.contextKey) {`.
- Source keys are also set after the fact by a backfill: src/be/session-source-backfill.ts:83 `const key = sessionSourceKey(root);`. It selects root tasks with slackChannelId and slackThreadTs set, or contextKey matching `task:chat-sdk:*`, whose key is still `shared/` or `shared/task:<id>/`.
- Source groups are read-only to users: src/assets/source-key.ts:76 `export const SOURCE_GROUPS_READ_ONLY = "Source groups are read-only.";` and sourceMoveError at :88. They are enforced in src/http/sessions.ts:783 and src/http/assets.ts:343.
- The chat-sdk context key is `task:chat-sdk:<adapter>:<encodeURIComponent(platformThreadId)>`, parsed back by chatThreadOfContextKey (src/tasks/context-key.ts:153-163). sessionSourceKey depends on this parse for every non-Slack-column case. A malformed or non-chat-sdk contextKey gives null (source-key.ts:31).
- Chat-sdk Slack threads shaped `slack:<channel>:` (top-level DM, empty ts) map to `shared/slack/<channel>/task:<id>/` (source-key.ts:11 and :34).
- Not covered by these 8 claims and not verified here: the thread storage tables, the outbound tools, the schedule and workflow targeting, and the asset-key to channel linkage claims.

**Unknowns:**

- Exact Telegram and Discord thread.id strings come from the external chat SDK package and adapters (not read). The formats here come from comments in source-key.ts and context-key.ts.
- I did not read apps/ui in full. A grep of apps/ui/src and src found no code linking an asset key to a channel or thread, but a UI-only link is not fully excluded.
- I did not read the chat SDK Slack adapter vs built-in Slack coexistence beyond assertNoSlackClash. Chat-sdk Slack tasks use contextKey task:chat-sdk:slack:... and no slackChannelId columns.
- HTTP create-schedule and POST /api/workflows body schemas were only skimmed (update body in src/http/schedules.ts). No channel field was seen, but I did not read every route.
- I did not trace slack-upload-file, slack-read and slack-delete inputs in detail, nor the Slack render-v2 and watcher outbound paths.

### Q7-sessions-groups

**Findings (44):**

- Group key = task key with a resource leaf (task|thread|schedule|workflow:<id>/) stripped; leaf kinds list (`src/assets/key.ts:92-100`): `export const SESSION_LEAF_KINDS = ["task", "thread", "schedule", "workflow"] as const;`
- sessionGroupKey applies the leaf regex replace (`src/assets/key.ts:100`): `return normalized.replace(sessionLeafPattern, "/");`
- Default asset key for a resource is shared/<resource>:<id>/ (`src/assets/key.ts:81-83`): `return normalizeAssetKey('shared/${resource}:${id}/');`
- A source thread with at least two owned roots is its own nested group, else the leaf-stripped key (`src/assets/source-key.ts:62-73`): `export const NESTED_THREAD_MIN_ROOTS = 2;`
- src/http/sessions.ts 706-745 are the move routes, not the derivation (`src/http/sessions.ts:706`): `summary: "Move sessions into a group or reset their keys",`
- Rename/delete group route is a prefix move (`src/http/sessions.ts:725`): `summary: "Rename or delete a session group",`
- Tree derives each row's group via sessionThreadGroupKey, then skips hidden or not-shown sources before creating the group (`src/be/db/session-tree.ts:727-738`): `if (hidden.has(source) || (shown && !shown.has(source))) continue;`
- No group = shared/ or personal/<me>/ (`src/be/db/session-tree.ts:739-740`): `key === "shared/" || (actor.kind === "user" && key === 'personal/${actor.userId}/');`
- The tree query itself applies the Mine condition (`src/be/db/session-tree.ts:678`): `mine: opts.mine,`
- Group list filter applies showSource, tree requester check, and Mine condition in the same filter as groupKey (`src/be/db/session-tree.ts:307-314`): `if (opts.tree) conditions.push("+r.requestedByUserId IS NOT NULL");`
- groupKey filter matches the exact group plus direct resource leaves (`src/be/db/session-tree.ts:314`): `if (opts.groupKey) add(groupCondition(normalizeAssetKey(opts.groupKey)));`
- With a viewer, group lists exclude Later/Done-marked sessions (`src/be/db/session-tree.ts:384`): `filters.push("(readState IS NULL OR readState IN ('read','unread'))");`
- Effective source is the key-prefix source else raw task source, so a schedule run counts as 'schedule' (`src/assets/source-key.ts:79-80`): `return sourceOfKey(key) ?? source;`
- Machine sources excluded by the Mine view (`src/be/db/session-visibility.ts:47`): `export const MACHINE_SESSION_SOURCES = ["workflow", "schedule", "system"] as const;`
- Mine keeps only human-started roots (or shared) (`src/be/db/session-visibility.ts:65`): `const humanStarted = '(r.source NOT IN (${machine})`
- Schedule runs are readable by every user in the All viewer scope (`src/be/db/session-visibility.ts:35`): `r.scheduleId IS NOT NULL OR ${shared})',`
- Default shown sources are only the two dashboard sources (`apps/ui/src/lib/sessions-show.ts:30`): `export const DEFAULT_SHOWN_SOURCES: readonly string[] = ["comb", "ui"];`
- Mine / All dropdown hint text (`apps/ui/src/components/sessions-v2/sidebar/filter-menu.tsx:36`): `{ value: "all", label: "All", hint: "Also workflow, schedule, and system runs for you" },`
- Every tree list (group tab included) sends show and showSource (`apps/ui/src/api/hooks/session-query-keys.ts:79-80`): `if (rest.scope === "tree" && show === "all") params.show = "all";`
- Group container uses scope=tree and groupKey (`apps/ui/src/lib/sessions-v2.ts:246-251`): `return { ...base, groupKey: container };`
- GroupTab re-renders on filter change and builds its list from sidebarListParams(view) (`apps/ui/src/components/sessions-v2/group-tab.tsx:107-131`): `const { limit: _sidebarLimit, ...base } = sidebarListParams(view);`
- GroupTab header is only an icon, crumb title and total count (`apps/ui/src/components/sessions-v2/group-tab.tsx:274-288`): `<h2 className="flex min-w-0 items-center gap-1.5 text-base font-semibold">`
- GroupTab opens at ?view= in the main pane (`apps/ui/src/components/sessions-v2/sessions-v2-shell.tsx:322`): `<GroupTab view={view} onOpen={(id) => openSession(id, { pane: 0 })} />`
- view param accepts a section name or a key ending in / (`apps/ui/src/lib/sessions-v2.ts:72-76`): `return value.endsWith("/") ? value : null;`
- Schedule run task takes the schedule's key, source schedule, and createdBy as requester (`src/scheduler/schedule-task.ts:66-78`): `requestedByUserId: schedule.createdBy,`
- Schedule run context key is task:schedule:<id> (sibling in-progress tasks can become its parent) (`src/scheduler/schedule-task.ts:48`): `return scheduleContextKey({ scheduleId: schedule.id });`
- createScheduledTask default key (`src/be/db.ts:6268`): `normalizeAssetKey(data.key ?? defaultAssetKey("schedule", id)),`
- create-schedule MCP tool accepts optional key, default shared/schedule:<id>/ (`src/tools/schedules/create-schedule.ts:26-27`): `"Logical namespace. Defaults to a shared/schedule:<id>/ resource key.",`
- update-schedule accepts key as a move (`src/tools/schedules/update-schedule.ts:29`): `key: AssetKeySchema.optional().describe("Move to a logical namespace."),`
- update-schedule writes the key through authorizeAssetKeyWrite (`src/tools/schedules/update-schedule.ts:352`): `if (key !== undefined) updateData.key = await authorizeAssetKeyWrite(key, updatedBy);`
- HTTP create schedule body accepts key (`src/http/schedules.ts:102`): `key: AssetKeySchema.optional(),`
- authorizeAssetKeyWrite accepts any shared key (`src/be/asset-key-auth.ts:36`): `if (parsed.root === "shared") return key;`
- Workflow-target runs use the workflow's key, not the schedule's (`src/workflows/executors/agent-task.ts:98`): `effectiveKey = workflow.key;`
- Sessions v2 composer sends the picked group, undefined for No group (`apps/ui/src/components/sessions-v2/new-session-tab.tsx:46`): `startKey={group ?? undefined}`
- useStartSession creates the task with source ui and the optional key (`apps/ui/src/components/sessions/use-start-session.ts:99-101`): `source: "ui",`
- Contextual panel passes contextKey and buildTask but no key (`apps/ui/src/components/session-panel/session-panel.tsx:258-262`): `buildTask: (typed) => withContextFooter(typed, contextFooter),`
- POST /api/tasks uses body key, else the parent's key (`src/http/tasks.ts:1133`): `const requestedKey = parsed.body.key ?? inheritedKey;`
- createTaskExtended key default: explicit, else source thread key (no parent), else shared/task:<id>/ (`src/be/db.ts:2884-2893`): `defaultAssetKey("task", id),`
- Child tasks inherit the parent's key (`src/be/db.ts:2691-2692`): `if (parent.key && !options.key) {`
- Lead send-task defaults the parent to the caller's current task and takes its key (`src/tools/send-task.ts:397`): `const effectiveParentTaskId = parentTaskId ?? sourceTaskId;`
- send-task key resolution (`src/tools/send-task.ts:470`): `const requestedKey = key ?? effectiveParentTask?.key;`
- task-action create key default text (`src/tools/task-action.ts:70-71`): `Default: the Slack or chat source key of the task (for example shared/slack/<channel>/thread:<ts>/), else shared/task:<id>/.`
- Only group-level data in the tree is key plus counts and lastActivityAt; empty groups live in the browser (`src/http/sessions.ts:169-172`): `const SessionTreeGroupSchema = SessionSectionCountsSchema.extend({`
- A group with no sessions exists only in browser storage until a session moves in (`apps/ui/src/lib/empty-groups.ts:1-3`): `// yet. It lives in this browser until a session moves in (plan D8).`

**Verifier:** 8/8 confirmed.

**Verifier: missed facts:**

- Mine rule detail (answer says 'excludes workflow/schedule/system unless shared'): src/be/db/session-visibility.ts:47-48 and 65-66. kapso-inbound is a system-source exception that counts as human. Non-readAll Mine also requires `r.requestedByUserId = ?` (line 76). readAll widens to every user's human-started roots (line 74). Shared sessions stay in Mine.
- Mine and the requester filter apply only when a user viewer exists: src/be/db/session-tree.ts:301-308 puts `+r.requestedByUserId IS NOT NULL` and sessionMineCondition inside `if (opts.viewer)`. The viewer is added only for actor.kind === "user" (src/http/sessions.ts:1050-1062; session-tree.ts:674-678). A bypass actor gets neither filter.
- HTTP wiring of Mine for list vs tree: src/http/sessions.ts:1050-1051 `tree: parsed.query.scope === "tree"` and `mine: ... parsed.query.show !== "all"`. The tree route uses `mine: parsed.query.show !== "all"` (line ~1096). UI list params add show/showSource only for scope=tree: apps/ui/src/api/hooks/session-query-keys.ts:79-80.
- Group view list query: apps/ui/src/components/sessions-v2/group-tab.tsx:131-142 spreads sidebarListParams(view) (apps/ui/src/lib/sessions-v2.ts:243-252 returns {scope:'tree', groupKey: container}). Line 108 calls useSessionsFilter() so the list re-queries on Mine/All or shown-source changes. Route is /sessions?view=<key> (use-sessions-url-state.ts:70, sessions-v2-shell.tsx:322).
- Group list membership (src/be/db/session-tree.ts:189-212 groupCondition): key equals the group key, or exactly one direct resource leaf under it, and the leaf's source thread has fewer than NESTED_THREAD_MIN_ROOTS roots. A nested thread group is therefore not listed in its parent group.
- Triaged rows leave group lists: src/be/db/session-tree.ts:335-337 excludesTriaged (viewer userId plus groupKey/keyPrefix/noGroup) and 359-360 filter readState to NULL/read/unread. The tree mirrors this at 750-756, putting later/done rows only in the later/done counters.
- Schedule run attributes: src/scheduler/schedule-task.ts:73-84 passes key: schedule.key, source: "schedule", requestedByUserId: schedule.createdBy, scheduleId, and a schedule contextKey. effectiveSource for a `shared/schedule:<id>/` key is the raw source 'schedule', because sourceOfKey only matches slack/telegram/discord prefixes (src/assets/source-key.ts:3, 58-60). The default shown sources are comb,ui (apps/ui/src/lib/sessions-show.ts:30), so it is hidden on that filter. Separately, sessionViewerCondition (session-visibility.ts:35) lets any user read schedule runs.
- With a custom schedule key that has no leaf (for example `shared/reports/daily/`), the run's group is that key itself, because sessionGroupKey strips nothing. With `shared/reports/schedule:<id>/` the group is `shared/reports/`. The default key always collapses to No group.
- Schedule key inputs: create-schedule MCP tool has `key` optional with describe 'Defaults to a shared/schedule:<id>/ resource key.' (src/tools/schedules/create-schedule.ts:26-27; authorizeAssetKeyWrite at 301). update-schedule has `key` at src/tools/schedules/update-schedule.ts:29 and 352. HTTP schedules route accepts `key` at src/http/schedules.ts:41, 102, 419, 547.
- Task key rules at creation: src/be/db.ts:2888-2894 `options?.key ?? (options?.parentTaskId ? null : sessionSourceKey(...)) ?? defaultAssetKey("task", id)`. A parent's key is inherited only when no explicit key is given (db.ts:2691-2693) and is re-read inside the insert transaction (db.ts:2920-2928). Lead send-task passes `key ?? effectiveParentTask?.key` (src/tools/send-task.ts:470).
- UI composer detail: apps/ui/src/components/sessions/use-start-session.ts:96-102 calls api.createTask with source: "ui", contextKey and key (the picked key). new-session-tab.tsx:3-5 says 'No group sends none, so the server sets the default key'. The contextual panel NewSession (apps/ui/src/components/session-panel/session-panel.tsx:258-262) passes only contextKey, buildTask and onStarted, with no key.
- Group-level metadata today: SessionTreeGroup is {key, total, unread, running, needsYou, lastActivityAt} (session-tree.ts:745-748). The GroupTab header shows only GroupCrumbIcon, the title from groupCrumb(view, me, nameOf, labels), and the total (group-tab.tsx:125-126, ~279-287). Source-group labels come from getSessionLabels / threadLabels (src/http/sessions.ts:~1100-1105; session-tree.ts:764-776). No description, owner or settings field exists for a group.

**Unknowns:**

- The question's pointer to src/http/sessions.ts ~706-745 is the move/rename routes. The group derivation I found is in src/be/db/session-tree.ts (getSessionTree, groupCondition) and src/assets/key.ts.
- I did not check whether schedules made from the dashboard always set createdBy. A schedule with no human creator gives a run with a null requester, which tree-scope lists drop.
- I did not read all of updateScheduledTask. The visible part does not rewrite the key of existing agent_tasks when a schedule's key changes, so earlier runs likely keep the old key.
- Behavior when the API key maps to no user (bypass actor) was only partly traced. Mine and the requester check are inside the viewer branch, so they appear to be skipped.
- I did not check where the UI creates schedules, so I do not know if any UI form sends a schedule key.
- Whether a 'schedule' checkbox appears in the filter menu was not confirmed. Its rows come from tree `sources`, which in Mine view are built after the Mine SQL filter, so schedule counts likely appear only under All.

### Q8-home-signals

**Findings (43):**

- Per-workflow runs list route (the only runs-list HTTP endpoint) (`src/http/workflows.ts:355`): `path: "/api/workflows/{id}/runs",`
- MCP list-workflow-runs tool also requires a workflowId (no global variant) (`src/tools/workflows/list-workflow-runs.ts:52`): `workflowId: z.string().uuid().describe("Workflow ID to list runs for"),`
- DB query is scoped to one workflowId, ordered newest first (`src/be/db.ts:8170`): `ORDER BY startedAt DESC, id DESC${pagination}',`
- workflow_runs status CHECK enum (`src/be/migrations/025_workflow_run_cancelled_status.sql:9`): `CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled')),`
- Plain status index on workflow_runs (`src/be/migrations/025_workflow_run_cancelled_status.sql:27`): `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);`
- Composite index leading with workflowId, then status (`src/be/migrations/175_workflow_runs_list_index.sql:10`): `CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_status_started`
- triggeredByAgentId is the latest column added to workflow_runs (`src/be/migrations/247_workflow_run_triggered_by_agent.sql:11`): `ALTER TABLE workflow_runs ADD COLUMN triggeredByAgentId TEXT;`
- fetchAllWorkflowRuns lists workflows, then loops sequentially per workflow (`apps/ui/src/api/client.ts:1715-1719`): `const result = await this.fetchWorkflowRuns(w.id, { limit: perWorkflowLimit });`
- Per-workflow cap is 50 and the merge sorts client-side (`apps/ui/src/api/client.ts:476`): `export const ALL_WORKFLOW_RUNS_PER_WORKFLOW = 50;`
- useAllWorkflowRuns is consumed by the Workflows page (`apps/ui/src/pages/workflows/page.tsx:64`): `const { data: allRunsData, isLoading: runsLoading } = useAllWorkflowRuns();`
- Only GET /api/workflows takes a lastRunStatus filter (latest run status per workflow) (`src/http/workflows.ts:153`): `lastRunStatus: WorkflowRunStatusSchema.optional(),`
- useBlockingInbox calls approvals (pending) and credential-missing agents (`apps/ui/src/api/hooks/use-inbox.ts:86-87`): `const approvalsQ = useApprovalRequests({ status: "pending" });`
- useBrokenInbox calls GET /api/tasks for failed,cancelled tasks (`apps/ui/src/api/hooks/use-inbox.ts:173-174`): `status: "failed,cancelled",`
- useToReadInbox calls GET /api/sessions (completed root sessions of the last 7d, filtered client-side) (`apps/ui/src/api/hooks/use-inbox.ts:232`): `const sessionsQ = useSessions({ limit: 50, source: ["ui"] });`
- useToStartInbox calls GET /api/task-templates (`apps/ui/src/api/hooks/use-inbox.ts:285`): `const templatesQ = useTaskTemplates({ kind: "task" });`
- The four inbox hooks are only re-exported from the barrel; no component imports them (`apps/ui/src/api/hooks/index.ts:78`): `useBlockingInbox,`
- Every inbox hook also calls GET /api/inbox-state?userId=, so dismiss/snooze/done state is per user (`apps/ui/src/api/client.ts:3805`): `const url = '${this.getBaseUrl()}/api/inbox-state?${params.toString()}';`
- Approvals list endpoint filters only by status, workflowRunId and limit (default 100); no per-user filter (`src/be/db/approvals.ts:41`): `params.push(filters?.limit ?? 100);`
- The approvals list route supports fields=slim and returns full rows by default (`src/http/approval-requests.ts:486`): `path: "/api/approval-requests",`
- Credential-status is a bulk endpoint across all agents (`src/http/agents.ts:647`): `path: "/api/agents/credential-status",`
- The credential-status handler returns every agent, filtered only by status; not per user (`src/http/agents.ts:1452`): `const agents = (await getAllAgents())`
- The UI asks for status=waiting_for_credentials (`apps/ui/src/api/client.ts:3982`): `/api/agents/credential-status?status=waiting_for_credentials`
- session-tree returns total/unread/running/needsYou per section (`src/http/sessions.ts:163-167`): `const SessionSectionCountsSchema = z.object({`
- session-tree is per viewer: it joins the viewer's inbox_item_state row (`src/be/db/session-tree.ts:428`): `ON s.userId = ? AND s.itemType = 'to_read' AND s.itemId = r.id`
- needsYou is an unread failed chain or a pending approval (`src/be/db/session-tree.ts:431`): `SELECT *, (COALESCE(readState = 'unread' AND latestStatus = 'failed', 0) OR pendingApproval) AS needsYou`
- running counts roots whose latest chain status is not terminal (`src/be/db/session-tree.ts:720`): `if (!isTerminalTaskStatus(row.latestStatus)) section.running++;`
- An operator key with no picked dashboard user is a bypass actor (no viewer, so readState is NULL) (`src/http/session-access.ts:91`): `if (!picked) return BYPASS;`
- useSessionTree is consumed by sessions-v2 components, not by Home (`apps/ui/src/components/sessions-v2/status-bar.tsx:84`): `const { data: tree } = useSessionTree();`
- GET /api/tasks has status CSV plus key and keyPrefix filters but no group-by (`src/http/tasks.ts:248-249`): `key: AssetKeySchema.optional(),`
- GET /api/sessions has status=running and group filters (keyPrefix, groupKey, noGroup) (`src/http/sessions.ts:576`): `status: z.enum(["running", "failed", "needs"]).optional(),`
- GET /api/active-sessions filters only by agentId (`src/http/active-sessions.ts:28`): `agentId: z.string().optional(),`
- agent_tasks has an indexed asset key column (`src/be/migrations/115_asset_namespace_keys.sql:8`): `ALTER TABLE agent_tasks ADD COLUMN "key" TEXT NOT NULL DEFAULT 'shared/';`
- The UI TaskFilters type has no key or keyPrefix field (`apps/ui/src/api/hooks/use-tasks.ts:29`): `export interface TaskFilters {`
- Home mounts DashboardNudges and FleetBenchmarkCard above the timeline region (`apps/ui/src/pages/home/unified-home.tsx:53-54`): `<FleetBenchmarkCard />`
- Desktop gets AgentActivityTimeline, phones get MobileNow (`apps/ui/src/pages/home/unified-home.tsx:118`): `return isMobile ? <MobileNow /> : <AgentActivityTimeline />;`
- MobileNow reads approvals(pending), tasks in_progress (limit 20), pending count, failed (limit 50), agents (`apps/ui/src/components/dashboard/mobile-now.tsx:61-70`): `const approvals = useApprovalRequests({ status: "pending" });`
- AgentActivityTimeline reads one 1200-row tasks window plus agents (`apps/ui/src/components/dashboard/agent-activity-timeline.tsx:610-615`): `limit: 1200,`
- FleetBenchmarkCard dependencies: StatusProvider data, benchmark query, dismiss flag, inbox-state, telemetry, current user, config (`apps/ui/src/components/dashboard/fleet-benchmark-card.tsx:71-77`): `const benchmark = useFleetBenchmark(Boolean(status));`
- The card needs GET /api/fleet-benchmark (`apps/ui/src/api/client.ts:3973`): `const url = '${this.getBaseUrl()}/api/fleet-benchmark';`
- The card's mode logic reads status.instance.workflow_runs_completed (`apps/ui/src/components/dashboard/fleet-benchmark-card.tsx:110`): `workflowRunsCompleted: status?.instance?.workflow_runs_completed ?? 0,`
- StatusProvider is mounted in RootLayout (the parent of the /usage routes) (`apps/ui/src/components/layout/root-layout.tsx:112`): `<StatusProvider pollIntervalMs={30_000}>`
- The telemetry banner in DashboardNudges shares the fleet-benchmark query key and the telemetry-banner dismissal state (`apps/ui/src/components/dashboard/telemetry-benchmark-banner.tsx:45`): `const benchmark = useFleetBenchmark(Boolean(status));`
- /usage is an admin-only nav route with its own layout (`apps/ui/src/app/routes.tsx:304-313`): `adminOnly: true,`

**Verifier:** 8/8 confirmed.

**Verifier: missed facts:**

- The runs list does not return the whole table row. WORKFLOW_RUN_SUMMARY_COLUMNS (src/be/db/workflow-runs.ts:73-74) is "id, workflowId, status, triggerType, triggerData, error, created_by, startedAt, lastUpdatedAt, finishedAt, parentStepId, parentStepAttempt". It omits context, context_replay and triggeredByAgentId. Context is only returned by GET /api/workflow-runs/{id} (route description at src/http/workflows.ts:358).
- The list route returns a page envelope. The description at src/http/workflows.ts:358 says to follow `page.nextOffset` while `page.hasMore` is true. UI types are WorkflowRunsPage (client.ts:1697), and the db layer has a separate countWorkflowRuns(workflowId, {status}) (src/be/db.ts ~8180).
- There is a global aggregate over workflow_runs, but it is not a list: src/be/db/instance-signals.ts:22 runs "SELECT COUNT(*) AS count FROM workflow_runs WHERE status = 'completed'" and feeds the workflow_runs_completed field in src/http/status.ts:173. GET /api/stats (src/http/stats.ts:80) only reports workflows total/enabled, not runs, so nothing server-side gives a global running-runs count or list.
- Other workflow_runs indexes: idx_workflow_runs_workflowId (025:26), idx_workflow_runs_workflow_started (175:8-9), idx_workflow_runs_trigger_type (133:12), and the partial unique idx_workflow_runs_parentStep_attempt on (parentStepId, parentStepAttempt) WHERE parentStepId IS NOT NULL (240:36, which replaced idx_workflow_runs_parentStepId from 203:9).
- fetchAllWorkflowRuns costs one request for /api/workflows plus one /api/workflows/{id}/runs per workflow, run strictly in series (client.ts:1718-1719), and it carries a `capped` flag that the Workflows page uses to show 'latest 50 runs of each workflow' (pages/workflows/page.tsx:539). A 'running now' view across workflows via this path would only see each workflow's newest 50 runs.
- Claims 1-8 only cover part (a). I did not check the answer's statements for parts (b), (c) and (d). That covers the inbox hooks, approvals, session-tree counts, credential-status, tasks/sessions filters and the Home components.

**Unknowns:**

- Whether any plugin, app or script outside apps/ui mounts the use-inbox hooks. I only searched apps/ui/src.
- Whether GET /api/approval-requests narrows rows for non-admin users. The list handler applies no per-user filter, but I did not trace RBAC middleware.
- How session_summaries.pendingApprovalCount and latestStatus are kept current (trigger-maintained). I did not read the triggers.
- Whether the /api/tasks handler's readableBy filter makes in_progress tasks per user. I saw it passed at tasks.ts ~1029 but did not trace its SQL.
- Whether the UsageLayout or usage page has anything that conflicts with the card's layout (HomeCard styling, BorderBeam).

### Q9-page-key

**Findings (29):**

- create-page sets the key only from explicit input.key (or leaves undefined for create); no read of the calling task's key (`src/tools/create-page.ts:213-214`): `assetKey = input.key ? await authorizeAssetKeyWrite(input.key, trustedUserId) : undefined;`
- sourceTaskId is only used to resolve the trusted user for personal/ namespace authorization (`src/tools/create-page.ts:207-210`): `const trustedUserId = await resolveTaskAuditUserId(`
- Tool input docs state the default is the resource key, not the task key (`src/tools/create-page.ts:103-104`): `Logical namespace. Defaults to a shared/page:<id>/ resource key.`
- createPage falls back to defaultAssetKey('page', id) when key is omitted; blamed to 9fc74c7efc (#963) (`src/be/db.ts:8700`): `normalizeAssetKey(data.key ?? defaultAssetKey("page", id)),`
- defaultAssetKey builds a per-resource shared leaf (`src/assets/key.ts:81-83`): `return normalizeAssetKey('shared/${resource}:${id}/');`
- Commit that introduced the behavior (squash message has no rationale for pages) (`git:9fc74c7efc2b2c04aa4bfba9c579563be3eeb25b:commit message`): `feat: add asset namespace keys (#963)`
- PR #963 body states omitted writes default to shared/ and mentions inheritance only for agent-fs attachments (`gh pr view 963:body Summary`): `defaulting existing and omitted writes to 'shared/'`
- Later commit 22a348f67 only converted create-page lines to async/await (no behaviour change) (`git:22a348f6703390a41a097945361c47ebeb7577ed:commit subject`): `refactor(db): async DbClient seam over bun:sqlite (no behaviour change) (#1204)`
- Child tasks inherit the parent's key (introduced in #963; keyInherited flag added by e74eb19ca #2408) (`src/be/db.ts:2691-2694`): `if (parent.key && !options.key) {`
- Task default key when no parent and no source: defaultAssetKey('task', id) (`src/be/db.ts:2893`): `defaultAssetKey("task", id),`
- send-task inherits the parent/source task key (effective parent = parentTaskId ?? sourceTaskId); introduced in #963 (`src/tools/send-task.ts:470`): `const requestedKey = key ?? effectiveParentTask?.key;`
- effective parent for send-task falls back to the calling task (`src/tools/send-task.ts:397`): `const effectiveParentTaskId = parentTaskId ?? sourceTaskId;`
- create-schedule uses only an explicit key, no source-task inheritance (`src/tools/schedules/create-schedule.ts:301`): `const assetKey = key ? await authorizeAssetKeyWrite(key, createdBy) : undefined;`
- create-workflow uses only an explicit key, no source-task inheritance (`src/tools/workflows/create-workflow.ts:146`): `const assetKey = key ? await authorizeAssetKeyWrite(key, createdBy) : undefined;`
- Schedule runs inherit the schedule's key (`src/scheduler/schedule-task.ts:66`): `key: schedule.key,`
- Workflow-launched agent-task nodes inherit the workflow key (`src/workflows/executors/agent-task.ts:98`): `effectiveKey = workflow.key;`
- App creation always uses the default key; the app-upsert tool has no key parameter (`src/apps/store.ts:120`): `defaultAssetKey("app", id),`
- Script insert always uses the default key; the script-upsert tool has no key parameter (`src/be/scripts/db.ts:134`): `defaultAssetKey("script", id),`
- defer-task creates a schedule with no key (default shared/schedule:<id>/) and links the deferred task via parentTaskId (`src/tools/defer-task.ts:365`): `parentTaskId: taskId,`
- Page-feedback tasks take the page's key (page to task direction) (`src/http/pages.ts:1000`): `key: page.key,`
- Skill tells agents to pass key explicitly for pages and to set it at the highest-level parent (`templates/skills/asset-namespaces/content.md:16`): `Pass 'key' when creating a task, workflow, schedule, or page.`
- Skill guidance on descendants inheriting (`templates/skills/asset-namespaces/content.md:58`): `3. Pass the key at the highest-level parent so descendants inherit it.`
- Only test asserting the page default key (DB-level createPage, not the tool) (`src/tests/asset-key-invariants.test.ts:86`): `'shared/page:${page.id}/',`
- MCP create_page test passes an explicit key (not the default) with a sourceTaskId (`src/tests/asset-key-mcp.test.ts:177`): `expect((page.structuredContent as { key?: string }).key).toBe(key);`
- Pages data model: key and agentId on the Page schema; no task id field (`src/types.ts:2842-2843`): `key: AssetKeySchema, agentId: z.string(),`
- Pages table unique on (agentId, slug); no task column (`src/be/migrations/059_pages.sql:30`): `UNIQUE (agentId, slug)`
- Pages key column added by migration 115 with default shared/ (`src/be/migrations/115_asset_namespace_keys.sql:11`): `ALTER TABLE pages ADD COLUMN "key" TEXT NOT NULL DEFAULT 'shared/';`
- Only task-to-page link is a task_attachments row with kind='page' and page_id (`src/be/migrations/072_task_attachments.sql:24`): `page_id TEXT, -- kind='page'`
- Page attachment is agent-supplied via store-progress (`src/tools/store-progress.ts:470`): `pageId: a.kind === "page" ? a.pageId : undefined,`

**Verifier:** 8/8 confirmed.

**Verifier: missed facts:**

- The per-resource page default was added inside PR #963's branch by commit 1fc15441f 'fix: preserve asset namespace compatibility' (desplega-bot, 2026-07-11, empty body). Before it, the branch used `export const DEFAULT_ASSET_KEY = "shared/" as const;` (src/assets/key.ts:1 in 8e6d6fea6) and the create-page tool description was 'Logical namespace (default shared/).' Run `git show 1fc15441f -- src/assets/key.ts src/tools/create-page.ts`.
- The shipped migration default is `ALTER TABLE pages ADD COLUMN "key" TEXT NOT NULL DEFAULT 'shared/';` (src/be/migrations/115_asset_namespace_keys.sql:11). Rows inserted at the SQL level without a key get `shared/`. The `shared/page:<id>/` leaf comes only from the createPage code path.
- The HTTP page routes also never read a task key. POST /api/pages uses `parsed.body.key ? await authorizeAssetKeyWrite(...) : undefined` (src/http/pages.ts:631-634). PUT /api/pages/:id applies `key` only when `parsed.body.key !== undefined` (src/http/pages.ts:876-877).
- Default task keys are not simply `shared/task:<id>/`. createTaskExtended computes `options?.key ?? (options?.parentTaskId ? null : sessionSourceKey({...})) ?? defaultAssetKey("task", id)` (src/be/db.ts:2883-2894). It derives a key from the Slack channel/thread or contextKey when there is no parent. Pages have no such session-source derivation. `SESSION_LEAF_KINDS` is `["task", "thread", "schedule", "workflow"]` and omits page (src/assets/key.ts:92).
- Child-task inheritance block at src/be/db.ts:2691-2694 (`if (parent.key && !options.key) { options.key = parent.key; keyInherited = true; }`) sits inside `if (options?.parentTaskId)` at 2547. The INSERT then re-reads the parent's current key under the write lock (db.ts:2923-2931) so a concurrent key move cannot leave a child stale.
- Schedule-run inheritance is at src/scheduler/schedule-task.ts:66 (`key: schedule.key,`). Workflow-launched task inheritance is at src/workflows/executors/agent-task.ts:98 and 112 (`effectiveKey = workflow.key;` then `key: effectiveKey,`). The answer cited no file:line for either.
- defer-task: the deferred wake-up schedule is created with no key, so it gets `shared/schedule:<id>/` (src/be/db.ts:6268). defer-task passes `parentTaskId: taskId` (src/tools/defer-task.ts:365) and the wake-up task is created with `key: schedule.key` (schedule-task.ts:66) plus `parentTaskId: schedule.parentTaskId` (schedule-task.ts:~90). Because `options.key` is already set from the schedule, the db.ts:2691 parent-key inheritance does not fire for deferred wake-ups. So the deferred task's key is the schedule's `shared/schedule:<id>/`, not the parent task's key. This refines the answer's statement that defer-task's parentTaskId is read only if !options.key.
- send-task inheritance is at src/tools/send-task.ts:470 (`const requestedKey = key ?? effectiveParentTask?.key;`). The key param description is at send-task.ts:88-90: 'Child tasks inherit their parent namespace when provided.' The effective parent defaults to the caller's current task.
- app-upsert and script-upsert expose no key param (grep for `key` in src/tools/app-upsert.ts and src/tools/script-upsert.ts returns nothing). They always use `defaultAssetKey("app"|"script", id)` (src/apps/store.ts:120, src/be/scripts/db.ts:134).
- Task attachments inherit the task key only for kind='agent-fs'. `insertTaskAttachment` calls `upsertAssetKeyMapping({... key: task.key, sourceEntityType: "task-attachment" ...})` only when `attachment.kind === "agent-fs"` (src/be/db.ts:1239-1255). A `kind='page'` attachment (inserted via store-progress, src/tools/store-progress.ts:470 `pageId: a.kind === "page" ? a.pageId : undefined`) stores only `page_id` (db.ts:1371, 1426) and does not change the page's key.
- Pages data model: `pages` table (src/be/migrations/059_pages.sql:16-31) has id, agentId, slug, title, description, contentType, authMode, passwordHash, body, needsCredentials, createdAt, updatedAt and `UNIQUE (agentId, slug)`. Later columns: `key` (migration 115, non-unique index `idx_pages_asset_key`), view count (062), theme/theme_tokens/design_version (269). `PageSchema` is at src/types.ts:2839-2860. There is no task column. `task_attachments` (src/be/migrations/072_task_attachments.sql:19-24) has `task_id`, `kind` CHECK including 'page', and `page_id`.
- Tests: the only assertion of the page default is src/tests/asset-key-invariants.test.ts:73-86 (`createPage` called directly, expects `shared/page:${page.id}/`). The tool-level test src/tests/asset-key-mcp.test.ts:171-177 passes an explicit `personal/<user>/automation/` key with a sourceTaskId and asserts it round-trips. src/tests/asset-key-api.test.ts:168 asserts an explicit `shared/team/` via HTTP. src/tests/create-page-tool.test.ts has no key assertions. No test asserts that create_page does NOT inherit the calling task's key.
- Docs state the same contract. templates/skills/asset-namespaces/content.md:16 says omitting `key` for a page gives `shared/page:<id>/`. docs-site/content/docs/(documentation)/guides/asset-namespaces.mdx:19 lists `shared/page:<id>/` among the standalone-resource defaults.

**Unknowns:**

- No commit message, PR body or thoughts doc states why create-page was left out of inheritance. #963 is a squash and its inner commits are not recoverable.
- I did not read the review threads on PR #963, only its body.
- The deferred wake-up claim comes from reading the code (schedule.key is always set, so the `!options.key` check in db.ts:2691 never fires). I did not run it.
- I did not check whether the UI or docs outside the asset-namespaces skill and guide say anything about page keys.

### Q10-checklist-favorites

**Findings (37):**

- Onboarding state lives in swarm_config under a fixed key; the global-scope row makes it per-swarm (`src/be/onboarding.ts:14`): `const ONBOARDING_CONFIG_KEY = "onboarding_state";`
- State is loaded from the global-scope swarm_config row (`src/be/onboarding.ts:461`): `const rows = await getSwarmConfigs({ scope: "global", key: ONBOARDING_CONFIG_KEY });`
- State is persisted as JSON into the same global swarm_config row (`src/be/onboarding.ts:477-481`): `description: "Internal first-run onboarding state",`
- The key is internal and the generic config API refuses it (`src/be/swarm-config-guard.ts:93-95`): `export const INTERNAL_CONFIG_KEYS = new Set([ "onboarding_state",`
- OnboardingSignals shape is defined as a zod schema (`src/be/onboarding.ts:151`): `export const OnboardingSignalsSchema = z.object({`
- Signals are built per request by buildSignals in the HTTP layer; agents come from ready lead/worker counts (`src/http/onboarding.ts:110-154`): `leadsOnline: agentCounts.leads,`
- Integration signals derive from automation setup states and env tokens (`src/http/onboarding.ts:143-150`): `github: Boolean(process.env.GITHUB_TOKEN?.trim()) || integrations.github === "verified",`
- firstTask and files signals (`src/http/onboarding.ts:155-156`): `files: { enabled: isCombEnabled() },`
- PUT /api/onboarding is the action route, gated by config.write.any (`src/http/onboarding.ts:171-177`): `rbac: { permission: "config.write.any" },`
- Dismiss action exists in the action union (dismiss/minimize/resume/view/skip also there) (`src/be/onboarding.ts:272`): `z.object({ action: z.literal("dismiss") }).strict(),`
- Dismiss action sets dismissedAt and emits telemetry (`src/be/onboarding.ts:706-710`): `if (state.dismissedAt) return false;`
- Existing installs start already completed (autoCompleted) (`src/be/onboarding.ts:372`): `completedAt: autoCompleted ? now : null,`
- completedAt is set only when the first task's tree settles (derived) (`src/be/onboarding.ts:635`): `if (!state.completedAt) state.completedAt = new Date().toISOString();`
- Finished means completedAt or autoCompleted (`apps/ui/src/api/hooks/use-onboarding.ts:125`): `return Boolean(state.completedAt || state.autoCompleted);`
- isOnboardingOpen is false when finished or dismissed (`apps/ui/src/api/hooks/use-onboarding.ts:131`): `return !isOnboardingFinished(data.state) && !data.state.dismissedAt;`
- Onboarding has its own fixed 8-step list in the UI (`apps/ui/src/api/hooks/visible-onboarding-steps.ts:11-12`): `export const ONBOARDING_STEPS: ReadonlyArray<OnboardingStepDef> = [`
- Prompt templates are registered in an in-memory registry with declared variables (`src/prompts/registry.ts:22`): `variables: VariableDefinition[];`
- The base prompt passes only name, role, agentId and persona as dynamic variables to the composite template (`src/prompts/base-prompt.ts:213-234`): `const compositeResult = await resolveTemplateAsync(compositeEventType, vars);`
- Workers resolve templates through the API render endpoint with caller-supplied variables (`src/http/prompt-templates.ts:133-143`): `summary: "Full scope-aware template resolution with interpolation (used by workers via HTTP)",`
- Interpolation is plain {{path}} replacement from a context object (`src/utils/template.ts:22`): `const INTERPOLATION_TOKEN_RE = /\{\{([^}]+)\}\}/g;`
- Heartbeat template gets per-swarm data as the system_status variable (`src/heartbeat/heartbeat.ts:1847`): `system_status: systemStatus,`
- Setup milestones exist separately in /status, not in a prompt (`src/http/status.ts:57-69`): `export const SetupMilestoneIdSchema = z.enum([`
- Migration 105 created user_favorites with a CHECK on item type (`src/be/migrations/105_user_favorites.sql:8`): `CHECK (itemType IN ('page','workflow','schedule'))`
- Migration 116 rebuilt the table with favoriteScope and a nullable userId (`src/be/migrations/116_favorite_principal_scope.sql:10-11`): `favoriteScope TEXT NOT NULL,`
- Migration 192 rebuilt the table to add agent-fs-path to the CHECK (`src/be/migrations/192_favorites_agent_fs_path.sql:10`): `CHECK (itemType IN ('page','workflow','schedule','agent-fs-path'))`
- Migration 205 is data-only: copies operator rows to every active user and deletes orphans (`src/be/migrations/205_favorites_per_dashboard_user.sql:21-22`): `WHERE f.favoriteScope = 'operator'`
- The zod item type enum is the server-side source list (`src/types.ts:1224`): `export const FavoriteItemTypeSchema = z.enum(["page", "workflow", "schedule", "agent-fs-path"]);`
- PUT /api/favorites is rbac-gated by favorite.write.own; GET /api/favorites is also defined (`src/http/favorites.ts:37`): `rbac: { permission: "favorite.write.own" },`
- Scope resolution: user-bound requests own user:<id> (`src/http/favorite-owner.ts:48`): `return { scope: 'user:${requestUserId}', userId: requestUserId, actorId: requestUserId };`
- Operator-key requests with no picked active user fall back to the shared operator scope (`src/http/favorite-owner.ts:64`): `scope: "operator",`
- Dashboard picked-user header (`src/http/favorite-owner.ts:17`): `export const DASHBOARD_USER_HEADER = "x-swarm-user-id";`
- Entity deletes remove favorites manually because there is no FK to the entity (`src/be/db.ts:7951`): `await client.run("DELETE FROM user_favorites WHERE itemType = 'workflow' AND itemId = ?", [id]);`
- UI type union duplicates the item type list (`apps/ui/src/api/types.ts:1006`): `export type FavoriteItemType = "page" | "workflow" | "schedule" | "agent-fs-path";`
- UI hook maps each item type to the query keys to refresh (typed as Record over FavoriteItemType) (`apps/ui/src/api/hooks/use-favorites.ts:13-19`): `const ENTITY_QUERY_KEYS: Record<FavoriteItemType, string[]> = {`
- Pin consumer uses agent-fs-path as a literal (`apps/ui/src/api/hooks/use-comb-favorites.ts:67`): `const dashboard = useFavorites("agent-fs-path");`
- openapi.json and generated docs-site types embed the enum (4 places in openapi.json) (`openapi.json:2279`): `"agent-fs-path"`
- Highest numbered migration is 278 (217 numbered files) (`src/be/migrations/278_slack_render_v2_reconcile.sql:1`): `278_slack_render_v2_reconcile.sql`

**Verifier:** 8/8 confirmed.

**Verifier: missed facts:**

- src/be/db.ts:6811-6813: upsertSwarmConfig only rejects RESERVED keys, not INTERNAL ones. That is why persistState (src/be/onboarding.ts:476-482) can write onboarding_state directly while the HTTP/MCP config surfaces refuse it. Quote: "if (isReservedConfigKey(data.key)) {".
- src/be/onboarding.ts:728-755 (readOrUpdateOnboarding): GET runs a readOnly transaction and only persists when the derived state is dirty. PUT applies the action, rebuilds signals via loadSignals(state), runs deriveState, then persists. Signals therefore both feed the response AND auto-complete steps. Quote: "const read = await client.transaction(async () => await loadAndDerive(loadSignals, []), {".
- src/be/onboarding.ts:629-635: completedAt is set only when signals.firstTask.status === "completed" and the task tree is settled (isTaskTreeSettled). Quote: "if (!state.completedAt) state.completedAt = new Date().toISOString();". The answer states this correctly but cites no line.
- src/be/onboarding.ts:365-373: freshState sets completedAt = now and autoCompleted = true when isExistingInstall() is true. Quote: "completedAt: autoCompleted ? now : null,". The answer's 'autoCompleted is set at creation for an existing install' matches.
- apps/ui/src/api/hooks/use-onboarding.ts:124-132: isOnboardingOpen is a UI-side function, not server-side. Quote: "return !isOnboardingFinished(data.state) && !data.state.dismissedAt;" with isOnboardingFinished = Boolean(state.completedAt || state.autoCompleted). The answer's closed-condition is accurate, but minimizedAt does not close it; the dismiss action sets dismissedAt (src/be/onboarding.ts:707-708) and resume clears it (704).
- src/be/onboarding.ts:365-410 and the step schema: OnboardingState has version: 1, startedAt, currentStep, minimizedAt, dismissedAt, completedAt, autoCompleted, firstTaskId, and a steps map (connect, name, ... ai, memory, files, first_task). This is a fixed set of onboarding steps, not an editable checklist or a favorites store.
- Migration tail check: highest numbered file in src/be/migrations is 278_slack_render_v2_reconcile.sql (273 and 276/277 are absent, so there are gaps). The answer's '278' is correct.

**Unknowns:**

- Whether any agent MCP tool or seeded skill exposes /api/onboarding or the /status setup milestones to agents (I only searched src/prompts, src/tools, src/heartbeat and templates/skills content.md; no hits for onboarding there).
- Whether the heartbeat system_status text (built in src/heartbeat/heartbeat.ts) includes setup milestones. I did not read the status builder.
- Line 1 of the 278 migration file was not read. The quote is the file name, and the number of numbered migration files (217) comes from a directory listing.
- I did not enumerate test files or e2e scenarios that hard-code the favorites item type list beyond noting src/tests/favorites*.test.ts and scripts/e2e/scenarios/core-preferences.ts exist.
