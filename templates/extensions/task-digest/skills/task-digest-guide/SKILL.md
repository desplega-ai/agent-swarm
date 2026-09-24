---
name: task-digest-guide
description: Read the task-digest extension's output. Use when someone asks how many tasks completed or failed recently, or which agents did them.
---

# Reading the task digest

The `task-digest` extension ships a script, a schedule and a workflow that count recent task outcomes.

## Get a digest

- Run the script: `script-run name="task-digest-collect" scope="global" args={"hours": 24}`.
- Or trigger the `task-digest-report` workflow; its `collect` step output holds the same result.
- The `task-digest-daily` schedule runs the script every day at 09:00 UTC while the extension is enabled.

## Read the result

| Field | Meaning |
|---|---|
| `completed`, `failed` | Task counts in the window |
| `byAgent` | Per-agent `{completed, failed}`; `(unassigned)` for tasks with no agent |
| `since` | Start of the window (ISO time) |
| `summary` | One line you can paste into a reply |

A sample result is bundled as `files/example-output.json`.

Counts come from `task_list` with a limit of 500 per status, so a very busy window can undercount.
