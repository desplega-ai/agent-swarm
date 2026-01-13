import { createTaskExtended, getAllAgents } from "../be/db";
import { detectMention, extractMentionContext } from "./mentions";
import { addIssueReaction, addReaction } from "./reactions";
import type { CommentEvent, IssueEvent, PullRequestEvent } from "./types";

// Simple deduplication cache (60 second TTL)
const processedEvents = new Map<string, number>();
const EVENT_TTL = 60_000;

function isDuplicate(eventKey: string): boolean {
  const now = Date.now();

  // Clean old entries
  for (const [key, timestamp] of processedEvents) {
    if (now - timestamp > EVENT_TTL) {
      processedEvents.delete(key);
    }
  }

  if (processedEvents.has(eventKey)) {
    return true;
  }

  processedEvents.set(eventKey, now);
  return false;
}

/**
 * Find the lead agent to receive GitHub tasks
 * Returns null if no lead is available (task will go to pool)
 */
function findLeadAgent() {
  const agents = getAllAgents();
  // First try to find an online lead
  const onlineLead = agents.find((a) => a.isLead && a.status !== "offline");
  if (onlineLead) return onlineLead;
  // Fall back to any lead (even offline) - task will be waiting for them
  return agents.find((a) => a.isLead) ?? null;
}

/**
 * Handle pull_request events (opened, edited)
 */
export async function handlePullRequest(
  event: PullRequestEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, pull_request: pr, repository, sender, installation } = event;

  // Only handle opened/edited actions
  if (action !== "opened" && action !== "edited") {
    return { created: false };
  }

  // Check for @agent-swarm mention in title or body
  const hasMention = detectMention(pr.title) || detectMention(pr.body);
  if (!hasMention) {
    return { created: false };
  }

  // Deduplicate
  const eventKey = `pr:${repository.full_name}:${pr.number}:${action}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  // Find lead agent (may be null - task will be unassigned)
  const lead = findLeadAgent();

  // Build task description
  const context = extractMentionContext(pr.body) || pr.title;
  const taskDescription = `[GitHub PR #${pr.number}] ${pr.title}\n\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nBranch: ${pr.head.ref} → ${pr.base.ref}\nURL: ${pr.html_url}\n\nContext:\n${context}`;

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "github",
    taskType: "github-pr",
    githubRepo: repository.full_name,
    githubEventType: "pull_request",
    githubNumber: pr.number,
    githubAuthor: sender.login,
    githubUrl: pr.html_url,
  });

  if (lead) {
    console.log(`[GitHub] Created task ${task.id} for PR #${pr.number} -> ${lead.name}`);
  } else {
    console.log(
      `[GitHub] Created unassigned task ${task.id} for PR #${pr.number} (no lead available)`,
    );
  }

  // Add 👀 reaction to acknowledge the mention
  if (installation?.id) {
    addIssueReaction(repository.full_name, pr.number, "eyes", installation.id);
  }

  return { created: true, taskId: task.id };
}

/**
 * Handle issues events (opened, edited)
 */
export async function handleIssue(
  event: IssueEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, issue, repository, sender, installation } = event;

  // Only handle opened/edited actions
  if (action !== "opened" && action !== "edited") {
    return { created: false };
  }

  // Check for @agent-swarm mention in title or body
  const hasMention = detectMention(issue.title) || detectMention(issue.body);
  if (!hasMention) {
    return { created: false };
  }

  // Deduplicate
  const eventKey = `issue:${repository.full_name}:${issue.number}:${action}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  // Find lead agent (may be null - task will be unassigned)
  const lead = findLeadAgent();

  // Build task description
  const context = extractMentionContext(issue.body) || issue.title;
  const taskDescription = `[GitHub Issue #${issue.number}] ${issue.title}\n\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${issue.html_url}\n\nContext:\n${context}`;

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "github",
    taskType: "github-issue",
    githubRepo: repository.full_name,
    githubEventType: "issues",
    githubNumber: issue.number,
    githubAuthor: sender.login,
    githubUrl: issue.html_url,
  });

  if (lead) {
    console.log(`[GitHub] Created task ${task.id} for issue #${issue.number} -> ${lead.name}`);
  } else {
    console.log(
      `[GitHub] Created unassigned task ${task.id} for issue #${issue.number} (no lead available)`,
    );
  }

  // Add 👀 reaction to acknowledge the mention
  if (installation?.id) {
    addIssueReaction(repository.full_name, issue.number, "eyes", installation.id);
  }

  return { created: true, taskId: task.id };
}

/**
 * Handle comment events (issue_comment, pull_request_review_comment)
 */
export async function handleComment(
  event: CommentEvent,
  eventType: "issue_comment" | "pull_request_review_comment",
): Promise<{ created: boolean; taskId?: string }> {
  const { action, comment, repository, sender, issue, pull_request, installation } = event;

  // Only handle created action
  if (action !== "created") {
    return { created: false };
  }

  // Check for @agent-swarm mention in comment
  if (!detectMention(comment.body)) {
    return { created: false };
  }

  // Deduplicate
  const eventKey = `comment:${repository.full_name}:${comment.id}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  // Find lead agent (may be null - task will be unassigned)
  const lead = findLeadAgent();

  // Determine context (issue or PR)
  const target = pull_request || issue;
  const targetType = pull_request ? "PR" : "Issue";
  const targetNumber = target?.number ?? 0;
  const targetTitle = target?.title ?? "Unknown";
  const targetUrl = target?.html_url ?? comment.html_url;

  // Build task description
  const context = extractMentionContext(comment.body);
  const taskDescription = `[GitHub ${targetType} #${targetNumber} Comment] ${targetTitle}\n\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${comment.html_url}\n\nComment:\n${context}`;

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "github",
    taskType: "github-comment",
    githubRepo: repository.full_name,
    githubEventType: eventType,
    githubNumber: targetNumber,
    githubCommentId: comment.id,
    githubAuthor: sender.login,
    githubUrl: targetUrl,
  });

  if (lead) {
    console.log(`[GitHub] Created task ${task.id} for comment on #${targetNumber} -> ${lead.name}`);
  } else {
    console.log(
      `[GitHub] Created unassigned task ${task.id} for comment on #${targetNumber} (no lead available)`,
    );
  }

  // Add 👀 reaction to the comment to acknowledge the mention
  if (installation?.id) {
    addReaction(repository.full_name, comment.id, "eyes", installation.id);
  }

  return { created: true, taskId: task.id };
}
