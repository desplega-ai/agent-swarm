import { getOAuthApp } from "../be/db-queries/oauth";
import { oauthAppRowToProviderConfig } from "../oauth/ensure-token";
import { buildAuthorizationUrl, exchangeCode, type OAuthProviderConfig } from "../oauth/wrapper";
import { updateJiraMetadata } from "./metadata";
import type { JiraAccessibleResource } from "./types";

const ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

/**
 * Build the OAuth provider config for the generic wrapper.
 *
 * All provider quirks (space-separated scopes, `audience=api.atlassian.com`,
 * refresh-token rotation) are now first-class `oauth_apps` columns seeded by
 * `initJira()`, so this is a thin projection of the row — the drift-prone
 * hardcoding it used to carry moved into the seeding call + schema.
 */
export function getJiraOAuthConfig(): OAuthProviderConfig | null {
  const app = getOAuthApp("jira");
  return app ? oauthAppRowToProviderConfig(app) : null;
}

export async function getJiraAuthorizationUrl(): Promise<string | null> {
  const config = getJiraOAuthConfig();
  if (!config) return null;
  // flow='tracker' so the unified state-keyed callback runs the tracker
  // post-processing (cloudId capture) after landing tokens on the default
  // authorization.
  const result = await buildAuthorizationUrl(config, { flow: "tracker", label: "default" });
  return result.url;
}

/**
 * Resolve the workspace `cloudId`/`siteUrl` from Atlassian's
 * accessible-resources endpoint using a freshly-exchanged access token, and
 * persist both into `oauth_apps.metadata`.
 *
 * v1 single-workspace constraint: we always pick the first resource and throw
 * if the list is empty. Multi-workspace is a v2 concern. Shared by the unified
 * `flow='tracker'` callback branch and the legacy {@link handleJiraCallback}.
 */
export async function resolveAndStoreJiraCloudId(
  accessToken: string,
): Promise<{ cloudId: string; siteUrl: string }> {
  const response = await fetch(ACCESSIBLE_RESOURCES_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
  return { cloudId: first.id, siteUrl: first.url };
}

/**
 * Legacy provider-string callback: exchange the code (persisted onto the
 * default authorization by `exchangeCode`), then resolve + persist cloudId.
 *
 * The production tracker callback route now delegates to the unified
 * state-keyed handler (which invokes {@link resolveAndStoreJiraCloudId} in its
 * `flow='tracker'` branch); this wrapper is retained for the direct unit-test
 * surface and any provider-string caller.
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
  const { cloudId, siteUrl } = await resolveAndStoreJiraCloudId(tokens.accessToken);

  return { ...tokens, cloudId, siteUrl };
}
