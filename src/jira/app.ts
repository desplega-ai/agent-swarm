import { upsertOAuthApp } from "../be/db-queries/oauth";

let initialized = false;

export function isJiraEnabled(): boolean {
  const disabled = process.env.JIRA_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  const enabled = process.env.JIRA_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  return !!process.env.JIRA_CLIENT_ID;
}

export function resetJira(): void {
  // TODO(phase 3): call resetBotAccountIdCache() once src/jira/sync.ts lands
  // so a reconnect as a different Atlassian user invalidates the cached
  // bot accountId. (Plan Phase 3 step 3.)
  // TODO(phase 4): teardownJiraOutboundSync() once src/jira/outbound.ts lands.
  // TODO(phase 5): stopJiraWebhookKeepalive() once src/jira/webhook-lifecycle.ts lands.
  initialized = false;
}

export function initJira(): boolean {
  if (initialized) return isJiraEnabled();
  initialized = true;

  if (!isJiraEnabled()) {
    console.log("[Jira] Integration disabled or JIRA_CLIENT_ID not set");
    return false;
  }

  const clientId = process.env.JIRA_CLIENT_ID!;
  const clientSecret = process.env.JIRA_CLIENT_SECRET ?? "";
  const redirectUri =
    process.env.JIRA_REDIRECT_URI ??
    `http://localhost:${process.env.PORT || "3013"}/api/trackers/jira/callback`;

  upsertOAuthApp("jira", {
    clientId,
    clientSecret,
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    redirectUri,
    // Atlassian uses space-separated scopes (NOT comma-separated like Linear).
    // We persist them as-stored; the OAuth wrapper splits on "," so we keep
    // commas here and the wrapper.ts join(",") will recombine — see oauth.ts
    // where we override scopes from the comma-stored value back to spaces in
    // the authorize URL via the standard `scopes` array path.
    scopes: "read:jira-work,write:jira-work,manage:jira-webhook,offline_access,read:me",
    metadata: "{}",
  });

  // TODO(phase 4): initJiraOutboundSync() once src/jira/outbound.ts lands.
  // TODO(phase 5): startJiraWebhookKeepalive() once src/jira/webhook-lifecycle.ts lands.

  console.log("[Jira] Integration initialized");
  return true;
}
