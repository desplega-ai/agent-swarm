/**
 * GitHub event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 *
 * Template text uses {{variable}} syntax. The resolver interpolates variables
 * and expands {{@template[id]}} references before returning the final text.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Common building blocks
// ============================================================================

registerTemplate({
  eventType: "common.delegation_instruction",
  header: "",
  defaultBody:
    "\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.",
  variables: [],
  category: "common",
});

registerTemplate({
  eventType: "common.command_suggestions.github_pr",
  header: "",
  defaultBody: "\ud83d\udca1 Suggested: /review-pr or /respond-github",
  variables: [],
  category: "common",
});

registerTemplate({
  eventType: "common.command_suggestions.github_issue",
  header: "",
  defaultBody: "\ud83d\udca1 Suggested: /implement-issue or /respond-github",
  variables: [],
  category: "common",
});

registerTemplate({
  eventType: "common.command_suggestions.github_comment_pr",
  header: "",
  defaultBody: "\ud83d\udca1 Suggested: /respond-github or /review-pr",
  variables: [],
  category: "common",
});

registerTemplate({
  eventType: "common.command_suggestions.github_comment_issue",
  header: "",
  defaultBody: "\ud83d\udca1 Suggested: /respond-github",
  variables: [],
  category: "common",
});

// ============================================================================
// Pull Request events
// ============================================================================

registerTemplate({
  eventType: "github.pull_request.assigned",
  header: "[GitHub PR #{{pr_number}}] {{pr_title}}",
  defaultBody: `Assigned to: @{{bot_name}}
From: {{sender_login}}
Repo: {{repo_full_name}}
Branch: {{head_ref}} \u2192 {{base_ref}}
URL: {{pr_url}}

Context:
{{context}}

---
{{@template[common.delegation_instruction]}}
{{@template[common.command_suggestions.github_pr]}}`,
  variables: [
    { name: "pr_number", description: "Pull request number" },
    { name: "pr_title", description: "Pull request title" },
    { name: "bot_name", description: "GitHub bot username" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "head_ref", description: "Head branch name" },
    { name: "base_ref", description: "Base branch name" },
    { name: "pr_url", description: "Pull request HTML URL" },
    { name: "context", description: "PR body or title as context" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.pull_request.review_requested",
  header: "[GitHub PR #{{pr_number}}] {{pr_title}}",
  defaultBody: `Review requested from: @{{bot_name}}
From: {{sender_login}}
Repo: {{repo_full_name}}
Branch: {{head_ref}} \u2192 {{base_ref}}
URL: {{pr_url}}

Context:
{{context}}

---
{{@template[common.delegation_instruction]}}
{{@template[common.command_suggestions.github_pr]}}`,
  variables: [
    { name: "pr_number", description: "Pull request number" },
    { name: "pr_title", description: "Pull request title" },
    { name: "bot_name", description: "GitHub bot username" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "head_ref", description: "Head branch name" },
    { name: "base_ref", description: "Base branch name" },
    { name: "pr_url", description: "Pull request HTML URL" },
    { name: "context", description: "PR body or title as context" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.pull_request.closed",
  header: "{{status_emoji}} [GitHub PR #{{pr_number}}] {{status}}{{merged_by}}",
  defaultBody: `PR: {{pr_title}}
Repo: {{repo_full_name}}
URL: {{pr_url}}

---
Related task: {{related_task_id}}
\ud83d\udd00 Consider routing to the same agent working on the related task.
{{follow_up_suggestion}}`,
  variables: [
    { name: "status_emoji", description: "Status emoji (merge or close)" },
    { name: "pr_number", description: "Pull request number" },
    { name: "status", description: "MERGED or CLOSED" },
    { name: "merged_by", description: "Merged by info (e.g. ' by user') or empty" },
    { name: "pr_title", description: "Pull request title" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "pr_url", description: "Pull request HTML URL" },
    { name: "related_task_id", description: "ID of the related existing task" },
    {
      name: "follow_up_suggestion",
      description: "Suggestion text for merged or closed PR",
    },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.pull_request.synchronize",
  header: "\ud83d\udd04 [GitHub PR #{{pr_number}}] New commits pushed",
  defaultBody: `PR: {{pr_title}}
Repo: {{repo_full_name}}
Branch: {{head_ref}}
New HEAD: {{head_sha_short}}
URL: {{pr_url}}

---
Related task: {{related_task_id}}
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 New commits were pushed. CI will re-run - monitor for results.`,
  variables: [
    { name: "pr_number", description: "Pull request number" },
    { name: "pr_title", description: "Pull request title" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "head_ref", description: "Head branch name" },
    { name: "head_sha_short", description: "Short HEAD SHA (7 chars)" },
    { name: "pr_url", description: "Pull request HTML URL" },
    { name: "related_task_id", description: "ID of the related existing task" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.pull_request.mentioned",
  header: "[GitHub PR #{{pr_number}}] {{pr_title}}",
  defaultBody: `From: {{sender_login}}
Repo: {{repo_full_name}}
Branch: {{head_ref}} \u2192 {{base_ref}}
URL: {{pr_url}}

Context:
{{context}}

---
{{@template[common.delegation_instruction]}}
{{@template[common.command_suggestions.github_pr]}}`,
  variables: [
    { name: "pr_number", description: "Pull request number" },
    { name: "pr_title", description: "Pull request title" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "head_ref", description: "Head branch name" },
    { name: "base_ref", description: "Base branch name" },
    { name: "pr_url", description: "Pull request HTML URL" },
    { name: "context", description: "Extracted mention context or PR title" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.pull_request.labeled",
  header: "[GitHub PR #{{pr_number}}] {{pr_title}}",
  defaultBody: `Label added: {{label_name}}
From: {{sender_login}}
Repo: {{repo_full_name}}
Branch: {{head_ref}} → {{base_ref}}
URL: {{pr_url}}

Context:
{{context}}

---
{{@template[common.delegation_instruction]}}
{{@template[common.command_suggestions.github_pr]}}`,
  variables: [
    { name: "pr_number", description: "Pull request number" },
    { name: "pr_title", description: "Pull request title" },
    { name: "label_name", description: "Label that was added" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "head_ref", description: "Head branch name" },
    { name: "base_ref", description: "Base branch name" },
    { name: "pr_url", description: "Pull request HTML URL" },
    { name: "context", description: "PR body or title as context" },
  ],
  category: "event",
});

// ============================================================================
// Issue events
// ============================================================================

registerTemplate({
  eventType: "github.issue.assigned",
  header: "[GitHub Issue #{{issue_number}}] {{issue_title}}",
  defaultBody: `Assigned to: @{{bot_name}}
From: {{sender_login}}
Repo: {{repo_full_name}}
URL: {{issue_url}}

Context:
{{context}}

---
{{@template[common.delegation_instruction]}}
{{@template[common.command_suggestions.github_issue]}}`,
  variables: [
    { name: "issue_number", description: "Issue number" },
    { name: "issue_title", description: "Issue title" },
    { name: "bot_name", description: "GitHub bot username" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "issue_url", description: "Issue HTML URL" },
    { name: "context", description: "Issue body or title as context" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.issue.mentioned",
  header: "[GitHub Issue #{{issue_number}}] {{issue_title}}",
  defaultBody: `From: {{sender_login}}
Repo: {{repo_full_name}}
URL: {{issue_url}}

Context:
{{context}}

---
{{@template[common.delegation_instruction]}}
{{@template[common.command_suggestions.github_issue]}}`,
  variables: [
    { name: "issue_number", description: "Issue number" },
    { name: "issue_title", description: "Issue title" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "issue_url", description: "Issue HTML URL" },
    { name: "context", description: "Extracted mention context or issue title" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.issue.labeled",
  header: "[GitHub Issue #{{issue_number}}] {{issue_title}}",
  defaultBody: `Label added: {{label_name}}
From: {{sender_login}}
Repo: {{repo_full_name}}
URL: {{issue_url}}

Context:
{{context}}

---
{{@template[common.delegation_instruction]}}
{{@template[common.command_suggestions.github_issue]}}`,
  variables: [
    { name: "issue_number", description: "Issue number" },
    { name: "issue_title", description: "Issue title" },
    { name: "label_name", description: "Label that was added" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "issue_url", description: "Issue HTML URL" },
    { name: "context", description: "Issue body or title as context" },
  ],
  category: "event",
});

// ============================================================================
// Comment events
// ============================================================================

registerTemplate({
  eventType: "github.comment.mentioned",
  header: "[GitHub {{target_type}} #{{target_number}} Comment] {{target_title}}",
  defaultBody: `From: {{sender_login}}
Repo: {{repo_full_name}}
URL: {{comment_url}}

Comment:
{{context}}

---
{{related_task_section}}{{@template[common.delegation_instruction]}}
{{command_suggestions}}`,
  variables: [
    { name: "target_type", description: "PR or Issue" },
    { name: "target_number", description: "PR or issue number" },
    { name: "target_title", description: "PR or issue title" },
    { name: "sender_login", description: "Event sender login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "comment_url", description: "Comment HTML URL" },
    { name: "context", description: "Extracted mention context from comment" },
    {
      name: "related_task_section",
      description: "Related task info with routing hint, or empty string if no related task",
    },
    { name: "command_suggestions", description: "Context-appropriate command suggestions" },
  ],
  category: "event",
});

// ============================================================================
// Pull Request Review events
// ============================================================================

registerTemplate({
  eventType: "github.pull_request.review_submitted",
  header: "{{review_emoji}} [GitHub PR #{{pr_number}} Review] {{review_label}}",
  defaultBody: `PR: {{pr_title}}
Reviewer: {{sender_login}}
Repo: {{repo_full_name}}
URL: {{review_url}}{{review_body_section}}

---
{{related_task_section}}{{@template[common.delegation_instruction]}}
{{review_suggestions}}`,
  variables: [
    { name: "review_emoji", description: "Emoji for review state" },
    { name: "pr_number", description: "Pull request number" },
    { name: "review_label", description: "Review state label (APPROVED, CHANGES REQUESTED, etc.)" },
    { name: "pr_title", description: "Pull request title" },
    { name: "sender_login", description: "Reviewer login" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "review_url", description: "Review HTML URL" },
    { name: "review_body_section", description: "Review comment section or empty string" },
    { name: "related_task_section", description: "Related task info or empty string" },
    { name: "review_suggestions", description: "Context-appropriate review suggestion" },
  ],
  category: "event",
});

// ============================================================================
// CI events
// ============================================================================

registerTemplate({
  eventType: "github.check_run.failed",
  header: "{{conclusion_emoji}} [GitHub PR #{{pr_number}} CI] {{check_name}} {{conclusion_label}}",
  defaultBody: `Repo: {{repo_full_name}}
Check: {{check_name}}
URL: {{check_url}}{{output_summary_section}}

---
Related task: {{related_task_id}}
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 CI check failed. Review the logs and fix the issue.`,
  variables: [
    { name: "conclusion_emoji", description: "Emoji for check conclusion" },
    { name: "pr_number", description: "Pull request number" },
    { name: "check_name", description: "Check run name" },
    { name: "conclusion_label", description: "Conclusion label (FAILED, ACTION REQUIRED, etc.)" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "check_url", description: "Check run HTML URL" },
    { name: "output_summary_section", description: "Output summary section or empty string" },
    { name: "related_task_id", description: "ID of the related existing task" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.check_suite.failed",
  header: "{{conclusion_emoji}} [GitHub PR #{{pr_number}} CI Suite] {{conclusion_label}}",
  defaultBody: `Repo: {{repo_full_name}}
Branch: {{branch}}
Commit: {{head_sha_short}}

---
Related task: {{related_task_id}}
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 CI suite failed. Check individual check runs for details.`,
  variables: [
    { name: "conclusion_emoji", description: "Emoji for check conclusion" },
    { name: "pr_number", description: "Pull request number" },
    { name: "conclusion_label", description: "Conclusion label" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "branch", description: "Head branch name" },
    { name: "head_sha_short", description: "Short HEAD SHA (7 chars)" },
    { name: "related_task_id", description: "ID of the related existing task" },
  ],
  category: "event",
});

registerTemplate({
  eventType: "github.workflow_run.failed",
  header:
    "{{conclusion_emoji}} [GitHub PR #{{pr_number}} Workflow] {{workflow_run_name}} {{conclusion_label}}",
  defaultBody: `Repo: {{repo_full_name}}
Workflow: {{workflow_name}}
Run #{{run_number}}
Branch: {{head_branch}}
Triggered by: {{trigger_event}}
Logs: {{logs_url}}

---
Related task: {{related_task_id}}
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 Workflow failed. Click the logs URL above to see what went wrong and fix the issue.`,
  variables: [
    { name: "conclusion_emoji", description: "Emoji for check conclusion" },
    { name: "pr_number", description: "Pull request number" },
    { name: "workflow_run_name", description: "Workflow run name" },
    { name: "conclusion_label", description: "Conclusion label" },
    { name: "repo_full_name", description: "Repository full name (owner/repo)" },
    { name: "workflow_name", description: "Workflow name" },
    { name: "run_number", description: "Workflow run number" },
    { name: "head_branch", description: "Head branch name" },
    { name: "trigger_event", description: "Event that triggered the workflow" },
    { name: "logs_url", description: "Workflow run logs URL" },
    { name: "related_task_id", description: "ID of the related existing task" },
  ],
  category: "event",
});
