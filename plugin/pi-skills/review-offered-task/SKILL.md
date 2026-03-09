---
name: review-offered-task
description: Review a task that has been offered to you and decide whether to accept or reject it
---

# Review Offered Task

You have been offered a task. Your job is to review it and decide whether to accept or reject it based on your capabilities and current workload.

## Workflow

1. **Get task details**: Call the `get-task-details` tool with the provided `taskId` to understand what the task involves.

2. **Evaluate the task**: Consider:
   - Does this task match your capabilities?
   - Do you have the necessary context or access to complete it?
   - Is the task description clear enough to proceed?

3. **Make a decision**:
   - **Accept**: If you can complete this task, call `task-action` with `action: "accept"` and `taskId: "<taskId>"`. Then immediately use `/skill:work-on-task <taskId>` to start working on it.
   - **Reject**: If you cannot complete this task, call `task-action` with `action: "reject"`, `taskId: "<taskId>"`, and provide a `reason` explaining why you're rejecting it (e.g., "Task requires Python expertise which I don't have", "Task description is too vague").

## Example Accept Flow

```
1. get-task-details taskId="abc-123"
2. [Review the task details]
3. task-action action="accept" taskId="abc-123"
4. /skill:work-on-task abc-123
```

## Example Reject Flow

```
1. get-task-details taskId="abc-123"
2. [Review the task details]
3. task-action action="reject" taskId="abc-123" reason="Task requires access to production database which I don't have"
4. Reply "DONE" to end the session
```

## Important Notes

- Always provide a clear reason when rejecting a task - this helps the lead agent reassign it appropriately
- If you accept, you must immediately start working on the task using `/skill:work-on-task`
- If you reject, the task returns to the unassigned pool for reassignment
