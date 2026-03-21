/**
 * Task lifecycle prompt template definitions (store-progress follow-ups).
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Worker task follow-ups (created by store-progress for the lead)
// ============================================================================

registerTemplate({
  eventType: "task.worker.completed",
  header: "",
  defaultBody: `Worker task completed \u2014 review needed.

Agent: {{agent_name}}
Task: "{{task_desc}}"

Output:
{{output_summary}}

Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "agent_name", description: "Worker agent name or ID prefix" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "output_summary", description: "Task output (truncated to 500 chars)" },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.worker.failed",
  header: "",
  defaultBody: `Worker task failed \u2014 action needed.

Agent: {{agent_name}}
Task: "{{task_desc}}"

Failure reason: {{failure_reason}}

Decide whether to reassign, retry, or handle the failure. Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "agent_name", description: "Worker agent name or ID prefix" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "failure_reason", description: "Failure reason text" },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});
