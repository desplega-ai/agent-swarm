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

## Your Standing Orders (snapshot from HEARTBEAT.md)
{{heartbeat_content}}

> The above is a snapshot. For the latest version, read \`/workspace/HEARTBEAT.md\` directly.

## Instructions
1. **Read your HEARTBEAT.md** — run \`read /workspace/HEARTBEAT.md\` to get the latest standing orders (the snapshot above may be slightly stale).
2. Review the system status above for anything that needs attention (stalled tasks, idle workers with available work, anomalies).
3. **CRITICAL — Reboot failure triage:** Failures with reason "worker session not found" or "worker session heartbeat is stale" indicate tasks that were INTERRUPTED by a server restart. These are NOT "expected auto-cleanup" — they represent work that was lost mid-execution. For each such failure:
   - Check what the task was (via \`get-task-details\` with the task ID from the failure)
   - If a retry task was auto-created (tagged \`reboot-retry\`), verify it is progressing
   - If no retry exists and the work is still needed, re-create the task
   - Do NOT dismiss these as "expected" or "auto-cleanup"
4. Review your standing orders for any periodic checks or actions.
5. If something needs attention — take action now using your available tools (create tasks, post to Slack, cancel stuck tasks, etc.).
6. If everything looks healthy and no standing orders are actionable — complete this task with a brief "All clear" summary. You may NOT say "All clear" if reboot-related failures exist that haven't been triaged.
7. Do NOT create another heartbeat-checklist task — the system handles scheduling.
8. **Update your standing orders** — After every heartbeat check, edit \`/workspace/HEARTBEAT.md\` directly. Add new patterns you noticed (recurring failures, workers needing attention), remove resolved items. This is your live operational runbook — keep it current.`,
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
Goal: The system just restarted — assess current state and take action on interrupted work.

## Boot Event [auto-generated]
The API server has just restarted (deployment, pod rotation, or crash). An aggressive reboot sweep ran automatically and:
- Auto-failed all in-progress tasks whose workers had no active session
- Created retry tasks for each (tagged \`reboot-retry\`, linked via \`parentTaskId\`)

## Current System Status [auto-generated]
{{system_status}}

## Your Standing Orders (from HEARTBEAT.md)
{{heartbeat_content}}

## Instructions
1. **Triage reboot-interrupted work FIRST.** If the "Reboot-Interrupted Work" section above lists tasks:
   - For each task: verify the retry is progressing via \`get-task-details\` with the retry task ID
   - If a retry failed or is stuck, re-create the task manually
   - If the work is no longer needed, cancel the retry task
   - You MUST address every item — do NOT skip this section
2. **Check orphaned tasks.** If the "Orphaned Tasks" section lists pending/offered tasks assigned to offline workers, re-assign or cancel them.
3. Review agent status — are all expected workers online? If not, note which are missing.
4. Review your standing orders for any post-reboot checks.
5. Take action using your available tools.
6. Complete this task with a summary of what you found and what actions you took. Include the status of each reboot-interrupted task.
7. Do NOT create another boot-triage task — this is a one-off event.
8. **Update your standing orders** — If the reboot revealed a pattern worth monitoring (e.g., frequent restarts, specific tasks that keep failing), add a standing order to HEARTBEAT.md via \`update-profile\` with \`heartbeatMd\`.`,
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
