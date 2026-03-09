/**
 * GitLab Webhook Payload Types
 *
 * Based on https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html
 * Only the fields we actually use are typed.
 */

export interface GitLabUser {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
  email?: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string; // e.g. "group/project"
  web_url: string;
  default_branch: string;
}

// ── Merge Request Event ──

export interface MergeRequestAttributes {
  id: number;
  iid: number; // project-scoped ID (equivalent to GitHub PR number)
  title: string;
  description: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  action: string; // "open", "close", "reopen", "update", "merge", "approved", "unapproved"
  source_branch: string;
  target_branch: string;
  url: string;
  last_commit: { id: string; message: string } | null;
  author_id: number;
}

export interface MergeRequestEvent {
  object_kind: "merge_request";
  event_type: "merge_request";
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: MergeRequestAttributes;
  assignees?: GitLabUser[];
  reviewers?: GitLabUser[];
  changes?: Record<string, { previous: unknown; current: unknown }>;
}

// ── Issue Event ──

export interface IssueAttributes {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  action: string; // "open", "close", "reopen", "update"
  url: string;
  author_id: number;
}

export interface IssueEvent {
  object_kind: "issue";
  event_type: "issue";
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: IssueAttributes;
  assignees?: GitLabUser[];
}

// ── Note (Comment) Event ──

export interface NoteAttributes {
  id: number;
  note: string;
  noteable_type: "MergeRequest" | "Issue" | "Commit" | "Snippet";
  noteable_id: number;
  url: string;
  author_id: number;
  type: string | null; // "DiffNote", "DiscussionNote", null
}

export interface NoteEvent {
  object_kind: "note";
  event_type: "note";
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: NoteAttributes;
  merge_request?: MergeRequestAttributes;
  issue?: IssueAttributes;
}

// ── Pipeline Event ──

export interface PipelineAttributes {
  id: number;
  ref: string;
  status:
    | "created"
    | "pending"
    | "running"
    | "success"
    | "failed"
    | "canceled"
    | "skipped"
    | "manual";
  source: string;
  detailed_status: string;
}

export interface PipelineEvent {
  object_kind: "pipeline";
  event_type: "pipeline";
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: PipelineAttributes;
  merge_request?: {
    id: number;
    iid: number;
    title: string;
    url: string;
    source_branch: string;
    target_branch: string;
  };
}

// ── Union type for all supported events ──
export type GitLabWebhookEvent = MergeRequestEvent | IssueEvent | NoteEvent | PipelineEvent;
