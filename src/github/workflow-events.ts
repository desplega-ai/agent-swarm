import type {
  CheckRunEvent,
  CheckSuiteEvent,
  CommentEvent,
  IssueEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
} from "./types";

/** One workflow bus event built from a verified GitHub delivery. */
export interface GitHubWorkflowEvent {
  name: string;
  payload: Record<string, unknown>;
}

const names = (items: Array<{ name: string }> | undefined): string[] =>
  (items ?? []).map((item) => item.name);
const logins = (items: Array<{ login: string }> | undefined): string[] =>
  (items ?? []).map((item) => item.login);

/**
 * The workflow bus event for a verified GitHub delivery, or null when the event
 * type publishes none. `wait` nodes and `event` triggers read the same event.
 * The fields `wait` filters already match on keep their names and values; the
 * rest (`delivery_id`, `labels`, `assignees`, ...) are additive. `delivery_id`
 * is the `X-GitHub-Delivery` header, which a redelivery repeats, so an event
 * trigger starts one run per delivery.
 */
export function githubWorkflowEvent(
  eventType: string | undefined,
  body: unknown,
  deliveryId: string | undefined,
): GitHubWorkflowEvent | null {
  const delivery = deliveryId ? { delivery_id: deliveryId } : {};
  switch (eventType) {
    case "pull_request": {
      const pr = body as PullRequestEvent;
      return {
        name: `github.pull_request.${pr.action}`,
        payload: {
          repo: pr.repository.full_name,
          number: pr.pull_request.number,
          title: pr.pull_request.title,
          body: pr.pull_request.body,
          action: pr.action,
          merged: pr.pull_request.merged ?? false,
          html_url: pr.pull_request.html_url,
          user_login: pr.pull_request.user.login,
          changed_files: pr.pull_request.changed_files,
          draft: pr.pull_request.draft ?? false,
          head_ref: pr.pull_request.head?.ref,
          head_sha: pr.pull_request.head?.sha,
          base_ref: pr.pull_request.base?.ref,
          labels: names(pr.pull_request.labels),
          assignees: logins(pr.pull_request.assignees),
          sender_login: pr.sender?.login,
          ...delivery,
        },
      };
    }
    case "issues": {
      const iss = body as IssueEvent;
      return {
        name: `github.issue.${iss.action}`,
        payload: {
          repo: iss.repository.full_name,
          number: iss.issue.number,
          title: iss.issue.title,
          action: iss.action,
          body: iss.issue.body,
          html_url: iss.issue.html_url,
          user_login: iss.issue.user?.login,
          labels: names(iss.issue.labels),
          assignees: logins(iss.issue.assignees),
          sender_login: iss.sender?.login,
          // The label or assignee this delivery added, on labeled / assigned.
          ...(iss.label ? { label: iss.label.name } : {}),
          ...(iss.action === "assigned" && iss.assignee ? { assigned_to: iss.assignee.login } : {}),
          ...delivery,
        },
      };
    }
    case "issue_comment": {
      // Named `.created` for every action, as before: `wait` nodes rely on it.
      // An `event` trigger checks `action`, so an edit or delete starts no run.
      const ic = body as CommentEvent;
      return {
        name: "github.issue_comment.created",
        payload: {
          repo: ic.repository.full_name,
          number: ic.issue?.number,
          action: ic.action,
          title: ic.issue?.title,
          html_url: ic.comment?.html_url,
          comment: ic.comment?.body,
          comment_id: ic.comment?.id,
          user_login: ic.comment?.user?.login,
          is_pull_request: ic.issue?.pull_request !== undefined,
          labels: names(ic.issue?.labels),
          assignees: logins(ic.issue?.assignees),
          ...delivery,
        },
      };
    }
    case "check_suite": {
      const cs = body as CheckSuiteEvent;
      return {
        name: `github.check_suite.${cs.action}`,
        payload: {
          repo: cs.repository.full_name,
          action: cs.action,
          status: cs.check_suite.status,
          conclusion: cs.check_suite.conclusion,
          head_sha: cs.check_suite.head_sha,
          head_branch: cs.check_suite.head_branch,
          pull_requests: (cs.check_suite.pull_requests ?? []).map((pr) => pr.number),
          sender_login: cs.sender?.login,
          ...delivery,
        },
      };
    }
    case "check_run": {
      const cr = body as CheckRunEvent;
      return {
        name: `github.check_run.${cr.action}`,
        payload: {
          repo: cr.repository.full_name,
          name: cr.check_run.name,
          headSha: cr.check_run.check_suite?.head_sha,
          conclusion: cr.check_run.conclusion,
          pullRequests: (cr.check_run.pull_requests ?? []).map((pr) => pr.number),
        },
      };
    }
    case "pull_request_review": {
      const prr = body as PullRequestReviewEvent;
      return {
        name: "github.pull_request_review.submitted",
        payload: {
          repo: prr.repository.full_name,
          number: prr.pull_request.number,
          state: prr.review.state,
          action: prr.action,
        },
      };
    }
    default:
      return null;
  }
}
