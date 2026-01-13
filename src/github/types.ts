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
    head: { ref: string };
    base: { ref: string };
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
