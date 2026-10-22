/**
 * Bitbucket Cloud webhook payload types (subsets of the documented event
 * payloads; only the fields the handlers read).
 * https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/
 */

export interface BitbucketAccount {
  type?: string;
  /** Atlassian account id, e.g. `557058:<uuid>`. Absent for some app/team actors. */
  account_id?: string;
  /** Bitbucket user UUID, wrapped in braces: `{…}`. */
  uuid?: string;
  display_name?: string;
  nickname?: string;
}

export interface BitbucketRepository {
  /** Repository UUID, wrapped in braces: `{…}`. Stable across renames. */
  uuid: string;
  /** `<workspace>/<repo_slug>` */
  full_name: string;
  name?: string;
  links?: { html?: { href: string } };
}

export interface BitbucketBranchRef {
  branch?: { name: string };
  commit?: { hash: string };
  repository?: BitbucketRepository;
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description?: string | null;
  state?: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  author?: BitbucketAccount;
  source?: BitbucketBranchRef;
  destination?: BitbucketBranchRef;
  reviewers?: BitbucketAccount[];
  links?: { html?: { href: string } };
}

export interface BitbucketComment {
  id: number;
  content: { raw: string; markup?: string; html?: string };
  user?: BitbucketAccount;
  inline?: { path: string; from?: number | null; to?: number | null } | null;
  parent?: { id: number } | null;
  links?: { html?: { href: string } };
}

/** `pullrequest:created`, `pullrequest:fulfilled`, `pullrequest:rejected` */
export interface PullRequestEvent {
  actor: BitbucketAccount;
  pullrequest: BitbucketPullRequest;
  repository: BitbucketRepository;
}

/** `pullrequest:comment_created` */
export interface PullRequestCommentEvent extends PullRequestEvent {
  comment: BitbucketComment;
}

export type BitbucketWebhookEvent = PullRequestEvent | PullRequestCommentEvent;
