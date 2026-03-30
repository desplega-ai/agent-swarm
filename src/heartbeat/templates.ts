/**
 * Heartbeat event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Heartbeat checklist
// ============================================================================

registerTemplate({
  eventType: "heartbeat.checklist",
  header: "",
  defaultBody: `Task Type: Heartbeat Checklist
Goal: Review system status and your standing orders, take action if needed.

## Current System Status [auto-generated]
{{system_status}}

## Your Standing Orders (from HEARTBEAT.md)
{{heartbeat_content}}

## Instructions
1. Review the system status above for anything that needs attention (stalled tasks, idle workers with available work, anomalies).
2. Review your standing orders for any periodic checks or actions.
3. If something needs attention — take action now using your available tools (create tasks, post to Slack, cancel stuck tasks, etc.).
4. If everything looks healthy and no standing orders are actionable — complete this task with a brief "All clear" summary.
5. Do NOT create another heartbeat-checklist task — the system handles scheduling.
6. **Update your standing orders** — if you noticed a new pattern (e.g., recurring failures, a worker that needs attention), add it to your HEARTBEAT.md via \`update-profile\` with \`heartbeatMd\`. Remove resolved items. Keep it a live operational runbook.`,
  variables: [
    {
      name: "system_status",
      description: "Auto-generated markdown section with current system status",
    },
    {
      name: "heartbeat_content",
      description: "The lead agent's HEARTBEAT.md standing orders",
    },
  ],
  category: "event",
});

// ============================================================================
// Boot triage (one-off after container restart)
// ============================================================================

registerTemplate({
  eventType: "heartbeat.boot-triage",
  header: "",
  defaultBody: `Task Type: Boot Triage
Goal: The system just restarted — assess current state and triage based on your role.

## Boot Event [auto-generated]
The API server has just restarted (possible pod rotation or deployment). This is a one-off triage task — not a recurring checklist. Review the current state, identify anything that needs immediate attention, and take action.

## Current System Status [auto-generated]
{{system_status}}

## Your Standing Orders (from HEARTBEAT.md)
{{heartbeat_content}}

## Instructions
1. **Acknowledge the reboot** — note that the system just restarted and any in-flight work may have been interrupted.
2. Review the system status above. Pay special attention to:
   - Tasks that were in-progress before the restart (they may have been auto-failed by the startup sweep)
   - Workers that may need to re-register
   - Any stalled or orphaned work
3. Review your standing orders for any checks that are relevant post-reboot.
4. Take action using your available tools (re-create failed tasks, notify affected parties, etc.).
5. Complete this task with a summary of what you found and what actions you took.
6. Do NOT create another boot-triage task — this is a one-off event.
7. **Update your standing orders** — if the reboot was caused by an issue worth monitoring, add a standing order to HEARTBEAT.md via \`update-profile\` with \`heartbeatMd\`. Keep it a live operational runbook.`,
  variables: [
    {
      name: "system_status",
      description: "Auto-generated markdown section with current system status",
    },
    {
      name: "heartbeat_content",
      description: "The lead agent's HEARTBEAT.md standing orders",
    },
  ],
  category: "event",
});
