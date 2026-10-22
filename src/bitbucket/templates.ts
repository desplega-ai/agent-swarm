/**
 * Bitbucket Cloud event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 *
 * Template text uses {{variable}} syntax. The resolver interpolates variables
 * and expands {{@template[id]}} references before returning the final text.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Common building blocks (Bitbucket-specific)
// ============================================================================

registerTemplate({
  eventType: "common.delegation_instruction.bitbucket",
  header: "",
  defaultBody:
    "\n\n**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent. Use `send-task` to delegate with clear instructions.",
  variables: [],
  category: "common",
});

// There is no Bitbucket CLI in the worker image, so the recipes are curl calls
// against the REST API with the worker's BITBUCKET_TOKEN.
registerTemplate({
  eventType: "common.command_suggestions.bitbucket_pr",
  header: "",
  defaultBody:
    'Workers have `git` authenticated for bitbucket.org and `BITBUCKET_TOKEN` in env; there is no Bitbucket CLI, so use curl against `https://api.bitbucket.org/2.0/repositories/{{repo}}` with `-H "Authorization: Bearer $BITBUCKET_TOKEN"`. Inspect the PR with `GET .../pullrequests/{{pr_id}}` and its diff with `GET .../pullrequests/{{pr_id}}/diff`. Reply with `POST .../pullrequests/{{pr_id}}/comments` and JSON body `{"content":{"raw":"<reply>"}}`. Find a PR by branch with `GET .../pullrequests?q=source.branch.name="<branch>"`. Open a PR with `POST .../pullrequests` and JSON body `{"title":"<title>","source":{"branch":{"name":"<branch>"}},"destination":{"branch":{"name":"<base>"}}}`.',
  variables: [
    { name: "repo", description: "Repository full name (<workspace>/<repo_slug>)" },
    { name: "pr_id", description: "Pull request ID" },
  ],
  category: "common",
});

const SHARED_VARIABLES = [
  { name: "pr_id", description: "Pull request ID" },
  { name: "pr_title", description: "Pull request title" },
  { name: "repo", description: "Repository full name (<workspace>/<repo_slug>)" },
  { name: "pr_url", description: "Pull request web URL" },
];

const PR_BRANCH_VARIABLES = [
  { name: "source_branch", description: "Source branch name" },
  { name: "target_branch", description: "Target branch name" },
  { name: "context_section", description: "Context section with description or empty string" },
];

// ============================================================================
// Pull request events
// ============================================================================

registerTemplate({
  eventType: "bitbucket.pull_request.opened",
  header: "[Bitbucket PR #{{pr_id}}] {{pr_title}}",
  defaultBody: `Repo: {{repo}}
Author: {{username}}
Branch: {{source_branch}} → {{target_branch}}
URL: {{pr_url}}

{{context_section}}{{@template[common.command_suggestions.bitbucket_pr]}}{{@template[common.delegation_instruction.bitbucket]}}`,
  variables: [
    ...SHARED_VARIABLES,
    {
      name: "username",
      description:
        "Author identity — resolved canonical name (e.g. 'Luis (bitbucket:557058:…)') or the UNKNOWN sentinel",
    },
    ...PR_BRANCH_VARIABLES,
  ],
  category: "event",
});

registerTemplate({
  eventType: "bitbucket.pull_request.review_requested",
  header: "[Bitbucket PR #{{pr_id}}] Review requested: {{pr_title}}",
  defaultBody: `Repo: {{repo}}
Author: {{username}}
Branch: {{source_branch}} → {{target_branch}}
URL: {{pr_url}}

You were added as a reviewer on this pull request.

{{context_section}}{{@template[common.command_suggestions.bitbucket_pr]}}{{@template[common.delegation_instruction.bitbucket]}}`,
  variables: [
    ...SHARED_VARIABLES,
    {
      name: "username",
      description:
        "Author identity — resolved canonical name (e.g. 'Luis (bitbucket:557058:…)') or the UNKNOWN sentinel",
    },
    ...PR_BRANCH_VARIABLES,
  ],
  category: "event",
});

// ============================================================================
// Pull request comment events
// ============================================================================

registerTemplate({
  eventType: "bitbucket.comment.mentioned",
  header: "[Bitbucket Comment on PR #{{pr_id}}] {{username}} mentioned bot",
  defaultBody: `Repo: {{repo}}
PR: {{pr_title}}
URL: {{pr_url}}
{{location_section}}
Comment:
{{context}}{{existing_task_note}}

{{@template[common.command_suggestions.bitbucket_pr]}}{{@template[common.delegation_instruction.bitbucket]}}`,
  variables: [
    ...SHARED_VARIABLES,
    {
      name: "username",
      description:
        "Comment author identity — resolved canonical name (e.g. 'Luis (bitbucket:557058:…)') or the UNKNOWN sentinel",
    },
    {
      name: "location_section",
      description: "`File: <path>:<line>` line for inline comments, or empty string",
    },
    { name: "context", description: "Extracted mention context from comment" },
    {
      name: "existing_task_note",
      description: "Note about existing active task, or empty string",
    },
  ],
  category: "event",
});
