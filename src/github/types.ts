export interface GitHubWebhookEvent {
  action: string;
  sender: { login: string };
  repository: { full_name: string; html_url: string };
  installation?: { id: number };
  assignee?: { login: string; id: number }; // Added for assigned/unassigned events
}

export interface PullRequestEvent extends GitHubWebhookEvent {
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    head: { ref: string; sha: string };
    base: { ref: string };
    merged: boolean;
    merged_by?: { login: string };
  };
  requested_reviewer?: { login: string; id: number }; // Added for review_requested/review_request_removed events
}

export interface IssueEvent extends GitHubWebhookEvent {
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
  };
}

export interface CommentEvent extends GitHubWebhookEvent {
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: { login: string };
  };
  issue?: { number: number; title: string; html_url: string };
  pull_request?: { number: number; title: string; html_url: string };
}

export interface PullRequestReviewEvent extends GitHubWebhookEvent {
  action: "submitted" | "edited" | "dismissed";
  review: {
    id: number;
    body: string | null;
    state: "approved" | "changes_requested" | "commented" | "dismissed";
    html_url: string;
    user: { login: string };
    submitted_at: string;
  };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    head: { ref: string };
    base: { ref: string };
  };
}

export interface CheckRunEvent extends GitHubWebhookEvent {
  action: "created" | "completed" | "rerequested" | "requested_action";
  check_run: {
    id: number;
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | null;
    html_url: string;
    started_at: string;
    completed_at: string | null;
    output: {
      title: string | null;
      summary: string | null;
    };
    check_suite: {
      id: number;
      head_sha: string;
    };
    pull_requests: Array<{
      number: number;
      head: { sha: string };
    }>;
  };
}

export interface CheckSuiteEvent extends GitHubWebhookEvent {
  action: "completed" | "requested" | "rerequested";
  check_suite: {
    id: number;
    status: "queued" | "in_progress" | "completed";
    conclusion:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | "startup_failure"
      | "stale"
      | null;
    head_sha: string;
    head_branch: string | null;
    pull_requests: Array<{
      number: number;
      head: { sha: string };
    }>;
  };
}

export interface WorkflowRunEvent extends GitHubWebhookEvent {
  action: "completed" | "requested" | "in_progress";
  workflow_run: {
    id: number;
    name: string;
    head_branch: string;
    head_sha: string;
    status: "queued" | "in_progress" | "completed";
    conclusion:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "skipped"
      | "timed_out"
      | "action_required"
      | "startup_failure"
      | "stale"
      | null;
    html_url: string;
    run_number: number;
    event: string; // The event that triggered the workflow (e.g., "pull_request", "push")
    pull_requests: Array<{
      number: number;
      head: { sha: string };
    }>;
  };
  workflow: {
    id: number;
    name: string;
    path: string;
  };
}
