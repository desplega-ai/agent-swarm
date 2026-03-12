/**
 * Event prompt template resolution.
 *
 * Handlers call resolveEventTaskDescription() before building their
 * inline prompt. If a custom template exists in the DB, it's interpolated
 * and returned. Otherwise null is returned, signaling the handler to use
 * its hardcoded default.
 */

import { getEventPromptTemplate } from "../be/db";
import type { EventPromptProvider } from "../types";
import { interpolate } from "../workflows/template";

/**
 * Resolve a custom event task description, or null if none exists.
 *
 * @param provider - "github", "gitlab", or "agentmail"
 * @param eventType - e.g. "pull_request.assigned", "pipeline.failed"
 * @param context - structured context object for interpolation
 * @param agentId - optional agent ID for agent-specific overrides
 * @returns interpolated template string, or null for hardcoded default
 */
export function resolveEventTaskDescription(
  provider: EventPromptProvider,
  eventType: string,
  context: Record<string, unknown>,
  agentId?: string,
): string | null {
  const template = getEventPromptTemplate(provider, eventType, agentId);
  if (!template) return null;
  return interpolate(template.template, context);
}

/**
 * All valid event types per provider.
 * Used for validation in MCP tools and documentation.
 */
export const VALID_EVENT_TYPES: Record<EventPromptProvider, string[]> = {
  github: [
    "pull_request.assigned",
    "pull_request.review_requested",
    "pull_request.mention",
    "pull_request.closed",
    "pull_request.synchronize",
    "issues.assigned",
    "issues.mention",
    "comment.mention",
    "pull_request_review.submitted",
    "check_run.failed",
    "check_suite.failed",
    "workflow_run.failed",
  ],
  gitlab: [
    "merge_request.opened",
    "merge_request.assigned",
    "merge_request.mention",
    "merge_request.comment_mention",
    "issue.assigned",
    "issue.mention",
    "issue.comment_mention",
    "pipeline.failed",
  ],
  agentmail: [
    "message.follow_up",
    "message.new_to_lead",
    "message.new_to_worker",
    "message.unmapped_inbox",
    "message.no_agent",
  ],
};

/**
 * Available template variables per event type.
 * Shown to users in MCP tool descriptions so they know what {{}} tokens work.
 */
export const EVENT_TEMPLATE_VARIABLES: Record<string, string[]> = {
  // GitHub PR events
  "github:pull_request.assigned": [
    "pr.number",
    "pr.title",
    "pr.body",
    "pr.url",
    "pr.head_branch",
    "pr.base_branch",
    "pr.author",
    "pr.head_sha",
    "repo.full_name",
    "repo.url",
    "sender.login",
    "assignee",
    "delegation_instruction",
    "suggestions",
  ],
  "github:pull_request.review_requested": [
    "pr.number",
    "pr.title",
    "pr.body",
    "pr.url",
    "pr.head_branch",
    "pr.base_branch",
    "pr.author",
    "pr.head_sha",
    "repo.full_name",
    "repo.url",
    "sender.login",
    "delegation_instruction",
    "suggestions",
  ],
  "github:pull_request.mention": [
    "pr.number",
    "pr.title",
    "pr.body",
    "pr.url",
    "pr.head_branch",
    "pr.base_branch",
    "pr.author",
    "pr.head_sha",
    "repo.full_name",
    "repo.url",
    "sender.login",
    "mention_context",
    "delegation_instruction",
    "suggestions",
  ],
  "github:pull_request.closed": [
    "pr.number",
    "pr.title",
    "pr.url",
    "pr.merged",
    "pr.merged_by",
    "repo.full_name",
    "sender.login",
    "status",
    "emoji",
    "related_task_id",
  ],
  "github:pull_request.synchronize": [
    "pr.number",
    "pr.title",
    "pr.url",
    "pr.head_branch",
    "pr.head_sha",
    "repo.full_name",
    "sender.login",
    "related_task_id",
  ],
  // GitHub issue events
  "github:issues.assigned": [
    "issue.number",
    "issue.title",
    "issue.body",
    "issue.url",
    "repo.full_name",
    "repo.url",
    "sender.login",
    "assignee",
    "delegation_instruction",
    "suggestions",
  ],
  "github:issues.mention": [
    "issue.number",
    "issue.title",
    "issue.body",
    "issue.url",
    "repo.full_name",
    "repo.url",
    "sender.login",
    "mention_context",
    "delegation_instruction",
    "suggestions",
  ],
  // GitHub comment events
  "github:comment.mention": [
    "comment.body",
    "comment.url",
    "comment.id",
    "target.type",
    "target.number",
    "target.title",
    "target.url",
    "repo.full_name",
    "sender.login",
    "mention_context",
    "related_task_id",
    "delegation_instruction",
    "suggestions",
  ],
  // GitHub review events
  "github:pull_request_review.submitted": [
    "review.state",
    "review.body",
    "review.url",
    "review.emoji",
    "review.label",
    "pr.number",
    "pr.title",
    "pr.url",
    "repo.full_name",
    "reviewer",
    "sender.login",
    "related_task_id",
    "delegation_instruction",
    "suggestions",
  ],
  // GitHub CI events
  "github:check_run.failed": [
    "check.name",
    "check.conclusion",
    "check.emoji",
    "check.label",
    "check.url",
    "check.output_summary",
    "pr.number",
    "repo.full_name",
    "related_task_id",
  ],
  "github:check_suite.failed": [
    "check.conclusion",
    "check.emoji",
    "check.label",
    "pr.number",
    "repo.full_name",
    "repo.url",
    "branch",
    "commit_sha",
    "related_task_id",
  ],
  "github:workflow_run.failed": [
    "workflow.name",
    "workflow.run_number",
    "workflow.url",
    "workflow.event",
    "workflow.branch",
    "workflow.conclusion",
    "workflow.emoji",
    "workflow.label",
    "pr.number",
    "repo.full_name",
    "related_task_id",
  ],
  // GitLab MR events
  "gitlab:merge_request.opened": [
    "mr.iid",
    "mr.title",
    "mr.description",
    "mr.url",
    "mr.source_branch",
    "mr.target_branch",
    "mr.author",
    "repo.full_name",
    "sender.login",
    "delegation_instruction",
    "suggestions",
  ],
  "gitlab:merge_request.assigned": [
    "mr.iid",
    "mr.title",
    "mr.description",
    "mr.url",
    "mr.source_branch",
    "mr.target_branch",
    "mr.author",
    "repo.full_name",
    "sender.login",
    "assignee",
    "delegation_instruction",
    "suggestions",
  ],
  "gitlab:merge_request.mention": [
    "mr.iid",
    "mr.title",
    "mr.description",
    "mr.url",
    "mr.source_branch",
    "mr.target_branch",
    "mr.author",
    "repo.full_name",
    "sender.login",
    "mention_context",
    "delegation_instruction",
    "suggestions",
  ],
  "gitlab:merge_request.comment_mention": [
    "note.body",
    "note.url",
    "target.type",
    "target.iid",
    "target.title",
    "repo.full_name",
    "sender.login",
    "mention_context",
    "related_task_id",
    "delegation_instruction",
    "suggestions",
  ],
  "gitlab:issue.assigned": [
    "issue.iid",
    "issue.title",
    "issue.description",
    "issue.url",
    "repo.full_name",
    "sender.login",
    "assignee",
    "delegation_instruction",
    "suggestions",
  ],
  "gitlab:issue.mention": [
    "issue.iid",
    "issue.title",
    "issue.description",
    "issue.url",
    "repo.full_name",
    "sender.login",
    "mention_context",
    "delegation_instruction",
    "suggestions",
  ],
  "gitlab:issue.comment_mention": [
    "note.body",
    "note.url",
    "target.type",
    "target.iid",
    "target.title",
    "repo.full_name",
    "sender.login",
    "mention_context",
    "related_task_id",
    "delegation_instruction",
    "suggestions",
  ],
  "gitlab:pipeline.failed": [
    "pipeline.id",
    "pipeline.status",
    "pipeline.url",
    "pipeline.ref",
    "pipeline.sha",
    "pipeline.source",
    "mr.iid",
    "mr.title",
    "mr.url",
    "repo.full_name",
    "related_task_id",
  ],
  // AgentMail events
  "agentmail:message.follow_up": [
    "message.from",
    "message.subject",
    "message.body",
    "message.inbox_id",
    "message.thread_id",
    "message.message_id",
    "is_follow_up",
  ],
  "agentmail:message.new_to_lead": [
    "message.from",
    "message.subject",
    "message.body",
    "message.inbox_id",
    "message.thread_id",
    "message.message_id",
  ],
  "agentmail:message.new_to_worker": [
    "message.from",
    "message.subject",
    "message.body",
    "message.inbox_id",
    "message.thread_id",
    "message.message_id",
  ],
  "agentmail:message.unmapped_inbox": [
    "message.from",
    "message.subject",
    "message.body",
    "message.inbox_id",
    "message.thread_id",
    "message.message_id",
  ],
  "agentmail:message.no_agent": [
    "message.from",
    "message.subject",
    "message.body",
    "message.inbox_id",
    "message.thread_id",
    "message.message_id",
  ],
};
