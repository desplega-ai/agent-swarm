import { createTaskExtended, failTask, findTaskByGitHub, getAllAgents } from "../be/db";
import { detectMention, extractMentionContext, GITHUB_BOT_NAME, isBotAssignee } from "./mentions";
import { addIssueReaction, addReaction } from "./reactions";
import type {
  CheckRunEvent,
  CheckSuiteEvent,
  CommentEvent,
  IssueEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  WorkflowRunEvent,
} from "./types";

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

    // Check if there's an existing task for this PR (e.g., bot created it)
    const existingTask = findTaskByGitHub(repository.full_name, pr.number);

    // Create review task
    const lead = findLeadAgent();
    const suggestions = getCommandSuggestions("github-pr");
    const taskDescription = `[GitHub PR #${pr.number}] ${pr.title}\n\nReview requested from: @${GITHUB_BOT_NAME}\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nBranch: ${pr.head.ref} → ${pr.base.ref}\nURL: ${pr.html_url}\n\nContext:\n${pr.body || pr.title}\n\n---\n${existingTask ? `Related task: ${existingTask.id}\n🔀 Consider routing to the same agent working on the related task.\n` : ""}${DELEGATION_INSTRUCTION}\n${suggestions}`;

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

  // Handle closed action - PR was merged or closed without merge
  if (action === "closed") {
    // Find the related task
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (!task) {
      // No task for this PR, nothing to notify
      return { created: false };
    }

    // Deduplicate
    const eventKey = `pr-closed:${repository.full_name}:${pr.number}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    const lead = findLeadAgent();
    const wasMerged = pr.merged;
    const emoji = wasMerged ? "🎉" : "❌";
    const status = wasMerged ? "MERGED" : "CLOSED";
    const mergedBy = wasMerged && pr.merged_by ? ` by ${pr.merged_by.login}` : "";

    const taskDescription = `${emoji} [GitHub PR #${pr.number}] ${status}${mergedBy}\n\nPR: ${pr.title}\nRepo: ${repository.full_name}\nURL: ${pr.html_url}\n\n---\nRelated task: ${task.id}\n🔀 Consider routing to the same agent working on the related task.\n${wasMerged ? "💡 PR successfully merged! Update any related issues or documentation." : "💡 PR was closed without merging. Review if follow-up is needed."}`;

    const notifyTask = createTaskExtended(taskDescription, {
      agentId: lead?.id ?? "",
      source: "github",
      taskType: "github-pr-status",
      githubRepo: repository.full_name,
      githubEventType: "pull_request",
      githubNumber: pr.number,
      githubAuthor: sender.login,
      githubUrl: pr.html_url,
    });

    console.log(
      `[GitHub] Created task ${notifyTask.id} for PR #${pr.number} (${status}) -> ${lead?.name ?? "unassigned"}`,
    );

    return { created: true, taskId: notifyTask.id };
  }

  // Handle synchronize action - new commits pushed to PR
  if (action === "synchronize") {
    // Find the related task
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (!task) {
      // No task for this PR, nothing to notify
      return { created: false };
    }

    // Deduplicate using SHA to avoid duplicate notifications for same push
    const eventKey = `pr-sync:${repository.full_name}:${pr.number}:${pr.head.sha}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    const lead = findLeadAgent();
    const taskDescription = `🔄 [GitHub PR #${pr.number}] New commits pushed\n\nPR: ${pr.title}\nRepo: ${repository.full_name}\nBranch: ${pr.head.ref}\nNew HEAD: ${pr.head.sha.substring(0, 7)}\nURL: ${pr.html_url}\n\n---\nRelated task: ${task.id}\n🔀 Consider routing to the same agent working on the related task.\n💡 New commits were pushed. CI will re-run - monitor for results.`;

    const notifyTask = createTaskExtended(taskDescription, {
      agentId: lead?.id ?? "",
      source: "github",
      taskType: "github-pr-update",
      githubRepo: repository.full_name,
      githubEventType: "pull_request",
      githubNumber: pr.number,
      githubAuthor: sender.login,
      githubUrl: pr.html_url,
    });

    console.log(
      `[GitHub] Created task ${notifyTask.id} for PR #${pr.number} (synchronize) -> ${lead?.name ?? "unassigned"}`,
    );

    return { created: true, taskId: notifyTask.id };
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

  // Check if there's an existing task for this PR/Issue
  const existingTask = targetNumber ? findTaskByGitHub(repository.full_name, targetNumber) : null;

  // Build task description
  const context = extractMentionContext(comment.body);
  const suggestions = getCommandSuggestions("github-comment", targetType);
  const taskDescription = `[GitHub ${targetType} #${targetNumber} Comment] ${targetTitle}\n\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${comment.html_url}\n\nComment:\n${context}\n\n---\n${existingTask ? `Related task: ${existingTask.id}\n🔀 Consider routing to the same agent working on the related task.\n` : ""}${DELEGATION_INSTRUCTION}\n${suggestions}`;

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

/**
 * Get review state emoji and label
 */
function getReviewStateInfo(state: string): { emoji: string; label: string } {
  switch (state) {
    case "approved":
      return { emoji: "✅", label: "APPROVED" };
    case "changes_requested":
      return { emoji: "🔄", label: "CHANGES REQUESTED" };
    case "commented":
      return { emoji: "💬", label: "COMMENTED" };
    case "dismissed":
      return { emoji: "🚫", label: "DISMISSED" };
    default:
      return { emoji: "📝", label: state.toUpperCase() };
  }
}

/**
 * Handle pull_request_review events (submitted, edited, dismissed)
 *
 * This notifies agents when PRs they created or are assigned to receive reviews.
 * - approved: PR is ready to merge
 * - changes_requested: PR needs updates before merging
 * - commented: Reviewer left feedback without explicit approval/rejection
 * - dismissed: A previous review was dismissed
 */
export async function handlePullRequestReview(
  event: PullRequestReviewEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, review, pull_request: pr, repository, sender, installation } = event;

  // Only handle submitted reviews (the most important action)
  // Edited reviews are less common and dismissed is handled by the state
  if (action !== "submitted") {
    return { created: false };
  }

  // Skip "commented" reviews that are empty - these are often just line comments
  // without an overall review body
  if (review.state === "commented" && !review.body) {
    return { created: false };
  }

  // Deduplicate
  const eventKey = `pr-review:${repository.full_name}:${pr.number}:${review.id}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  // Find any existing task for this PR
  const existingTask = findTaskByGitHub(repository.full_name, pr.number);

  // Only notify for PRs where bot is creator or already has a task
  const isBotCreator = isBotAssignee(pr.user.login);
  if (!isBotCreator && !existingTask) {
    return { created: false };
  }

  // Find lead agent for new task
  const lead = findLeadAgent();

  // Get review state info
  const { emoji, label } = getReviewStateInfo(review.state);

  // Build task description
  const reviewBody = review.body ? `\n\nReview Comment:\n${review.body}` : "";
  const suggestions =
    review.state === "approved"
      ? "💡 Suggested: Merge the PR or wait for additional reviews"
      : review.state === "changes_requested"
        ? "💡 Suggested: Address the requested changes and update the PR"
        : "💡 Suggested: Review the feedback and respond if needed";

  const taskDescription = `${emoji} [GitHub PR #${pr.number} Review] ${label}\n\nPR: ${pr.title}\nReviewer: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${review.html_url}${reviewBody}\n\n---\n${existingTask ? `Related task: ${existingTask.id}\n🔀 Consider routing to the same agent working on the related task.\n` : ""}${DELEGATION_INSTRUCTION}\n${suggestions}`;

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "github",
    taskType: "github-review",
    githubRepo: repository.full_name,
    githubEventType: "pull_request_review",
    githubNumber: pr.number,
    githubAuthor: sender.login,
    githubUrl: review.html_url,
  });

  if (lead) {
    console.log(
      `[GitHub] Created task ${task.id} for PR #${pr.number} review (${review.state}) -> ${lead.name}`,
    );
  } else {
    console.log(
      `[GitHub] Created unassigned task ${task.id} for PR #${pr.number} review (${review.state}, no lead available)`,
    );
  }

  // Add reaction to acknowledge the review
  if (installation?.id) {
    addIssueReaction(repository.full_name, pr.number, "eyes", installation.id);
  }

  return { created: true, taskId: task.id };
}

/**
 * Get conclusion emoji and label for CI checks
 */
function getCheckConclusionInfo(conclusion: string | null): { emoji: string; label: string } {
  switch (conclusion) {
    case "success":
      return { emoji: "✅", label: "PASSED" };
    case "failure":
      return { emoji: "❌", label: "FAILED" };
    case "cancelled":
      return { emoji: "⏹️", label: "CANCELLED" };
    case "timed_out":
      return { emoji: "⏱️", label: "TIMED OUT" };
    case "action_required":
      return { emoji: "⚠️", label: "ACTION REQUIRED" };
    case "skipped":
      return { emoji: "⏭️", label: "SKIPPED" };
    case "neutral":
      return { emoji: "➖", label: "NEUTRAL" };
    default:
      return { emoji: "❓", label: conclusion?.toUpperCase() ?? "UNKNOWN" };
  }
}

/**
 * Handle check_run events (CI check completed)
 *
 * This notifies agents when CI checks pass or fail on PRs they're working on.
 */
export async function handleCheckRun(
  event: CheckRunEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, check_run, repository } = event;

  // Only handle completed check runs
  if (action !== "completed") {
    return { created: false };
  }

  // Only notify on failure or action_required - success is less critical
  // Skip neutral/skipped/cancelled as they're usually not actionable
  const conclusion = check_run.conclusion;
  if (conclusion !== "failure" && conclusion !== "action_required") {
    return { created: false };
  }

  // Must be associated with at least one PR
  if (!check_run.pull_requests || check_run.pull_requests.length === 0) {
    return { created: false };
  }

  // Check if we have a task for any of these PRs
  let relatedTask = null;
  let prNumber = 0;
  for (const pr of check_run.pull_requests) {
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (task) {
      relatedTask = task;
      prNumber = pr.number;
      break;
    }
  }

  if (!relatedTask) {
    // No task for any of the associated PRs
    return { created: false };
  }

  // Deduplicate
  const eventKey = `check-run:${repository.full_name}:${check_run.id}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  const lead = findLeadAgent();
  const { emoji, label } = getCheckConclusionInfo(conclusion);

  const outputSummary = check_run.output.summary
    ? `\n\nSummary:\n${check_run.output.summary.substring(0, 500)}`
    : "";

  const taskDescription = `${emoji} [GitHub PR #${prNumber} CI] ${check_run.name} ${label}\n\nRepo: ${repository.full_name}\nCheck: ${check_run.name}\nURL: ${check_run.html_url}${outputSummary}\n\n---\nRelated task: ${relatedTask.id}\n🔀 Consider routing to the same agent working on the related task.\n💡 CI check failed. Review the logs and fix the issue.`;

  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "github",
    taskType: "github-ci",
    githubRepo: repository.full_name,
    githubEventType: "check_run",
    githubNumber: prNumber,
    githubAuthor: "",
    githubUrl: check_run.html_url,
  });

  console.log(
    `[GitHub] Created task ${task.id} for check_run ${check_run.name} (${conclusion}) on PR #${prNumber} -> ${lead?.name ?? "unassigned"}`,
  );

  return { created: true, taskId: task.id };
}

/**
 * Handle check_suite events (CI suite completed)
 *
 * This provides a summary notification when the entire CI suite completes.
 */
export async function handleCheckSuite(
  event: CheckSuiteEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, check_suite, repository } = event;

  // Only handle completed check suites
  if (action !== "completed") {
    return { created: false };
  }

  // Only notify on failure - success notifications would be too noisy
  const conclusion = check_suite.conclusion;
  if (conclusion !== "failure") {
    return { created: false };
  }

  // Must be associated with at least one PR
  if (!check_suite.pull_requests || check_suite.pull_requests.length === 0) {
    return { created: false };
  }

  // Check if we have a task for any of these PRs
  let relatedTask = null;
  let prNumber = 0;
  for (const pr of check_suite.pull_requests) {
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (task) {
      relatedTask = task;
      prNumber = pr.number;
      break;
    }
  }

  if (!relatedTask) {
    // No task for any of the associated PRs
    return { created: false };
  }

  // Deduplicate
  const eventKey = `check-suite:${repository.full_name}:${check_suite.id}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  const lead = findLeadAgent();
  const { emoji, label } = getCheckConclusionInfo(conclusion);
  const branch = check_suite.head_branch ?? "unknown";

  const taskDescription = `${emoji} [GitHub PR #${prNumber} CI Suite] ${label}\n\nRepo: ${repository.full_name}\nBranch: ${branch}\nCommit: ${check_suite.head_sha.substring(0, 7)}\n\n---\nRelated task: ${relatedTask.id}\n🔀 Consider routing to the same agent working on the related task.\n💡 CI suite failed. Check individual check runs for details.`;

  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "github",
    taskType: "github-ci",
    githubRepo: repository.full_name,
    githubEventType: "check_suite",
    githubNumber: prNumber,
    githubAuthor: "",
    githubUrl: repository.html_url,
  });

  console.log(
    `[GitHub] Created task ${task.id} for check_suite (${conclusion}) on PR #${prNumber} -> ${lead?.name ?? "unassigned"}`,
  );

  return { created: true, taskId: task.id };
}

/**
 * Handle workflow_run events (GitHub Actions workflow completed)
 *
 * This is the most useful event for CI failures as it provides:
 * - Direct URL to workflow run logs
 * - Workflow name for context
 * - Associated PR information
 */
export async function handleWorkflowRun(
  event: WorkflowRunEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, workflow_run, workflow, repository } = event;

  // Only handle completed workflow runs
  if (action !== "completed") {
    return { created: false };
  }

  // Only notify on failure - success notifications would be too noisy
  const conclusion = workflow_run.conclusion;
  if (conclusion !== "failure") {
    return { created: false };
  }

  // Must be associated with at least one PR
  if (!workflow_run.pull_requests || workflow_run.pull_requests.length === 0) {
    return { created: false };
  }

  // Check if we have a task for any of these PRs
  let relatedTask = null;
  let prNumber = 0;
  for (const pr of workflow_run.pull_requests) {
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (task) {
      relatedTask = task;
      prNumber = pr.number;
      break;
    }
  }

  if (!relatedTask) {
    // No task for any of the associated PRs
    return { created: false };
  }

  // Deduplicate
  const eventKey = `workflow-run:${repository.full_name}:${workflow_run.id}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  const lead = findLeadAgent();
  const { emoji, label } = getCheckConclusionInfo(conclusion);

  const taskDescription = `${emoji} [GitHub PR #${prNumber} Workflow] ${workflow_run.name} ${label}\n\nRepo: ${repository.full_name}\nWorkflow: ${workflow.name}\nRun #${workflow_run.run_number}\nBranch: ${workflow_run.head_branch}\nTriggered by: ${workflow_run.event}\nLogs: ${workflow_run.html_url}\n\n---\nRelated task: ${relatedTask.id}\n🔀 Consider routing to the same agent working on the related task.\n💡 Workflow failed. Click the logs URL above to see what went wrong and fix the issue.`;

  const task = createTaskExtended(taskDescription, {
    agentId: lead?.id ?? "",
    source: "github",
    taskType: "github-ci",
    githubRepo: repository.full_name,
    githubEventType: "workflow_run",
    githubNumber: prNumber,
    githubAuthor: "",
    githubUrl: workflow_run.html_url,
  });

  console.log(
    `[GitHub] Created task ${task.id} for workflow_run "${workflow_run.name}" (${conclusion}) on PR #${prNumber} -> ${lead?.name ?? "unassigned"}`,
  );

  return { created: true, taskId: task.id };
}
