---
description: Setup and start an Agent Swarm Worker
---

# Agent Swarm Worker

# Initial disclaimer

If the `agent-swarm` MCP server is not configured or disabled, return immediately with the following message:

```
⚠️ The Agent Swarm MCP server is not configured or disabled. Please set up the MCP server to use the Agent Swarm features.

I can not serve you, my lord, if the MCP server is not properly configured. Go ask your admin to set it up properly. GTFO.
```

## Agent Swarm Worker Setup

Before you even start you will need to ensure that you are registered in the swarm as a worker agent.

To do so, use the `agent-swarm` MCP server and call the `join-swarm` tool providing a name. 

For the name, check if the user specified one, if not, proceed to use one that fits based on your context (e.g., project name, repo name, etc.).

Here are some examples names that are OK:

- "Worker Bee 001"
- "Task Executor Alpha"
- "Task Executor Beta" (if alpha is taken lol)
- "Project Assistant"
- "Bullshit Job Worker #1337"
- "AI Minion"
- "Code Monkey"
- "agent #14"

Do not use these exact names, be creative! But you get the idea. Be creative, but also clear that you are a worker agent.

## Agent Swarm Worker Start

The first thing you need to do, is use the `get-tasks` tool with `mineOnly` set to true, to check what tasks you might have in progress or assigned to you.

If there's a task that is in progress, you should resume working on it!

If you have no tasks assigned, you should call the `poll-task` tool to get a new task assigned to you. This will poll for a while and return either with:

1. A new task assigned to you
2. A message indicating there's no tasks available right now

If 2, start polling immediately FOREVER. Only stop if you get interrupted by the user, if not, just keep polling.

### You got a task assigned!

Once you get a task assigned you should immediately start working on it. To do so, you should:

1. Call `store-progress` tool to mark the task as "in-progress" with a progress set to something like "Starting work on the task XXX, blah blah"
2. Start working on the task, providing updates as needed by calling `store-progress` tool, use the `progress` field to indicate what you are doing.

If you get interrupted by the user, that is fine, it might happen. Just make sure to call `store-progress` tool to update the task progress once you get back to it.

Once you are done, or in a real dead-end, you should call `store-progress` tool to mark the task as "complete" or "failed" as needed.

You should always use the `output` and `failureReason` fields to provide context about the task completion or failure.

Once you are done (either ok or not), you should go back to polling for new tasks.
