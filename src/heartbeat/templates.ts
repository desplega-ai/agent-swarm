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
2. **Prune tracked HEARTBEAT items FIRST.** Active Blockers + Watch Items + Open Discussion combined must stay at ≤10 items; 20 is the absolute max only when genuinely super busy. This cap does not apply to evergreen Standing Orders / Governance / Playbook-index reference sections. Before adding anything, re-check every tracked item against its lift trigger and remove anything resolved, stale, or past its trigger date. Lift incident detail to memory; never keep it inline in HEARTBEAT.md. Every new tracked item must include an explicit lift trigger + date; if it has no removal condition, do not add it. If the tracked list is already at/over cap, prune before (or instead of) adding — the cap is binding.
3. **Run seeded heartbeat data-gathering.** Use \`script-run\` with global script \`Heartbeat Audit\` and pass the current HEARTBEAT.md text as \`heartbeatMarkdown\`. It covers Rules #10/#13/#15/#16/#17: resolved stale PRs, pool-target risk schedules, schedule/provider failure clusters, and whether daily-blocker-digest ran today. The Slack thread-reply check (Rule #11) stays Lead-side; the script runtime has no Slack token.
4. Review the system status above plus the \`Heartbeat Audit\` result for anything that needs attention (stalled tasks, idle workers with available work, anomalies).
5. **CRITICAL — Interrupted work triage:** The heartbeat puts a task whose worker died back to \`pending\` on the same task (its \`attempt\` goes up by one) and fails it only once the reclaim budget is spent (\`resume_budget_exhausted\`) or when it is a workflow step or control-plane task (reason "worker session not found" or "worker session heartbeat is stale"). These failures are NOT "expected auto-cleanup" — they are work that was lost mid-execution. For each such failure:
   - Check what the task was (via \`get-task-details\` with the task ID from the failure)
   - If the work is still needed, re-create the task
   - Do NOT dismiss these as "expected" or "auto-cleanup"
6. Review your standing orders for any periodic checks or actions.
7. If something needs attention — take action now using your available tools (create tasks, post to Slack, cancel stuck tasks, etc.).
8. If everything looks healthy and no standing orders are actionable — complete this task with a brief "All clear" summary. You may NOT say "All clear" if interrupted-work failures exist that haven't been triaged.
9. Do NOT create another heartbeat-checklist task — the system handles scheduling.
10. **Update HEARTBEAT.md only after pruning.** Keep it current, but keep tracked items capped: remove resolved items, add only dated lift-triggered items, and lift detail to memory instead of growing the file.`,
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
The API server has just restarted (deployment, pod rotation, or crash). Workers keep running through an API restart, so nothing is failed at boot. The first heartbeat sweep after boot puts an in-progress task whose worker is gone back to \`pending\` on the same task, pinned to its agent (its \`attempt\` goes up by one). If the agent does not restart it within the unpin grace window, it returns to the pool.

## Current System Status [auto-generated]
{{system_status}}

## Your Standing Orders (from HEARTBEAT.md)
{{heartbeat_content}}

## Instructions
1. **Prune tracked HEARTBEAT items FIRST.** Active Blockers + Watch Items + Open Discussion combined must stay at ≤10 items; 20 is the absolute max only when genuinely super busy. This cap does not apply to evergreen Standing Orders / Governance / Playbook-index reference sections. Before adding anything, re-check every tracked item against its lift trigger and remove anything resolved, stale, or past its trigger date. Lift incident detail to memory; never keep it inline in HEARTBEAT.md. Every new tracked item must include an explicit lift trigger + date; if it has no removal condition, do not add it. If the tracked list is already at/over cap, prune before (or instead of) adding — the cap is binding.
2. **Run seeded boot triage.** Use \`script-run\` with global script \`boot-triage\` to gather deploy-restart PR context, recent real failures, stuck offline-agent work, orphaned pending/offered tasks, and superseded tasks missing resume children in one read-only call.
3. **Triage reclaimed work FIRST.** If the "Reclaimed Work" section above or the \`boot-triage\` result lists tasks:
   - For each task: check via \`get-task-details\` that it restarts (\`in_progress\` again) or returns to the pool
   - If the work is no longer needed, cancel the task
   - You MUST address every item — do NOT skip this section
4. **Verify recovery end-to-end.** Worker crashes / OOMs are recovered in place: the same task goes back to \`pending\` and restarts with a resume preamble. A \`superseded\` task now only comes from a runner's graceful shutdown or a manual supersede, and has a \`taskType=resume\` child. Sanity check:
   - Look for \`in_progress\` tasks older than 5 min on agents that show as offline — the sweep should have reclaimed them. If any remain, recreate as needed.
   - For any recent \`superseded\` task, confirm a non-terminal \`taskType=resume\` child exists.
5. **Check orphaned tasks.** If the "Orphaned Tasks" section or \`boot-triage\` result lists pending/offered tasks assigned to offline workers, re-assign or cancel them.
6. Review agent status — are all expected workers online? If not, note which are missing.
7. Review your standing orders for any post-reboot checks.
8. Take action using your available tools.
9. Complete this task with a summary of what you found and what actions you took. Include the status of each reclaimed task.
10. Do NOT create another boot-triage task — this is a one-off event.
11. **Update HEARTBEAT.md only after pruning.** If the reboot revealed a pattern worth monitoring, add it only as a dated lift-triggered tracked item and only if the cap still holds after pruning. Lift incident detail to memory instead of growing HEARTBEAT.md.`,
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
