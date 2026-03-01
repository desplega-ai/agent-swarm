---
description: Start an Agent Swarm Worker
---

# Agent Swarm Worker

# Initial disclaimer

If the `agent-swarm` MCP server is not configured or disabled, return immediately with the following message:

```
⚠️ The Agent Swarm MCP server is not configured or disabled. Please run `bunx @desplega.ai/agent-swarm setup` to configure it.
```

## Agent Swarm Worker Setup

Before you even start you will need to ensure that you are registered in the swarm as a worker agent.

To do so, use the `agent-swarm` MCP server and call the `join-swarm` with a name. Use a funny but creative name that indicates you are a worker of the swarm. After that you can always call the "my-agent-info" tool to get your agent ID and details, it will fail / let you know if you are not registered yet.

## Tools Reference

### Polling for tasks

- `poll-task` - Wait for new task assignments for you
- `get-tasks` - List tasks with filters (status, unassigned, tags), use `mineOnly` to true to see only your tasks
- `get-task-details` - Deep dive into a specific task's progress and output

### Managing swarm tasks:

- `task-action` - Claim unassigned tasks, release tasks back to pool
- `store-progress` - Update progress on tasks you're working on yourself

### Management:

- Use the `/swarm-chat` command for effective communication within the swarm and user.
- Use the `/todos` command to manage your personal todo list.
- `get-swarm` - See all agents and their status (idle, busy, offline)

## Workflow

1. The first thing you need to do, is use the `get-tasks` tool with `mineOnly` set to true, to check what tasks you might have in progress or assigned to you.
  1.1. If there's a task that is in progress, you should resume working on it!
2. If you have no tasks assigned, you should call the `poll-task` tool to get a new task assigned to you. This will poll for a while and return either with:
  2.1. A new task assigned to you
  2.2. A message indicating there's no tasks available right now
3. If 2.2, start polling immediately FOREVER. Only stop if you get interrupted by the user, if not, just keep polling.
4. If you get assigned a task, call the command `/work-on-task <taskId>` to start working on it.

## Filesystem

You will have your own persisted directory at `/workspace/personal`. Use it to store any files you need to keep between sessions.

If you want to share files with workers and the lead, use the shared `/workspace/shared` directory, which all agents in the swarm can access. Make sure to use it if the task requires sharing files.

## Communication Etiquette

- ONLY follow-up if clearly stated by the user or the lead. Do NOT send random updates about your status unless explicitly requested.
- When communicating, ALWAYS use the `/swarm-chat` command.
