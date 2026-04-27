/**
 * Jira event prompt template definitions.
 *
 * Each template is registered at module load time via `registerTemplate()`.
 * Handlers import this module for the side effect of registration (mirrors
 * the pattern in `src/linear/templates.ts`).
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Issue events
// ============================================================================

registerTemplate({
  eventType: "jira.issue.assigned",
  header: "[Jira {{issue_key}}] {{issue_summary}}",
  defaultBody: `Source: Jira (issue assigned to bot)
URL: {{issue_url}}
Reporter: {{reporter}}
{{description_section}}`,
  variables: [
    { name: "issue_key", description: "Jira issue key (e.g. ENG-123)" },
    { name: "issue_summary", description: "Issue summary / title" },
    { name: "issue_url", description: "Issue URL on the Jira site" },
    { name: "reporter", description: "Reporter display name (or empty string)" },
    {
      name: "description_section",
      description: "Description section (extracted from ADF) or empty string",
    },
  ],
  category: "event",
});

registerTemplate({
  eventType: "jira.issue.commented",
  header: "[Jira {{issue_key}}] {{issue_summary}}",
  defaultBody: `Source: Jira (bot mentioned in comment)
URL: {{issue_url}}
Comment author: {{comment_author}}
{{description_section}}
Comment:
{{comment_text}}
`,
  variables: [
    { name: "issue_key", description: "Jira issue key (e.g. ENG-123)" },
    { name: "issue_summary", description: "Issue summary / title" },
    { name: "issue_url", description: "Issue URL on the Jira site" },
    { name: "comment_author", description: "Comment author display name" },
    {
      name: "description_section",
      description: "Description section (extracted from ADF) or empty string",
    },
    { name: "comment_text", description: "Comment body (extracted from ADF)" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "jira.issue.followup",
  header: "[Jira {{issue_key}}] Follow-up: {{issue_summary}}",
  defaultBody: `Source: Jira (follow-up on previously-tracked issue)
URL: {{issue_url}}

Trigger: {{trigger}}

{{user_message}}

Original issue: {{issue_key}} — {{issue_summary}}`,
  variables: [
    { name: "issue_key", description: "Jira issue key (e.g. ENG-123)" },
    { name: "issue_summary", description: "Issue summary / title" },
    { name: "issue_url", description: "Issue URL on the Jira site" },
    {
      name: "trigger",
      description: "Why a follow-up was created (re-assignment / new comment)",
    },
    {
      name: "user_message",
      description: "Either the new comment text or empty for re-assignment",
    },
  ],
  category: "event",
});
