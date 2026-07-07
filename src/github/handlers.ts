import { failTask, findTaskByVcs, getAllAgents, getSwarmConfigs, incrKv, upsertKv } from "../be/db";
import { findUserByExternalId } from "../be/users";
import { resolveTemplate } from "../prompts/resolver";
import { githubContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { getInstallationToken } from "./app";
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
 * Build a uniform cross-ingress context key for a GitHub issue or PR.
 * `repository.full_name` is "owner/repo"; split it and fall back gracefully
 * if the split unexpectedly fails so we never block task creation on a bad key.
 */
function buildGithubContextKey(
  fullName: string,
  kind: "issue" | "pr",
  number: number,
): string | undefined {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return undefined;
  try {
    return githubContextKey({ owner, repo, kind, number });
  } catch {
    return undefined;
  }
}

/**
 * Runtime-config guards for cancel-on-unassign and cancel-on-review-request-removed.
 * Absent key / any value other than "false" → true (cancel, current behavior).
 * Value "false" → false (skip cancel, leave task untouched).
 */
function cancelFlagEnabled(key: string): boolean {
  const row = getSwarmConfigs({ scope: "global", key })[0];
  return row?.value !== "false";
}
const cancelOnUnassignEnabled = () => cancelFlagEnabled("github.cancelOnUnassign");
const cancelOnReviewRequestRemovedEnabled = () =>
  cancelFlagEnabled("github.cancelOnReviewRequestRemoved");

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

// ── Identity resolution ──

const UNMAPPED_NAMESPACE = "integration:unmapped:github";
const UNMAPPED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Resolve a GitHub webhook sender to a `users.id`.
 *
 * Per Q17.A: GitHub never exposes email reliably via webhook or App-installation
 * token, so there is NO email auto-link cascade. The only paths are:
 *   1. Fast path — `findUserByExternalId('github', sender.login)`.
 *   2. Miss — record an unmapped tracker entry (kv) for operator triage on
 *      the People → Unmapped tab.
 *
 * Returns `undefined` when no mapping exists — callers pass that straight to
 * `requestedByUserId`.
 */
function resolveGitHubSender(
  login: string,
  sampleEventType: string,
  sampleContext: string,
): string | undefined {
  const existing = findUserByExternalId("github", login);
  if (existing) return existing.id;

  // No mapping → unmapped tracker.
  upsertKv({
    namespace: UNMAPPED_NAMESPACE,
    key: `${login}:meta`,
    value: {
      lastSeenAt: new Date().toISOString(),
      sampleEventType,
      sampleContext: sampleContext.slice(0, 100),
    },
    valueType: "json",
    expiresAt: Date.now() + UNMAPPED_TTL_MS,
  });
  incrKv(UNMAPPED_NAMESPACE, `${login}:count`, 1);
  return undefined;
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
  const requestedByUserId = resolveGitHubSender(
    sender.login,
    "pull_request",
    `PR #${pr.number}: ${pr.title}`,
  );

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

    const task = createTaskWithSiblingAwareness(result.text, {
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
      contextKey: buildGithubContextKey(repository.full_name, "pr", pr.number),
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

    // Config gate: skip cancel if disabled
    if (!cancelOnUnassignEnabled()) {
      console.log(
        `[GitHub] unassign cancel disabled by config — leaving task untouched (PR #${pr.number})`,
      );
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

    const task = createTaskWithSiblingAwareness(result.text, {
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
      contextKey: buildGithubContextKey(repository.full_name, "pr", pr.number),
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

    // Config gate: skip cancel if disabled
    if (!cancelOnReviewRequestRemovedEnabled()) {
      console.log(
        `[GitHub] review-request-removed cancel disabled by config — leaving task untouched (PR #${pr.number})`,
      );
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

    const task = createTaskWithSiblingAwareness(result.text, {
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
      contextKey: buildGithubContextKey(repository.full_name, "pr", pr.number),
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
  const task = createTaskWithSiblingAwareness(result.text, {
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
    contextKey: buildGithubContextKey(repository.full_name, "pr", pr.number),
    requestedByUserId,
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
  const requestedByUserId = resolveGitHubSender(
    sender.login,
    "issues",
    `Issue #${issue.number}: ${issue.title}`,
  );

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

    const task = createTaskWithSiblingAwareness(result.text, {
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
      contextKey: buildGithubContextKey(repository.full_name, "issue", issue.number),
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

    // Config gate: skip cancel if disabled
    if (!cancelOnUnassignEnabled()) {
      console.log(
        `[GitHub] unassign cancel disabled by config — leaving task untouched (issue #${issue.number})`,
      );
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

    const task = createTaskWithSiblingAwareness(result.text, {
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
      contextKey: buildGithubContextKey(repository.full_name, "issue", issue.number),
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
  const task = createTaskWithSiblingAwareness(result.text, {
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
    contextKey: buildGithubContextKey(repository.full_name, "issue", issue.number),
    requestedByUserId,
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
  const requestedByUserId = resolveGitHubSender(
    sender.login,
    eventType,
    comment.body.slice(0, 100),
  );

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
  const task = createTaskWithSiblingAwareness(result.text, {
    agentId: lead?.id ?? "",
    source: "github",
    vcsProvider: "github",
    taskType: "github-comment",
    vcsRepo: repository.full_name,
    vcsEventType: eventType,
    vcsNumber: targetNumber,
    vcsCommentId: comment.id,
    vcsAuthor: sender.login,
    requestedByUserId,
    vcsUrl: targetUrl,
    vcsInstallationId: installation?.id,
    vcsNodeId: comment.node_id,
    contextKey: targetNumber
      ? buildGithubContextKey(repository.full_name, pull_request ? "pr" : "issue", targetNumber)
      : undefined,
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

interface ReviewInlineComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  html_url: string;
  diff_hunk: string;
  pull_request_review_id?: number | null;
}

interface FetchReviewCommentsResult {
  comments: ReviewInlineComment[];
  degraded: boolean;
}

function parseNextPageLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? (match[1] ?? null) : null;
}

const REVIEW_COMMENTS_EMPTY_RETRY_DELAYS_MS = [1_500, 3_000, 3_000];
const defaultReviewCommentsRetryDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
let reviewCommentsRetryDelay: (ms: number) => Promise<void> | void =
  defaultReviewCommentsRetryDelay;

export function setReviewCommentsRetryDelayForTests(
  delay?: (ms: number) => Promise<void> | void,
): void {
  reviewCommentsRetryDelay = delay ?? defaultReviewCommentsRetryDelay;
}

function buildReviewCommentsHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchPaginatedReviewComments(
  initialUrl: string,
  headers: Record<string, string>,
): Promise<FetchReviewCommentsResult> {
  const allComments: ReviewInlineComment[] = [];
  let url: string | null = initialUrl;
  try {
    while (url) {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.error(`[GitHub] Failed to fetch review inline comments: ${response.status}`);
        return { comments: allComments, degraded: true };
      }
      const page = (await response.json()) as ReviewInlineComment[];
      if (Array.isArray(page)) {
        allComments.push(...page);
      }
      url = parseNextPageLink(response.headers.get("link"));
    }
    return { comments: allComments, degraded: false };
  } catch (error) {
    console.error("[GitHub] Error fetching review inline comments:", error);
    return { comments: allComments, degraded: true };
  }
}

async function fetchReviewScopedComments(
  repo: string,
  prNumber: number,
  reviewId: number,
  headers: Record<string, string>,
): Promise<FetchReviewCommentsResult> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100`;

  let result = await fetchPaginatedReviewComments(url, headers);
  if (result.degraded || result.comments.length > 0) {
    return result;
  }

  for (const delayMs of REVIEW_COMMENTS_EMPTY_RETRY_DELAYS_MS) {
    await reviewCommentsRetryDelay(delayMs);
    result = await fetchPaginatedReviewComments(url, headers);
    if (result.degraded || result.comments.length > 0) {
      return result;
    }
  }

  return result;
}

async function fetchPrLevelReviewComments(
  repo: string,
  prNumber: number,
  reviewId: number,
  headers: Record<string, string>,
): Promise<FetchReviewCommentsResult> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`;
  const result = await fetchPaginatedReviewComments(url, headers);
  return {
    comments: result.comments.filter((comment) => comment.pull_request_review_id === reviewId),
    degraded: result.degraded,
  };
}

function dedupeReviewComments(comments: ReviewInlineComment[]): ReviewInlineComment[] {
  const byId = new Map<number, ReviewInlineComment>();
  for (const comment of comments) {
    if (!byId.has(comment.id)) {
      byId.set(comment.id, comment);
    }
  }
  return [...byId.values()];
}

async function fetchReviewComments(
  repo: string,
  prNumber: number,
  reviewId: number,
  installationId: number,
): Promise<FetchReviewCommentsResult> {
  const token = await getInstallationToken(installationId);
  if (!token) {
    return { comments: [], degraded: true };
  }

  const headers = buildReviewCommentsHeaders(token);
  const scopedResult = await fetchReviewScopedComments(repo, prNumber, reviewId, headers);
  if (!scopedResult.degraded && scopedResult.comments.length > 0) {
    return scopedResult;
  }

  const fallbackResult = await fetchPrLevelReviewComments(repo, prNumber, reviewId, headers);
  const mergedComments = dedupeReviewComments([
    ...scopedResult.comments,
    ...fallbackResult.comments,
  ]);

  if (fallbackResult.comments.length > 0) {
    return { comments: mergedComments, degraded: false };
  }

  return {
    comments: mergedComments,
    degraded: scopedResult.degraded || fallbackResult.degraded,
  };
}

function buildInlineCommentsSection(comments: ReviewInlineComment[]): string {
  if (comments.length === 0) return "";
  const items = comments.map((c) => {
    const loc = c.line ? `${c.path}:${c.line}` : c.path;
    const hunk = c.diff_hunk ? `\n\`\`\`diff\n${c.diff_hunk.slice(0, 300)}\n\`\`\`` : "";
    return `- **${loc}**${hunk}\n  > ${c.body}`;
  });
  return `\n\n## Inline review comments (${comments.length})\n\n${items.join("\n\n")}`;
}

function buildInlineCommentsDegradedSection(repo: string, prNumber: number): string {
  return `\n\n## ⚠️ Inline comments could NOT be auto-fetched
The automatic inline-comment fetch failed or was unverifiable while the reviewer submitted this review. Inline comments ARE the change requests. BEFORE scoping or dispatching this task you MUST fetch them yourself:
\`gh api "repos/${repo}/pulls/${prNumber}/comments?per_page=100" --jq '.[] | {id,path,line,body}'\`
Reply to and resolve EVERY unresolved inline thread. Do NOT dispatch off the review body alone.`;
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
  const requestedByUserId = resolveGitHubSender(
    sender.login,
    "pull_request_review",
    `Review on PR #${pr.number}: ${review.state}`,
  );

  // Only handle submitted reviews (the most important action)
  // Edited reviews are less common and dismissed is handled by the state
  if (action !== "submitted") {
    return { created: false };
  }

  // Deduplicate before making any API calls
  const eventKey = `pr-review:${repository.full_name}:${pr.number}:${review.id}`;
  if (isDuplicate(eventKey)) {
    return { created: false };
  }

  const { comments: inlineComments, degraded } = installation?.id
    ? await fetchReviewComments(repository.full_name, pr.number, review.id, installation.id)
    : { comments: [], degraded: true };

  // Skip "commented" reviews only when there is neither an overall body nor any inline
  // comments — a body-less review with inline comments carries real reviewer feedback.
  if (review.state === "commented" && !review.body && inlineComments.length === 0 && !degraded) {
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
  const inlineCommentsSection =
    buildInlineCommentsSection(inlineComments) +
    (degraded ? buildInlineCommentsDegradedSection(repository.full_name, pr.number) : "");
  const relatedTaskSection = existingTask
    ? `Related task: ${existingTask.id}\n🔀 Consider routing to the same agent working on the related task.\n`
    : "";

  const hasInlineComments = inlineComments.length > 0;
  const baseReviewSuggestion =
    review.state === "approved"
      ? "💡 Suggested: Merge the PR or wait for additional reviews"
      : review.state === "changes_requested"
        ? "💡 Suggested: Address the requested changes and update the PR"
        : "💡 Suggested: Review the feedback and respond if needed";
  const reviewSuggestions =
    hasInlineComments || degraded
      ? `${baseReviewSuggestion}\n💬 Address EVERY inline comment. After pushing fixes, reply to and resolve each inline review thread on GitHub so the reviewer sees visible confirmation.`
      : baseReviewSuggestion;

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
      inline_comments_section: inlineCommentsSection,
      related_task_section: relatedTaskSection,
      review_suggestions: reviewSuggestions,
    },
    { agentId: lead?.id, repoId: repository.full_name },
  );

  if (result.skipped) {
    return { created: false };
  }

  // Create task (assigned to lead if available, otherwise unassigned)
  const task = createTaskWithSiblingAwareness(result.text, {
    agentId: lead?.id ?? "",
    source: "github",
    vcsProvider: "github",
    taskType: "github-review",
    vcsRepo: repository.full_name,
    vcsEventType: "pull_request_review",
    vcsNumber: pr.number,
    vcsAuthor: sender.login,
    requestedByUserId,
    vcsUrl: review.html_url,
    vcsInstallationId: installation?.id,
    vcsNodeId: review.node_id,
    contextKey: buildGithubContextKey(repository.full_name, "pr", pr.number),
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
