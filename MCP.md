# MCP Tools Reference

> Auto-generated from source. Do not edit manually.
> Run `bun run docs:mcp` to regenerate.

## Table of Contents

- [Core Tools](#core-tools)
  - [join-swarm](#join-swarm)
  - [poll-task](#poll-task)
  - [get-swarm](#get-swarm)
  - [get-tasks](#get-tasks)
  - [get-metrics](#get-metrics)
  - [send-task](#send-task)
  - [get-task-details](#get-task-details)
  - [store-progress](#store-progress)
  - [my-agent-info](#my-agent-info)
  - [cancel-task](#cancel-task)
  - [resolve-user](#resolve-user)
  - [manage-user](#manage-user)
  - [db-query](#db-query)
  - [get-oauth-access-token](#get-oauth-access-token)
  - [set-config](#set-config)
  - [get-config](#get-config)
  - [list-config](#list-config)
  - [delete-config](#delete-config)
  - [credential-bindings](#credential-bindings)
  - [get-repos](#get-repos)
  - [update-repo](#update-repo)
  - [list-prompt-templates](#list-prompt-templates)
  - [get-prompt-template](#get-prompt-template)
  - [set-prompt-template](#set-prompt-template)
  - [delete-prompt-template](#delete-prompt-template)
  - [preview-prompt-template](#preview-prompt-template)
  - [script-search](#script-search)
  - [script-connections](#script-connections)
  - [script-apis](#script-apis)
  - [script-run](#script-run)
  - [script-upsert](#script-upsert)
  - [script-delete](#script-delete)
  - [script-query-types](#script-query-types)
  - [swarm_x](#swarm_x)
  - [slack-reply](#slack-reply)
  - [slack-read](#slack-read)
  - [slack-post](#slack-post)
  - [slack-start-thread](#slack-start-thread)
  - [slack-list-channels](#slack-list-channels)
  - [slack-upload-file](#slack-upload-file)
  - [slack-download-file](#slack-download-file)
  - [slack-delete](#slack-delete)
  - [slack-update](#slack-update)
  - [register-agentmail-inbox](#register-agentmail-inbox)
  - [register-kapso-number](#register-kapso-number)
  - [unregister-kapso-number](#unregister-kapso-number)
  - [send-whatsapp-message](#send-whatsapp-message)
  - [reply-whatsapp-message](#reply-whatsapp-message)
- [Task Pool Tools](#task-pool-tools)
  - [task-action](#task-action)
- [Messaging Tools](#messaging-tools)
  - [list-channels](#list-channels)
  - [create-channel](#create-channel)
  - [delete-channel](#delete-channel)
- [Profiles Tools](#profiles-tools)
  - [update-profile](#update-profile)
  - [context-history](#context-history)
  - [context-diff](#context-diff)
- [Services Tools](#services-tools)
  - [register-service](#register-service)
  - [unregister-service](#unregister-service)
  - [list-services](#list-services)
  - [update-service-status](#update-service-status)
- [Scheduling Tools](#scheduling-tools)
  - [list-schedules](#list-schedules)
  - [create-schedule](#create-schedule)
  - [update-schedule](#update-schedule)
  - [patch-schedule](#patch-schedule)
  - [delete-schedule](#delete-schedule)
  - [run-schedule-now](#run-schedule-now)
- [Memory Tools](#memory-tools)
  - [memory-search](#memory-search)
  - [memory-get](#memory-get)
  - [memory-edit](#memory-edit)
  - [memory-delete](#memory-delete)
  - [memory_rate](#memory_rate)
  - [inject-learning](#inject-learning)
- [Workflows Tools](#workflows-tools)
  - [create-workflow](#create-workflow)
  - [list-workflows](#list-workflows)
  - [get-workflow](#get-workflow)
  - [update-workflow](#update-workflow)
  - [patch-workflow](#patch-workflow)
  - [patch-workflow-node](#patch-workflow-node)
  - [delete-workflow](#delete-workflow)
  - [trigger-workflow](#trigger-workflow)
  - [list-workflow-runs](#list-workflow-runs)
  - [get-workflow-run](#get-workflow-run)
  - [retry-workflow-run](#retry-workflow-run)
  - [cancel-workflow-run](#cancel-workflow-run)
  - [request-human-input](#request-human-input)
- [Pages Tools](#pages-tools)
  - [create_page](#create_page)
  - [delete-page](#delete-page)
- [Kv Tools](#kv-tools)
  - [kv-get](#kv-get)
  - [kv-set](#kv-set)
  - [kv-delete](#kv-delete)
  - [kv-incr](#kv-incr)
  - [kv-list](#kv-list)
- [Other Tools](#other-tools)

---

## Core Tools

*Always available tools for basic swarm operations.*

### join-swarm

**Join the agent swarm**

Tool for an agent to join the swarm of agents with optional profile information.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `requestedId` | `string` | No | - | Requested ID for the agent (overridden by X-Agent-ID header). |
| `lead` | `boolean` | No | false | Whether this agent should be the lead. |
| `name` | `string` | Yes | - | The name of the agent joining the swarm. |
| `description` | `string` | No | - | Agent description. |
| `role` | `string` | No | - | Agent role (free-form, e.g., 'frontend dev', 'code reviewer'). |
| `capabilities` | `array` | No | - | List of capabilities (e.g., ['typescript', 'react', 'testing']). |

### poll-task

**Poll for a task**

Poll for a new task assignment. Returns immediately if there are offered tasks awaiting accept/reject. Also returns count of unassigned tasks in the pool.

*No parameters*

### get-swarm

**Get the agent swarm**

Returns a list of agents in the swarm without their tasks. Identity markdown (claudeMd/soulMd/identityMd/toolsMd/heartbeatMd/setupScript) is omitted by default — pass includeFull:true to include it.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `a` | `string` | No | - | - |
| `includeFull` | `boolean` | No | - | Include the six identity-markdown blobs (claudeMd/soulMd/identityMd/toolsMd/heartbeatMd/setupScript). Default false — they are large and rarely needed at the swarm-overview level. |

### get-tasks

**Get tasks**

Returns a list of tasks in the swarm with various filters. Sorted by priority (desc) then lastUpdatedAt (desc). Each row carries a `taskPreview` (~300 chars) — enough to pool-triage; pass includeFull:true (or call `get-task-details` by id) for the full `task` text.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | `unknown` | No | - | Filter by task status (unassigned, offered, pending, in_progress, completed, failed). |
| `mineOnly` | `boolean` | No | - | Only return tasks assigned to you. |
| `unassigned` | `boolean` | No | - | Only return unassigned tasks in the pool. |
| `offeredToMe` | `boolean` | No | - | Only return tasks offered to you (awaiting accept/reject). |
| `readyOnly` | `boolean` | No | - | Only return tasks whose dependencies are met. |
| `taskType` | `string` | No | - | Filter by task type (e.g., 'bug', 'feature'). |
| `tags` | `array` | No | - | Filter by any matching tag. |
| `search` | `string` | No | - | Search in task description. |
| `scheduleId` | `string` | No | - | Filter by schedule ID to find tasks created by a specific schedule. |
| `key` | `unknown` | No | - | Filter by exact logical namespace. |
| `keyPrefix` | `unknown` | No | - | Filter by namespace subtree. |
| `includeHeartbeat` | `boolean` | No | - | Include heartbeat/system tasks in results (excluded by default). |
| `limit` | `number` | No | - | Max tasks to return (default: 25, max: 100). |
| `includeFull` | `boolean` | No | - | Return the full `task` text instead of a ~300-char `taskPreview`. Default false. |

### get-metrics

**Get swarm metrics**

Returns lightweight swarm-wide counts in a single object — tasks (total + by status), agents (total + by status), workflows (total + enabled), pages, active sessions, skills. Use this instead of fetching full list payloads just to count things. Pure COUNT queries; cheap.

*No parameters*

### send-task

**Send a task**

Sends a task to a specific agent, creates an unassigned task for the pool, or offers a task for acceptance.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `uuid` | No | - | The agent to assign/offer task to. Omit to create unassigned task for pool. |
| `task` | `string` | Yes | - | The task description to send. |
| `key` | `unknown` | No | - | Logical namespace key. Child tasks inherit their parent namespace when provided. |
| `offerMode` | `boolean` | No | false | If true, offer the task instead of direct assign (agent must accept/reject). |
| `taskType` | `string` | No | - | Task type (e.g., 'bug', 'feature', 'review'). |
| `tags` | `array` | No | - | Tags for filtering (e.g., ['urgent', 'frontend']). |
| `requiredCapabilities` | `array` | No | - | Capabilities a claiming agent must have (declared via join-swarm/update-profile) to be pool-eligible for this task. Written into the created task's routingAffinity (role is left unset — only enforced when the pool auto-claim/claim-tool paths check it). Most useful when omitting agentId (unassigned pool task); a no-op for a task with an explicit agentId, which bypasses the pool gate entirely. |
| `priority` | `number` | No | - | Priority 0-100 (default: 50). |
| `dependsOn` | `array` | No | - | Task IDs this task depends on. |
| `parentTaskId` | `uuid` | No | - | Parent task ID for session continuity. Child task will resume the parent's Claude session. Auto-routes to the same worker unless agentId is explicitly provided. |
| `dir` | `string` | No | - | Working directory (absolute path) for the agent to start in. If the directory doesn't exist, falls back to the default working directory. |
| `vcsRepo` | `string` | No | - | VCS repo identifier (e.g., 'desplega-ai/agent-swarm' for GitHub or 'group/project' for GitLab). Links the task to a registered repo for workspace context. |
| `model` | `string` | No | - | Concrete model override for this task, interpreted by the assignee's harness/provider. This does not switch providers. Prefer modelTier for portable intent. |
| `modelTier` | `unknown` | No | - | Portable model tier for this task: 'smol', 'regular', 'smart', or 'ultra'. Resolved at claim/run time using the assignee's harness/provider. Legacy model shortnames map as haiku→smol, sonnet→regular, opus→smart, fable→ultra. |
| `effort` | `unknown` | No | - | Reasoning effort for this task: 'off', 'low', 'medium', 'high', 'xhigh', or 'max'. If omitted, the assignee's REASONING_EFFORT_OVERRIDE/default applies. |
| `allowDuplicate` | `boolean` | No | false | If true, skip duplicate detection and create the task even if a similar one exists. |
| `slackChannelId` | `string` | No | - | Slack channel ID to post progress updates to. Use this to propagate Slack context when delegating from a Slack thread. |
| `slackThreadTs` | `string` | No | - | Slack thread timestamp. Required with slackChannelId for thread-level updates. |
| `slackUserId` | `string` | No | - | Slack user ID of the original requester. |
| `overrideSlackContext` | `boolean` | No | false | Explicitly route this task's Slack updates to a different channel/thread than its parent/contextKey. Requires slackChannelId AND slackThreadTs. Use only for deliberate cross-channel dispatch (e.g. escalation to another human's DM); logged for audit. Without this flag, a slackChannelId/slackThreadTs that disagrees with the parent task or inherited contextKey is rejected — omit the three Slack fields to inherit them from the parent as a unit instead. |
| `requestedByUserId` | `string` | No | - | ID of the human user who originally requested this task chain. When omitted, inherited from the caller's current task so the attribution flows through multi-hop delegation automatically. |
| `followUpConfig` | `unknown` | No | - | Control the lead follow-up created when this task finishes. When to use `followUpConfig`: set `disabled: true` when you'll wait for this task to complete inline and no follow-up is needed; set `onCompleted` / `onFailed` with specific instructions when you need to follow up effectively on a particular outcome of a long-running flow; for normal one-shot tasks, leave it unset because defaults are fine. It is most valuable for long-running / complex flows. |

### get-task-details

**Get task details**

Returns detailed information about a specific task, including output, failure reason, and log history.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | `uuid` | Yes | - | The ID of the task to get details for. |

### store-progress

**Store task progress**

Stores the progress of a specific task. Can also mark task as completed or failed, which will set the agent back to idle.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | `uuid` | Yes | - | The ID of the task to update progress for. |
| `progress` | `string` | No | - | The progress update to store. |
| `status` | `completed \| failed` | No | - | Set to 'completed' or 'failed' to finish the task. |
| `output` | `string` | No | - | The output of the task (used when completing). |
| `failureReason` | `string` | No | - | The reason for failure (used when failing). |
| `attachments` | `array` | No | - | Pointer-based artifacts produced by this step — agent-fs path, URL, shared-fs path, or swarm Page. No inline file data; upload to agent-fs first and attach by path. May be sent on any call (progress or completion) and accumulates across calls; duplicates are de-duped by sha256 (when present) or by (kind, pointer, name). |
| `persistMemory` | `boolean` | No | - | Opt in to task_completion memory persistence for automatic/recurring tasks. Manual tasks are persisted by default; scheduled, system, heartbeat/boot-triage, monitor, and digest tasks are skipped unless this is true. |

### my-agent-info

**Get your agent info**

Returns your agent ID based on the X-Agent-ID header.

*No parameters*

### cancel-task

**Cancel Task**

Cancel a task that is pending or in progress. Only the lead or task creator can cancel tasks. The worker will be notified via hooks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | `uuid` | Yes | - | The ID of the task to cancel. |
| `reason` | `string` | No | - | Reason for cancellation. |

### resolve-user

**Resolve user identity**

Provider-agnostic reverse lookup: (kind, externalId) → user, e.g. {kind: 'slack', externalId: 'U016H7XKZGS'} or {kind: 'github', externalId: 'octocat'} — the same shape for every provider, no per-provider keys. Also accepts email (primary or alias), userId (reverse lookup of all linked identities), or name (exact/prefix search). A miss returns a structured {status: 'unknown', ...} payload, never prose; an ambiguous name search returns {status: 'ambiguous', candidates: [...]}.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `kind` | `string` | No | - | Identity kind — e.g. 'slack', 'linear', 'github', 'gitlab', 'jira', 'kapso', 'whatsapp', or a custom value. Must be paired with externalId. |
| `externalId` | `string` | No | - | Platform-specific identifier for the given kind (e.g. Slack user ID 'U08NR6QD6CS', Linear user UUID, GitHub login, Jira accountId). |
| `email` | `string` | No | - | Email address (primary or alias). |
| `userId` | `string` | No | - | Canonical swarm user ID. Use this to reverse-look up all external identities for a known user (e.g. find their GitHub handle from a requestedByUserId). |
| `name` | `string` | No | - | Human display name to search for (exact, or first-token prefix). Convenience only — ambiguous matches return all candidates rather than picking one. |

### manage-user

**Manage user profiles**

Create, update, delete, or list user profiles in the user registry. Identities are managed via an `identities: [{kind, externalId}]` array (declarative — update computes diff). Lead-only.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `create \| update \| delete \| list \| get` | Yes | - | Action to perform |
| `userId` | `string` | No | - | User ID (required for update/delete/get) |
| `name` | `string` | No | - | Display name (required for create) |
| `email` | `string` | No | - | Primary email address |
| `role` | `string` | No | - | Role (e.g., "founder", "engineer") |
| `notes` | `string` | No | - | Free-form notes |
| `identities` | `array` | No | - | List of platform identities to link. On create: every entry is linked. On update: the list is treated as the desired set — entries not currently linked are added (identity_added), entries currently linked but missing are removed (identity_removed). |
| `emailAliases` | `array` | No | - | Additional email addresses |
| `preferredChannel` | `string` | No | - | Preferred contact channel |
| `timezone` | `string` | No | - | Timezone (e.g., America/New_York) |
| `dailyBudgetUsd` | `number` | No | - | Daily budget in USD (null clears the cap) |
| `status` | `invited \| active \| suspended` | No | - | User status — invited / active / suspended |
| `metadata` | `object` | No | - | Free-form JSON metadata (null clears the field) |

### db-query

**Execute database query**

Execute a read-only SQL query against the swarm database. Available to all authenticated agents — be aware results may include secrets (oauth_tokens, configs). Results capped at 100 rows.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sql` | `string` | No | - | SQL query (read-only only — writes are rejected) |
| `query` | `string` | No | - | Deprecated runtime alias for sql. |
| `params` | `array` | No | [] | Query parameters |

### get-oauth-access-token

**Get OAuth access token**

Return a valid plaintext OAuth access token for an integrated tracker. The token is refreshed first when it is near expiry. Returns access_token only; never returns refresh_token.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `string` | Yes | - | OAuth provider slug to read from oauth_tokens (for example: linear, jira). |
| `minValiditySeconds` | `number` | No | 300 | Minimum remaining token lifetime required before returning it. |

### set-config

**Set Config**

Set or update a swarm configuration value. Upserts by (scope, scopeId, key). Use scope='global' for server-wide settings, 'agent' for agent-specific, or 'repo' for repo-specific. Set isSecret=true to mask the value in API responses.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scope` | `unknown` | Yes | - | Config scope: 'global', 'agent', or 'repo'. |
| `scopeId` | `string` | No | - | Agent ID or repo ID. Required for 'agent' and 'repo' scopes, omit for 'global'. |
| `key` | `string` | Yes | - | Configuration key (e.g., 'AGENTMAIL_WEBHOOK_SECRET'). |
| `value` | `string` | Yes | - | Configuration value. |
| `isSecret` | `boolean` | No | - | If true, value is masked in API responses (default: false). |
| `envPath` | `string` | No | - | Optional: file path to write the value as KEY=VALUE in a .env file. |
| `description` | `string` | No | - | Optional human-readable description of this config entry. |

### get-config

**Get Config**

Get resolved configuration values with scope resolution (repo > agent > global). Returns one entry per unique key with the most-specific scope winning. Use includeSecrets=true to see secret values. IMPORTANT: never pass returned secret values directly on a command line — write them to a temp .env file and source it instead, so the literal value stays out of logged commands.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `string` | No | - | Agent ID for scope resolution. Omit for global-only configs. |
| `repoId` | `string` | No | - | Repo ID for scope resolution. Omit for agent/global-only configs. |
| `key` | `string` | No | - | Filter by specific key. If omitted, returns all resolved configs. |
| `includeSecrets` | `boolean` | No | - | If true, include actual secret values (default: false, secrets are masked). |

### list-config

**List Config**

List raw config entries with optional filters. Unlike get-config, this returns raw entries without scope resolution — useful for seeing exactly what's configured at each scope level.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scope` | `unknown` | No | - | Filter by scope: 'global', 'agent', or 'repo'. |
| `scopeId` | `string` | No | - | Filter by agent ID or repo ID. |
| `key` | `string` | No | - | Filter by specific key. |
| `includeSecrets` | `boolean` | No | - | If true, include actual secret values (default: false). |

### delete-config

**Delete Config**

Delete a swarm configuration entry by its ID. Use list-config to find config IDs first.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | The config entry ID to delete. |

### credential-bindings

**Credential Bindings**

Lead-only management for scripts-runtime credential broker bindings. Bindings map config keys to allowed egress hosts; scripts consume them only through fetch-layer placeholder substitution.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `list \| upsert \| disable \| import-legacy \| oauth-app-upsert \| oauth-authorize-url` | Yes | - | List, add/update, disable, import legacy JSON bindings, or register/authorize OAuth apps. |
| `id` | `string` | No | - | Existing credential binding ID for update or disable. |
| `configKey` | `string` | No | - | Swarm config key whose secret value is injected through templates. |
| `allowedHosts` | `array` | No | - | Allowed outbound hostnames for this binding. |
| `headerTemplate` | `string` | No | - | Header template containing the config-key placeholder. |
| `queryTemplate` | `string` | No | - | Query parameter template containing the config-key placeholder. |
| `scope` | `global \| agent \| repo` | No | "global" | Binding visibility scope. |
| `scopeId` | `unknown` | No | - | Agent UUID for agent scope or repo id (owner/name) for repo scope. |
| `authKind` | `config \| oauth` | No | "config" | Use config for stored swarm config secrets or oauth for OAuth token resolution. |
| `oauthProvider` | `string` | No | - | OAuth provider slug required when authKind is oauth. |
| `provider` | `string` | No | - | OAuth provider slug for oauth-app-upsert and oauth-authorize-url. |
| `clientId` | `string` | No | - | OAuth client ID for oauth-app-upsert. |
| `clientSecret` | `string` | No | - | OAuth client secret for oauth-app-upsert. |
| `authorizeUrl` | `string` | No | - | OAuth authorization URL for oauth-app-upsert. |
| `tokenUrl` | `string` | No | - | OAuth token URL for oauth-app-upsert. |
| `scopes` | `array` | No | - | OAuth scopes for oauth-app-upsert. |
| `extraParams` | `object` | No | - | Extra OAuth authorization parameters stored with the OAuth app. |
| `tokenAuthStyle` | `body \| basic` | No | - | How client credentials reach the token endpoint: body params (default) or HTTP Basic auth (required by e.g. Notion). |
| `tokenBodyFormat` | `form \| json` | No | - | Token request body encoding: form-urlencoded (default) or JSON (required by e.g. Notion). |

### get-repos

**Get Repos**

List registered repos with their guidelines (PR checks, merge policy, review guidance). Use the optional name filter to check a specific repo. The lead should use this to verify a repo has guidelines before routing tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | No | - | Filter by repo name. If omitted, returns all repos. |

### update-repo

**Update Repo**

Update a repo's configuration including guidelines (PR checks, merge policy, review guidance). The lead uses this to set guidelines after asking the user. Pass null for guidelines to clear them.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | The repo ID to update. |
| `url` | `string` | No | - | New repo URL. |
| `name` | `string` | No | - | New repo name. |
| `clonePath` | `string` | No | - | New clone path. |
| `defaultBranch` | `string` | No | - | New default branch. |
| `autoClone` | `boolean` | No | - | Whether to auto-clone. |
| `hooks` | `unknown` | No | - | Repository hook install config. Set { enabled: true } to opt into best-effort worker hook installation, or null to disable. |
| `guidelines` | `unknown` | No | - | Repository guidelines: prChecks (commands before PR), mergeChecks (conditions before merge), allowMerge (default false), review (guidance for reviewers). Pass null to clear. |

### list-prompt-templates

**List Prompt Templates**

List prompt templates with optional filters. Returns all templates matching the specified criteria, including defaults and overrides at all scope levels.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `eventType` | `string` | No | - | Filter by event type (e.g. 'github.pull_request.opened'). |
| `scope` | `unknown` | No | - | Filter by scope: 'global', 'agent', or 'repo'. |
| `scopeId` | `string` | No | - | Filter by scope ID (agent ID or repo ID). |
| `isDefault` | `boolean` | No | - | Filter by default status. |

### get-prompt-template

**Get Prompt Template**

Get a prompt template by ID, including its version history and the code-defined variable definitions for its event type.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | The prompt template ID. |

### set-prompt-template

**Set Prompt Template**

Create or update a prompt template override. Upserts by (eventType, scope, scopeId). Use scope='global' for server-wide, 'agent' for agent-specific, or 'repo' for repo-specific overrides.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `eventType` | `string` | Yes | - | Event type identifier (e.g. 'github.pull_request.opened'). |
| `scope` | `unknown` | No | - | Template scope: 'global' (default), 'agent', or 'repo'. |
| `scopeId` | `string` | No | - | Agent ID or repo ID. Required for 'agent' and 'repo' scopes, omit for 'global'. |
| `state` | `unknown` | No | - | Template state: 'enabled' (default), 'default_prompt_fallback', or 'skip_event'. |
| `body` | `string` | Yes | - | The template body text with {{variable}} placeholders. |
| `changeReason` | `string` | No | - | Reason for the change (recorded in history). |

### delete-prompt-template

**Delete Prompt Template**

Delete a prompt template override by ID. Cannot delete default templates — use reset instead. Use list-prompt-templates to find template IDs first.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | The prompt template ID to delete. |

### preview-prompt-template

**Preview Prompt Template**

Dry-run render a prompt template with provided variables. Optionally supply a custom body to preview before saving. Returns the interpolated text and any unresolved {{variable}} tokens.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `eventType` | `string` | Yes | - | Event type to preview (used to look up header and default body). |
| `body` | `string` | No | - | Custom body to preview instead of the default. |
| `variables` | `object` | No | - | Variables to interpolate into the template. |

### script-search

**Script Search**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | No | "" | Search query for reusable scripts. |
| `scope` | `unknown` | No | - | Optional script scope filter. |
| `limit` | `number` | No | 10 | Maximum results. |

### script-connections

**Script Connections**

Lead-only registry management for scripts ctx.api/ctx.mcp connections. Supports OpenAPI, MCP, and GraphQL script connections.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `list \| upsert-openapi \| upsert-mcp \| upsert-graphql \| refresh \| disable` | Yes | - | List, create/update, refresh, or disable a script connection. |
| `id` | `string` | No | - | Existing connection ID for update, refresh, or disable. |
| `slug` | `string` | No | - | Stable script namespace slug exposed under ctx.api or ctx.mcp. |
| `displayName` | `string` | No | - | Human-readable connection name. |
| `scope` | `global \| agent \| repo` | No | - | Connection visibility scope. |
| `scopeId` | `unknown` | No | - | Agent UUID for agent scope or repo id (owner/name) for repo scope. |
| `mcpServerId` | `string` | No | - | Registered MCP server ID for upsert-mcp connections. |
| `baseUrl` | `string` | No | - | Base URL for OpenAPI or GraphQL connections. |
| `allowedHosts` | `array` | No | - | Allowed outbound hostnames for credential substitution. |
| `credentialBindingId` | `string` | No | - | Existing credential binding ID to attach to the connection. |
| `configKey` | `string` | No | - | Config key used to create a credential binding when credentialBindingId is omitted. |
| `headerTemplate` | `string` | No | - | Header template containing the config-key placeholder. |
| `queryTemplate` | `string` | No | - | Query parameter template containing the config-key placeholder. |
| `openapiSpecUrl` | `string` | No | - | URL to fetch and store an OpenAPI spec for upsert-openapi and refresh. |
| `openapiSpecJson` | `string` | No | - | Inline OpenAPI JSON for upsert-openapi. Mutually exclusive with openapiSpecUrl. |
| `enabled` | `boolean` | No | - | Whether the connection is enabled. |

### script-apis

**Script APIs**

Manage external HTTP API endpoints for swarm scripts (POST /api/x/script/<id>). list/create/update/rotate/delete. Bearer tokens are masked ('********') on list unless includeSecrets=true; create and rotate always return the fresh plaintext token once — the only time it's visible without an explicit reveal.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `list \| create \| update \| rotate \| delete` | Yes | - | list: endpoints for a script, tokens masked unless includeSecrets=true. create: expose the script as a new endpoint (returns the plaintext token once). update: enable/disable or relabel an endpoint. rotate: issue a new token (returns it once). delete: remove an endpoint. |
| `scriptId` | `string` | Yes | - | The script the endpoint(s) belong to. |
| `endpointId` | `string` | No | - | Required for update, rotate, and delete. |
| `authMode` | `none \| bearer` | No | - | For create: 'bearer' (default, auto-generated token) or 'none' (no auth). |
| `label` | `string` | No | - | For create/update. |
| `agentId` | `string` | No | - | For create: the agent the endpoint runs as (its egress secrets + API connections apply). Defaults to the script's owning agent; required if the script has none. |
| `enabled` | `boolean` | No | - | For update: enable or disable the endpoint. |
| `includeSecrets` | `boolean` | No | - | For list only: reveal real bearer tokens (default: false — tokens come back masked as '********', mirroring get-config's includeSecrets). |

### script-run

**Script Run**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `unknown` | No | - | Name of a reusable script to run. |
| `source` | `string` | No | - | Inline TypeScript source to run. |
| `args` | `unknown` | No | - | JSON-serializable script arguments. |
| `intent` | `string` | No | "" | Why this script is being run. |
| `scope` | `unknown` | No | - | Optional scope for named script resolution. |
| `fsMode` | `unknown` | No | "none" | Filesystem mode. v1 supports none only. |
| `idempotencyKey` | `string` | No | - | When set, output is auto-persisted to kv under script:executions/{key}. Re-running with the same key overwrites. Queryable via kv-get. |

### script-upsert

**Script Upsert**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `unknown` | Yes | - | Stable script name within the selected scope. |
| `source` | `string` | Yes | - | TypeScript source with a default export function. |
| `description` | `string` | No | "" | Human-readable script description. |
| `intent` | `string` | No | "" | Why this script exists. |
| `scope` | `unknown` | No | "agent" | Persist under agent or global scope. |
| `fsMode` | `unknown` | No | "none" | Filesystem mode. v1 supports none only. |

### script-delete

**Script Delete**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `unknown` | Yes | - | Script name to delete. |
| `scope` | `unknown` | No | "agent" | Script scope to delete from. |

### script-query-types

**Script Query Types**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `unknown` | Yes | - | Script name whose signature should be fetched. |
| `scope` | `unknown` | No | - | Optional scope for script resolution. |

### swarm_x

**Swarm X**

Execute an Agent Swarm external command route. v1 supports target='composio' and mirrors `agent-swarm x composio <method> <path>` with the Composio API key injected server-side.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `target` | `unknown` | No | "composio" | External route target. Only 'composio' is supported in v1. |
| `method` | `unknown` | Yes | - | HTTP method to route to Composio. |
| `path` | `string` | Yes | - | Composio API path relative to the configured base URL, e.g. /tool_router/session. |
| `body` | `unknown` | No | - | Optional JSON request body. |
| `query` | `object` | No | - | Optional query parameters appended to the Composio path. |
| `headers` | `object` | No | - | Optional extra headers. Auth headers are injected by the server. |
| `baseUrl` | `string` | No | - | Optional Composio API base URL override. |
| `useOrgKey` | `boolean` | No | false | Use COMPOSIO_ORG_API_KEY/x-org-api-key instead of COMPOSIO_API_KEY/x-api-key. |
| `raw` | `boolean` | No | false | Return raw text instead of JSON-pretty output text. |

### slack-reply

**Reply to Slack thread**

Send a reply to a Slack thread. Use inboxMessageId for inbox messages, or taskId for task-related threads.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inboxMessageId` | `uuid` | No | - | The inbox message ID to reply to (for leads responding to inbox). |
| `taskId` | `uuid` | No | - | The task ID with Slack context (for task-related threads). |
| `message` | `string` | Yes | - | The message to send to the Slack thread. |

### slack-read

**Read Slack thread/channel history**

Read messages from a Slack thread or channel. Use inboxMessageId or taskId to read from a thread you have context for, or provide channelId directly for channel history (leads only).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inboxMessageId` | `uuid` | No | - | Read thread history for an inbox message. |
| `taskId` | `uuid` | No | - | Read thread history for a task. |
| `channelId` | `string` | No | - | Slack channel ID to read from (requires lead privileges). |
| `threadTs` | `string` | No | - | Thread timestamp (required with channelId for thread history). |
| `limit` | `number` | No | 20 | Maximum number of messages to retrieve (default: 20, max: 100). |
| `includeFiles` | `boolean` | No | true | Include file attachments in the response (default: true). |

### slack-post

**Post message to Slack channel**

Post a message to a Slack channel. By default creates a new top-level message; pass `threadTs` to post as a threaded reply under an existing message (obtain the ts from `slack-start-thread`). Requires lead privileges.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channelId` | `string` | Yes | - | The Slack channel ID to post to. |
| `message` | `string` | Yes | - | The message content to post. |
| `threadTs` | `string` | No | - | Optional parent message ts to thread under. Obtain via `slack-start-thread`. When omitted, posts as a new top-level message. |

### slack-start-thread

**Start a new Slack thread**

Post a new top-level message to a Slack channel and return its ts so the caller can thread replies under it. Pass the returned `ts` as `threadTs` on subsequent `slack-post` calls to keep replies in the same thread. Requires lead privileges.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channelId` | `string` | Yes | - | The Slack channel ID to post to. |
| `message` | `string` | Yes | - | The message content to post. |

### slack-list-channels

**List Slack channels**

List Slack channels the bot is a member of. Use this to discover available channels for reading messages.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `types` | `array` | No | - | Filter by channel types. Options: public (public channels), private (private channels), dm (direct messages), mpim (group DMs). Default: all types. |
| `limit` | `number` | No | 100 | Maximum number of channels to retrieve (default: 100, max: 200). |

### slack-upload-file

**Upload file to Slack**

Upload a file (image, document, etc.) to a Slack channel or thread. Use inboxMessageId or taskId for context, or provide channelId directly (leads only). Maximum file size is 1 GB.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inboxMessageId` | `uuid` | No | - | The inbox message ID for thread context (leads only). |
| `taskId` | `uuid` | No | - | The task ID with Slack context (for task-related threads). |
| `channelId` | `string` | No | - | Direct channel ID to upload to (requires lead privileges). |
| `threadTs` | `string` | No | - | Thread timestamp to upload as a thread reply (used with channelId). |
| `filePath` | `string` | No | - | Path to the file to upload. Either filePath OR content must be provided. IMPORTANT: the file is read on the API server's filesystem (where this tool runs), NOT on the caller's. Worker/lead containers do NOT share /tmp or /workspace/personal/ with the API server — the only shared volume is /workspace/shared/. Use /workspace/shared/<agent-id>/file.png (or a relative path like 'shared/<agent-id>/file.png'). For files that only live on the caller (e.g. /tmp), pass them inline via `content` (base64) instead. |
| `content` | `string` | No | - | Base64-encoded file content. Use this when the file lives on the caller's filesystem and isn't reachable by the API server (e.g. anything under /tmp on a worker/lead container). Either filePath OR content must be provided. |
| `filename` | `string` | No | - | Name to give the file in Slack. Required when using content, defaults to original filename when using filePath. |
| `initialComment` | `string` | No | - | Optional message to post with the file. |

### slack-download-file

**Download file from Slack**

Download a file from Slack by file ID or URL. Files are saved to the agent's download directory on the shared disk by default.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `fileId` | `string` | No | - | The Slack file ID to download (e.g., 'F0RDC39U1'). |
| `url` | `string` | No | - | Direct URL to download (url_private_download from a file object). |
| `savePath` | `string` | No | - | Where to save the file. Can be a directory or full path. Defaults to /workspace/shared/downloads/{agentId}/slack/ |
| `filename` | `string` | No | - | Filename to use when saving. Only used if savePath is a directory. |

### slack-delete

**Delete a Slack message**

Deletes a Slack message that THIS bot authored (e.g. a message previously posted via `slack-post`/`slack-reply`). Cannot delete messages authored by humans or other apps. Requires lead privileges.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channelId` | `string` | Yes | - | The Slack channel ID the message is in. |
| `messageTs` | `string` | Yes | - | Timestamp of the message to delete. Accepts the dotted form (1783411554.596189), the 'p' deep-link form (p1783411554596189), or a full Slack permalink URL. |

### slack-update

**Edit a Slack message**

Edits (in place) the text of a Slack message that THIS bot authored — use it to post corrections to your own messages. Cannot edit messages authored by humans or other apps. Note: editing may reset the message's display name/icon to the app default (Slack's chat.update cannot set the crown persona). Requires lead privileges.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channelId` | `string` | Yes | - | The Slack channel ID the message is in. |
| `messageTs` | `string` | Yes | - | Timestamp of the message to edit (dotted, 'p' deep-link, or full permalink URL). |
| `message` | `string` | Yes | - | The new message content. |

### register-agentmail-inbox

**Register AgentMail Inbox**

Register an AgentMail inbox ID to route incoming emails to this agent. When emails arrive at this inbox, they will be routed to you as tasks (for workers) or inbox messages (for leads). Use action 'register' to add a mapping, 'unregister' to remove one, or 'list' to see your current mappings.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `register \| unregister \| list` | Yes | - | Action to perform: register, unregister, or list inbox mappings. |
| `inboxId` | `string` | No | - | The AgentMail inbox ID (e.g., 'inb_xxx'). Required for register/unregister. |
| `inboxEmail` | `string` | No | - | Optional email address for this inbox (for reference only). |

### register-kapso-number

**Register Kapso WhatsApp Number**

Provision a Kapso WhatsApp phone number for native inbound routing. Lead-only. Points the number's Kapso webhook at the swarm's native handler (signed with KAPSO_WEBHOOK_HMAC_SECRET) and stores a KV mapping so inbound messages route to an agent (defaults to the lead, or a workflow if workflowId is given). Returns the stored mapping + the registered webhook URL.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `phoneNumberId` | `string` | Yes | - | Kapso/Meta phone-number ID to provision (KAPSO_PHONE_NUMBER_ID). |
| `agentId` | `string` | No | - | Agent to route inbound messages to as a `kapso-inbound` task. Defaults to the lead agent when omitted. |
| `workflowId` | `string` | No | - | Advanced override: dispatch inbound via this workflow's webhook trigger instead of a task. |
| `name` | `string` | No | - | Human-friendly display name for the number. |

### unregister-kapso-number

**Unregister Kapso WhatsApp Number**

Remove a Kapso phone number's native routing mapping from the KV store. Lead-only. Inbound messages for the number stop routing through the native handler. The Kapso-side webhook is not deleted automatically — remove it in the Kapso dashboard if you want deliveries to stop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `phoneNumberId` | `string` | Yes | - | Kapso/Meta phone-number ID whose mapping should be removed. |

### send-whatsapp-message

**Send WhatsApp Message**

Send a free-form WhatsApp text via Kapso (within the 24h session window). Thin wrapper over the Kapso Meta-proxy send. For templates/media/reactions use the `kapso-whatsapp` skill. If the recipient is outside the 24h window the call returns a structured error pointing at the template path.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `phoneNumberId` | `string` | Yes | - | The swarm's Kapso/Meta phone-number ID to send from (KAPSO_PHONE_NUMBER_ID). |
| `to` | `string` | Yes | - | Recipient phone in E.164 WITHOUT '+' (e.g. '15551234567'). |
| `body` | `string` | Yes | - | Message text. |
| `previewUrl` | `boolean` | No | - | Render a link preview for URLs in the body (default false). |

### reply-whatsapp-message

**Reply to WhatsApp Message**

Quote-reply a WhatsApp message via Kapso — same as send-whatsapp-message but threads to a specific inbound WAMID via context.message_id. Recipient is inferred from the conversation; pass the original sender's phone as `to`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `phoneNumberId` | `string` | Yes | - | The swarm's Kapso/Meta phone-number ID to send from (KAPSO_PHONE_NUMBER_ID). |
| `to` | `string` | Yes | - | Recipient phone in E.164 WITHOUT '+'. |
| `inReplyTo` | `string` | Yes | - | The inbound WAMID to quote-reply (set as context.message_id). |
| `body` | `string` | Yes | - | Reply text. |

## Task Pool Tools

*KV*

### task-action

**Task Pool Actions**

Perform task pool operations: create unassigned tasks, claim/release tasks from pool, accept/reject offered tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `unknown` | Yes | - | The action to perform: 'create' creates an unassigned task, 'claim' takes a task from pool, 'release' returns task to pool, 'accept' accepts offered task, 'reject' declines offered task, 'to_backlog' moves task to backlog, 'from_backlog' moves task from backlog to pool. |
| `key` | `unknown` | No | - | Logical namespace for a created task. Defaults to a shared/task:<id>/ resource key. |
| `taskType` | `string` | No | - | Task type (e.g., 'bug', 'feature'). |
| `tags` | `array` | No | - | Tags for filtering (e.g., ['urgent', 'frontend']). |
| `priority` | `number` | No | - | Priority 0-100, default 50. |
| `dependsOn` | `array` | No | - | Task IDs this task depends on. |
| `model` | `string` | No | - | Concrete model override for the created task, interpreted by the claiming worker's harness/provider. This does not switch providers. Only used with 'create' action. |
| `modelTier` | `unknown` | No | - | Portable model tier for the created task: 'smol', 'regular', 'smart', or 'ultra'. Resolved when a worker claims/runs the task. Only used with 'create' action. |
| `effort` | `unknown` | No | - | Reasoning effort for the created task: 'off', 'low', 'medium', 'high', 'xhigh', or 'max'. Only used with 'create' action. |
| `requiredCapabilities` | `array` | No | - | Capabilities a claiming agent must have (declared via join-swarm/update-profile) to be pool-eligible for this task. Written into the created task's routingAffinity (role is left unset). Only used with 'create' action. |

## Messaging Tools

*Messaging*

### list-channels

**List Channels**

Lists all available channels for cross-agent communication.

*No parameters*

### create-channel

**Create Channel**

Creates a new channel for cross-agent communication.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Channel name (must be unique). |
| `description` | `string` | No | - | Channel description. |
| `type` | `unknown` | No | - | Channel type: 'public' (default) or 'dm'. |
| `participants` | `array` | No | - | Agent IDs for DM channels. |

### delete-channel

**Delete Channel**

Deletes a channel and all its messages. Only the lead agent can delete channels. The default 'general' channel cannot be deleted.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channelId` | `string` | No | - | The ID of the channel to delete. |
| `name` | `string` | No | - | Channel name (alternative to channelId). |

## Profiles Tools

*Profiles*

### update-profile

**Update Profile**

Updates an agent's profile information (name, description, role, capabilities). By default updates the calling agent. Lead agents can update any agent's profile by providing the agentId parameter.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `string` | No | - | Target agent ID to update. If omitted, updates the calling agent. Only lead agents can update other agents' profiles. |
| `name` | `string` | No | - | Agent name. |
| `description` | `string` | No | - | Agent description. |
| `role` | `string` | No | - | Agent role (free-form, e.g., 'frontend dev', 'code reviewer'). |
| `capabilities` | `array` | No | - | List of capabilities (e.g., ['typescript', 'react', 'testing']). |
| `claudeMd` | `string` | No | - | Personal CLAUDE.md content. Loaded on session start and synced back on session end. Use for persistent notes and instructions. |
| `soulMd` | `string` | No | - | Soul content: persona and behavioral directives. Updates both DB and /workspace/SOUL.md. Must be at least 200 characters to prevent accidental corruption. |
| `identityMd` | `string` | No | - | Identity content: expertise and working style. Updates both DB and /workspace/IDENTITY.md. Must be at least 200 characters to prevent accidental corruption. |
| `setupScript` | `string` | No | - | Setup script content (bash). Runs at container start as the worker user after privilege drop. Persists across sessions. Also written to /workspace/start-up.sh. |
| `toolsMd` | `string` | No | - | Environment-specific operational knowledge. Repos, services, SSH hosts, APIs, device names — anything specific to your setup. Synced to /workspace/TOOLS.md. |
| `heartbeatMd` | `string` | No | - | Heartbeat checklist content (HEARTBEAT.md). Checked periodically — add standing orders for the lead to review. Synced to /workspace/HEARTBEAT.md. |

### context-history

**Context History**

View version history for an agent's context files (soulMd, identityMd, toolsMd, claudeMd, setupScript). Returns metadata for each version without full content.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `string` | No | - | Agent ID to query. Default: your own agent. Lead can query any agent. |
| `field` | `soulMd \| identityMd \| toolsMd \| claudeMd \| setupScript` | No | - | Filter by specific field. Omit for all fields. |
| `limit` | `number` | No | - | Max versions to return (default: 10). |

### context-diff

**Context Diff**

Compare two versions of a context file. Shows a unified diff between the specified version and its predecessor (or a specific comparison version).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `versionId` | `string` | Yes | - | The "newer" version ID to diff. |
| `compareToVersionId` | `string` | No | - | The "older" version ID to compare against. Default: previous version. |

## Services Tools

*Services*

### register-service

**Register Service**

Register a background service (e.g., PM2 process) for discovery by other agents. The service URL is automatically derived from your agent ID (https://{AGENT_ID}.{SWARM_URL}). Each agent can only run one service on port 3000.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `script` | `string` | Yes | - | Path to the script to run (required for PM2 restart). |
| `description` | `string` | No | - | What this service does. |
| `healthCheckPath` | `string` | No | - | Health check endpoint path (default: /health). |
| `cwd` | `string` | No | - | Working directory for the script. |
| `interpreter` | `string` | No | - | Interpreter to use (e.g., 'node', 'bun'). Auto-detected from extension if not set. |
| `args` | `array` | No | - | Command line arguments for the script. |
| `env` | `object` | No | - | Environment variables for the process. |
| `metadata` | `object` | No | - | Additional metadata. |

### unregister-service

**Unregister Service**

Remove a service from the registry. Use this after stopping a PM2 process. You can only unregister your own services.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `serviceId` | `uuid` | No | - | Service ID to unregister. |
| `name` | `string` | No | - | Service name to unregister (alternative to serviceId). |

### list-services

**List Services**

Query services registered by agents in the swarm. Use this to discover services exposed by other agents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `uuid` | No | - | Filter by specific agent ID. |
| `name` | `string` | No | - | Filter by service name (partial match). |
| `status` | `unknown` | No | - | Filter by health status. |
| `includeOwn` | `boolean` | No | true | Include services registered by calling agent (default: true). |

### update-service-status

**Update Service Status**

Update the health status of a registered service. Use this after a service becomes healthy or needs to be marked as stopped/unhealthy.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `serviceId` | `uuid` | No | - | Service ID to update. |
| `name` | `string` | No | - | Service name to update (alternative to serviceId). |
| `status` | `unknown` | Yes | - | New status: 'starting', 'healthy', 'unhealthy', or 'stopped'. |

## Scheduling Tools

*Scheduling*

### list-schedules

**List Scheduled Tasks**

View all scheduled tasks with optional filters. Use this to discover existing schedules. Rows are slim by default — the full `taskTemplate` is replaced with a short `taskTemplatePreview`; pass includeFull:true (or call `get-schedule` by id) for the full template.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `enabled` | `boolean` | No | - | Filter by enabled status |
| `name` | `string` | No | - | Filter by name (partial match) |
| `key` | `unknown` | No | - | Filter by exact namespace. |
| `keyPrefix` | `unknown` | No | - | Filter by namespace subtree. |
| `scheduleType` | `recurring \| one_time` | No | - | Filter by schedule type |
| `hideCompleted` | `boolean` | No | true | Hide completed one-time schedules (default: true) |
| `consecutiveErrorsMin` | `number` | No | - | Only return schedules with at least this many consecutive errors. |
| `lastRunStatus` | `failed \| succeeded` | No | - | Filter by derived last run status. `failed` means consecutiveErrors > 0; `succeeded` means lastRunAt is set and consecutiveErrors is 0. |
| `includeFull` | `boolean` | No | - | Return the full `taskTemplate` instead of a short `taskTemplatePreview`. Default false. |

### create-schedule

**Create Scheduled Task**

Create a new scheduled task. For recurring: provide cronExpression or intervalMs. For one-time: provide delayMs or runAt with scheduleType 'one_time'.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | No | - | Logical namespace. Defaults to a shared/schedule:<id>/ resource key. |
| `name` | `string` | Yes | - | Unique name for the schedule (e.g., 'daily-cleanup') |
| `taskTemplate` | `string` | No | - | The task description that will be created each time. Required when targetType is 'agent-task' (the default). |
| `targetType` | `unknown` | No | "agent-task" | Execution target. Use 'workflow' + workflowId when the schedule only starts a workflow; use 'script' + scriptName/scriptArgs when it only runs a catalog script; use 'agent-task' only when a reasoning agent genuinely needs to be in the loop. Do not create an agent-task whose taskTemplate just tells an agent to trigger a workflow or script. |
| `workflowId` | `string` | No | - | Workflow ID to trigger. Required when targetType is 'workflow'. |
| `scriptName` | `string` | No | - | Catalog script name (global scope). Required when targetType is 'script'. |
| `scriptArgs` | `object` | No | - | JSON args passed to the script. Used when targetType is 'script'. |
| `scheduleType` | `recurring \| one_time` | No | "recurring" | Schedule type: 'recurring' (default) or 'one_time' |
| `cronExpression` | `string` | No | - | Cron expression for recurring schedules (e.g., '0 9 * * *') |
| `intervalMs` | `number` | No | - | Interval in milliseconds for recurring schedules (e.g., 3600000 for hourly) |
| `delayMs` | `number` | No | - | Delay in milliseconds for one-time schedules (e.g., 1800000 for 30 min) |
| `runAt` | `string` | No | - | ISO datetime for one-time schedules (e.g., '2026-03-06T15:00:00Z') |
| `description` | `string` | No | - | Human-readable description of the schedule |
| `taskType` | `string` | No | - | Task type (e.g., 'maintenance', 'report') |
| `tags` | `array` | No | - | Tags to apply to created tasks |
| `priority` | `number` | No | 50 | Task priority 0-100 (default: 50) |
| `targetAgentId` | `string` | No | - | Agent to assign tasks to (omit for task pool) |
| `timezone` | `string` | No | "UTC" | Timezone for cron schedules |
| `enabled` | `boolean` | No | true | Whether the schedule is enabled (default: true) |
| `model` | `string` | No | - | Concrete model override for tasks created by this schedule. Interpreted by each assignee's harness/provider and does not switch providers. Prefer modelTier for portable intent. |
| `modelTier` | `unknown` | No | - | Portable model tier for tasks created by this schedule: 'smol', 'regular', 'smart', or 'ultra'. Resolved by each assignee's harness/provider at run time. |

### update-schedule

**Update Scheduled Task**

Update an existing scheduled task. Any registered agent can update schedules.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | No | - | Move to a logical namespace. |
| `scheduleId` | `string` | No | - | Schedule ID to update |
| `name` | `string` | No | - | Schedule name to update (alternative to ID) |
| `newName` | `string` | No | - | New name for the schedule |
| `taskTemplate` | `string` | No | - | New task template |
| `targetType` | `unknown` | No | - | Change the execution target: 'agent-task', 'workflow', or 'script'. |
| `workflowId` | `string` | No | - | New workflow ID (required when targetType is 'workflow'; null to clear) |
| `scriptName` | `string` | No | - | New catalog script name (required when targetType is 'script'; null to clear) |
| `scriptArgs` | `object` | No | - | New JSON args for the script target (null to clear) |
| `cronExpression` | `string` | No | - | New cron expression (null to clear) |
| `intervalMs` | `number` | No | - | New interval in milliseconds (null to clear) |
| `description` | `string` | No | - | New description |
| `taskType` | `string` | No | - | New task type |
| `tags` | `array` | No | - | New tags |
| `priority` | `number` | No | - | New priority |
| `targetAgentId` | `string` | No | - | New target agent ID |
| `timezone` | `string` | No | - | New timezone |
| `enabled` | `boolean` | No | - | Enable or disable the schedule |
| `model` | `string` | No | - | Concrete model override for tasks created by this schedule. Set to null to clear. |
| `modelTier` | `unknown` | No | - | Portable model tier for tasks created by this schedule. Set to null to clear. |

### patch-schedule

**Patch Scheduled Task**

Patch an existing scheduled task by shallow-merging provided fields over the current row. Any registered agent can patch schedules.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | No | - | Move to a logical namespace. |
| `scheduleId` | `string` | No | - | Schedule ID to patch |
| `name` | `string` | No | - | Schedule name to patch (alternative to ID) |
| `newName` | `string` | No | - | New name for the schedule |
| `taskTemplate` | `string` | No | - | New task template |
| `targetType` | `unknown` | No | - | Change the execution target: 'agent-task', 'workflow', or 'script'. |
| `workflowId` | `string` | No | - | New workflow ID (required when targetType is 'workflow'; null to clear) |
| `scriptName` | `string` | No | - | New catalog script name (required when targetType is 'script'; null to clear) |
| `scriptArgs` | `object` | No | - | New JSON args for the script target (null to clear) |
| `cronExpression` | `string` | No | - | New cron expression (null to clear) |
| `intervalMs` | `number` | No | - | New interval in milliseconds (null to clear) |
| `description` | `string` | No | - | New description |
| `taskType` | `string` | No | - | New task type |
| `tags` | `array` | No | - | New tags |
| `priority` | `number` | No | - | New priority |
| `targetAgentId` | `string` | No | - | New target agent ID |
| `timezone` | `string` | No | - | New timezone |
| `enabled` | `boolean` | No | - | Enable or disable the schedule |
| `model` | `string` | No | - | Concrete model override for tasks created by this schedule. Set to null to clear. |
| `modelTier` | `unknown` | No | - | Portable model tier for tasks created by this schedule. Set to null to clear. |

### delete-schedule

**Delete Scheduled Task**

Delete a scheduled task permanently. Any registered agent can delete schedules.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scheduleId` | `string` | No | - | Schedule ID to delete |
| `name` | `string` | No | - | Schedule name to delete (alternative to ID) |

### run-schedule-now

**Run Schedule Now**

Immediately execute a scheduled task, creating a task right away. Does not affect the regular schedule timing.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scheduleId` | `string` | No | - | Schedule ID to run |
| `name` | `string` | No | - | Schedule name to run (alternative to ID) |

## Memory Tools

*Memory*

### memory-search

**Search memories**

Search your accumulated memories using natural language. Returns summaries with IDs — use memory-get to retrieve full content.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | - | Natural language search query. |
| `intent` | `string` | Yes | - | Why you are searching for this memory. Required. E.g. 'looking for auth pattern to fix login bug'. |
| `scope` | `all \| agent \| swarm` | No | "all" | Search scope: 'all' (own + swarm), 'agent' (own only), 'swarm' (shared only). |
| `limit` | `number` | No | 10 | Max results to return. |
| `source` | `unknown` | No | - | Filter by memory source type. |

### memory-get

**Get memory details**

Retrieve the full content of a specific memory by its ID. Use memory-search to find memory IDs first.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memoryId` | `uuid` | Yes | - | The ID of the memory to retrieve. |
| `intent` | `string` | Yes | - | Why you are retrieving this memory. Required. E.g. 'need full details of the auth fix pattern'. |

### memory-edit

**Edit a memory**

Edit a single memory in place while preserving its ID, usefulness posterior, and audit history. Two modes: 'replace' overwrites the entire content (requires `content`); 'exact' performs a surgical find-and-replace of `oldString` with `newString` within the existing content (fails if `oldString` is missing or ambiguous). Use 'replace' for full rewrites, 'exact' for targeted edits.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memoryId` | `uuid` | No | - | The memory ID to edit. |
| `key` | `string` | No | - | Structured key alternative to memoryId. |
| `scope` | `unknown` | No | - | Required when editing by key. |
| `mode` | `replace \| exact` | No | "replace" | 'replace' overwrites the entire memory content; 'exact' finds a unique substring (oldString) and replaces it with newString. |
| `content` | `string` | No | - | Full replacement content. Required for 'replace' mode, ignored in 'exact'. |
| `oldString` | `string` | No | - | Substring to find in existing content. Required for 'exact' mode. Must appear exactly once. |
| `newString` | `string` | No | - | Replacement for oldString. Required for 'exact' mode. Can be empty to delete. |
| `intent` | `string` | Yes | - | Why you are editing this memory. |
| `expectedVersion` | `number` | No | - | - |

### memory-delete

**Delete a memory**

Delete a specific memory by its ID. Agents can delete their own memories; lead agents can also delete swarm-scoped memories.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memoryId` | `uuid` | Yes | - | The ID of the memory to delete. |

### memory_rate

**Rate a memory**

Rate a memory you used in the current task. Call this when a retrieved memory was clearly useful (or actively misleading) so the swarm learns to surface better memories next time.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Memory ID returned by memory_search. |
| `useful` | `boolean` | Yes | - | true = this memory helped solve the task; false = misled or wasted time. |
| `note` | `string` | No | - | Short reason. Captured for telemetry; not surfaced to other agents. |
| `referencesSource` | `string` | No | - | Optional external source ID this memory references. Free-form string, convention "<source>:<identifier>" (e.g. "github:owner/repo#N", "linear:KEY-N", "customer:<slug>", "slack:<channel>:<ts>", "agentmail:<thread-id>"). Pick any prefix that fits — no closed enum. When present, an edge from this memory to the external source is created/updated. |

### inject-learning

**Inject learning into worker memory**

Allows the lead agent to push learnings into a worker's memory. The learning will be stored as a searchable memory entry that the worker can recall in future sessions.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `uuid` | Yes | - | Target worker agent ID |
| `learning` | `string` | Yes | - | The learning content to inject |
| `category` | `unknown` | Yes | - | Category of the learning: mistake-pattern, best-practice, codebase-knowledge, or preference |

## Workflows Tools

*Tracker*

### create-workflow

**Create Workflow**

Create a new automation workflow. Key concepts: - Nodes are linked via 'next' (string or port-based record). - CROSS-NODE DATA: To use output from an upstream node, you MUST declare an 'inputs' mapping on the downstream node. Example: inputs: { "cityData": "generate-city" } → then use {{cityData.taskOutput.field}} in config templates. Without 'inputs', only 'trigger' and workflow-level 'input' are available for interpolation. - STRUCTURED OUTPUT: For agent-task nodes, put outputSchema inside 'config' to validate the agent's raw JSON output. Node-level outputSchema validates the executor's return ({taskId, taskOutput}), which is different. - Agent-task config: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }. - TRIGGER SCHEMA: Optional 'triggerSchema' is a JSON-Schema object that validates incoming trigger payloads. Supported keywords: type, required, properties, enum, const, items (recursive into arrays). Other JSON-Schema keywords (oneOf/anyOf/$ref/pattern/format/additionalProperties) are silently ignored. - WEBHOOK VERIFICATION: Webhook triggers use hmacSecret for all verification formats. Omit verification for legacy HMAC-SHA256 over the raw body with fallback header scanning; or set verification to { format: 'hmac-sha256', header }, { format: 'timestamped-hmac-sha256', header, toleranceSeconds? }, or { format: 'token-equality', header }. Example: { type: 'webhook', hmacSecret: 'secret.SUPERAGENT_WEBHOOK_SECRET', verification: { format: 'timestamped-hmac-sha256', header: 'X-Superagent-Signature', toleranceSeconds: 300 } }. - WAIT NODE: type 'wait' pauses a workflow for a duration or until a named workflowEventBus event arrives. See runbooks/workflows.md#wait-nodes for config shapes, ordering caveats, and built-in event names.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Unique name for the workflow |
| `key` | `unknown` | No | - | Logical namespace. Defaults to a shared/workflow:<id>/ resource key. |
| `description` | `string` | No | - | Description of what this workflow does |
| `definition` | `unknown` | Yes | - | The workflow definition with nodes (each node has id, type, config, and optional next/retry/validation) |
| `triggers` | `array` | No | - | Optional trigger configurations (webhook, schedule). Webhook verification formats: legacy omitted verification, hmac-sha256, timestamped-hmac-sha256, token-equality. |
| `cooldown` | `unknown` | No | - | Optional cooldown configuration to prevent re-triggering too frequently |
| `input` | `object` | No | - | Optional input values resolved at execution time (env vars like VAR_NAME, secrets secret.NAME, or literals) |
| `dir` | `string` | No | - | Default working directory for all agent-task nodes (absolute path, e.g. /tmp/workspace) |
| `vcsRepo` | `string` | No | - | Default VCS repo for all agent-task nodes (e.g. org/repo) |
| `triggerSchema` | `object` | No | - | Optional JSON-Schema object that validates incoming trigger payloads. Supported keywords: type, required, properties, enum, const, items. Other JSON-Schema keywords are silently ignored. |

### list-workflows

**List Workflows**

List all automation workflows, optionally filtered by enabled status. Returns SLIM rows WITHOUT the full `definition` (DAG) — each row carries a `nodeCount` instead. To inspect or patch a workflow's nodes/triggers, call `get-workflow` by id, or pass `includeFull: true` here.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `enabled` | `boolean` | No | - | Filter by enabled status (omit to return all) |
| `key` | `unknown` | No | - | Filter by exact namespace. |
| `keyPrefix` | `unknown` | No | - | Filter by namespace subtree. |
| `consecutiveErrorsMin` | `number` | No | - | Only return workflows with at least this many latest consecutive failed runs. |
| `lastRunStatus` | `unknown` | No | - | Only return workflows whose latest run has this status. |
| `includeFull` | `boolean` | No | - | Return the full workflow `definition` + trigger config instead of slim rows. Default false — prefer `get-workflow` to fetch a single workflow in full. |

### get-workflow

**Get Workflow**

Get a workflow by ID, including its definition, triggers, cooldown, input, and auto-generated edges for UI rendering.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID |

### update-workflow

**Update Workflow**

Update an existing workflow's name, description, definition, triggers, cooldown, input, triggerSchema, or enabled state. Creates a version snapshot before applying changes. TRIGGER SCHEMA: pass 'triggerSchema' as a JSON-Schema object to set/replace, or 'null' to clear. Supported JSON-Schema keywords: type, required, properties, enum, const, items (recursive into arrays). Other JSON-Schema keywords (oneOf/anyOf/$ref/pattern/format/additionalProperties) are silently ignored. WEBHOOK VERIFICATION: webhook triggers use hmacSecret for all verification formats. Omit verification for legacy HMAC-SHA256 over the raw body with fallback header scanning; or set verification to { format: 'hmac-sha256', header }, { format: 'timestamped-hmac-sha256', header, toleranceSeconds? }, or { format: 'token-equality', header }.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to update |
| `key` | `unknown` | No | - | Move to a logical namespace. |
| `name` | `string` | No | - | New name for the workflow |
| `description` | `string` | No | - | New description |
| `definition` | `unknown` | No | - | New workflow definition |
| `triggers` | `array` | No | - | New trigger configurations. Webhook verification formats: legacy omitted verification, hmac-sha256, timestamped-hmac-sha256, token-equality. |
| `cooldown` | `unknown` | No | - | New cooldown configuration (null to remove) |
| `input` | `object` | No | - | New input values (null to remove) |
| `dir` | `string` | No | - | Default working directory for all agent-task nodes (null to remove) |
| `vcsRepo` | `string` | No | - | Default VCS repo for all agent-task nodes (null to remove) |
| `enabled` | `boolean` | No | - | Enable or disable the workflow |
| `triggerSchema` | `object` | No | - | New trigger payload JSON-Schema (null to clear). Supported keywords: type, required, properties, enum, const, items. Other JSON-Schema keywords are silently ignored. |

### patch-workflow

**Patch Workflow Definition**

Partially update a workflow by creating, updating, or deleting individual nodes, and/or by setting/clearing the trigger payload schema. DAG operations are applied in order: delete → create → update. `triggerSchema` is independent of DAG ops: pass an object to set/replace, pass null to clear, or omit to leave unchanged. Validator subset for `triggerSchema`: type, required, properties, enum, const, items. Other JSON-Schema keywords are silently ignored. Creates a version snapshot before applying changes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to patch |
| `key` | `unknown` | No | - | Move to a logical namespace. |
| `update` | `array` | No | - | Nodes to update (partial merge) |
| `delete` | `array` | No | - | Node IDs to delete |
| `create` | `array` | No | - | New nodes to add |
| `onNodeFailure` | `fail \| continue` | No | - | Update onNodeFailure behavior |
| `triggerSchema` | `object` | No | - | Optional JSON-Schema describing the expected trigger payload. Pass an object to set/replace; pass null to clear; omit to leave unchanged. Validator subset: type, required, properties, enum, const, items. |

### patch-workflow-node

**Patch Workflow Node**

Partially update a single node in a workflow definition. Merges the provided fields into the existing node. Creates a version snapshot before applying changes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID |
| `nodeId` | `string` | Yes | - | Node ID to update |

### delete-workflow

**Delete Workflow**

Delete a workflow by ID. This also removes all associated runs and steps.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to delete |

### trigger-workflow

**Trigger Workflow**

Manually trigger a workflow execution, optionally passing trigger data as context. Respects cooldown configuration. If the workflow has a triggerSchema, the payload is validated first; on failure, the response includes structured validationErrors plus the workflow's triggerSchema for self-correction.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to trigger |
| `triggerData` | `object` | No | - | Optional data to pass as trigger context to the workflow |

### list-workflow-runs

**List Workflow Runs**

List all execution runs for a given workflow, optionally filtered by status.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `workflowId` | `string` | Yes | - | Workflow ID to list runs for |
| `status` | `unknown` | No | - | Filter by run status (running, waiting, completed, failed, skipped) |

### get-workflow-run

**Get Workflow Run**

Get details of a workflow run by ID, including all steps and their statuses.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow run ID |

### retry-workflow-run

**Retry Workflow Run**

Retry a failed workflow run from the beginning. The run must be in 'failed' status.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | Yes | - | Workflow run ID to retry |

### cancel-workflow-run

**Cancel Workflow Run**

Cancel a running or waiting workflow run. Cancels all non-terminal steps and their associated tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | Yes | - | Workflow run ID to cancel |
| `reason` | `string` | No | - | Optional reason for cancellation |

### request-human-input

**Request human input**

Create an approval request that pauses until a human responds. Supports multiple question types: approval (yes/no), text, single-select, multi-select, and boolean. Returns the request ID and URL for the human to respond.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `title` | `string` | Yes | - | Title of the approval request |
| `questions` | `array` | Yes | - | Questions to ask the human |
| `timeoutSeconds` | `number` | No | - | Timeout in seconds (auto-rejects on timeout) |

## Pages Tools

*Pages*

### create_page

**Create or update a page**

Stores an HTML or JSON page in the swarm and returns shareable URLs. Calls are upsert-by-(agent, slug): if you previously created a page with the same slug, its prior state is snapshotted and the row is updated. Use this for static reports, dashboards, or JSON action specs that don't need a long-lived process.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | No | - | Logical namespace. Defaults to a shared/page:<id>/ resource key. |
| `title` | `string` | Yes | - | Human-readable title shown in listings. |
| `slug` | `string` | No | - | URL slug. Defaults to the kebab-cased title. Same slug → updates the existing row. |
| `body` | `string` | Yes | - | Full page body (HTML document or JSON-render spec, per contentType). |
| `contentType` | `unknown` | Yes | - | 'text/html' renders directly at /p/:id; 'application/json' is rendered by the SPA. |
| `authMode` | `unknown` | No | "authed" | 'authed' — requires page-session cookie (default); 'public' — no gate and must be explicit; 'password' — requires key. |
| `password` | `string` | No | - | Plaintext password, hashed before storage. Only meaningful for authMode='password'. |
| `description` | `string` | No | - | Optional short description, used in listings + OG-tag unfurl. |
| `needsCredentials` | `array` | No | - | Declared credential needs for JSON pages (renderer ignores for v1 — reserved for follow-up). |

### delete-page

**Delete Page**

Permanently delete one page by pageId, or by slug in the caller's page namespace. Only the lead or the page owner can delete a page.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pageId` | `string` | No | - | Page ID to delete. |
| `slug` | `string` | No | - | Page slug to delete from the caller's own (agentId, slug) namespace. Alternative to pageId. |

## Kv Tools

*KV*

### kv-get

**KV Get**

Read a key from the swarm KV store. Returns the entry or null if missing/expired. Namespace defaults to your current context (Slack thread / PR / Linear issue when invoked from a task; otherwise your agent scratchpad).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | Yes | - | KV key (≤512 chars, [a-zA-Z0-9._:/-]). |
| `namespace` | `unknown` | No | - | Optional explicit namespace. Defaults to the caller's contextKey. |

### kv-set

**KV Set**

Write a key in the swarm KV store. Upserts atomically. Namespace defaults to your current context. Use `expiresInSec` for opt-in TTL (default: never expires). 2 MiB body cap.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | Yes | - | KV key (≤512 chars, [a-zA-Z0-9._:/-]). |
| `value` | `unknown` | Yes | - | Value. Stored as JSON by default; pass `valueType: 'string'` or `'integer'` to skip JSON wrapping. |
| `valueType` | `unknown` | No | - | How to encode `value`. Defaults to 'json'. 'integer' is required for INCR. |
| `expiresInSec` | `number` | No | - | Optional TTL in seconds. Omit for no expiry. |
| `namespace` | `unknown` | No | - | Optional explicit namespace. Defaults to the caller's contextKey. |

### kv-delete

**KV Delete**

Remove a key from the swarm KV store. Returns whether a row was actually deleted. Namespace defaults to your current context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | Yes | - | - |
| `namespace` | `unknown` | No | - | - |

### kv-incr

**KV Incr**

Atomically increment an integer KV entry. Creates the entry (set to `by`) if it doesn't exist or has expired. Fails if the existing value_type is not 'integer' (use kv-delete first if you want to switch).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `unknown` | Yes | - | - |
| `by` | `number` | No | - | Increment (or decrement when negative). Default: 1. |
| `namespace` | `unknown` | No | - | - |

### kv-list

**KV List**

List KV entries in the resolved namespace (optionally filtered by key prefix). Expired entries are filtered out. Pagination via limit/offset (limit capped at 1000).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prefix` | `string` | No | - | Key prefix to filter on. |
| `limit` | `number` | No | - | Max entries to return (default 100, max 1000). |
| `offset` | `number` | No | - | - |
| `namespace` | `unknown` | No | - | - |

## Other Tools

*Tools not assigned to a capability group*

### launch-script-run

**Launch Script Run**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | `string` | Yes | - | TypeScript script workflow source. |
| `args` | `unknown` | No | - | JSON-serializable workflow arguments. |
| `idempotencyKey` | `string` | No | - | Optional key that returns the existing run instead of launching a duplicate. |
| `scriptName` | `unknown` | No | - | Optional human-readable script/workflow name for the run. |
| `requestedByUserId` | `string` | No | - | Optional canonical user ID to attribute the run to. |

### get-script-run

**Get Script Run**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Script run ID. |

### list-script-runs

**List Script Runs**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | `unknown` | No | - | Optional script run status filter. |
| `agentId` | `string` | No | - | Optional agent ID filter. |
| `limit` | `number` | No | 50 | Maximum runs to return. |
| `offset` | `number` | No | 0 | Pagination offset. |

### create_metric

**Create or update a metric**

Stores a config-driven dashboard backed by read-only SQL widget queries. Calls are upsert-by-(agent, slug), mirroring create_page: same slug updates the existing dashboard and snapshots the prior JSON definition.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `title` | `string` | Yes | - | Human-readable dashboard title. |
| `slug` | `string` | No | - | URL-safe slug. Defaults to the kebab-cased title. |
| `description` | `string` | No | - | Short description shown in the dashboard. |
| `definition` | `unknown` | Yes | - | Dashboard JSON definition: a list of widgets, each with SELECT/WITH SQL and viz config. |

### post-message

**Post Message**

Posts a message to a channel for cross-agent communication.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `string` | No | "general" | Channel name (default: 'general'). |
| `content` | `string` | Yes | - | Message content. |
| `replyTo` | `uuid` | No | - | Message ID to reply to (for threading). |
| `mentions` | `array` | No | - | Agent IDs to @mention (they'll see it in unread). |

### script-tools

**Manage Script-Backed Tools**

Publish a global catalog script as an agent-visible MCP tool (lead only), unpublish, enable/disable, or list. Published tools become callable on the next MCP session; the script receives the tool call arguments as its args.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `publish \| unpublish \| enable \| disable \| list` | Yes | - | - |
| `toolName` | `string` | No | - | Tool name (^[a-z][a-z0-9_-]{2,63}$). Required for all actions except 'list'. Must not collide with a built-in tool. |
| `scriptName` | `string` | No | - | Global catalog script to back the tool. Required for 'publish'. |
| `description` | `string` | No | - | Tool description shown to agents. Required for 'publish'. |

### read-messages

**Read Messages**

Reads messages from a channel. If no channel is specified, returns unread messages from ALL channels. Supports filtering by unread, mentions, and time range. Automatically marks messages as read.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `string` | No | - | Channel name or ID. If omitted, returns unread messages from all channels. |
| `limit` | `number` | No | 20 | Max messages to return per channel (default: 20). |
| `since` | `unknown` | No | - | Only messages after this ISO timestamp. |
| `unreadOnly` | `boolean` | No | false | Only return unread messages. |
| `mentionsOnly` | `boolean` | No | false | Only return messages that @mention you. |
| `markAsRead` | `boolean` | No | true | Update your read position after fetching (default: true). |

### mcp-server-get

**Get MCP Server**

Get MCP server details by ID or name. Name resolution uses scope cascade: agent > swarm > global.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | No | - | MCP server ID |
| `name` | `string` | No | - | MCP server name (resolved with scope cascade) |

### mcp-server-uninstall

**Uninstall MCP Server**

Uninstall an MCP server from an agent. Self-uninstall is always allowed; cross-agent requires lead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mcpServerId` | `string` | Yes | - | ID of the MCP server to uninstall |
| `agentId` | `string` | No | - | Target agent (default: calling agent) |

### mcp-server-create

**Create MCP Server**

Create a new MCP server definition. Agent-scope servers are auto-installed for the creating agent. Swarm/global scope requires lead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Server name |
| `description` | `string` | No | - | Server description |
| `transport` | `stdio \| http \| sse` | Yes | - | Transport type |
| `scope` | `global \| swarm \| agent` | No | "agent" | Scope: agent (personal), swarm (shared), or global. Default: agent |
| `command` | `string` | No | - | Command to run (required for stdio transport) |
| `args` | `string` | No | - | JSON array of command arguments (stdio only) |
| `url` | `string` | No | - | Server URL (required for http/sse transport) |
| `headers` | `string` | No | - | JSON object of non-secret headers (http/sse only) |
| `envConfigKeys` | `string` | No | - | JSON object mapping env var names to config key paths |
| `headerConfigKeys` | `string` | No | - | JSON object mapping header names to config key paths for secret headers |
| `extraAuthorizeParams` | `string` | No | - | JSON object string of extra OAuth authorize-request params, e.g. {"access_type":"offline","prompt":"consent"} |

### mcp-server-install

**Install MCP Server**

Install an MCP server for an agent. Self-install is always allowed; cross-agent install requires lead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mcpServerId` | `string` | Yes | - | ID of the MCP server to install |
| `agentId` | `string` | No | - | Target agent (default: calling agent). Lead can install for others. |

### mcp-server-delete

**Delete MCP Server**

Delete an MCP server definition. Only the owning agent or lead can delete.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | ID of the MCP server to delete |

### mcp-server-update

**Update MCP Server**

Update an MCP server's configuration. Only the owner or lead can update.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | ID of the MCP server to update |
| `name` | `string` | No | - | New name |
| `description` | `string` | No | - | New description |
| `transport` | `stdio \| http \| sse` | No | - | New transport type |
| `command` | `string` | No | - | New command (stdio) |
| `args` | `string` | No | - | New JSON array of arguments (stdio) |
| `url` | `string` | No | - | New URL (http/sse) |
| `headers` | `string` | No | - | New JSON object of non-secret headers |
| `envConfigKeys` | `string` | No | - | New env config key mappings |
| `headerConfigKeys` | `string` | No | - | New header config key mappings |
| `extraAuthorizeParams` | `string` | No | - | JSON object string of extra OAuth authorize-request params, e.g. {"access_type":"offline","prompt":"consent"} |
| `isEnabled` | `boolean` | No | - | Toggle enabled/disabled |

### mcp-server-list

**List MCP Servers**

List MCP servers with optional filters. Use installedOnly to see servers installed for the calling agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scope` | `global \| swarm \| agent` | No | - | Filter by scope |
| `transport` | `stdio \| http \| sse` | No | - | Filter by transport type |
| `search` | `string` | No | - | Search by name or description |
| `installedOnly` | `boolean` | No | - | Only show servers installed for the calling agent |

### skill-search

**Search Skills**

Search skills by keyword (name and description).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | - | Search query |
| `limit` | `number` | No | 20 | - |

### skill-install

**Install Skill**

Install/assign a skill to an agent. Leads can install for other agents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the skill to install |
| `agentId` | `string` | No | - | Target agent (default: calling agent). Lead can install for others. |

### skill-install-remote

**Install Remote Skill**

Fetch and install a remote skill from a GitHub repository. Fetches SKILL.md via GitHub raw content API.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sourceRepo` | `string` | Yes | - | GitHub repo (e.g. "vercel-labs/skills") |
| `sourcePath` | `string` | No | - | Path within repo (e.g. "skills/nextjs") |
| `scope` | `global \| swarm` | No | "global" | Scope for the installed skill |
| `isComplex` | `boolean` | No | false | If true, registers for npx install (metadata only) |

### skill-list

**List Skills**

List available skills with optional filters.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | `remote \| personal` | No | - | Filter by type |
| `scope` | `global \| swarm \| agent` | No | - | Filter by scope |
| `agentId` | `string` | No | - | Filter by owning agent |
| `installedOnly` | `boolean` | No | - | Only show skills installed for calling agent |
| `includeContent` | `boolean` | No | false | Include full content (default false) |

### skill-sync-remote

**Sync Remote Skills**

Check and update remote skills from their GitHub sources. Compares content and updates if changed.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | No | - | Sync a specific skill, or all remote skills if omitted |
| `force` | `boolean` | No | false | Force re-fetch even if hash matches |

### skill-publish

**Publish Skill**

Publish a personal skill to swarm scope. Creates an approval task for the lead agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the personal skill to publish |

### skill-get

**Get Skill**

Get full skill content by ID or name. Name resolution checks agent scope first, then swarm, then global.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | No | - | Skill ID |
| `name` | `string` | No | - | Skill name (resolved with precedence) |

### skill-update

**Update Skill**

Update a skill's content or settings. Re-parses frontmatter if content changes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | No | - | Skill ID to update |
| `content` | `string` | No | - | New SKILL.md content (re-parses frontmatter) |
| `isEnabled` | `boolean` | No | - | Toggle enabled/disabled |
| `scope` | `agent \| swarm` | No | - | Scope: agent (personal) or swarm (shared). Only leads can promote a skill to swarm scope (used by the skill-approval flow). |

### skill-delete

**Delete Skill**

Delete a skill. Only the owning agent or lead can delete.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the skill to delete |

### skill-create

**Create Skill**

Create a personal skill from SKILL.md content. Parses frontmatter for name, description, and metadata.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | `string` | Yes | - | Full SKILL.md content (YAML frontmatter + markdown body) |
| `scope` | `agent \| swarm` | No | "agent" | Scope: agent (personal) or swarm (shared). Default: agent |

### skill-get-file

**Get Skill File**

Fetch a bundled reference file from a complex skill by skillId and relative path. Use this when the file is not available on disk.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | Skill ID |
| `path` | `string` | Yes | - | Relative path, e.g. references/animations.md |

### skill-uninstall

**Uninstall Skill**

Remove a skill from an agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the skill to uninstall |
| `agentId` | `string` | No | - | Target agent (default: calling agent) |

### patch-subscription

**Patch Event Subscription**

Update fields of an event subscription: pause/resume (enabled), description, eventPattern, filter, or scriptArgs. Target (script/workflow) is immutable — delete and recreate to retarget.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Subscription name to patch |
| `description` | `string` | No | - | - |
| `eventPattern` | `string` | No | - | - |
| `filter` | `unknown` | No | - | New payload filter; pass null to clear |
| `scriptArgs` | `unknown` | No | - | New extra script args; pass null to clear |
| `enabled` | `boolean` | No | - | false pauses the subscription |

### list-subscriptions

**List Event Subscriptions**

List event subscriptions (event pattern → script/workflow bindings), optionally with recent delivery attempts per subscription.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `enabledOnly` | `boolean` | No | false | - |
| `includeDeliveries` | `boolean` | No | false | Include the 5 most recent deliveries per subscription |

### delete-subscription

**Delete Event Subscription**

Delete an event subscription by name. Pending deliveries are not executed.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Subscription name to delete |

### create-subscription

**Create Event Subscription**

Subscribe a catalog script or workflow to swarm events (task lifecycle, GitHub/GitLab webhooks, approvals, …). When a matching event fires, the target runs with the event payload. Delivery is at-least-once with retries.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Unique name for the subscription (e.g., 'triage-failed-tasks') |
| `description` | `string` | No | - | Human-readable description |
| `eventPattern` | `string` | Yes | - | Glob over dot-separated event names: '*' matches one segment, '**' (last segment only) matches the rest. Examples: 'task.completed', 'task.*', 'github.**'. |
| `filter` | `unknown` | No | - | Optional payload filter (wait-node filter language): object of dot-path → expected value for deep-equal matching, or a string expression over the event payload. |
| `targetType` | `unknown` | Yes | - | What to run when the event fires: 'script' (global catalog script, receives the event as args.event) or 'workflow' (triggered with { event, subscriptionId } as trigger data). |
| `scriptName` | `string` | No | - | Catalog script name (global scope). Required when targetType is 'script'. |
| `scriptArgs` | `object` | No | - | Extra JSON args merged into the script invocation (event wins on key 'event'). |
| `workflowId` | `string` | No | - | Workflow ID to trigger. Required when targetType is 'workflow'. |
| `enabled` | `boolean` | No | true | - |

### tracker-status

**Tracker Status**

Show all connected trackers and their OAuth status (token expiry, workspace info). Proactively refreshes near-expiry tokens before reporting, so the returned `tokenExpiresAt` reflects the row that subsequent API calls (and direct DB reads) will see.

*No parameters*

### tracker-map-agent

**Map Agent to Tracker User**

Map a swarm agent to an external tracker user (for assignment sync).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `string` | Yes | - | Tracker provider (e.g. 'linear', 'jira') |
| `agentId` | `string` | Yes | - | The swarm agent ID |
| `externalUserId` | `string` | Yes | - | The external user ID in the tracker |
| `agentName` | `string` | Yes | - | Display name for the agent mapping |

### tracker-link-task

**Link Task to Tracker**

Link a swarm task to an external tracker issue.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `string` | Yes | - | Tracker provider (e.g. 'linear', 'jira') |
| `swarmTaskId` | `string` | Yes | - | The swarm task ID to link |
| `externalId` | `string` | Yes | - | The external issue ID in the tracker |
| `externalIdentifier` | `string` | No | - | Human-readable identifier (e.g. 'ENG-42') |
| `externalUrl` | `string` | No | - | URL to the external issue |

### tracker-unlink

**Unlink Tracker Sync**

Remove a tracker sync mapping by ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `syncId` | `string` | Yes | - | The tracker sync mapping ID to remove |

### tracker-sync-status

**Tracker Sync Status**

Show all tracker sync mappings with their state.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `string` | No | - | Filter by provider (e.g. 'linear', 'jira') |
| `entityType` | `task` | No | - | Filter by entity type |

