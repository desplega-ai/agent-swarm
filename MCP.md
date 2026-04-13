# MCP Tools Reference

> Auto-generated from source. Do not edit manually.
> Run `bun run docs:mcp` to regenerate.

## Table of Contents

- [Core Tools](#core-tools)
  - [join-swarm](#join-swarm)
  - [poll-task](#poll-task)
  - [get-swarm](#get-swarm)
  - [get-tasks](#get-tasks)
  - [send-task](#send-task)
  - [get-task-details](#get-task-details)
  - [store-progress](#store-progress)
  - [my-agent-info](#my-agent-info)
  - [cancel-task](#cancel-task)
  - [resolve-user](#resolve-user)
  - [manage-user](#manage-user)
  - [db-query](#db-query)
  - [set-config](#set-config)
  - [get-config](#get-config)
  - [list-config](#list-config)
  - [delete-config](#delete-config)
  - [get-repos](#get-repos)
  - [update-repo](#update-repo)
  - [list-prompt-templates](#list-prompt-templates)
  - [get-prompt-template](#get-prompt-template)
  - [set-prompt-template](#set-prompt-template)
  - [delete-prompt-template](#delete-prompt-template)
  - [preview-prompt-template](#preview-prompt-template)
  - [slack-reply](#slack-reply)
  - [slack-read](#slack-read)
  - [slack-post](#slack-post)
  - [slack-list-channels](#slack-list-channels)
  - [slack-upload-file](#slack-upload-file)
  - [slack-download-file](#slack-download-file)
  - [register-agentmail-inbox](#register-agentmail-inbox)
- [Task Pool Tools](#task-pool-tools)
  - [task-action](#task-action)
- [Messaging Tools](#messaging-tools)
  - [list-channels](#list-channels)
  - [create-channel](#create-channel)
  - [delete-channel](#delete-channel)
  - [post-message](#post-message)
  - [read-messages](#read-messages)
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
  - [delete-schedule](#delete-schedule)
  - [run-schedule-now](#run-schedule-now)
- [Memory Tools](#memory-tools)
  - [memory-search](#memory-search)
  - [memory-get](#memory-get)
  - [memory-delete](#memory-delete)
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

---

## Core Tools

*Always available tools for basic swarm operations.*

### join-swarm

**Join the agent swarm**

Tool for an agent to join the swarm of agents with optional profile information.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lead` | `boolean` | No | false | Whether this agent should be the lead. |
| `name` | `string` | Yes | - | The name of the agent joining the swarm. |
| `description` | `string` | No | - | Agent description. |

### poll-task

**Poll for a task**

Poll for a new task assignment. Returns immediately if there are offered tasks awaiting accept/reject. Also returns count of unassigned tasks in the pool.

*No parameters*

### get-swarm

**Get the agent swarm**

Returns a list of agents in the swarm without their tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `a` | `string` | No | - | - |

### get-tasks

**Get tasks**

Returns a list of tasks in the swarm with various filters. Sorted by priority (desc) then lastUpdatedAt (desc).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mineOnly` | `boolean` | No | - | Only return tasks assigned to you. |
| `unassigned` | `boolean` | No | - | Only return unassigned tasks in the pool. |
| `readyOnly` | `boolean` | No | - | Only return tasks whose dependencies are met. |
| `taskType` | `string` | No | - | Filter by task type (e.g., 'bug', 'feature |
| `tags` | `array` | No | - | Filter by any matching tag. |
| `search` | `string` | No | - | Search in task description. |

### send-task

**Send a task**

Sends a task to a specific agent, creates an unassigned task for the pool, or offers a task for acceptance.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task` | `string` | Yes | - | The task description to send. |
| `dependsOn` | `array` | No | - | Task IDs this task depends on. |
| `slackUserId` | `string` | No | - | Slack user ID of the original requester. |

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
| `output` | `string` | No | - | The output of the task (used when completing). |

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

Look up a canonical user profile by any platform-specific identifier (Slack ID, Linear ID, GitHub username, email, or name). Returns the full user profile or null.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `slackUserId` | `string` | No | - | Slack user ID (e.g., U08NR6QD6CS) |
| `linearUserId` | `string` | No | - | Linear user UUID |
| `githubUsername` | `string` | No | - | GitHub username |
| `gitlabUsername` | `string` | No | - | GitLab username |
| `email` | `string` | No | - | Email address |
| `name` | `string` | No | - | Name (fuzzy substring match, lowest priority) |

### manage-user

**Manage user profiles**

Create, update, delete, or list user profiles in the user registry. Lead-only.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `create \| update \| delete \| list \| get` | Yes | - | Action to perform |
| `userId` | `string` | No | - | User ID (required for update/delete/get) |
| `name` | `string` | No | - | Display name (required for create) |
| `email` | `string` | No | - | Primary email address |
| `role` | `string` | No | - | Role (e.g., "founder", "engineer |
| `notes` | `string` | No | - | Free-form notes |
| `slackUserId` | `string` | No | - | Slack user ID |
| `linearUserId` | `string` | No | - | Linear user UUID |
| `githubUsername` | `string` | No | - | GitHub username |
| `gitlabUsername` | `string` | No | - | GitLab username |
| `emailAliases` | `array` | No | - | Additional email addresses |
| `preferredChannel` | `string` | No | - | Preferred contact channel |
| `timezone` | `string` | No | - | Timezone (e.g., America/New_York) |

### db-query

**Execute database query**

Execute a read-only SQL query against the swarm database. Lead-only. Results capped at 100 rows.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sql` | `string` | Yes | - | SQL query (read-only only — writes are rejected) |
| `params` | `array` | No | [] | Query parameters |

### set-config

**Set Config**

Set or update a swarm configuration value. Upserts by (scope, scopeId, key). Use scope='global' for server-wide settings, 'agent' for agent-specific, or 'repo' for repo-specific. Set isSecret=true to mask the value in API responses.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `string` | Yes | - | Configuration value. |

### get-config

**Get Config**

Get resolved configuration values with scope resolution (repo > agent > global). Returns one entry per unique key with the most-specific scope winning. Use includeSecrets=true to see secret values.

*No parameters*

### list-config

**List Config**

List raw config entries with optional filters. Unlike get-config, this returns raw entries without scope resolution — useful for seeing exactly what's configured at each scope level.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scopeId` | `string` | No | - | Filter by agent ID or repo ID. |
| `key` | `string` | No | - | Filter by specific key. |

### delete-config

**Delete Config**

Delete a swarm configuration entry by its ID. Use list-config to find config IDs first.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | The config entry ID to delete. |

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

### list-prompt-templates

**List Prompt Templates**

List prompt templates with optional filters. Returns all templates matching the specified criteria, including defaults and overrides at all scope levels.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
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
| `body` | `string` | Yes | - | The template body text with {{variable}} placeholders. |

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
| `body` | `string` | No | - | Custom body to preview instead of the default. |

### slack-reply

**Reply to Slack thread**

Send a reply to a Slack thread. Use inboxMessageId for inbox messages, or taskId for task-related threads.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | `string` | Yes | - | The message to send to the Slack thread. |

### slack-read

**Read Slack thread/channel history**

Read messages from a Slack thread or channel. Use inboxMessageId or taskId to read from a thread you have context for, or provide channelId directly for channel history (leads only).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inboxMessageId` | `uuid` | No | - | Read thread history for an inbox message. |
| `taskId` | `uuid` | No | - | Read thread history for a task. |

### slack-post

**Post new message to Slack channel**

Post a new message to a Slack channel. This creates a new message (not a thread reply). Requires lead privileges.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channelId` | `string` | Yes | - | The Slack channel ID to post to. |
| `message` | `string` | Yes | - | The message content to post. |

### slack-list-channels

**List Slack channels**

List Slack channels the bot is a member of. Use this to discover available channels for reading messages.

*No parameters*

### slack-upload-file

**Upload file to Slack**

Upload a file (image, document, etc.) to a Slack channel or thread. Use inboxMessageId or taskId for context, or provide channelId directly (leads only). Maximum file size is 1 GB.

*No parameters*

### slack-download-file

**Download file from Slack**

Download a file from Slack by file ID or URL. Files are saved to the agent's download directory on the shared disk by default.

*No parameters*

### register-agentmail-inbox

**Register AgentMail Inbox**

Register an AgentMail inbox ID to route incoming emails to this agent. When emails arrive at this inbox, they will be routed to you as tasks (for workers) or inbox messages (for leads). Use action 'register' to add a mapping, 'unregister' to remove one, or 'list' to see your current mappings.

*No parameters*

## Task Pool Tools

*Messaging*

### task-action

**Task Pool Actions**

Perform task pool operations: create unassigned tasks, claim/release tasks from pool, accept/reject offered tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskType` | `string` | No | - | Task type (e.g., 'bug', 'feature |
| `dependsOn` | `array` | No | - | Task IDs this task depends on. |

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
| `participants` | `array` | No | - | Agent IDs for DM channels. |

### delete-channel

**Delete Channel**

Deletes a channel and all its messages. Only the lead agent can delete channels. The default 'general' channel cannot be deleted.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channelId` | `string` | No | - | The ID of the channel to delete. |
| `name` | `string` | No | - | Channel name (alternative to channelId). |

### post-message

**Post Message**

Posts a message to a channel for cross-agent communication.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `string` | No | "general" | Channel name (default: 'general |
| `content` | `string` | Yes | - | Message content. |
| `replyTo` | `uuid` | No | - | Message ID to reply to (for threading). |

### read-messages

**Read Messages**

Reads messages from a channel. If no channel is specified, returns unread messages from ALL channels. Supports filtering by unread, mentions, and time range. Automatically marks messages as read.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `since` | `unknown` | No | - | Only messages after this ISO timestamp. |
| `unreadOnly` | `boolean` | No | false | Only return unread messages. |

## Profiles Tools

*Profiles*

### update-profile

**Update Profile**

Updates an agent's profile information (name, description, role, capabilities). By default updates the calling agent. Lead agents can update any agent's profile by providing the agentId parameter.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | No | - | Agent name. |
| `description` | `string` | No | - | Agent description. |

### context-history

**Context History**

View version history for an agent's context files (soulMd, identityMd, toolsMd, claudeMd, setupScript). Returns metadata for each version without full content.

*No parameters*

### context-diff

**Context Diff**

Compare two versions of a context file. Shows a unified diff between the specified version and its predecessor (or a specific comparison version).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `versionId` | `string` | Yes | - | The "newer" version ID to diff. |

## Services Tools

*Services*

### register-service

**Register Service**

Register a background service (e.g., PM2 process) for discovery by other agents. The service URL is automatically derived from your agent ID (https://{AGENT_ID}.{SWARM_URL}). Each agent can only run one service on port 3000.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `script` | `string` | Yes | - | Path to the script to run (required for PM2 restart). |
| `description` | `string` | No | - | What this service does. |
| `cwd` | `string` | No | - | Working directory for the script. |
| `args` | `array` | No | - | Command line arguments for the script. |
| `metadata` | `object` | No | - | Additional metadata. |

### unregister-service

**Unregister Service**

Remove a service from the registry. Use this after stopping a PM2 process. You can only unregister your own services.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `serviceId` | `uuid` | No | - | Service ID to unregister. |

### list-services

**List Services**

Query services registered by agents in the swarm. Use this to discover services exposed by other agents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `uuid` | No | - | Filter by specific agent ID. |
| `name` | `string` | No | - | Filter by service name (partial match). |

### update-service-status

**Update Service Status**

Update the health status of a registered service. Use this after a service becomes healthy or needs to be marked as stopped/unhealthy.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `serviceId` | `uuid` | No | - | Service ID to update. |
| `name` | `string` | No | - | Service name to update (alternative to serviceId). |

## Scheduling Tools

*Scheduling*

### list-schedules

**List Scheduled Tasks**

View all scheduled tasks with optional filters. Use this to discover existing schedules.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `enabled` | `boolean` | No | - | Filter by enabled status |
| `name` | `string` | No | - | Filter by name (partial match) |

### create-schedule

**Create Scheduled Task**

Create a new scheduled task. For recurring: provide cronExpression or intervalMs. For one-time: provide delayMs or runAt with scheduleType 'one_time'.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `description` | `string` | No | - | Human-readable description of the schedule |
| `tags` | `array` | No | - | Tags to apply to created tasks |
| `timezone` | `string` | No | "UTC" | Timezone for cron schedules |

### update-schedule

**Update Scheduled Task**

Update an existing scheduled task. Only the creator or lead agent can update schedules.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scheduleId` | `string` | No | - | Schedule ID to update |
| `name` | `string` | No | - | Schedule name to update (alternative to ID) |
| `newName` | `string` | No | - | New name for the schedule |
| `taskTemplate` | `string` | No | - | New task template |
| `cronExpression` | `string` | No | - | New cron expression |
| `intervalMs` | `number` | No | - | New interval in milliseconds |
| `description` | `string` | No | - | New description |
| `taskType` | `string` | No | - | New task type |
| `tags` | `array` | No | - | New tags |
| `priority` | `number` | No | - | New priority |
| `targetAgentId` | `string` | No | - | New target agent ID |
| `timezone` | `string` | No | - | New timezone |
| `enabled` | `boolean` | No | - | Enable or disable the schedule |

### delete-schedule

**Delete Scheduled Task**

Delete a scheduled task permanently. Only the creator or lead agent can delete schedules.

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
| `limit` | `number` | No | 10 | Max results to return. |

### memory-get

**Get memory details**

Retrieve the full content of a specific memory by its ID. Use memory-search to find memory IDs first.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memoryId` | `uuid` | Yes | - | The ID of the memory to retrieve. |

### memory-delete

**Delete a memory**

Delete a specific memory by its ID. Agents can delete their own memories; lead agents can also delete swarm-scoped memories.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memoryId` | `uuid` | Yes | - | The ID of the memory to delete. |

### inject-learning

**Inject learning into worker memory**

Allows the lead agent to push learnings into a worker's memory. The learning will be stored as a searchable memory entry that the worker can recall in future sessions.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `uuid` | Yes | - | Target worker agent ID |
| `learning` | `string` | Yes | - | The learning content to inject |

## Workflows Tools

*Tracker*

### create-workflow

**Create Workflow**

Create a new automation workflow. Key concepts:\n" + "- Nodes are linked via 'next' (string or port-based record).\n" + "- CROSS-NODE DATA: To use output from an upstream node, you MUST declare an 'inputs' mapping on the downstream node. " + 'Example: inputs: { "cityData": "generate-city" } → then use {{cityData.taskOutput.field}} in config templates. ' + "Without 'inputs', only 'trigger' and workflow-level 'input' are available for interpolation.\n" + "- STRUCTURED OUTPUT: For agent-task nodes, put outputSchema inside 'config' to validate the agent's raw JSON output. " + "Node-level outputSchema validates the executor's return ({taskId, taskOutput}), which is different.\n" + "- Agent-task config: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Unique name for the workflow |
| `description` | `string` | No | - | Description of what this workflow does |

### list-workflows

**List Workflows**

List all automation workflows, optionally filtered by enabled status. Returns new fields: triggers, cooldown, input.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `enabled` | `boolean` | No | - | Filter by enabled status (omit to return all) |

### get-workflow

**Get Workflow**

Get a workflow by ID, including its definition, triggers, cooldown, input, and auto-generated edges for UI rendering.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID |

### update-workflow

**Update Workflow**

Update an existing workflow's name, description, definition, triggers, cooldown, input, or enabled state. Creates a version snapshot before applying changes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to update |
| `name` | `string` | No | - | New name for the workflow |
| `description` | `string` | No | - | New description |
| `triggers` | `array` | No | - | New trigger configurations |
| `enabled` | `boolean` | No | - | Enable or disable the workflow |

### patch-workflow

**Patch Workflow Definition**

Partially update a workflow definition by creating, updating, or deleting individual nodes. " + "Operations are applied in order: delete → create → update. " + "Creates a version snapshot before applying changes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to patch |
| `delete` | `array` | No | - | Node IDs to delete |

### patch-workflow-node

**Patch Workflow Node**

Partially update a single node in a workflow definition. " + "Merges the provided fields into the existing node. " + "Creates a version snapshot before applying changes.

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

Manually trigger a workflow execution, optionally passing trigger data as context. Respects cooldown configuration.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to trigger |

### list-workflow-runs

**List Workflow Runs**

List all execution runs for a given workflow, optionally filtered by status.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `workflowId` | `string` | Yes | - | Workflow ID to list runs for |

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

Create an approval request that pauses until a human responds. " + "Supports multiple question types: approval (yes/no), text, single-select, " + "multi-select, and boolean. Returns the request ID and URL for the human to respond.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `title` | `string` | Yes | - | Title of the approval request |
| `questions` | `array` | Yes | - | Questions to ask the human |

## Other Tools

*Tools not assigned to a capability group*

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
| `isEnabled` | `boolean` | No | - | Toggle enabled/disabled |

### mcp-server-create

**Create MCP Server**

Create a new MCP server definition. Agent-scope servers are auto-installed for the creating agent. Swarm/global scope requires lead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Server name |
| `description` | `string` | No | - | Server description |
| `transport` | `stdio \| http \| sse` | Yes | - | Transport type |
| `command` | `string` | No | - | Command to run (required for stdio transport) |
| `args` | `string` | No | - | JSON array of command arguments (stdio only) |
| `url` | `string` | No | - | Server URL (required for http/sse transport) |

### mcp-server-install

**Install MCP Server**

Install an MCP server for an agent. Self-install is always allowed; cross-agent install requires lead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mcpServerId` | `string` | Yes | - | ID of the MCP server to install |

### mcp-server-list

**List MCP Servers**

List MCP servers with optional filters. Use installedOnly to see servers installed for the calling agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scope` | `global \| swarm \| agent` | No | - | Filter by scope |
| `transport` | `stdio \| http \| sse` | No | - | Filter by transport type |
| `search` | `string` | No | - | Search by name or description |

### mcp-server-uninstall

**Uninstall MCP Server**

Uninstall an MCP server from an agent. Self-uninstall is always allowed; cross-agent requires lead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mcpServerId` | `string` | Yes | - | ID of the MCP server to uninstall |
| `agentId` | `string` | No | - | Target agent (default: calling agent) |

### mcp-server-get

**Get MCP Server**

Get MCP server details by ID or name. Name resolution uses scope cascade: agent > swarm > global.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | No | - | MCP server ID |
| `name` | `string` | No | - | MCP server name (resolved with scope cascade) |

### mcp-server-delete

**Delete MCP Server**

Delete an MCP server definition. Only the owning agent or lead can delete.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | ID of the MCP server to delete |

### tracker-map-agent

**Map Agent to Tracker User**

Map a swarm agent to an external tracker user (for assignment sync).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `string` | Yes | - | Tracker provider (e.g. 'linear |
| `agentId` | `string` | Yes | - | The swarm agent ID |
| `externalUserId` | `string` | Yes | - | The external user ID in the tracker |
| `agentName` | `string` | Yes | - | Display name for the agent mapping |

### tracker-link-task

**Link Task to Tracker**

Link a swarm task to an external tracker issue.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `string` | Yes | - | Tracker provider (e.g. 'linear |
| `swarmTaskId` | `string` | Yes | - | The swarm task ID to link |
| `externalId` | `string` | Yes | - | The external issue ID in the tracker |
| `externalUrl` | `string` | No | - | URL to the external issue |

### tracker-sync-status

**Tracker Sync Status**

Show all tracker sync mappings with their state.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `string` | No | - | Filter by provider (e.g. 'linear |
| `entityType` | `task` | No | - | Filter by entity type |

### tracker-status

**Tracker Status**

Show all connected trackers and their OAuth status (token expiry, workspace info).

*No parameters*

### tracker-unlink

**Unlink Tracker Sync**

Remove a tracker sync mapping by ID.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `syncId` | `string` | Yes | - | The tracker sync mapping ID to remove |

### skill-install-remote

**Install Remote Skill**

Fetch and install a remote skill from a GitHub repository. Fetches SKILL.md via GitHub raw content API.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sourceRepo` | `string` | Yes | - | GitHub repo (e.g. "vercel-labs/skills |
| `sourcePath` | `string` | No | - | Path within repo (e.g. "skills/nextjs |

### skill-update

**Update Skill**

Update a skill's content or settings. Re-parses frontmatter if content changes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | No | - | Skill ID to update |
| `content` | `string` | No | - | New SKILL.md content (re-parses frontmatter) |
| `isEnabled` | `boolean` | No | - | Toggle enabled/disabled |

### skill-create

**Create Skill**

Create a personal skill from SKILL.md content. Parses frontmatter for name, description, and metadata.

*No parameters*

### skill-get

**Get Skill**

Get full skill content by ID or name. Name resolution checks agent scope first, then swarm, then global.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | No | - | Skill ID |
| `name` | `string` | No | - | Skill name (resolved with precedence) |

### skill-search

**Search Skills**

Search skills by keyword (name and description).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | - | Search query |
| `limit` | `number` | No | 20 | - |

### skill-sync-remote

**Sync Remote Skills**

Check and update remote skills from their GitHub sources. Compares content and updates if changed.

*No parameters*

### skill-install

**Install Skill**

Install/assign a skill to an agent. Leads can install for other agents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the skill to install |

### skill-publish

**Publish Skill**

Publish a personal skill to swarm scope. Creates an approval task for the lead agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the personal skill to publish |

### skill-uninstall

**Uninstall Skill**

Remove a skill from an agent.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the skill to uninstall |
| `agentId` | `string` | No | - | Target agent (default: calling agent) |

### skill-delete

**Delete Skill**

Delete a skill. Only the owning agent or lead can delete.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `skillId` | `string` | Yes | - | ID of the skill to delete |

### skill-list

**List Skills**

List available skills with optional filters.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | `remote \| personal` | No | - | Filter by type |
| `scope` | `global \| swarm \| agent` | No | - | Filter by scope |
| `agentId` | `string` | No | - | Filter by owning agent |

