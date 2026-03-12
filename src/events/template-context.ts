/**
 * Interpolation context interfaces for event prompt templates.
 *
 * Each event type exposes a structured context that template authors
 * can reference with {{path.to.value}} syntax.
 */

/** Common fields available in all GitHub event contexts */
export interface GitHubBaseContext {
  repo: { full_name: string; url: string };
  sender: { login: string };
  action: string;
  delegation_instruction: string;
  suggestions: string;
}

/** Context for pull_request.assigned, pull_request.review_requested, pull_request.mention */
export interface GitHubPullRequestContext extends GitHubBaseContext {
  pr: {
    number: number;
    title: string;
    body: string;
    url: string;
    head_branch: string;
    base_branch: string;
    author: string;
    head_sha: string;
  };
  assignee?: string;
  mention_context?: string;
}

/** Context for pull_request.closed */
export interface GitHubPullRequestClosedContext extends GitHubBaseContext {
  pr: {
    number: number;
    title: string;
    url: string;
    merged: boolean;
    merged_by: string;
  };
  status: string;
  emoji: string;
  related_task_id: string;
}

/** Context for pull_request.synchronize */
export interface GitHubPullRequestSyncContext extends GitHubBaseContext {
  pr: {
    number: number;
    title: string;
    url: string;
    head_branch: string;
    head_sha: string;
  };
  related_task_id: string;
}

/** Context for issues.assigned, issues.mention */
export interface GitHubIssueContext extends GitHubBaseContext {
  issue: {
    number: number;
    title: string;
    body: string;
    url: string;
  };
  assignee?: string;
  mention_context?: string;
}

/** Context for comment.mention (issue_comment / pr_review_comment) */
export interface GitHubCommentContext extends GitHubBaseContext {
  comment: {
    body: string;
    url: string;
    id: number;
  };
  target: {
    type: string;
    number: number;
    title: string;
    url: string;
  };
  mention_context: string;
  related_task_id?: string;
}

/** Context for pull_request_review.submitted */
export interface GitHubReviewContext extends GitHubBaseContext {
  review: {
    state: string;
    body: string;
    url: string;
    emoji: string;
    label: string;
  };
  pr: {
    number: number;
    title: string;
    url: string;
  };
  reviewer: string;
  related_task_id?: string;
}

/** Context for check_run.failed, check_suite.failed */
export interface GitHubCIContext extends GitHubBaseContext {
  check: {
    name: string;
    conclusion: string;
    emoji: string;
    label: string;
    url: string;
    output_summary?: string;
  };
  pr: {
    number: number;
  };
  branch?: string;
  commit_sha?: string;
  related_task_id: string;
}

/** Context for workflow_run.failed */
export interface GitHubWorkflowRunContext extends GitHubBaseContext {
  workflow: {
    name: string;
    run_number: number;
    url: string;
    event: string;
    branch: string;
    conclusion: string;
    emoji: string;
    label: string;
  };
  pr: {
    number: number;
  };
  related_task_id: string;
}

/** Common fields for GitLab event contexts */
export interface GitLabBaseContext {
  repo: { full_name: string; url: string };
  sender: { login: string };
  action: string;
  delegation_instruction: string;
  suggestions: string;
}

/** Context for merge_request events */
export interface GitLabMergeRequestContext extends GitLabBaseContext {
  mr: {
    iid: number;
    title: string;
    description: string;
    url: string;
    source_branch: string;
    target_branch: string;
    author: string;
  };
  assignee?: string;
  mention_context?: string;
}

/** Context for GitLab issue events */
export interface GitLabIssueContext extends GitLabBaseContext {
  issue: {
    iid: number;
    title: string;
    description: string;
    url: string;
  };
  assignee?: string;
  mention_context?: string;
}

/** Context for GitLab note (comment) events */
export interface GitLabNoteContext extends GitLabBaseContext {
  note: {
    body: string;
    url: string;
  };
  target: {
    type: string;
    iid: number;
    title: string;
  };
  mention_context: string;
  related_task_id?: string;
}

/** Context for pipeline.failed */
export interface GitLabPipelineContext extends GitLabBaseContext {
  pipeline: {
    id: number;
    status: string;
    url: string;
    ref: string;
    sha: string;
    source: string;
  };
  mr?: {
    iid: number;
    title: string;
    url: string;
  };
  related_task_id?: string;
}

/** Context for AgentMail events */
export interface AgentMailContext {
  message: {
    from: string;
    subject: string;
    body: string;
    inbox_id: string;
    thread_id: string;
    message_id: string;
  };
  is_follow_up: boolean;
}
