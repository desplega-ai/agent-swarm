/**
 * Linear event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Issue events
// ============================================================================

registerTemplate({
  eventType: "linear.issue.assigned",
  header: "[Linear {{issue_identifier}}] {{issue_title}}",
  defaultBody: `Source: Linear (Agent Session)
URL: {{issue_url}}{{session_section}}
{{description_section}}`,
  variables: [
    { name: "issue_identifier", description: "Linear issue identifier (e.g. ENG-123)" },
    { name: "issue_title", description: "Issue title" },
    { name: "issue_url", description: "Issue URL on Linear" },
    { name: "session_section", description: "Session URL line or empty string" },
    { name: "description_section", description: "Description section or empty string" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "linear.issue.reassigned",
  header: "[Linear {{issue_identifier}}] Re-assigned: {{issue_title}}",
  defaultBody: `Source: Linear (Agent Session re-assignment)
URL: {{issue_url}}{{session_section}}
{{description_section}}
This issue was previously tracked but the original task has completed. A new task has been created to handle the re-assignment.`,
  variables: [
    { name: "issue_identifier", description: "Linear issue identifier (e.g. ENG-123)" },
    { name: "issue_title", description: "Issue title" },
    { name: "issue_url", description: "Issue URL on Linear" },
    { name: "session_section", description: "Session URL line or empty string" },
    { name: "description_section", description: "Description section or empty string" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "linear.issue.followup",
  header: "[Linear {{issue_identifier}}] Follow-up: {{issue_title}}",
  defaultBody: `Source: Linear (Agent Session follow-up)
URL: {{issue_url}}

User message:
{{user_message}}

Original issue: {{issue_identifier}} \u2014 {{issue_title}}`,
  variables: [
    { name: "issue_identifier", description: "Linear issue identifier (e.g. ENG-123)" },
    { name: "issue_title", description: "Issue title" },
    { name: "issue_url", description: "Issue URL on Linear" },
    { name: "user_message", description: "Follow-up message from user" },
  ],
  category: "event",
});
