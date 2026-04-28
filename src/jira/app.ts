import { upsertOAuthApp } from "../be/db-queries/oauth";
import { initJiraOutboundSync, teardownJiraOutboundSync } from "./outbound";
// Side-effect import: registers all Jira event templates in the in-memory
// registry at module load time (mirrors `src/linear/templates.ts`).
import "./templates";
import { resetBotAccountIdCache } from "./sync";
import { startJiraWebhookKeepalive, stopJiraWebhookKeepalive } from "./webhook-lifecycle";

let initialized = false;

export function isJiraEnabled(): boolean {
  const disabled = process.env.JIRA_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  const enabled = process.env.JIRA_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  return !!process.env.JIRA_CLIENT_ID;
}

export function resetJira(): void {
  // Phase 3: drop the cached bot accountId so a reconnect as a different
  // Atlassian user re-resolves identity on the next inbound webhook.
  resetBotAccountIdCache();
  teardownJiraOutboundSync();
  stopJiraWebhookKeepalive();
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
  // Boot-time redirect URI gets persisted into oauth_apps.redirectUri and used
  // verbatim by the OAuth flow — so it must match what's registered with
  // Atlassian. Prefer MCP_BASE_URL over the localhost dev default; in prod
  // with no JIRA_REDIRECT_URI set, this is what stops Atlassian from sending
  // the user back to localhost.
  const apiBaseUrl =
    process.env.MCP_BASE_URL?.trim().replace(/\/+$/, "") ||
    `http://localhost:${process.env.PORT || "3013"}`;
  const redirectUri = process.env.JIRA_REDIRECT_URI ?? `${apiBaseUrl}/api/trackers/jira/callback`;

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
    // Intentionally omit metadata: cloudId/siteUrl/webhookIds are written by
    // the OAuth callback + webhook-register flows. upsertOAuthApp preserves
    // existing metadata on UPDATE when not passed.
  });

  initJiraOutboundSync();
  startJiraWebhookKeepalive();

  warnIfMcpBaseUrlLooksLikeAppUrl();

  console.log("[Jira] Integration initialized");
  return true;
}

/**
 * Soft sanity check for `MCP_BASE_URL`. If it equals `APP_URL` (a common
 * misconfig that points the webhook URL at the dashboard host), warn loudly
 * so the operator can fix the env. We don't fail boot — Atlassian will just
 * 404 webhook deliveries until corrected.
 */
function warnIfMcpBaseUrlLooksLikeAppUrl(): void {
  const mcp = process.env.MCP_BASE_URL?.trim().replace(/\/+$/, "");
  const app = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (mcp && app && mcp === app) {
    console.warn(
      `[Jira] WARNING: MCP_BASE_URL (${mcp}) equals APP_URL — registered webhook URLs will hit the dashboard host, not the API. Atlassian will likely 404 webhook deliveries. Point MCP_BASE_URL at the API server.`,
    );
  }
}
