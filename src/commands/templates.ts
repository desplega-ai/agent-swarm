/**
 * Runner trigger prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * The runner imports this module for the side-effect of registration.
 *
 * Note: These templates use {{variable}} syntax. The fmt() function for
 * slash commands is pre-applied before template resolution (passed as a variable).
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Task trigger prompts
// ============================================================================

registerTemplate({
  eventType: "task.trigger.assigned",
  header: "",
  defaultBody: `{{work_on_task_cmd}} {{task_id}}{{task_desc_section}}{{output_instructions}}`,
  variables: [
    { name: "work_on_task_cmd", description: "Formatted /work-on-task command" },
    { name: "task_id", description: "Task ID" },
    { name: "task_desc_section", description: "Task description section or empty string" },
    {
      name: "output_instructions",
      description:
        "Output format instructions (with outputSchema if present, or generic store-progress)",
    },
  ],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.trigger.offered",
  header: "",
  defaultBody: `{{review_offered_task_cmd}} {{task_id}}{{task_desc_section}}

Accept if you have capacity and skills. Reject with a reason if you cannot handle it.`,
  variables: [
    { name: "review_offered_task_cmd", description: "Formatted /review-offered-task command" },
    { name: "task_id", description: "Task ID" },
    { name: "task_desc_section", description: "Task description section or empty string" },
  ],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.trigger.unread_mentions",
  header: "",
  defaultBody: `You have {{mention_count}} mention(s) in chat channels.

1. Use \`read-messages\` with unreadOnly: true to see them
2. Respond to questions or requests directed at you
3. If a message requires work, create a task using \`send-task\``,
  variables: [{ name: "mention_count", description: "Number of unread mentions or 'unread'" }],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.trigger.pool_available",
  header: "",
  defaultBody: `{{task_count}} task(s) available in the pool.

1. Run \`get-tasks\` with unassigned: true to browse
2. Pick one matching your skills
3. Run \`task-action\` with action: "claim" and taskId: "<id>"

Note: Claims are first-come-first-serve. If claim fails, pick another.`,
  variables: [{ name: "task_count", description: "Number of available pool tasks" }],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.trigger.epic_progress",
  header: "",
  defaultBody: `## Epic Progress Update

{{epic_count}} epic(s) have progress updates:

{{epics_detail}}
## Your Task: Plan Next Steps

For each epic:
1. **Review** the completed work and any failures
2. **Determine** if the epic goal is met (progress = 100% and all tasks succeeded)
3. **If complete:** Use \`update-epic\` to mark status as "completed"
4. **If not complete:**
   - Retry failed tasks with \`send-task\` (reassign or modify)
   - Create new tasks for remaining work with \`send-task\` (include epicId)
   - Keep the epic progressing until the goal is achieved

This is an iterative process - you'll be notified again when more tasks finish.
The epic should keep progressing until 100% complete and the goal is achieved.`,
  variables: [
    { name: "epic_count", description: "Number of epics with progress updates" },
    { name: "epics_detail", description: "Formatted detail section for all epics" },
  ],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.trigger.channel_activity",
  header: "",
  defaultBody: `## Slack Channel Activity

{{message_count}} new message(s) in monitored Slack channels:

{{messages_detail}}
## Your Task

Review these messages and decide if any require action:
1. If a message is a question or request, respond using \`slack-reply\` or create a task with \`send-task\`
2. If a message is informational, no action needed
3. Use \`slack-read\` with the channelId to get more context if needed`,
  variables: [
    { name: "message_count", description: "Number of new messages" },
    {
      name: "messages_detail",
      description: "Formatted list of messages with channel and user info",
    },
  ],
  category: "task_lifecycle",
});

// ============================================================================
// Task resumption prompts
// ============================================================================

registerTemplate({
  eventType: "task.resumption.with_progress",
  header: "",
  defaultBody: `{{work_on_task_cmd}} {{task_id}}

**RESUMED TASK** - This task was interrupted during a deployment and is being resumed.

Task: "{{task_description}}"

Previous Progress:
{{progress}}

Continue from where you left off. Review the progress above and complete the remaining work.

When done, use \`store-progress\` with status: "completed" and include your output.`,
  variables: [
    { name: "work_on_task_cmd", description: "Formatted /work-on-task command" },
    { name: "task_id", description: "Task ID" },
    { name: "task_description", description: "Original task description" },
    { name: "progress", description: "Previous progress text" },
  ],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.resumption.no_progress",
  header: "",
  defaultBody: `{{work_on_task_cmd}} {{task_id}}

**RESUMED TASK** - This task was interrupted during a deployment and is being resumed.

Task: "{{task_description}}"

No progress was saved before the interruption. Start the task fresh but be aware files may have been partially modified.

When done, use \`store-progress\` with status: "completed" and include your output.`,
  variables: [
    { name: "work_on_task_cmd", description: "Formatted /work-on-task command" },
    { name: "task_id", description: "Task ID" },
    { name: "task_description", description: "Original task description" },
  ],
  category: "task_lifecycle",
});
