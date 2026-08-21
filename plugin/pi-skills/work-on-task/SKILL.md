---
name: work-on-task
description: Work on a specific task assigned to you in the agent swarm
---

# Working on a task

The taskId follows the command. Without one, call `get-tasks` with `mineOnly: true` and take your `pending` or `in_progress` task. If there is none, say so and stop.

This message carries the task text, its attachments, its output format, and memories from past sessions. If it does not (you invoked this command yourself, or the context was compacted), run the `task-context-gathering` script with the taskId.

When the task names a command (`/researching`, `/planning`, `/implementing`), use it. Otherwise work directly.

Finish the task with one of the four endings in your operating contract: `completed`, `defer-task`, `request-human-input`, or `failed`. Then stop.

If the user interrupts, follow their instructions. To resume, call `/skill:work-on-task <taskId>` again.
