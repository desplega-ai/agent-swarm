/**
 * Azure DevOps event prompt template definitions.
 *
 * Each template is registered at module load time via registerTemplate().
 * Handlers import this module for the side-effect of registration.
 *
 * Template text uses {{variable}} syntax. The resolver interpolates variables
 * and expands {{@template[id]}} references before returning the final text.
 */

import { registerTemplate } from "../prompts/registry";

// ============================================================================
// Common building blocks (Azure DevOps-specific)
// ============================================================================

registerTemplate({
  eventType: "common.delegation_instruction.azure_devops",
  header: "",
  defaultBody:
    "\n\n**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent. Use `send-task` to delegate with clear instructions.",
  variables: [],
  category: "common",
});

// `az repos` has no comment command, so replies go through `az devops invoke`.
registerTemplate({
  eventType: "common.command_suggestions.azure_devops_pr",
  header: "",
  defaultBody:
    'Workers have the `az` CLI with the azure-devops extension, authenticated with the swarm PAT. Inspect the PR with `az repos pr show --id {{pr_id}}`. To reply on the PR, write `{"comments":[{"content":"<reply>"}],"status":1}` to a JSON file and run `az devops invoke --area git --resource pullRequestThreads --route-parameters project={{project}} repositoryId={{repository}} pullRequestId={{pr_id}} --http-method POST --in-file <file> --api-version 7.1`.',
  variables: [
    { name: "pr_id", description: "Pull request ID" },
    { name: "project", description: "Azure DevOps project name" },
    { name: "repository", description: "Azure Repos repository name" },
  ],
  category: "common",
});

const SHARED_VARIABLES = [
  { name: "pr_id", description: "Pull request ID" },
  { name: "pr_title", description: "Pull request title" },
  {
    name: "repo",
    description: "Repository clone URL (https://dev.azure.com/<org>/<project>/_git/<repo>)",
  },
  { name: "project", description: "Azure DevOps project name" },
  { name: "repository", description: "Azure Repos repository name" },
  { name: "pr_url", description: "Pull request web URL" },
];

// ============================================================================
// Pull request events
// ============================================================================

registerTemplate({
  eventType: "azure-devops.pull_request.opened",
  header: "[Azure DevOps PR #{{pr_id}}] {{pr_title}}",
  defaultBody: `Repo: {{repo}}
Author: {{username}}
Branch: {{source_branch}} → {{target_branch}}
URL: {{pr_url}}

{{context_section}}{{@template[common.command_suggestions.azure_devops_pr]}}{{@template[common.delegation_instruction.azure_devops]}}`,
  variables: [
    ...SHARED_VARIABLES,
    {
      name: "username",
      description:
        "Author identity — resolved canonical name (e.g. 'Luis (azure-devops:luis@example.com)') or the UNKNOWN sentinel",
    },
    { name: "source_branch", description: "Source branch name" },
    { name: "target_branch", description: "Target branch name" },
    { name: "context_section", description: "Context section with description or empty string" },
  ],
  category: "event",
});

// ============================================================================
// Pull request comment events
// ============================================================================

registerTemplate({
  eventType: "azure-devops.comment.mentioned",
  header: "[Azure DevOps Comment on PR #{{pr_id}}] {{username}} mentioned bot",
  defaultBody: `Repo: {{repo}}
PR: {{pr_title}}
URL: {{pr_url}}

Comment:
{{context}}{{existing_task_note}}

{{@template[common.command_suggestions.azure_devops_pr]}}{{@template[common.delegation_instruction.azure_devops]}}`,
  variables: [
    ...SHARED_VARIABLES,
    {
      name: "username",
      description:
        "Comment author identity — resolved canonical name (e.g. 'Luis (azure-devops:luis@example.com)') or the UNKNOWN sentinel",
    },
    { name: "context", description: "Extracted mention context from comment" },
    {
      name: "existing_task_note",
      description: "Note about existing active task, or empty string",
    },
  ],
  category: "event",
});
