/**
 * GitLab event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 *
 * Template text uses {{variable}} syntax. The resolver interpolates variables
 * and expands {{@template[id]}} references before returning the final text.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Common building blocks (GitLab-specific)
// ============================================================================

registerTemplate({
  eventType: "common.delegation_instruction.gitlab",
  header: "",
  defaultBody:
    "\n\n**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent. Use `send-task` to delegate with clear instructions.",
  variables: [],
  category: "common",
});

registerTemplate({
  eventType: "common.command_suggestions.gitlab_mr",
  header: "",
  defaultBody:
    "Suggested commands: `/review-pr` to review the MR, `/implement-issue` to implement changes.",
  variables: [],
  category: "common",
});

registerTemplate({
  eventType: "common.command_suggestions.gitlab_issue",
  header: "",
  defaultBody: "Suggested commands: `/implement-issue` to implement, `/close-issue` to close.",
  variables: [],
  category: "common",
});

// ============================================================================
// Merge Request events
// ============================================================================

registerTemplate({
  eventType: "gitlab.merge_request.opened",
  header: "[GitLab MR #{{mr_iid}}] {{mr_title}}",
  defaultBody: `Repo: {{repo}}
Author: @{{username}}
Branch: {{source_branch}} \u2192 {{target_branch}}
URL: {{mr_url}}

{{context_section}}{{@template[common.command_suggestions.gitlab_mr]}}{{@template[common.delegation_instruction.gitlab]}}`,
  variables: [
    { name: "mr_iid", description: "Merge request IID" },
    { name: "mr_title", description: "Merge request title" },
    { name: "repo", description: "Project path with namespace" },
    { name: "username", description: "Event sender username" },
    { name: "source_branch", description: "Source branch name" },
    { name: "target_branch", description: "Target branch name" },
    { name: "mr_url", description: "Merge request URL" },
    { name: "context_section", description: "Context section with description or empty string" },
  ],
  category: "event",
});

// ============================================================================
// Issue events
// ============================================================================

registerTemplate({
  eventType: "gitlab.issue.assigned",
  header: "[GitLab Issue #{{issue_iid}}] {{issue_title}}",
  defaultBody: `Repo: {{repo}}
Author: @{{username}}
URL: {{issue_url}}

{{context_section}}{{@template[common.command_suggestions.gitlab_issue]}}{{@template[common.delegation_instruction.gitlab]}}`,
  variables: [
    { name: "issue_iid", description: "Issue IID" },
    { name: "issue_title", description: "Issue title" },
    { name: "repo", description: "Project path with namespace" },
    { name: "username", description: "Event sender username" },
    { name: "issue_url", description: "Issue URL" },
    { name: "context_section", description: "Context section with description or empty string" },
  ],
  category: "event",
});

// ============================================================================
// Comment (Note) events
// ============================================================================

registerTemplate({
  eventType: "gitlab.comment.mentioned",
  header: "[GitLab Comment on {{entity_label}}] @{{username}} mentioned bot",
  defaultBody: `Repo: {{repo}}
URL: {{target_url}}

Comment:
{{context}}{{existing_task_note}}{{@template[common.delegation_instruction.gitlab]}}`,
  variables: [
    { name: "entity_label", description: "Entity label (e.g. 'MR #1' or 'Issue #2')" },
    { name: "username", description: "Comment author username" },
    { name: "repo", description: "Project path with namespace" },
    { name: "target_url", description: "Target entity URL" },
    { name: "context", description: "Extracted mention context from comment" },
    {
      name: "existing_task_note",
      description: "Note about existing active task, or empty string",
    },
  ],
  category: "event",
});

// ============================================================================
// Pipeline events
// ============================================================================

registerTemplate({
  eventType: "gitlab.pipeline.failed",
  header: "[GitLab CI Failed] Pipeline #{{pipeline_id}} failed for MR #{{mr_iid}}",
  defaultBody: `Repo: {{repo}}
MR: {{mr_title}}
URL: {{mr_url}}
Branch: {{source_branch}}

The CI pipeline has failed. Please investigate and fix the issues.{{@template[common.delegation_instruction.gitlab]}}`,
  variables: [
    { name: "pipeline_id", description: "Pipeline ID" },
    { name: "mr_iid", description: "Merge request IID" },
    { name: "repo", description: "Project path with namespace" },
    { name: "mr_title", description: "Merge request title" },
    { name: "mr_url", description: "Merge request URL" },
    { name: "source_branch", description: "Source branch name" },
  ],
  category: "event",
});
