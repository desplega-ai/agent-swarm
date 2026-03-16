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
  - [set-config](#set-config)
  - [get-config](#get-config)
  - [list-config](#list-config)
  - [delete-config](#delete-config)
  - [slack-reply](#slack-reply)
  - [slack-read](#slack-read)
  - [slack-post](#slack-post)
  - [slack-list-channels](#slack-list-channels)
  - [slack-upload-file](#slack-upload-file)
  - [slack-download-file](#slack-download-file)
  - [register-agent-mail-inbox](#register-agent-mail-inbox)
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
- [Epics Tools](#epics-tools)
  - [create-epic](#create-epic)
  - [list-epics](#list-epics)
  - [get-epic-details](#get-epic-details)
  - [update-epic](#update-epic)
  - [delete-epic](#delete-epic)
  - [assign-task-to-epic](#assign-task-to-epic)
  - [unassign-task-from-epic](#unassign-task-from-epic)
- [Memory Tools](#memory-tools)
  - [memory-search](#memory-search)
  - [memory-get](#memory-get)
  - [inject-learning](#inject-learning)
- [Workflows Tools](#workflows-tools)
  - [create-workflow](#create-workflow)
  - [list-workflows](#list-workflows)
  - [get-workflow](#get-workflow)
  - [update-workflow](#update-workflow)
  - [delete-workflow](#delete-workflow)
  - [trigger-workflow](#trigger-workflow)
  - [list-workflow-runs](#list-workflow-runs)
  - [get-workflow-run](#get-workflow-run)
  - [retry-workflow-run](#retry-workflow-run)

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
| `epicId` | `string` | No | - | Epic to associate this task with. |

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

### register-agent-mail-inbox

*Documentation not available*

## Task Pool Tools

*Epics*

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

Updates the calling agent's profile information (name, description, role, capabilities).

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

## Epics Tools

*Epics*

### create-epic

**Create Epic**

Create a new epic (project) to organize related tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Unique name for the epic |
| `goal` | `string` | Yes | - | The goal/objective of this epic |
| `description` | `string` | No | - | Detailed description |
| `prd` | `string` | No | - | Product Requirements Document (markdown) |
| `plan` | `string` | No | - | Implementation plan (markdown) |
| `priority` | `number` | No | 50 | - |
| `tags` | `array` | No | - | Tags for filtering |
| `leadAgentId` | `string` | No | - | Lead agent for this epic |
| `researchDocPath` | `string` | No | - | Path to research document |
| `planDocPath` | `string` | No | - | Path to plan document |
| `slackChannelId` | `string` | No | - | - |
| `slackThreadTs` | `string` | No | - | - |
| `vcsRepo` | `string` | No | - | - |
| `vcsMilestone` | `string` | No | - | - |

### list-epics

**List Epics**

List epics with optional filters. Returns epics with progress information.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `search` | `string` | No | - | Search in name, description, or goal |
| `leadAgentId` | `string` | No | - | Filter by lead agent |
| `createdByAgentId` | `string` | No | - | Filter by creator |

### get-epic-details

**Get Epic Details**

Get detailed information about a specific epic, including progress and associated tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `epicId` | `string` | No | - | The ID of the epic |
| `name` | `string` | No | - | The name of the epic (alternative to ID) |

### update-epic

**Update Epic**

Update an existing epic. Only the creator, lead agent, or swarm lead can update.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `epicId` | `string` | No | - | The ID of the epic to update |
| `name` | `string` | No | - | Epic name (alternative to ID for lookup) |
| `newName` | `string` | No | - | New name for the epic |
| `description` | `string` | No | - | New description |
| `goal` | `string` | No | - | New goal |
| `prd` | `string` | No | - | New PRD (markdown) |
| `plan` | `string` | No | - | New plan (markdown) |
| `priority` | `number` | No | - | New priority |
| `tags` | `array` | No | - | New tags |
| `leadAgentId` | `string` | No | - | New lead agent |
| `researchDocPath` | `string` | No | - | - |
| `planDocPath` | `string` | No | - | - |
| `slackChannelId` | `string` | No | - | - |
| `slackThreadTs` | `string` | No | - | - |
| `vcsRepo` | `string` | No | - | - |
| `vcsMilestone` | `string` | No | - | - |
| `nextSteps` | `string` | No | - | Notes on what to do next for this epic |

### delete-epic

**Delete Epic**

Delete an epic. Only the creator or swarm lead can delete. Tasks are unassigned, not deleted.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `epicId` | `string` | No | - | The ID of the epic to delete |
| `name` | `string` | No | - | Epic name (alternative to ID) |

### assign-task-to-epic

**Assign Task to Epic**

Assign an existing task to an epic.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | `string` | Yes | - | The ID of the task to assign |
| `epicId` | `string` | No | - | The ID of the epic |
| `epicName` | `string` | No | - | Epic name (alternative to ID) |

### unassign-task-from-epic

**Unassign Task from Epic**

Remove a task from its epic. The task is kept but no longer associated.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | `string` | Yes | - | The ID of the task to unassign |

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

### inject-learning

**Inject learning into worker memory**

Allows the lead agent to push learnings into a worker's memory. The learning will be stored as a searchable memory entry that the worker can recall in future sessions.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `uuid` | Yes | - | Target worker agent ID |
| `learning` | `string` | Yes | - | The learning content to inject |

## Workflows Tools

*Workflows*

### create-workflow

**Create Workflow**

Create a new automation workflow with a trigger → condition → action DAG definition.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | - | Unique name for the workflow |
| `description` | `string` | No | - | Description of what this workflow does |

### list-workflows

**List Workflows**

List all automation workflows, optionally filtered by enabled status.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `enabled` | `boolean` | No | - | Filter by enabled status (omit to return all) |

### get-workflow

**Get Workflow**

Get a workflow by ID, including its full DAG definition.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID |

### update-workflow

**Update Workflow**

Update an existing workflow's name, description, definition, or enabled state.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to update |
| `name` | `string` | No | - | New name for the workflow |
| `description` | `string` | No | - | New description |
| `enabled` | `boolean` | No | - | Enable or disable the workflow |

### delete-workflow

**Delete Workflow**

Delete a workflow by ID. This also removes all associated runs and steps.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to delete |

### trigger-workflow

**Trigger Workflow**

Manually trigger a workflow execution, optionally passing trigger data as context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | - | Workflow ID to trigger |

### list-workflow-runs

**List Workflow Runs**

List all execution runs for a given workflow.

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

## Other Tools

*Tools not assigned to a capability group*

### register-agentmail-inbox

**Register AgentMail Inbox**

Register an AgentMail inbox ID to route incoming emails to this agent. When emails arrive at this inbox, they will be routed to you as tasks (for workers) or inbox messages (for leads). Use action 'register' to add a mapping, 'unregister' to remove one, or 'list' to see your current mappings.

*No parameters*

