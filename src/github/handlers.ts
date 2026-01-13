import { createTaskExtended, failTask, findTaskByGitHub, getAllAgents } from "../be/db";
import { detectMention, extractMentionContext, GITHUB_BOT_NAME, isBotAssignee } from "./mentions";
import { addIssueReaction, addReaction } from "./reactions";
import type { CommentEvent, IssueEvent, PullRequestEvent } from "./types";

// Simple deduplication cache (60 second TTL)
const processedEvents = new Map<string, number>();
const EVENT_TTL = 60_000;

// Delegation instruction for lead agents receiving GitHub tasks
const DELEGATION_INSTRUCTION =
  "⚠️ As lead, DELEGATE this task to a worker agent - do not tackle it yourself.";

/**
 * Get suggested commands based on task type
 */
function getCommandSuggestions(taskType: string, targetType?: string): string {
  switch (taskType) {
    case "github-pr":
      return "💡 Suggested: /review-pr or /respond-github";
    case "github-issue":
      return "💡 Suggested: /implement-issue or /respond-github";
    case "github-comment":
      return targetType === "PR"
        ? "💡 Suggested: /respond-github or /review-pr"
        : "💡 Suggested: /respond-github";
    default:
      return "";
  }
}

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
  const {
    action,
    pull_request: pr,
    repository,
    sender,
    installation,
    assignee,
    requested_reviewer,
  } = event;

  // Handle assigned action - bot was assigned to PR
  if (action === "assigned") {
    // Check if bot was assigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Deduplicate using assignment-specific key
    const eventKey = `pr-assigned:${repository.full_name}:${pr.number}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    // Same task creation flow as mention-based handling
    const lead = findLeadAgent();
    const suggestions = getCommandSuggestions("github-pr");
    const taskDescription = `[GitHub PR #${pr.number}] ${pr.title}\n\nAssigned to: @${GITHUB_BOT_NAME}\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nBranch: ${pr.head.ref} → ${pr.base.ref}\nURL: ${pr.html_url}\n\nContext:\n${pr.body || pr.title}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

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
      console.log(
        `[GitHub] Created task ${task.id} for PR #${pr.number} (assigned) -> ${lead.name}`,
      );
    } else {
      console.log(
        `[GitHub] Created unassigned task ${task.id} for PR #${pr.number} (assigned, no lead available)`,
      );
    }

    if (installation?.id) {
      addIssueReaction(repository.full_name, pr.number, "eyes", installation.id);
    }

    return { created: true, taskId: task.id };
  }

  // Handle unassigned action - bot was removed from PR
  if (action === "unassigned") {
    // Check if bot was unassigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Find the related task
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (!task) {
      console.log(`[GitHub] No active task found for PR #${pr.number} to cancel`);
      return { created: false };
    }

    // Cancel the task
    const cancelledTask = failTask(task.id, `Unassigned from GitHub PR #${pr.number}`);
    if (cancelledTask) {
      console.log(`[GitHub] Cancelled task ${task.id} for PR #${pr.number} (unassigned)`);
      return { created: false, taskId: task.id };
    }

    return { created: false };
  }

  // Handle review_requested action - bot was requested to review PR
  if (action === "review_requested") {
    // Check if bot was requested as reviewer
    if (!isBotAssignee(requested_reviewer?.login)) {
      return { created: false };
    }

    // Deduplicate using review-specific key
    const eventKey = `pr-review-requested:${repository.full_name}:${pr.number}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    // Create review task
    const lead = findLeadAgent();
    const suggestions = getCommandSuggestions("github-pr");
    const taskDescription = `[GitHub PR #${pr.number}] ${pr.title}\n\nReview requested from: @${GITHUB_BOT_NAME}\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nBranch: ${pr.head.ref} → ${pr.base.ref}\nURL: ${pr.html_url}\n\nContext:\n${pr.body || pr.title}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

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
      console.log(
        `[GitHub] Created task ${task.id} for PR #${pr.number} (review requested) -> ${lead.name}`,
      );
    } else {
      console.log(
        `[GitHub] Created unassigned task ${task.id} for PR #${pr.number} (review requested, no lead available)`,
      );
    }

    if (installation?.id) {
      addIssueReaction(repository.full_name, pr.number, "eyes", installation.id);
    }

    return { created: true, taskId: task.id };
  }

  // Handle review_request_removed action - bot review request was cancelled
  if (action === "review_request_removed") {
    // Check if bot's review request was removed
    if (!isBotAssignee(requested_reviewer?.login)) {
      return { created: false };
    }

    // Find the related task
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (!task) {
      console.log(`[GitHub] No active task found for PR #${pr.number} to cancel`);
      return { created: false };
    }

    // Cancel the task
    const cancelledTask = failTask(task.id, `Review request removed from GitHub PR #${pr.number}`);
    if (cancelledTask) {
      console.log(
        `[GitHub] Cancelled task ${task.id} for PR #${pr.number} (review request removed)`,
      );
      return { created: false, taskId: task.id };
    }

    return { created: false };
  }

  // Only handle opened/edited actions for mention-based flow
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
  const suggestions = getCommandSuggestions("github-pr");
  const taskDescription = `[GitHub PR #${pr.number}] ${pr.title}\n\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nBranch: ${pr.head.ref} → ${pr.base.ref}\nURL: ${pr.html_url}\n\nContext:\n${context}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

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
  const { action, issue, repository, sender, installation, assignee } = event;

  // Handle assigned action - bot was assigned to issue
  if (action === "assigned") {
    // Check if bot was assigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Deduplicate using assignment-specific key
    const eventKey = `issue-assigned:${repository.full_name}:${issue.number}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    // Same task creation flow as mention-based handling
    const lead = findLeadAgent();
    const suggestions = getCommandSuggestions("github-issue");
    const taskDescription = `[GitHub Issue #${issue.number}] ${issue.title}\n\nAssigned to: @${GITHUB_BOT_NAME}\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${issue.html_url}\n\nContext:\n${issue.body || issue.title}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

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
      console.log(
        `[GitHub] Created task ${task.id} for issue #${issue.number} (assigned) -> ${lead.name}`,
      );
    } else {
      console.log(
        `[GitHub] Created unassigned task ${task.id} for issue #${issue.number} (assigned, no lead available)`,
      );
    }

    if (installation?.id) {
      addIssueReaction(repository.full_name, issue.number, "eyes", installation.id);
    }

    return { created: true, taskId: task.id };
  }

  // Handle unassigned action - bot was removed from issue
  if (action === "unassigned") {
    // Check if bot was unassigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Find the related task
    const task = findTaskByGitHub(repository.full_name, issue.number);
    if (!task) {
      console.log(`[GitHub] No active task found for issue #${issue.number} to cancel`);
      return { created: false };
    }

    // Cancel the task
    const cancelledTask = failTask(task.id, `Unassigned from GitHub issue #${issue.number}`);
    if (cancelledTask) {
      console.log(`[GitHub] Cancelled task ${task.id} for issue #${issue.number} (unassigned)`);
      return { created: false, taskId: task.id };
    }

    return { created: false };
  }

  // Only handle opened/edited actions for mention-based flow
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
  const suggestions = getCommandSuggestions("github-issue");
  const taskDescription = `[GitHub Issue #${issue.number}] ${issue.title}\n\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${issue.html_url}\n\nContext:\n${context}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

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
  const suggestions = getCommandSuggestions("github-comment", targetType);
  const taskDescription = `[GitHub ${targetType} #${targetNumber} Comment] ${targetTitle}\n\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${comment.html_url}\n\nComment:\n${context}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

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
