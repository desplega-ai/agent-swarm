---
name: work-on-task
description: "Turn prompt for an assigned swarm task: find the task, gather context when the message lacks it, use the skill the task names, finish with one of the four endings."
---

# Working on a task

The taskId follows the command. Without one, call `get-tasks` with `mineOnly: true` and take your `pending` or `in_progress` task. If there is none, say so and stop.

This message carries the task text, its attachments, its output format, and memories from past sessions. If it does not (you invoked this command yourself, or the context was compacted), run the `task-context-gathering` script with the taskId.

When the task names a skill (`researching`, `planning`, `implementing`), use it. Otherwise work directly.

Finish the task with one of the four endings in your operating contract: `completed`, `defer-task`, `request-human-input`, or `failed`. Then stop.

Resuming (a resume task, or work cut by a graceful shutdown): read the parent's last progress line, then re-read live state once (PR state and head SHA, branch, `git status`) before new work. Re-run controls only if the head moved. Never redo a pushed commit or open a second PR for the same branch. Store a progress line with branch, PR number and head SHA each time you push. A document task has no branch: its live state is the brief's agent-fs output path and the task attachments. Run `agent-fs ls` on that path, download any partial and extend it. Then list the task's local work directory: a shutdown can leave the newest draft only there, or leave cache files half-written. Parse every cache file, delete the ones that fail, and re-run only the stages whose output is missing. Never re-run collection steps that already produced artifacts. If your task's `model` differs from the parent's, say so in the output, because the result's provenance changed.

Write times in replies, outputs and defer notes in the requester's timezone when the Requester Profile names one, never raw UTC.

If the user interrupts, follow their instructions. To resume, call `/work-on-task <taskId>` again.
