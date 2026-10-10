/**
 * Azure DevOps service-hook payload types.
 *
 * Based on https://learn.microsoft.com/azure/devops/service-hooks/events
 * (resource version 1.0 for pull requests, 2.0 for pull request comments).
 * Only the fields we actually use are typed.
 */

export interface AzureDevOpsIdentityRef {
  id: string; // identity GUID; a picker @mention stores it as `@<GUID>`
  displayName: string;
  uniqueName?: string; // usually the sign-in email
  url?: string;
  imageUrl?: string;
}

export interface AzureDevOpsProjectRef {
  id: string;
  name: string;
  url?: string;
}

export interface AzureDevOpsRepository {
  id: string;
  name: string;
  url: string; // REST URL of the repository
  project: AzureDevOpsProjectRef;
  defaultBranch?: string;
  remoteUrl: string; // clone URL, may carry a `user@` prefix
}

export interface AzureDevOpsPullRequest {
  repository: AzureDevOpsRepository;
  pullRequestId: number;
  status: string; // "active" | "abandoned" | "completed"
  createdBy: AzureDevOpsIdentityRef;
  title: string;
  description?: string | null;
  sourceRefName: string; // e.g. "refs/heads/feature"
  targetRefName: string;
  url: string; // REST URL of the pull request
  _links?: { web?: { href: string } };
}

export interface AzureDevOpsComment {
  id: number;
  parentCommentId: number;
  author: AzureDevOpsIdentityRef;
  content: string;
  publishedDate: string;
  lastContentUpdatedDate?: string;
  commentType: string; // "text" | "system" | "codeChange"
  _links?: {
    self?: { href: string };
    threads?: { href: string };
  };
}

interface ResourceContainer {
  id: string;
  baseUrl?: string; // e.g. "https://dev.azure.com/fabrikam/"
}

interface ServiceHookEvent<TType extends string, TResource> {
  id: string;
  eventType: TType;
  publisherId: string;
  resource: TResource;
  resourceVersion?: string;
  resourceContainers?: {
    collection?: ResourceContainer;
    account?: ResourceContainer;
    project?: ResourceContainer;
  };
  createdDate?: string;
}

/** `git.pullrequest.created` */
export type PullRequestCreatedEvent = ServiceHookEvent<
  "git.pullrequest.created",
  AzureDevOpsPullRequest
>;

/** `ms.vss-code.git-pullrequest-comment-event` */
export type PullRequestCommentedEvent = ServiceHookEvent<
  "ms.vss-code.git-pullrequest-comment-event",
  { comment: AzureDevOpsComment; pullRequest: AzureDevOpsPullRequest }
>;

export type AzureDevOpsWebhookEvent = PullRequestCreatedEvent | PullRequestCommentedEvent;
