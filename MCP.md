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
  - [slack-reply](#slack-reply)
  - [inbox-delegate](#inbox-delegate)
  - [get-inbox-message](#get-inbox-message)
- [Task Pool Tools](#task-pool-tools)
  - [task-action](#task-action)
- [Messaging Tools](#messaging-tools)
  - [list-channels](#list-channels)
  - [create-channel](#create-channel)
  - [post-message](#post-message)
  - [read-messages](#read-messages)
- [Profiles Tools](#profiles-tools)
  - [update-profile](#update-profile)
- [Services Tools](#services-tools)
  - [register-service](#register-service)
  - [unregister-service](#unregister-service)
  - [list-services](#list-services)
  - [update-service-status](#update-service-status)

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

### slack-reply

**Reply to Slack thread**

Send a reply to a Slack thread. Use inboxMessageId for inbox messages, or taskId for task-related threads.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `message` | `string` | Yes | - | The message to send to the Slack thread. |

### inbox-delegate

**Delegate inbox message to worker**

Delegate an inbox message to a worker agent by creating a task. The task inherits Slack context for replies.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inboxMessageId` | `uuid` | Yes | - | The inbox message ID to delegate. |
| `agentId` | `uuid` | Yes | - | The worker agent to delegate to. |

### get-inbox-message

**Get inbox message details**

Returns detailed information about a specific inbox message, including full content and Slack context. Only accessible to the lead agent who owns the message.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inboxMessageId` | `uuid` | Yes | - | The ID of the inbox message to retrieve. |

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

