import { createTaskExtended, failTask, findTaskByVcs, getAllAgents, resolveUser } from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import {
  detectMention,
  extractMentionContext,
  GITHUB_BOT_NAME,
  isBotAssignee,
  isSwarmLabel,
} from "./mentions";
import { addIssueReaction, addReaction } from "./reactions";
// Side-effect import: registers all GitHub event templates in the in-memory registry
import "./templates";
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

/**
 * Get review state emoji and label
 */
export function getReviewStateInfo(state: string): { emoji: string; label: string } {
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
 * Get conclusion emoji and label for CI checks
 */
export function getCheckConclusionInfo(conclusion: string | null): {
  emoji: string;
  label: string;
} {
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

  // Resolve canonical user from GitHub sender
  const requestedByUserId = resolveUser({ githubUsername: sender.login })?.id;

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
    const result = resolveTemplate(
      "github.pull_request.assigned",
      {
        pr_number: pr.number,
        pr_title: pr.title,
        bot_name: GITHUB_BOT_NAME,
        sender_login: sender.login,
        repo_full_name: repository.full_name,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        pr_url: pr.html_url,
        context: pr.body || pr.title,
      },
      { agentId: lead?.id, repoId: repository.full_name },
    );

    if (result.skipped) {
      return { created: false };
    }

    const task = createTaskExtended(result.text, {
      agentId: lead?.id ?? "",
      source: "github",
      vcsProvider: "github",
      taskType: "github-pr",
      vcsRepo: repository.full_name,
      vcsEventType: "pull_request",
      vcsNumber: pr.number,
      vcsAuthor: sender.login,
      requestedByUserId,
      vcsUrl: pr.html_url,
      vcsInstallationId: installation?.id,
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
    const task = findTaskByVcs(repository.full_name, pr.number);
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

    // Check if there's an existing active task for this PR — skip duplicate review tasks
    const existingTask = findTaskByVcs(repository.full_name, pr.number);
    if (existingTask) {
      console.log(
        `[GitHub] Skipping review task for PR #${pr.number} — active task ${existingTask.id} already exists`,
      );
      return { created: false };
    }

    // Create review task
    const lead = findLeadAgent();
    const result = resolveTemplate(
      "github.pull_request.review_requested",
      {
        pr_number: pr.number,
        pr_title: pr.title,
        bot_name: GITHUB_BOT_NAME,
        sender_login: sender.login,
        repo_full_name: repository.full_name,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        pr_url: pr.html_url,
        context: pr.body || pr.title,
      },
      { agentId: lead?.id, repoId: repository.full_name },
    );

    if (result.skipped) {
      return { created: false };
    }

    const task = createTaskExtended(result.text, {
      agentId: lead?.id ?? "",
      source: "github",
      vcsProvider: "github",
      taskType: "github-pr",
      vcsRepo: repository.full_name,
      vcsEventType: "pull_request",
      vcsNumber: pr.number,
      vcsAuthor: sender.login,
      requestedByUserId,
      vcsUrl: pr.html_url,
      vcsInstallationId: installation?.id,
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
    const task = findTaskByVcs(repository.full_name, pr.number);
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

  // Handle labeled action - swarm label added to PR
  if (action === "labeled") {
    const labelName = event.label?.name;
    if (!labelName || !isSwarmLabel(labelName)) {
      return { created: false };
    }

    // Deduplicate
    const eventKey = `pr-labeled:${repository.full_name}:${pr.number}:${labelName}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    const lead = findLeadAgent();
    const result = resolveTemplate(
      "github.pull_request.labeled",
      {
        pr_number: pr.number,
        pr_title: pr.title,
        label_name: labelName,
        sender_login: sender.login,
        repo_full_name: repository.full_name,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        pr_url: pr.html_url,
        context: pr.body || pr.title,
      },
      { agentId: lead?.id, repoId: repository.full_name },
    );

    if (result.skipped) {
      return { created: false };
    }

    const task = createTaskExtended(result.text, {
      agentId: lead?.id ?? "",
      source: "github",
      vcsProvider: "github",
      taskType: "github-pr",
      vcsRepo: repository.full_name,
      vcsEventType: "pull_request",
      vcsNumber: pr.number,
      vcsAuthor: sender.login,
      requestedByUserId,
      vcsUrl: pr.html_url,
      vcsInstallationId: installation?.id,
    });

    if (lead) {
      console.log(
        `[GitHub] Created task ${task.id} for PR #${pr.number} (labeled: ${labelName}) -> ${lead.name}`,
      );
    } else {
      console.log(
        `[GitHub] Created unassigned task ${task.id} for PR #${pr.number} (labeled: ${labelName}, no lead available)`,
      );
    }

    if (installation?.id) {
      addIssueReaction(repository.full_name, pr.number, "eyes", installation.id);
    }

    return { created: true, taskId: task.id };
  }

  // Suppressed: see thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md
  if (action === "closed") {
    console.log(
      `[GitHub:suppressed] pull_request.closed on ${repository.full_name}#${pr.number} — lifecycle events disabled by default`,
    );
    return { created: false };
  }

  // Suppressed: see thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md
  if (action === "synchronize") {
    console.log(
      `[GitHub:suppressed] pull_request.synchronize on ${repository.full_name}#${pr.number} — lifecycle events disabled by default`,
    );
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
  const result = resolveTemplate(
    "github.pull_request.mentioned",
    {
      pr_number: pr.number,
      pr_title: pr.title,
      sender_login: sender.login,
      repo_full_name: repository.full_name,
      head_ref: pr.head.ref,
      base_ref: pr.base.ref,
      pr_url: pr.html_url,
      context,
    },
    { agentId: lead?.id, repoId: repository.full_name },
  );

  if (result.skipped) {
    return { created: false };
  }

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(result.text, {
    agentId: lead?.id ?? "",
    source: "github",
    vcsProvider: "github",
    taskType: "github-pr",
    vcsRepo: repository.full_name,
    vcsEventType: "pull_request",
    vcsNumber: pr.number,
    vcsAuthor: sender.login,
    vcsUrl: pr.html_url,
    vcsInstallationId: installation?.id,
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

  // Resolve canonical user from GitHub sender
  const requestedByUserId = resolveUser({ githubUsername: sender.login })?.id;

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
    const result = resolveTemplate(
      "github.issue.assigned",
      {
        issue_number: issue.number,
        issue_title: issue.title,
        bot_name: GITHUB_BOT_NAME,
        sender_login: sender.login,
        repo_full_name: repository.full_name,
        issue_url: issue.html_url,
        context: issue.body || issue.title,
      },
      { agentId: lead?.id, repoId: repository.full_name },
    );

    if (result.skipped) {
      return { created: false };
    }

    const task = createTaskExtended(result.text, {
      agentId: lead?.id ?? "",
      source: "github",
      vcsProvider: "github",
      taskType: "github-issue",
      vcsRepo: repository.full_name,
      vcsEventType: "issues",
      vcsNumber: issue.number,
      vcsAuthor: sender.login,
      requestedByUserId,
      vcsUrl: issue.html_url,
      vcsInstallationId: installation?.id,
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
    const task = findTaskByVcs(repository.full_name, issue.number);
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

  // Handle labeled action - swarm label added to issue
  if (action === "labeled") {
    const labelName = event.label?.name;
    if (!labelName || !isSwarmLabel(labelName)) {
      return { created: false };
    }

    // Deduplicate
    const eventKey = `issue-labeled:${repository.full_name}:${issue.number}:${labelName}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    const lead = findLeadAgent();
    const result = resolveTemplate(
      "github.issue.labeled",
      {
        issue_number: issue.number,
        issue_title: issue.title,
        label_name: labelName,
        sender_login: sender.login,
        repo_full_name: repository.full_name,
        issue_url: issue.html_url,
        context: issue.body || issue.title,
      },
      { agentId: lead?.id, repoId: repository.full_name },
    );

    if (result.skipped) {
      return { created: false };
    }

    const task = createTaskExtended(result.text, {
      agentId: lead?.id ?? "",
      source: "github",
      vcsProvider: "github",
      taskType: "github-issue",
      vcsRepo: repository.full_name,
      vcsEventType: "issues",
      vcsNumber: issue.number,
      vcsAuthor: sender.login,
      requestedByUserId,
      vcsUrl: issue.html_url,
      vcsInstallationId: installation?.id,
    });

    if (lead) {
      console.log(
        `[GitHub] Created task ${task.id} for issue #${issue.number} (labeled: ${labelName}) -> ${lead.name}`,
      );
    } else {
      console.log(
        `[GitHub] Created unassigned task ${task.id} for issue #${issue.number} (labeled: ${labelName}, no lead available)`,
      );
    }

    if (installation?.id) {
      addIssueReaction(repository.full_name, issue.number, "eyes", installation.id);
    }

    return { created: true, taskId: task.id };
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
  const result = resolveTemplate(
    "github.issue.mentioned",
    {
      issue_number: issue.number,
      issue_title: issue.title,
      sender_login: sender.login,
      repo_full_name: repository.full_name,
      issue_url: issue.html_url,
      context,
    },
    { agentId: lead?.id, repoId: repository.full_name },
  );

  if (result.skipped) {
    return { created: false };
  }

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(result.text, {
    agentId: lead?.id ?? "",
    source: "github",
    vcsProvider: "github",
    taskType: "github-issue",
    vcsRepo: repository.full_name,
    vcsEventType: "issues",
    vcsNumber: issue.number,
    vcsAuthor: sender.login,
    vcsUrl: issue.html_url,
    vcsInstallationId: installation?.id,
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

  // Resolve canonical user from GitHub sender
  const _requestedByUserId = resolveUser({ githubUsername: sender.login })?.id;

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
  const existingTask = targetNumber ? findTaskByVcs(repository.full_name, targetNumber) : null;

  // Build task description
  const context = extractMentionContext(comment.body);
  const suggestions = getCommandSuggestions("github-comment", targetType);
  const relatedTaskSection = existingTask
    ? `Related task: ${existingTask.id}\n🔀 Consider routing to the same agent working on the related task.\n`
    : "";

  const result = resolveTemplate(
    "github.comment.mentioned",
    {
      target_type: targetType,
      target_number: targetNumber,
      target_title: targetTitle,
      sender_login: sender.login,
      repo_full_name: repository.full_name,
      comment_url: comment.html_url,
      context,
      related_task_section: relatedTaskSection,
      command_suggestions: suggestions,
    },
    { agentId: lead?.id, repoId: repository.full_name },
  );

  if (result.skipped) {
    return { created: false };
  }

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(result.text, {
    agentId: lead?.id ?? "",
    source: "github",
    vcsProvider: "github",
    taskType: "github-comment",
    vcsRepo: repository.full_name,
    vcsEventType: eventType,
    vcsNumber: targetNumber,
    vcsCommentId: comment.id,
    vcsAuthor: sender.login,
    vcsUrl: targetUrl,
    vcsInstallationId: installation?.id,
    vcsNodeId: comment.node_id,
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

  // Resolve canonical user from GitHub sender
  const _requestedByUserId = resolveUser({ githubUsername: sender.login })?.id;

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
  const existingTask = findTaskByVcs(repository.full_name, pr.number);

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
  const reviewBodySection = review.body ? `\n\nReview Comment:\n${review.body}` : "";
  const relatedTaskSection = existingTask
    ? `Related task: ${existingTask.id}\n🔀 Consider routing to the same agent working on the related task.\n`
    : "";
  const reviewSuggestions =
    review.state === "approved"
      ? "💡 Suggested: Merge the PR or wait for additional reviews"
      : review.state === "changes_requested"
        ? "💡 Suggested: Address the requested changes and update the PR"
        : "💡 Suggested: Review the feedback and respond if needed";

  const result = resolveTemplate(
    "github.pull_request.review_submitted",
    {
      review_emoji: emoji,
      pr_number: pr.number,
      review_label: label,
      pr_title: pr.title,
      sender_login: sender.login,
      repo_full_name: repository.full_name,
      review_url: review.html_url,
      review_body_section: reviewBodySection,
      related_task_section: relatedTaskSection,
      review_suggestions: reviewSuggestions,
    },
    { agentId: lead?.id, repoId: repository.full_name },
  );

  if (result.skipped) {
    return { created: false };
  }

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskExtended(result.text, {
    agentId: lead?.id ?? "",
    source: "github",
    vcsProvider: "github",
    taskType: "github-review",
    vcsRepo: repository.full_name,
    vcsEventType: "pull_request_review",
    vcsNumber: pr.number,
    vcsAuthor: sender.login,
    vcsUrl: review.html_url,
    vcsInstallationId: installation?.id,
    vcsNodeId: review.node_id,
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
 * Handle check_run events (CI check completed)
 *
 * This notifies agents when CI checks pass or fail on PRs they're working on.
 */
export async function handleCheckRun(
  event: CheckRunEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, check_run, repository } = event;

  // Suppressed: see thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md
  const conclusion = check_run.conclusion ?? "unknown";
  console.log(
    `[GitHub:suppressed] check_run.${action} (${conclusion}) on ${repository.full_name} — CI events disabled by default`,
  );
  return { created: false };
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

  // Suppressed: see thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md
  const conclusion = check_suite.conclusion ?? "unknown";
  console.log(
    `[GitHub:suppressed] check_suite.${action} (${conclusion}) on ${repository.full_name} — CI events disabled by default`,
  );
  return { created: false };
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
  const { action, workflow_run, repository } = event;

  // Suppressed: see thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md
  const conclusion = workflow_run.conclusion ?? "unknown";
  console.log(
    `[GitHub:suppressed] workflow_run.${action} (${conclusion}) on ${repository.full_name} — CI events disabled by default`,
  );
  return { created: false };
}
