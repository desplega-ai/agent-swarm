/**
 * Task lifecycle prompt template definitions (store-progress follow-ups).
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Kapso/WhatsApp inbound (native handler creates a kapso-inbound task)
// ============================================================================

registerTemplate({
  eventType: "kapso.message.received",
  header: "",
  defaultBody: `# WhatsApp inbound (Kapso)

A Kapso webhook fired on the swarm's provisioned WhatsApp number. Load the \`kapso-whatsapp\` skill, then triage this like any other interaction and reply on WhatsApp by quote-replying the inbound WAMID (\`context.message_id\`).

## Source: WhatsApp (Kapso)
- conversation_id: {{conversation_id}}
- inbound_wamid: {{inbound_wamid}}
- sender_phone: {{sender_phone}}
- contact_name: {{contact_name}}
- phone_number_id: {{phone_number_id}}{{test_note}}

## Message
{{message_text}}`,
  variables: [
    { name: "conversation_id", description: "Kapso conversation id, or 'unknown'" },
    { name: "inbound_wamid", description: "Inbound message WAMID, or 'unknown'" },
    { name: "sender_phone", description: "Sender phone (E.164 no +), or 'unknown'" },
    { name: "contact_name", description: "Contact display name, or 'unknown'" },
    { name: "phone_number_id", description: "Provisioned phone-number id, or 'unknown'" },
    {
      name: "test_note",
      description: "Appended note when the payload is a Kapso test delivery (else empty)",
    },
    { name: "message_text", description: "Inbound message text or a non-text placeholder" },
  ],
  category: "event",
});

// ============================================================================
// Worker task follow-ups (created by store-progress for the lead)
// ============================================================================

registerTemplate({
  eventType: "task.worker.completed",
  header: "",
  defaultBody: `Worker task completed \u2014 review needed.

Agent: {{agent_name}}
Original task created by agent {{creator_agent}}
Task: "{{task_desc}}"

Output:
{{output_summary}}{{follow_up_instructions}}

IMPORTANT: Do NOT re-delegate or re-answer the original request. The worker has already handled it. Your job is ONLY to:
1. Review the output above
2. If the task has Slack metadata, use \`slack-reply\` to post the result to the thread (if the worker hasn't already)
3. Complete this follow-up task

Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "agent_name", description: "Worker agent name or ID prefix" },
    { name: "creator_agent", description: "Agent ID that originally created the worker task" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "output_summary", description: "Task output (truncated to 500 chars)" },
    {
      name: "follow_up_instructions",
      description: "Optional per-task instructions from followUpConfig for this completion",
    },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});

// ============================================================================
// HITL follow-up (created when a standalone approval request is resolved)
// ============================================================================

registerTemplate({
  eventType: "hitl.follow_up",
  header: "",
  defaultBody: `Human responded to your approval request ({{request_id}}).

Title: {{title}}
Status: {{status}}

Questions and responses:
{{responses}}

Continue your work based on the human's input.`,
  variables: [
    { name: "request_id", description: "The approval request ID" },
    { name: "title", description: "Title of the approval request" },
    { name: "status", description: "Resolution status: approved or rejected" },
    {
      name: "responses",
      description: "Formatted questions and human responses",
    },
  ],
  category: "task_lifecycle",
});

registerTemplate({
  eventType: "task.worker.failed",
  header: "",
  defaultBody: `Worker task failed \u2014 action needed.

Agent: {{agent_name}}
Original task created by agent {{creator_agent}}
Task: "{{task_desc}}"

Failure reason: {{failure_reason}}{{follow_up_instructions}}

Decide whether to reassign, retry, or handle the failure. Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "agent_name", description: "Worker agent name or ID prefix" },
    { name: "creator_agent", description: "Agent ID that originally created the worker task" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "failure_reason", description: "Failure reason text" },
    {
      name: "follow_up_instructions",
      description: "Optional per-task instructions from followUpConfig for this failure",
    },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});

// ============================================================================
// Budget refusal follow-up (Phase 5: created when an agent is refused due to
// per-agent or global daily budget exhaustion)
// ============================================================================

registerTemplate({
  eventType: "task.budget.refused",
  header: "",
  defaultBody: `Budget refusal \u2014 task is blocked.

Cause: {{cause}}
Agent: {{agent_name}}
Task: {{task_desc}}
Spend / budget: {{spend_summary}}
Resets at: {{reset_at}}

Decide whether to raise the budget, reassign, or wait for the daily reset.
Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: "cause", description: "'agent' or 'global'" },
    { name: "agent_name", description: "Refusing agent name or ID prefix" },
    { name: "task_desc", description: "Task description (truncated to 200 chars)" },
    { name: "spend_summary", description: 'Formatted "$X / $Y" pair' },
    { name: "reset_at", description: "UTC reset time (human readable)" },
    { name: "task_id", description: "Original task ID" },
  ],
  category: "task_lifecycle",
});

// ============================================================================
// Reroute-decision follow-up (Lead-routed crash-recovery, DES-523)
//
// Created by the heartbeat's stale-resume reaper when a crash-recovery resume
// was pinned to its original agent but never reclaimed within the grace window
// (the agent that looked recoverable never returned). Hands the Lead a DECISION
// task — not the raw work — telling it to re-delegate via `send-task` with an
// EXPLICIT agentId. The crashed agent's identity is provided as routing context
// only; the Lead picks who takes over. This work never falls back to the pool.
// ============================================================================

registerTemplate({
  eventType: "task.reroute.decision",
  header: "",
  defaultBody: `Reroute decision: a crashed worker's task needs a new owner.

Crashed agent: {{original_agent_name}}
Identity / specialization: {{original_agent_identity}}
Original task ID: {{original_task_id}}
Trigger: {{reason}}
Task: "{{task_desc}}"

Resume generation: {{generation_next}} of {{max_generations}} (max).{{artifacts_block}}

## Your job

The worker that was handling this task crashed and did not come back within the grace window, so its pinned resume was never reclaimed. Pick an agent to take this work over and RE-DELEGATE it — do NOT execute it yourself, and do NOT leave routing to the default.

Use the crashed agent's identity above as context for who was on it and what kind of work it is. You may re-delegate to the same kind of agent, a peer, or whoever you judge appropriate — the choice is yours, but you MUST choose explicitly.

Dispatch via \`send-task\` with ALL of:
- an explicit \`agentId\` (the chosen worker) — REQUIRED. If you omit it, \`send-task\` auto-routes to the original task's agent, which is the dead worker, and the work re-strands.
- \`taskType: "resume"\`
- the tag \`resume-generation:{{generation_next}}\`
- \`parentTaskId: {{original_task_id}}\`
- do NOT inherit the original task's \`model\` (the new worker runs on its own).

This work will NOT fall back to the unassigned pool — you are the only re-delegation path.`,
  variables: [
    { name: "original_agent_name", description: "Name or ID prefix of the crashed agent" },
    {
      name: "original_agent_identity",
      description:
        "Identity/specialization slice of the crashed agent (from identityMd), or a placeholder when none is recorded",
    },
    { name: "original_task_id", description: "ID of the superseded original task" },
    { name: "reason", description: "Reroute trigger reason (e.g. crash_recovery)" },
    { name: "task_desc", description: "Original task description (truncated to 200 chars)" },
    {
      name: "generation_next",
      description: "Next resume generation number (must be set on the dispatched resume)",
    },
    { name: "max_generations", description: "Maximum resume generations before budget exhaustion" },
    {
      name: "artifacts_block",
      description: "Formatted attachment list from the original task, or empty string",
    },
  ],
  category: "task_lifecycle",
});
