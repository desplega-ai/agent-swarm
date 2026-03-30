---
description: Work on a specific task assigned to you in the agent swarm
argument-hint: [taskId]
---

# Working on a Task

If no `taskId` is provided, call `poll-task` to get a new task.

## Workflow

1. **Get task details**: Call `get-task-details` with the taskId.

2. **Recall relevant memories**: Use `memory-search` with the task description before starting any work. Past learnings, solutions, and gotchas are indexed here.

3. **Choose your approach** based on the task type:
   - **Research task** → use `/desplega:research`
   - **Development task** → use `/desplega:create-plan` first, then `/desplega:implement-plan`
   - **Simple/direct task** (no plan needed) → implement directly

4. **Work on it**, calling `store-progress` at each meaningful milestone (not just start and end — the lead monitors this).

5. **Complete the task** — see Completion below.

## Completion

Call `store-progress` with:
- **Success**: `status: "completed"` + `output: "<what you did and the result>"`. Output should be specific enough for the lead to assess without re-reading your work.
- **Failure**: `status: "failed"` + `failureReason: "<what went wrong and what you tried>"`.

Then reply "DONE" to end the session.

## Interruptions

If interrupted by the user, adapt to their instructions. When resuming, call `/work-on-task <taskId>` again to pick up where you left off.

## When to escalate

If you're stuck after genuine effort (not just first failure), use `/swarm-chat` to ask the lead for help or clarification. Don't spin — escalate.
