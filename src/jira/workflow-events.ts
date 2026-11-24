import { extractText } from "./adf";

/** One workflow bus event built from an authenticated Jira delivery. */
export interface JiraWorkflowEvent {
  name: "jira.issue.assigned" | "jira.issue.commented" | "jira.issue.transitioned";
  payload: Record<string, unknown>;
}

type JiraUser = { accountId?: string; displayName?: string; emailAddress?: string } | null;

type JiraIssue = {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    project?: { key?: string } | null;
    labels?: unknown;
    assignee?: JiraUser;
    status?: { name?: string } | null;
  };
};

type ChangelogItem = Record<string, unknown>;

/** An own string property: a changelog item's `toString` key would otherwise read `Object.prototype.toString`. */
function own(item: ChangelogItem, key: string): string | null {
  const value = Object.hasOwn(item, key) ? item[key] : undefined;
  return typeof value === "string" && value ? value : null;
}

const isField = (item: ChangelogItem, name: string) =>
  own(item, "field") === name || own(item, "fieldId") === name;

/**
 * Workflow bus events for a Jira delivery, in the flat shape the Azure DevOps
 * triggers use (`title`, `project`, `action`, `assigned_to`, `user_login`, ...).
 * `jira:issue_updated` publishes `jira.issue.assigned` for a new assignee and
 * `jira.issue.transitioned` for a status change (both when one update does
 * both); `comment_created` publishes `jira.issue.commented`. `deliveryId`
 * becomes `delivery_id`, the key `event` triggers dedupe on.
 */
export function jiraWorkflowEvents(
  body: Record<string, unknown>,
  deliveryId: string,
): JiraWorkflowEvent[] {
  const issue = body.issue as JiraIssue | undefined;
  if (!issue?.key) return [];
  const user = (body.user as JiraUser | undefined) ?? null;
  const fields = issue.fields ?? {};
  const base = {
    issue_key: issue.key,
    issue_id: issue.id,
    title: fields.summary,
    project: fields.project?.key,
    labels: Array.isArray(fields.labels)
      ? fields.labels.filter((label): label is string => typeof label === "string")
      : [],
    assignee: fields.assignee?.displayName ?? null,
    assignee_account_id: fields.assignee?.accountId ?? null,
    status: fields.status?.name,
    user_login: user?.displayName ?? user?.accountId,
    user_account_id: user?.accountId,
    delivery_id: deliveryId,
  };

  const event = String(body.webhookEvent ?? "");
  if (event === "comment_created") {
    const comment = body.comment as
      | { id?: string; body?: unknown; author?: JiraUser; updateAuthor?: JiraUser }
      | undefined;
    if (!comment) return [];
    const author = comment.author ?? comment.updateAuthor ?? null;
    return [
      {
        name: "jira.issue.commented",
        payload: {
          ...base,
          action: "commented",
          comment: typeof comment.body === "string" ? comment.body : extractText(comment.body),
          comment_id: comment.id,
          user_login: author?.displayName ?? author?.accountId ?? base.user_login,
          user_account_id: author?.accountId ?? base.user_account_id,
        },
      },
    ];
  }
  if (event !== "jira:issue_updated") return [];

  const changelog = body.changelog as { items?: unknown } | undefined;
  const items = (Array.isArray(changelog?.items) ? changelog.items : []).filter(
    (item): item is ChangelogItem => !!item && typeof item === "object",
  );
  const events: JiraWorkflowEvent[] = [];
  const assignment = items.find((item) => isField(item, "assignee") && own(item, "to"));
  if (assignment) {
    events.push({
      name: "jira.issue.assigned",
      payload: {
        ...base,
        action: "assigned",
        assigned_to: own(assignment, "toString") ?? own(assignment, "to"),
        assigned_to_account_id: own(assignment, "to"),
        previous_assignee: own(assignment, "fromString") ?? own(assignment, "from"),
      },
    });
  }
  const transition = items.find((item) => isField(item, "status") && own(item, "toString"));
  if (transition) {
    events.push({
      name: "jira.issue.transitioned",
      payload: {
        ...base,
        action: "transitioned",
        status: own(transition, "toString"),
        previous_status: own(transition, "fromString"),
      },
    });
  }
  return events;
}
