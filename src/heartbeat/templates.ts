/**
 * Heartbeat event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Escalation events
// ============================================================================

registerTemplate({
  eventType: "heartbeat.escalation.stalled",
  header: "",
  defaultBody: `Task Type: Triage
Goal: Investigate heartbeat findings that need human reasoning

{{stalled_tasks_section}}
{{escalation_marker}}`,
  variables: [
    {
      name: "stalled_tasks_section",
      description: "Markdown section listing stalled tasks with details",
    },
    { name: "escalation_marker", description: "Heartbeat escalation marker with key" },
  ],
  category: "event",
});
