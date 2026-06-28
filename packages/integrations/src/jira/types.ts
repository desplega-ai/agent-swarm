/** Atlassian token endpoint response (POST https://auth.atlassian.com/oauth/token). */
export interface JiraTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * One entry from GET https://api.atlassian.com/oauth/token/accessible-resources.
 * The `id` is the `cloudId` we need for all subsequent REST calls under
 * `https://api.atlassian.com/ex/jira/{cloudId}`.
 */
export interface JiraAccessibleResource {
  id: string;
  url: string;
  name: string;
  scopes: string[];
  avatarUrl?: string;
}

/**
 * JSON shape of `oauth_apps.metadata` for the `jira` provider. All fields are
 * optional because the row is created at install-time before OAuth completes
 * (cloudId lands on first successful callback) and webhooks come even later.
 *
 * All writes MUST go through `updateJiraMetadata()` (read-modify-write inside
 * a transaction) to avoid clobbering keys written by concurrent callers.
 */
export interface JiraOAuthAppMetadata {
  cloudId?: string;
  siteUrl?: string;
  webhookIds?: Array<{ id: number; expiresAt: string; jql: string }>;
}
