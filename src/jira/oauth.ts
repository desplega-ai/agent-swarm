import { getOAuthApp } from "../be/db-queries/oauth";
import { buildAuthorizationUrl, exchangeCode, type OAuthProviderConfig } from "../oauth/wrapper";
import { updateJiraMetadata } from "./metadata";
import type { JiraAccessibleResource } from "./types";

const ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

/**
 * Build the OAuth provider config for the generic wrapper.
 *
 * - `audience=api.atlassian.com` is required by the Atlassian 3LO flow.
 * - We intentionally OMIT `prompt: "consent"`: forcing consent on every reconnect
 *   is UX noise. Atlassian's default (skip consent if scopes haven't changed)
 *   is what we want. (Plan errata I6.)
 * - `scopeSeparator: " "` is critical — Atlassian wants space-separated scopes
 *   per RFC 6749, unlike Linear which requires commas.
 */
export function getJiraOAuthConfig(): OAuthProviderConfig | null {
  const app = getOAuthApp("jira");
  if (!app) return null;

  return {
    provider: "jira",
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    redirectUri: app.redirectUri,
    scopes: app.scopes.split(","),
    scopeSeparator: " ",
    extraParams: { audience: "api.atlassian.com" },
  };
}

export async function getJiraAuthorizationUrl(): Promise<string | null> {
  const config = getJiraOAuthConfig();
  if (!config) return null;
  const result = await buildAuthorizationUrl(config);
  return result.url;
}

/**
 * Handle the OAuth callback: exchange the authorization code for tokens (which
 * `exchangeCode` persists via storeOAuthTokens), then resolve the workspace
 * `cloudId` via the Atlassian accessible-resources endpoint and persist it
 * into `oauth_apps.metadata`.
 *
 * v1 single-workspace constraint: we always pick the first resource and throw
 * if the list is empty. Multi-workspace is a v2 concern.
 */
export async function handleJiraCallback(
  code: string,
  state: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  cloudId: string;
  siteUrl: string;
}> {
  const config = getJiraOAuthConfig();
  if (!config) throw new Error("Jira OAuth not configured");

  const tokens = await exchangeCode(config, code, state);

  const response = await fetch(ACCESSIBLE_RESOURCES_URL, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira accessible-resources fetch failed (${response.status}): ${errorText}`);
  }

  const resources = (await response.json()) as JiraAccessibleResource[];
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error(
      "Jira OAuth completed but no accessible resources returned — does the consenting user have access to any Jira site?",
    );
  }

  const first = resources[0];
  if (!first || typeof first.id !== "string" || typeof first.url !== "string") {
    throw new Error("Jira accessible-resources returned malformed entry (missing id/url)");
  }

  updateJiraMetadata({ cloudId: first.id, siteUrl: first.url });

  return {
    ...tokens,
    cloudId: first.id,
    siteUrl: first.url,
  };
}
