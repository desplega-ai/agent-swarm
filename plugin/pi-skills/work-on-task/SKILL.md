---
name: work-on-task
description: Work on a specific task assigned to you in the agent swarm
---

# Working on a Task

If no `taskId` is provided, you should call the `poll-task` tool to get a new task assigned to you.

## Workflow

Once you get a task assigned, you need to immediately start working on it. To do so, the first thing you need to do is call the MCP tool `get-task-details` to get all the details about the task you need to work on.

Once you have the task details, you should:

1. **Check Installed Skills (REQUIRED):** Before researching or implementing, review your "Installed Skills" section in the system prompt:
   - If any skill's description or trigger matches this task, invoke it via the `Skill` tool BEFORE doing manual research
   - Skills contain pre-built, tested procedures that save context window and cost
   - Example: task involves Linear → use `linear-interaction` skill, task involves email → use `agentmail-sending` skill
   - Only proceed to manual research/web search if NO installed skill covers the task
   - This step is NOT optional. Skipping it wastes context and money.
2. Figure out if you need to perform any research or planning before starting (see below)
3. Use the `/skill:todos` to add a new todo item indicating you are starting to work on the task (e.g. "Work on task XXX: <short description>"). This will help on restarts, as it will be easier to remember what you were doing.
4. Call `store-progress` tool to mark the task as "in-progress" with a progress set to something like "Starting work on the task XXX, blah blah". Additionally use `/skill:swarm-chat` to notify the swarm, human and lead when applicable. Do not be too verbose, nor spammy.
5. Start working on the task, providing updates as needed by calling `store-progress` tool, use the `progress` field to indicate what you are doing.
6. Once you either done or in a dead-end, see the "Completion" section below.

### Research and Planning

As you start working on a task, consider whether you need to:

- **Research**: For research tasks, gather information from the web, codebase, or documentation before starting implementation.
- **Create a plan**: For development tasks, create a detailed plan before implementing. Write it to `/workspace/personal/plans/`.
- **Implement a plan**: If you already have a plan, follow it step by step.

### Communication

- Use `/skill:swarm-chat` to communicate with other agents in the swarm if you need help or want to provide updates.

#### Decision guidelines

When the task is a research task, you should ALWAYS perform thorough research before proceeding.

When the task is a development task, you should ALWAYS create a plan first, then implement it.

If the task is straightforward with clear instructions, proceed normally without extensive planning.

### Interruptions

If you get interrupted by the user, that is fine, it might happen. Just make sure to call `store-progress` tool to update the task progress once you get back to it. If the user provides new instructions, make sure to adapt your work on the task accordingly.

Once you get back to it, make sure to call `/skill:work-on-task` again with the same `taskId` to resume working on it.

### Completion

Once you are done, or in a real dead-end, you should call `store-progress` tool to mark the task as "complete" or "failed" as needed. You should always use the `output` and `failureReason` fields to provide context about the task completion or failure.

If you used the `/skill:todos` to add a todo item when starting the task, make sure to mark it as completed or remove it as needed.

Once you are done (either ok or not), perform the Post-Task Reflection below, then finish the session by just replying "DONE".

### Post-Task Reflection (REQUIRED)

After calling `store-progress` to complete or fail a task, do the following before finishing:

1. **Transferable learning?** If you learned something reusable (a pattern, a gotcha, a fix), write it to `/workspace/personal/memory/<descriptive-name>.md`
2. **Swarm-relevant?** If the learning applies to all agents (not just you), write it to `/workspace/shared/memory/<your-id>/<descriptive-name>.md` so all agents can find it via `memory-search`
3. **Identity update?** If you discovered a new area of expertise or working style preference, update your IDENTITY.md
4. **Tools update?** If you found a new service, API, or tool, update your TOOLS.md

Skip this section ONLY if the task was trivially simple (single file edit, no debugging, no new knowledge gained).
