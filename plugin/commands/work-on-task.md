---
description: Work on a specific task assigned to you in the agent swarm
argument-hint: [taskId]
---

# Working on a Task

If no `taskId` is provided, you should call the `poll-task` tool to get a new task assigned to you.

## Workflow

Once you get a task assigned, you need to immidiately start working on it. To do so, the first thing you need to do is call the MCP tool `get-task-details` to get all the details about the task you need to work on.

Once you have the task details, you should:

1. Figure out if you need to use any of the available commands to help you with your work (see below for available commands)
2. Use the `/todos` command to add a new todo item indicating you are starting to work on the task (e.g. "Work on task XXX: <short description>"). This will help on restarts, as it will be easier to remember what you were doing.
3. Call `store-progress` tool to mark the task as "in-progress" with a progress set to something like "Starting work on the task XXX, blah blah". Additionally use `/swarm-chat` command to notify the swarm, human and lead when applicable. Do not be too verbose, nor spammy.
4. Start working on the task, providing updates as needed by calling `store-progress` tool, use the `progress` field to indicate what you are doing.
5. Once you either done or in a dead-end, see the "Completion" section below.

### Available commands

As you start working on a task, you might need to use some of the following commands to help you with your work:

- `/desplega:research` - Use this command to perform research on the web to gather information needed for the task.
- `/desplega:create-plan` - Use this command to create a detailed plan for how you will approach and complete the task.
- `/desplega:implement-plan` - Use this command to implement the plan you created for the task. It can be used to continue working on the implementation too (not just start it).

- `/swarm-chat` - Use this command to communicate with other agents in the swarm if you need help or want to provide updates.
- `/todos` - Use this command to manage your personal todo list, which can help you keep track of sub-tasks related to the main task.

#### Decision to use commands

When the task is a research task, you should ALWAYS use the `/desplega:research` command to gather information.

When the task is a development task, you should ALWAYS use the `/desplega:create-plan` command first to create a plan, and then use the `/desplega:implement-plan` command to implement it.

If the implementation does not reference any existing plan, proceed normally to implement it without using any commands.

### Interruptions

If you get interrupted by the user, that is fine, it might happen. Just make sure to call `store-progress` tool to update the task progress once you get back to it. If the user provides new instructions, make sure to adapt your work on the task accordingly.

Once you get back to it, make sure to call the `/work-on-task` again with the same `taskId` to resume working on it.

### Completion

Once you are done, or in a real dead-end, you should call `store-progress` tool to mark the task as "complete" or "failed" as needed. You should always use the `output` and `failureReason` fields to provide context about the task completion or failure. 

If you used the `/todos` command to add a todo item when starting the task, make sure to mark it as completed or remove it as needed.

Once you are done (either ok or not), perform the Post-Task Reflection below, then finish the session by just replying "DONE".

### Post-Task Reflection (REQUIRED)

After calling `store-progress` to complete or fail a task, do the following before finishing:

1. **Transferable learning?** If you learned something reusable (a pattern, a gotcha, a fix), write it to `/workspace/personal/memory/<descriptive-name>.md`
2. **Swarm-relevant?** If the learning applies to all agents (not just you), write it to `/workspace/shared/memory/<descriptive-name>.md` instead
3. **Identity update?** If you discovered a new area of expertise or working style preference, update your IDENTITY.md
4. **Tools update?** If you found a new service, API, or tool, update your TOOLS.md

Skip this section ONLY if the task was trivially simple (single file edit, no debugging, no new knowledge gained).
